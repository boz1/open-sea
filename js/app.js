// ---------------------------------------------------------------------------
// Open Sea — boat trip planner
// Multiple named "sessions" (one per trip), each gated by a password chosen
// at creation. Each session is its own document: {title, generalNotes, days:
// [{stops:[...]}]}, synced live via Firestore when firebase-config.js has
// real keys; otherwise falls back to localStorage (single device only).
//
// The password gate is a lightweight name+password check done in the
// browser (password is hashed with SHA-256 before comparing/storing) — it
// keeps casual visitors and unrelated trip groups from wandering into each
// other's sessions. It is NOT real security: with Firestore rules open
// (read/write: if true, as documented in the README), anyone who queries
// the database directly could still read the raw documents. Don't put
// anything sensitive in a session.
// ---------------------------------------------------------------------------

const STOP_TYPES = {
  anchorage: { icon: "⚓", color: "#106a8c" },
  swim:      { icon: "🏊", color: "#4fa3c4" },
  sight:     { icon: "🏛️", color: "#e0674b" },
  town:      { icon: "🏘️", color: "#8a6d3b" },
  food:      { icon: "🍽️", color: "#5a8a4b" },
};

// ---------------------------------------------------------------------------
// Firebase / storage plumbing
// ---------------------------------------------------------------------------

const LOCAL_PREFIX = "open-sea-session:";
const REMEMBER_KEY = "open-sea-unlocked";
const usingFirebase = typeof firebaseConfig !== "undefined" && firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";

let db = null;

function initFirebase() {
  if (usingFirebase) {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  }
}

function sessionRef(id) {
  return db.collection("sessions").doc(id);
}

function fetchSessionOnce(id) {
  if (usingFirebase) {
    return sessionRef(id).get().then((doc) => (doc.exists ? doc.data() : null));
  }
  const raw = localStorage.getItem(LOCAL_PREFIX + id);
  return Promise.resolve(raw ? JSON.parse(raw) : null);
}

function subscribeSession(id, onData) {
  if (usingFirebase) {
    return sessionRef(id).onSnapshot(
      (doc) => {
        if (doc.exists) onData(doc.data());
        setSyncStatus("live");
      },
      (err) => {
        console.error("Firestore error", err);
        setSyncStatus("offline");
      }
    );
  }
  setSyncStatus("offline");
  const raw = localStorage.getItem(LOCAL_PREFIX + id);
  onData(raw ? JSON.parse(raw) : null);
  const handler = (e) => {
    if (e.key === LOCAL_PREFIX + id && e.newValue) onData(JSON.parse(e.newValue));
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

function createSessionDoc(id, data) {
  if (usingFirebase) return sessionRef(id).set(data);
  localStorage.setItem(LOCAL_PREFIX + id, JSON.stringify(data));
  return Promise.resolve();
}

function saveSession(id, data) {
  data._updatedAt = Date.now();
  if (usingFirebase) {
    setSyncStatus("pending");
    return sessionRef(id)
      .set(data)
      .then(() => setSyncStatus("live"))
      .catch(() => setSyncStatus("offline"));
  }
  localStorage.setItem(LOCAL_PREFIX + id, JSON.stringify(data));
  return Promise.resolve();
}

function setSyncStatus(state) {
  const el = document.getElementById("syncStatus");
  el.className = "sync-status " + state;
  el.title = { live: "Live sync with Firebase", offline: "Local only — friends won't see edits (set up Firebase, see README)", pending: "Saving…" }[state] || "";
}

// ---------------------------------------------------------------------------
// Helpers: slugify + password hashing
// ---------------------------------------------------------------------------

const TR_MAP = { ı: "i", İ: "i", ğ: "g", Ğ: "g", ü: "u", Ü: "u", ş: "s", Ş: "s", ö: "o", Ö: "o", ç: "c", Ç: "c" };

function slugify(str) {
  return str
    .toLowerCase()
    .split("")
    .map((ch) => TR_MAP[ch] || ch)
    .join("")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function hashPassword(pw) {
  if (window.crypto && window.crypto.subtle) {
    const buf = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for non-secure contexts (e.g. opening index.html directly as a file://
  // URL in a browser that doesn't expose crypto.subtle there). Not cryptographic.
  let h = 0;
  for (let i = 0; i < pw.length; i++) h = (Math.imul(31, h) + pw.charCodeAt(i)) | 0;
  return "fallback-" + (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Remembered sessions (per-browser convenience, so friends don't retype
// the password every visit on their own device)
// ---------------------------------------------------------------------------

function getRemembered() {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_KEY) || "{}");
  } catch {
    return {};
  }
}

function remember(id, passwordHash, name) {
  const all = getRemembered();
  all[id] = { passwordHash, name, ts: Date.now() };
  localStorage.setItem(REMEMBER_KEY, JSON.stringify(all));
}

function forget(id) {
  const all = getRemembered();
  delete all[id];
  localStorage.setItem(REMEMBER_KEY, JSON.stringify(all));
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let trip = { title: "", generalNotes: "", days: [] };
let currentSessionId = null;
let unsubscribeSession = null;
let map, markerLayer;
let addStopMode = false;
let editingContext = null; // { dayId, stopId } or { dayId } for new stop

function uid() {
  return "id-" + Math.random().toString(36).slice(2, 10);
}

function commit() {
  saveSession(currentSessionId, trip);
  render();
}

// ---------------------------------------------------------------------------
// Landing screen
// ---------------------------------------------------------------------------

function showLanding() {
  if (unsubscribeSession) {
    unsubscribeSession();
    unsubscribeSession = null;
  }
  currentSessionId = null;
  document.getElementById("landing").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("joinError").classList.add("hidden");
  document.getElementById("createError").classList.add("hidden");
  document.getElementById("joinForm").reset();
  document.getElementById("createForm").reset();
  renderRecentSessions();
}

function renderRecentSessions() {
  const remembered = getRemembered();
  const ids = Object.keys(remembered).sort((a, b) => remembered[b].ts - remembered[a].ts);
  const box = document.getElementById("recentSessions");
  const list = document.getElementById("recentList");
  list.innerHTML = "";
  if (ids.length === 0) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  ids.forEach((id) => {
    const row = document.createElement("div");
    row.className = "recent-item";
    row.innerHTML = `
      <button class="btn btn-secondary recent-btn">${escapeHtml(remembered[id].name || id)}</button>
      <button class="icon-btn recent-forget" title="Forget this session">✕</button>
    `;
    row.querySelector(".recent-btn").addEventListener("click", () => enterSession(id, remembered[id].name));
    row.querySelector(".recent-forget").addEventListener("click", (e) => {
      e.stopPropagation();
      forget(id);
      renderRecentSessions();
    });
    list.appendChild(row);
  });
}

function enterSession(id, name) {
  document.getElementById("landing").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  currentSessionId = id;
  if (unsubscribeSession) unsubscribeSession();
  unsubscribeSession = subscribeSession(id, (data) => {
    trip = data;
    if (!trip.days) trip.days = [];
    render();
  });
  renderMap._fitted = false;
  // The map was initialized while #app was display:none, so Leaflet measured
  // a zero-size container; now that it's visible, force it to re-measure.
  setTimeout(() => map.invalidateSize(), 50);
}

function wireLanding() {
  document.getElementById("joinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("joinError");
    errEl.classList.add("hidden");
    const rawName = document.getElementById("joinName").value.trim();
    const password = document.getElementById("joinPassword").value;
    const id = slugify(rawName);
    if (!id) return;

    const data = await fetchSessionOnce(id);
    if (!data) {
      errEl.textContent = "No session found with that name.";
      errEl.classList.remove("hidden");
      return;
    }
    const hash = await hashPassword(password);
    if (hash !== data.passwordHash) {
      errEl.textContent = "Wrong password.";
      errEl.classList.remove("hidden");
      return;
    }
    remember(id, hash, data.title || rawName);
    enterSession(id, data.title || rawName);
  });

  document.getElementById("createForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = document.getElementById("createError");
    errEl.classList.add("hidden");
    const rawName = document.getElementById("createName").value.trim();
    const password = document.getElementById("createPassword").value;
    const id = slugify(rawName);
    if (!id) {
      errEl.textContent = "Please enter a valid name.";
      errEl.classList.remove("hidden");
      return;
    }
    const existing = await fetchSessionOnce(id);
    if (existing) {
      errEl.textContent = "That name is taken — try a more specific one.";
      errEl.classList.remove("hidden");
      return;
    }
    const hash = await hashPassword(password);
    const data = { title: rawName, generalNotes: "", days: [], passwordHash: hash, createdAt: Date.now() };
    await createSessionDoc(id, data);
    remember(id, hash, rawName);
    enterSession(id, rawName);
  });

  document.getElementById("switchSessionBtn").addEventListener("click", showLanding);
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([36.62, 29.15], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 18,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  map.on("click", (e) => {
    if (!addStopMode) return;
    openStopModal({ lat: e.latlng.lat, lng: e.latlng.lng });
    setAddStopMode(false);
  });
}

function stopDivIcon(type) {
  const t = STOP_TYPES[type] || STOP_TYPES.sight;
  return L.divIcon({
    className: "",
    html: `<div class="stop-divicon" style="background:${t.color}"><span>${t.icon}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

const DAY_LINE_COLORS = ["#e0674b", "#4fa3c4", "#6a9e4a", "#c48fd6", "#d6a24f", "#5a6b73"];

function renderMap() {
  markerLayer.clearLayers();
  const bounds = [];

  trip.days.forEach((day, di) => {
    const latlngs = [];
    day.stops.forEach((stop) => {
      const marker = L.marker([stop.lat, stop.lng], { icon: stopDivIcon(stop.type) });
      marker.bindPopup(
        `<strong>${escapeHtml(stop.name)}</strong>` +
        (stop.time ? `<br><small>${escapeHtml(stop.time)}</small>` : "") +
        (stop.notes ? `<br>${notesToHtml(stop.notes)}` : "")
      );
      marker.on("click", () => openStopModal({ dayId: day.id, stopId: stop.id }));
      marker.addTo(markerLayer);
      latlngs.push([stop.lat, stop.lng]);
      bounds.push([stop.lat, stop.lng]);
    });
    if (latlngs.length > 1) {
      L.polyline(latlngs, {
        color: DAY_LINE_COLORS[di % DAY_LINE_COLORS.length],
        weight: 3,
        opacity: 0.6,
        dashArray: "6 6",
      }).addTo(markerLayer);
    }
  });

  if (bounds.length && !renderMap._fitted) {
    map.fitBounds(bounds, { padding: [40, 40] });
    renderMap._fitted = true;
  }
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function notesToHtml(str) {
  return escapeHtml(str)
    .replace(/(https?:\/\/\S+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, "<br>");
}

// ---------------------------------------------------------------------------
// Sidebar / itinerary
// ---------------------------------------------------------------------------

function renderItinerary() {
  const list = document.getElementById("dayList");
  list.innerHTML = "";

  trip.days.forEach((day, di) => {
    const card = document.createElement("div");
    card.className = "day-card";

    const header = document.createElement("div");
    header.className = "day-header";
    header.innerHTML = `
      <div class="day-header-row">
        <input class="day-title" value="${escapeHtml(day.title)}" />
        <button class="del-day" title="Delete day">✕</button>
      </div>
      <div class="day-header-row">
        <input class="day-date" type="text" placeholder="date" value="${escapeHtml(day.date || "")}" />
      </div>
    `;
    header.querySelector(".day-title").addEventListener("change", (e) => {
      day.title = e.target.value;
      commit();
    });
    header.querySelector(".day-date").addEventListener("change", (e) => {
      day.date = e.target.value;
      commit();
    });
    header.querySelector(".del-day").addEventListener("click", () => {
      if (confirm(`Delete "${day.title}" and all its stops?`)) {
        trip.days.splice(di, 1);
        commit();
      }
    });
    card.appendChild(header);

    const ul = document.createElement("ul");
    ul.className = "stop-list";

    if (day.stops.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-note";
      empty.textContent = "No stops yet — use \"Add Stop on Map\" below.";
      ul.appendChild(empty);
    }

    day.stops.forEach((stop, si) => {
      const li = document.createElement("li");
      li.className = "stop-item";
      const t = STOP_TYPES[stop.type] || STOP_TYPES.sight;
      li.innerHTML = `
        <span class="stop-icon">${t.icon}</span>
        <div class="stop-main">
          <div class="stop-name">${escapeHtml(stop.name)}</div>
          ${stop.time ? `<div class="stop-time">${escapeHtml(stop.time)}</div>` : ""}
          ${stop.notes ? `<div class="stop-notes">${notesToHtml(stop.notes)}</div>` : ""}
        </div>
        <div class="stop-reorder">
          <button class="up" title="Move up" ${si === 0 ? "disabled" : ""}>▲</button>
          <button class="down" title="Move down" ${si === day.stops.length - 1 ? "disabled" : ""}>▼</button>
        </div>
      `;
      li.querySelectorAll(".stop-notes a").forEach((a) => a.addEventListener("click", (e) => e.stopPropagation()));
      li.querySelector(".stop-main").addEventListener("click", () => openStopModal({ dayId: day.id, stopId: stop.id }));
      li.querySelector(".stop-icon").addEventListener("click", () => openStopModal({ dayId: day.id, stopId: stop.id }));
      li.querySelector(".up").addEventListener("click", (e) => {
        e.stopPropagation();
        [day.stops[si - 1], day.stops[si]] = [day.stops[si], day.stops[si - 1]];
        commit();
      });
      li.querySelector(".down").addEventListener("click", (e) => {
        e.stopPropagation();
        [day.stops[si + 1], day.stops[si]] = [day.stops[si], day.stops[si + 1]];
        commit();
      });
      ul.appendChild(li);
    });

    card.appendChild(ul);
    list.appendChild(card);
  });

  document.getElementById("tripTitle").value = trip.title || "Boat Trip";
  document.getElementById("generalNotes").value = trip.generalNotes || "";
  populateDaySelect();
}

function populateDaySelect() {
  const sel = document.getElementById("stopDay");
  sel.innerHTML = trip.days.map((d) => `<option value="${d.id}">${escapeHtml(d.title)}</option>`).join("");
}

function render() {
  renderItinerary();
  renderMap();
}

// ---------------------------------------------------------------------------
// Add-stop-on-map mode
// ---------------------------------------------------------------------------

function setAddStopMode(on) {
  addStopMode = on;
  document.getElementById("addStopBtn").classList.toggle("active", on);
  document.getElementById("addStopHint").classList.toggle("hidden", !on);
  document.getElementById("map").style.cursor = on ? "crosshair" : "";
}

// ---------------------------------------------------------------------------
// Stop modal
// ---------------------------------------------------------------------------

function openStopModal(ctx) {
  const overlay = document.getElementById("modalOverlay");
  const isNew = !ctx.stopId;
  editingContext = ctx;

  document.getElementById("modalHeading").textContent = isNew ? "New stop" : "Edit stop";
  document.getElementById("deleteStopBtn").classList.toggle("hidden", isNew);

  if (isNew) {
    document.getElementById("stopName").value = "";
    document.getElementById("stopTime").value = "";
    document.getElementById("stopNotes").value = "";
    document.getElementById("stopType").value = "sight";
    document.getElementById("stopLat").value = ctx.lat.toFixed(5);
    document.getElementById("stopLng").value = ctx.lng.toFixed(5);
    populateDaySelect();
    if (trip.days.length === 0) {
      trip.days.push({ id: uid(), title: "Day 1", date: "", stops: [] });
      populateDaySelect();
    }
    document.getElementById("stopDay").value = ctx.dayId || trip.days[trip.days.length - 1].id;
  } else {
    const day = trip.days.find((d) => d.id === ctx.dayId);
    const stop = day.stops.find((s) => s.id === ctx.stopId);
    document.getElementById("stopName").value = stop.name;
    document.getElementById("stopTime").value = stop.time || "";
    document.getElementById("stopNotes").value = stop.notes || "";
    document.getElementById("stopType").value = stop.type || "sight";
    document.getElementById("stopLat").value = stop.lat;
    document.getElementById("stopLng").value = stop.lng;
    populateDaySelect();
    document.getElementById("stopDay").value = day.id;
  }

  overlay.classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modalOverlay").classList.add("hidden");
  editingContext = null;
}

function saveStopFromModal() {
  const name = document.getElementById("stopName").value.trim();
  if (!name) {
    alert("Please give the stop a name.");
    return;
  }
  const dayId = document.getElementById("stopDay").value;
  const time = document.getElementById("stopTime").value.trim();
  const type = document.getElementById("stopType").value;
  const notes = document.getElementById("stopNotes").value.trim();
  const lat = parseFloat(document.getElementById("stopLat").value);
  const lng = parseFloat(document.getElementById("stopLng").value);
  if (isNaN(lat) || isNaN(lng)) {
    alert("Coordinates must be numbers.");
    return;
  }

  const targetDay = trip.days.find((d) => d.id === dayId);

  if (!editingContext.stopId) {
    targetDay.stops.push({ id: uid(), name, lat, lng, time, type, notes });
  } else {
    const originDay = trip.days.find((d) => d.id === editingContext.dayId);
    const idx = originDay.stops.findIndex((s) => s.id === editingContext.stopId);
    const stop = originDay.stops[idx];
    stop.name = name;
    stop.time = time;
    stop.type = type;
    stop.notes = notes;
    stop.lat = lat;
    stop.lng = lng;
    if (originDay.id !== dayId) {
      originDay.stops.splice(idx, 1);
      targetDay.stops.push(stop);
    }
  }

  closeModal();
  commit();
}

function deleteStopFromModal() {
  if (!editingContext || !editingContext.stopId) return;
  if (!confirm("Delete this stop?")) return;
  const day = trip.days.find((d) => d.id === editingContext.dayId);
  day.stops = day.stops.filter((s) => s.id !== editingContext.stopId);
  closeModal();
  commit();
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

function wireUi() {
  document.getElementById("menuToggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });

  document.getElementById("addStopBtn").addEventListener("click", () => setAddStopMode(!addStopMode));

  document.getElementById("addDayBtn").addEventListener("click", () => {
    trip.days.push({ id: uid(), title: `Day ${trip.days.length + 1}`, date: "", stops: [] });
    commit();
  });

  document.getElementById("tripTitle").addEventListener("change", (e) => {
    trip.title = e.target.value;
    commit();
  });

  document.getElementById("generalNotes").addEventListener("change", (e) => {
    trip.generalNotes = e.target.value;
    commit();
  });

  document.getElementById("cancelStopBtn").addEventListener("click", closeModal);
  document.getElementById("saveStopBtn").addEventListener("click", saveStopFromModal);
  document.getElementById("deleteStopBtn").addEventListener("click", deleteStopFromModal);
  document.getElementById("modalOverlay").addEventListener("click", (e) => {
    if (e.target.id === "modalOverlay") closeModal();
  });

  document.getElementById("locateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 13);
    });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener("DOMContentLoaded", () => {
  initFirebase();
  initMap();
  wireUi();
  wireLanding();

  const remembered = getRemembered();
  const ids = Object.keys(remembered).sort((a, b) => remembered[b].ts - remembered[a].ts);
  if (ids.length > 0) {
    enterSession(ids[0], remembered[ids[0]].name);
  } else {
    showLanding();
  }
});
