// ---------------------------------------------------------------------------
// Open Sea — boat trip planner
// Multiple named "sessions" (one per trip), each gated by a password chosen
// at creation. Each session is its own document: {title, notes, days:
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

// Converts legacy "DD.MM.YYYY" free-text dates into the ISO "YYYY-MM-DD"
// format the native <input type="date"> picker expects. Anything else
// (already ISO, blank, or unrecognized) passes through unchanged.
function toIsoDate(str) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(str || "");
  return m ? `${m[3]}-${m[2]}-${m[1]}` : str;
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

// Keeps the "Your sessions" quick-access label in sync with the trip's
// current title. Without this, the landing screen would keep showing
// whatever name was typed at the moment you first joined/created it, even
// after it's renamed (by you or a collaborator).
function refreshRememberedName(id, title) {
  const all = getRemembered();
  if (all[id] && title && all[id].name !== title) {
    all[id].name = title;
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(all));
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let trip = { title: "", notes: [], days: [] };
let currentSessionId = null;
let unsubscribeSession = null;
let pendingSessionId = null; // set right after Create, before the user clicks "Continue"
let pendingSessionName = null;
let map, markerLayer;
let addStopMode = false;
let editingContext = null; // { dayId, stopId } or { dayId } for new stop
let stopMarkers = {}; // stopId -> L.Marker
let stopListItems = {}; // stopId -> <li> element

function highlightStop(stopId, on) {
  const marker = stopMarkers[stopId];
  if (marker) {
    const el = marker.getElement();
    const inner = el && el.querySelector(".stop-divicon");
    if (inner) inner.classList.toggle("marker-highlight", on);
  }
  const li = stopListItems[stopId];
  if (li) li.classList.toggle("stop-highlight", on);
}

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
  document.getElementById("joinForm").classList.remove("hidden");
  document.getElementById("joinName").readOnly = false;
  delete document.getElementById("joinName").dataset.sessionId;
  document.getElementById("joinNameHint").classList.add("hidden");
  document.getElementById("createForm").classList.remove("hidden");
  document.getElementById("createSuccess").classList.add("hidden");
  renderRecentSessions();
}

function shareUrlFor(id) {
  return `${location.origin}${location.pathname}?session=${encodeURIComponent(id)}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Copy this link:", text);
    return false;
  }
}

// If the page was opened via a shared link (?session=slug), pre-fill and
// lock the join form's name field so the friend only has to type the password.
// The field shows the session's actual ID (its immutable slug) — not the
// editable display title, which can diverge from the slug once a trip is
// renamed after creation — so there's no ambiguity about what's being
// looked up. The friendly title still shows in the hint below for context.
async function applyShareLinkPrefill() {
  const sessionParam = new URLSearchParams(location.search).get("session");
  if (!sessionParam) return;
  const id = slugify(sessionParam);
  const data = await fetchSessionOnce(id);
  if (!data) return;
  const nameField = document.getElementById("joinName");
  nameField.value = id;
  nameField.readOnly = true;
  nameField.dataset.sessionId = id;
  const hint = document.getElementById("joinNameHint");
  hint.textContent = `Joining "${data.title || sessionParam}" — just enter the password.`;
  hint.classList.remove("hidden");
  document.getElementById("joinPassword").focus();
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
    let needsSave = false;
    if (!trip.notes) {
      // Migrate the old single-textarea generalNotes into the new list-of-notes shape.
      trip.notes = trip.generalNotes ? [{ id: uid(), text: trip.generalNotes }] : [];
      delete trip.generalNotes;
      needsSave = true;
    }
    trip.days.forEach((day) => {
      const iso = toIsoDate(day.date);
      if (iso !== day.date) {
        day.date = iso;
        needsSave = true;
      }
    });
    if (needsSave) saveSession(currentSessionId, trip);
    refreshRememberedName(id, trip.title);
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
    const nameField = document.getElementById("joinName");
    const rawName = nameField.value.trim();
    const password = document.getElementById("joinPassword").value;
    // If this field was locked by a share link, its lookup key was stashed
    // directly — re-slugifying the displayed title could produce a
    // different string if the trip was renamed after creation.
    const id = nameField.dataset.sessionId || slugify(rawName);
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
    const password = String(Math.floor(1000 + Math.random() * 9000));
    const hash = await hashPassword(password);
    const data = {
      title: rawName,
      notes: [],
      boatType: "catamaran",
      boatSpeedKnots: BOAT_PRESETS.catamaran.knots,
      days: [],
      passwordHash: hash,
      createdAt: Date.now(),
    };
    await createSessionDoc(id, data);
    remember(id, hash, rawName);

    pendingSessionId = id;
    pendingSessionName = rawName;
    document.getElementById("successName").textContent = rawName;
    document.getElementById("successPassword").textContent = password;
    document.getElementById("createForm").classList.add("hidden");
    document.getElementById("createSuccess").classList.remove("hidden");
  });

  document.getElementById("continueToSessionBtn").addEventListener("click", () => {
    enterSession(pendingSessionId, pendingSessionName);
  });

  document.getElementById("copyShareBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const ok = await copyToClipboard(shareUrlFor(pendingSessionId));
    if (ok) {
      const original = btn.textContent;
      btn.textContent = "✅ Copied!";
      setTimeout(() => (btn.textContent = original), 1500);
    }
  });

  document.getElementById("switchSessionBtn").addEventListener("click", showLanding);

  document.getElementById("shareBtn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const ok = await copyToClipboard(shareUrlFor(currentSessionId));
    if (ok) {
      const original = btn.textContent;
      btn.textContent = "✅";
      setTimeout(() => (btn.textContent = original), 1500);
    }
  });
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

function stopDivIcon(type, seq) {
  const t = STOP_TYPES[type] || STOP_TYPES.sight;
  return L.divIcon({
    className: "",
    html: `
      <div class="stop-wrap">
        <div class="stop-divicon" style="background:${t.color}"><span>${t.icon}</span></div>
        <div class="stop-seq">${seq}</div>
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28],
  });
}

function buildPopupHtml(stop) {
  return `
    <div class="stop-popup">
      <strong>${escapeHtml(stop.name)}</strong>
      ${stop.time ? `<div class="popup-time">${escapeHtml(stop.time)}</div>` : ""}
      ${stop.notes ? `<div class="popup-notes">${notesToHtml(stop.notes)}</div>` : ""}
      <button type="button" class="popup-edit-btn">✏️ Edit</button>
    </div>
  `;
}

const DAY_LINE_COLORS = ["#e0674b", "#4fa3c4", "#6a9e4a", "#c48fd6", "#d6a24f", "#5a6b73"];

function flattenStops(days) {
  const flat = [];
  days.forEach((day, dayIndex) => day.stops.forEach((stop) => flat.push({ stop, day, dayIndex })));
  return flat;
}

// When two or more stops share (almost) the same coordinates — e.g. a
// harbor used for both departure and return — plotting them at their real
// position would stack the pins exactly on top of each other, hiding all
// but one. This spreads such duplicates into a small circle around the
// shared point so every one of them stays visible, hoverable, and shows
// its own badge/popup. Distance/duration math elsewhere still uses the
// real stop.lat/lng, only the on-map position is nudged.
function computeDisplayPositions(flat) {
  const groups = {};
  flat.forEach((item, i) => {
    const key = `${item.stop.lat.toFixed(5)},${item.stop.lng.toFixed(5)}`;
    (groups[key] = groups[key] || []).push(i);
  });

  const positions = flat.map((item) => ({ lat: item.stop.lat, lng: item.stop.lng }));
  const RADIUS_DEG = 0.00035; // ~35m, purely a visual nudge

  Object.values(groups).forEach((indices) => {
    if (indices.length < 2) return;
    const latRad = (flat[indices[0]].stop.lat * Math.PI) / 180;
    indices.forEach((idx, j) => {
      const angle = (2 * Math.PI * j) / indices.length;
      positions[idx] = {
        lat: flat[idx].stop.lat + RADIUS_DEG * Math.cos(angle),
        lng: flat[idx].stop.lng + (RADIUS_DEG * Math.sin(angle)) / Math.cos(latRad),
      };
    });
  });

  return positions;
}

function renderMap() {
  markerLayer.clearLayers();
  stopMarkers = {};
  const bounds = [];
  const flat = flattenStops(trip.days);
  const displayPos = computeDisplayPositions(flat);

  flat.forEach(({ stop, day }, i) => {
    const pos = displayPos[i];
    const marker = L.marker([pos.lat, pos.lng], { icon: stopDivIcon(stop.type, i + 1) });
    marker.bindPopup(buildPopupHtml(stop), { closeButton: true, autoClose: false, closeOnClick: false, offset: [0, -4] });

    let closeTimer = null;
    const openNow = () => {
      clearTimeout(closeTimer);
      marker.openPopup();
    };
    const closeSoon = () => {
      closeTimer = setTimeout(() => marker.closePopup(), 200);
    };

    marker.on("mouseover", () => {
      openNow();
      highlightStop(stop.id, true);
    });
    marker.on("mouseout", () => {
      closeSoon();
      highlightStop(stop.id, false);
    });
    // Clicking (or tapping, on touch devices) just reveals the popup —
    // editing requires the explicit Edit button inside it.
    marker.on("click", openNow);
    marker.on("popupopen", (e) => {
      const el = e.popup.getElement();
      const btn = el.querySelector(".popup-edit-btn");
      if (btn) {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          marker.closePopup();
          openStopModal({ dayId: day.id, stopId: stop.id });
        });
      }
      el.addEventListener("mouseenter", () => clearTimeout(closeTimer));
      el.addEventListener("mouseleave", closeSoon);
    });

    marker.addTo(markerLayer);
    stopMarkers[stop.id] = marker;
    bounds.push([pos.lat, pos.lng]);
  });

  // Draw one continuous route across the whole trip: same-day hops get a
  // colored dashed line (per day), hops that cross into the next day get a
  // plain gray line so the two are easy to tell apart. Each segment shows
  // its distance/time on hover.
  for (let i = 1; i < flat.length; i++) {
    const a = flat[i - 1];
    const b = flat[i];
    const posA = displayPos[i - 1];
    const posB = displayPos[i];
    const sameDay = a.dayIndex === b.dayIndex;
    const style = sameDay
      ? { color: DAY_LINE_COLORS[a.dayIndex % DAY_LINE_COLORS.length], weight: 3, opacity: 0.6, dashArray: "6 6" }
      : { color: "#5a6b73", weight: 2, opacity: 0.5, dashArray: "2 8" };
    const nm = haversineNm(a.stop, b.stop);
    const line = L.polyline([[posA.lat, posA.lng], [posB.lat, posB.lng]], style).addTo(markerLayer);
    line.bindTooltip(
      `<strong>${escapeHtml(a.stop.name)} → ${escapeHtml(b.stop.name)}</strong><br>${nm.toFixed(1)} nm · ≈${formatDuration(nm / currentSpeedKnots())}`,
      { sticky: true, direction: "top", className: "route-tooltip" }
    );
    line.on("mouseover", () => line.setStyle({ weight: style.weight + 3, opacity: 1 }));
    line.on("mouseout", () => line.setStyle(style));
  }

  if (bounds.length && !renderMap._fitted) {
    map.fitBounds(bounds, { padding: [40, 40] });
    renderMap._fitted = true;
  }
}

// ---------------------------------------------------------------------------
// Distance / duration estimates
// ---------------------------------------------------------------------------

const BOAT_PRESETS = {
  catamaran: { label: "Catamaran", knots: 7 },
  monohull: { label: "Monohull sailboat", knots: 6 },
  gulet: { label: "Gulet / motor yacht", knots: 8 },
  motorboat: { label: "Motorboat", knots: 20 },
  other: { label: "Other", knots: 7 },
};

function haversineNm(a, b) {
  const R_KM = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  const km = R_KM * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return km / 1.852;
}

function lastStopBefore(days, dayIndex) {
  for (let i = dayIndex - 1; i >= 0; i--) {
    if (days[i].stops.length) return days[i].stops[days[i].stops.length - 1];
  }
  return null;
}

// Distance to sail/motor this day's plan, including the leg arriving from
// the previous day's last stop (so single-stop "transit" days still show
// an estimate instead of 0).
function dayDistanceNm(days, dayIndex) {
  const day = days[dayIndex];
  let prevStop = lastStopBefore(days, dayIndex);
  let nm = 0;
  for (const stop of day.stops) {
    if (prevStop) nm += haversineNm(prevStop, stop);
    prevStop = stop;
  }
  return nm;
}

function totalTripNm(days) {
  const flat = flattenStops(days);
  let nm = 0;
  for (let i = 1; i < flat.length; i++) nm += haversineNm(flat[i - 1].stop, flat[i].stop);
  return nm;
}

function formatDuration(hours) {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return (h > 0 ? h + "h " : "") + m + "m";
}

function currentSpeedKnots() {
  return trip.boatSpeedKnots || BOAT_PRESETS[trip.boatType]?.knots || 7;
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
// Weather (Open-Meteo — free, no API key, CORS-open)
// ---------------------------------------------------------------------------

const WEATHER_CODES = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️",
  45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌧️",
  56: "🌧️", 57: "🌧️",
  61: "🌦️", 63: "🌧️", 65: "🌧️",
  66: "🌧️", 67: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "❄️", 77: "🌨️",
  80: "🌦️", 81: "🌧️", 82: "⛈️",
  85: "🌨️", 86: "❄️",
  95: "⛈️", 96: "⛈️", 99: "⛈️",
};
const WIND_COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function windDirLabel(deg) {
  if (deg == null) return "";
  return WIND_COMPASS[Math.round(deg / 22.5) % 16];
}

const weatherCache = {};

function weatherKey(lat, lng, dateStr) {
  return `${lat.toFixed(2)},${lng.toFixed(2)},${dateStr}`;
}

async function fetchWeather(lat, lng, dateStr) {
  const key = weatherKey(lat, lng, dateStr);
  if (weatherCache[key]) return weatherCache[key];

  const target = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / 86400000);

  // General forecast covers 16 days out; marine (wave) forecast only 8.
  if (isNaN(diffDays) || diffDays < 0 || diffDays > 15) {
    return (weatherCache[key] = { status: "unavailable", checkedAt: Date.now() });
  }

  weatherCache[key] = { status: "loading", checkedAt: Date.now() };
  try {
    const [wx, mx] = await Promise.all([
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
        `&daily=weather_code,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant` +
        `&wind_speed_unit=kn&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`
      ).then((r) => r.json()),
      diffDays <= 7
        ? fetch(
            `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}` +
            `&daily=wave_height_max&timezone=auto&start_date=${dateStr}&end_date=${dateStr}`
          ).then((r) => r.json()).catch(() => null)
        : Promise.resolve(null),
    ]);
    const d = wx.daily || {};
    return (weatherCache[key] = {
      status: "ready",
      checkedAt: Date.now(),
      code: d.weather_code ? d.weather_code[0] : null,
      windKn: d.wind_speed_10m_max ? d.wind_speed_10m_max[0] : null,
      gustKn: d.wind_gusts_10m_max ? d.wind_gusts_10m_max[0] : null,
      windDir: d.wind_direction_10m_dominant ? d.wind_direction_10m_dominant[0] : null,
      waveM: mx && mx.daily && mx.daily.wave_height_max ? mx.daily.wave_height_max[0] : null,
    });
  } catch (err) {
    console.error("Weather fetch failed", err);
    return (weatherCache[key] = { status: "error", checkedAt: Date.now() });
  }
}

// A day that's too far out today won't be too far out forever, so
// "unavailable"/"error" results expire and get rechecked — otherwise a tab
// left open across days would keep showing a stale "not available yet"
// long after the forecast actually opened up.
const WEATHER_STALE_MS = 30 * 60 * 1000;

// Returns whatever's in the cache right now, kicking off a fetch (and a
// re-render once it lands) the first time a given spot/date is seen, or
// once a stale non-final result has expired.
function getWeatherSync(lat, lng, dateStr) {
  const key = weatherKey(lat, lng, dateStr);
  const cached = weatherCache[key];
  const stale =
    cached &&
    (cached.status === "unavailable" || cached.status === "error") &&
    Date.now() - cached.checkedAt > WEATHER_STALE_MS;
  if (!cached || stale) {
    delete weatherCache[key];
    fetchWeather(lat, lng, dateStr).then(() => render());
  }
  return weatherCache[key];
}

function weatherHtmlFor(day) {
  const stop = day.stops[0];
  if (!stop || !/^\d{4}-\d{2}-\d{2}$/.test(day.date || "")) return "";

  const w = getWeatherSync(stop.lat, stop.lng, day.date);
  if (!w || w.status === "loading") {
    return `<span class="day-weather loading">⏳ loading forecast…</span>`;
  }
  if (w.status === "unavailable") {
    return `<span class="day-weather muted">Forecast opens ~16 days before this date</span>`;
  }
  if (w.status === "error") {
    return `<span class="day-weather muted">Weather unavailable</span>`;
  }
  const wind = w.windKn != null ? `${Math.round(w.windKn)}kn ${windDirLabel(w.windDir)}` : "";
  const wave = w.waveM != null ? ` · 🌊${w.waveM.toFixed(1)}m` : "";
  const title =
    `Wind ${Math.round(w.windKn ?? 0)}kn (gusts ${Math.round(w.gustKn ?? 0)}kn) from ${windDirLabel(w.windDir)}` +
    (w.waveM != null ? `, waves ${w.waveM.toFixed(1)}m` : "");
  return `<span class="day-weather" title="${escapeHtml(title)}">${WEATHER_CODES[w.code] || "〰️"} ${wind}${wave}</span>`;
}

// ---------------------------------------------------------------------------
// Sidebar / itinerary
// ---------------------------------------------------------------------------

function renderItinerary() {
  const list = document.getElementById("dayList");
  list.innerHTML = "";
  stopListItems = {};
  let globalSeq = 0;

  trip.days.forEach((day, di) => {
    const card = document.createElement("div");
    card.className = "day-card";

    const header = document.createElement("div");
    header.className = "day-header";
    const nm = dayDistanceNm(trip.days, di);
    const estimate = nm > 0 ? `≈ ${formatDuration(nm / currentSpeedKnots())} · ${nm.toFixed(1)} nm` : "";
    const weatherHtml = weatherHtmlFor(day);
    header.innerHTML = `
      <div class="day-header-row">
        <input class="day-title" value="${escapeHtml(day.title)}" />
        <button class="del-day" title="Delete day">✕</button>
      </div>
      <div class="day-header-row">
        <input class="day-date" type="date" value="${escapeHtml(day.date || "")}" />
        ${estimate ? `<span class="day-estimate" title="Estimated underway time at ${currentSpeedKnots()} kn">${estimate}</span>` : ""}
      </div>
      ${weatherHtml ? `<div class="day-header-row">${weatherHtml}</div>` : ""}
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
      globalSeq++;
      const li = document.createElement("li");
      li.className = "stop-item";
      const t = STOP_TYPES[stop.type] || STOP_TYPES.sight;
      li.innerHTML = `
        <span class="stop-seq-badge">${globalSeq}</span>
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
      li.addEventListener("mouseenter", () => highlightStop(stop.id, true));
      li.addEventListener("mouseleave", () => highlightStop(stop.id, false));
      stopListItems[stop.id] = li;
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
  document.getElementById("boatType").value = trip.boatType || "catamaran";
  document.getElementById("boatSpeed").value = currentSpeedKnots();
  const totalNm = totalTripNm(trip.days);
  document.getElementById("boatTotalEstimate").textContent =
    totalNm > 0 ? `Estimated total underway time: ${formatDuration(totalNm / currentSpeedKnots())} over ${totalNm.toFixed(1)} nm` : "";
  populateDaySelect();
}

function renderNotes() {
  const list = document.getElementById("notesList");
  list.innerHTML = "";
  (trip.notes || []).forEach((note, i) => {
    const row = document.createElement("div");
    row.className = "note-item";
    row.innerHTML = `
      <textarea rows="3" placeholder="Note ${i + 1}...">${escapeHtml(note.text)}</textarea>
      <button class="icon-btn note-delete" title="Delete note">✕</button>
    `;
    row.querySelector("textarea").addEventListener("change", (e) => {
      note.text = e.target.value;
      commit();
    });
    row.querySelector(".note-delete").addEventListener("click", () => {
      trip.notes = trip.notes.filter((n) => n.id !== note.id);
      commit();
    });
    list.appendChild(row);
  });
}

function populateDaySelect() {
  const sel = document.getElementById("stopDay");
  sel.innerHTML = trip.days.map((d) => `<option value="${d.id}">${escapeHtml(d.title)}</option>`).join("");
}

function render() {
  renderItinerary();
  renderNotes();
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
    const sidebar = document.getElementById("sidebar");
    // "open" drives the mobile slide-over drawer, "collapsed" drives the
    // desktop width collapse. Pick the one that actually matters for the
    // current viewport rather than toggling both — relying on the other
    // being "harmlessly inert" isn't worth the risk.
    const isMobileLayout = window.matchMedia("(max-width: 820px)").matches;
    sidebar.classList.toggle(isMobileLayout ? "open" : "collapsed");
    setTimeout(() => map.invalidateSize(), 220);
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

  document.getElementById("addNoteBtn").addEventListener("click", () => {
    if (!trip.notes) trip.notes = [];
    trip.notes.push({ id: uid(), text: "" });
    commit();
  });

  document.getElementById("boatType").addEventListener("change", (e) => {
    trip.boatType = e.target.value;
    trip.boatSpeedKnots = BOAT_PRESETS[trip.boatType].knots;
    commit();
  });

  document.getElementById("boatSpeed").addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v) && v > 0) trip.boatSpeedKnots = v;
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

window.addEventListener("DOMContentLoaded", async () => {
  initFirebase();
  initMap();
  wireUi();
  wireLanding();

  if (new URLSearchParams(location.search).get("session")) {
    showLanding();
    await applyShareLinkPrefill();
    return;
  }

  const remembered = getRemembered();
  const ids = Object.keys(remembered).sort((a, b) => remembered[b].ts - remembered[a].ts);
  if (ids.length > 0) {
    enterSession(ids[0], remembered[ids[0]].name);
  } else {
    showLanding();
  }

  // Re-render on a timer and whenever the tab regains focus, so a session
  // left open across days picks up newly-in-range weather forecasts
  // without needing a manual reload.
  setInterval(() => {
    if (currentSessionId) render();
  }, 30 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentSessionId) render();
  });
});
