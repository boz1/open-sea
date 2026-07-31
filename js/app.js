// ---------------------------------------------------------------------------
// Fethiye Boat Trip planner
// Single shared document ({days:[{stops:[...]}]}) synced live via Firestore
// when firebase-config.js has real keys; otherwise falls back to
// localStorage (single device only).
// ---------------------------------------------------------------------------

const STOP_TYPES = {
  anchorage: { icon: "⚓", color: "#106a8c" },
  swim:      { icon: "🏊", color: "#4fa3c4" },
  sight:     { icon: "🏛️", color: "#e0674b" },
  town:      { icon: "🏘️", color: "#8a6d3b" },
  food:      { icon: "🍽️", color: "#5a8a4b" },
};

const DEFAULT_TRIP = {
  title: "Fethiye Boat Trip",
  days: [
    {
      id: "day-1", title: "Fethiye → Göcek Islands", date: "",
      stops: [
        { id: "s1", name: "Fethiye Harbor (departure)", lat: 36.6217, lng: 29.1164, time: "09:00", type: "town", notes: "" },
        { id: "s2", name: "Yassıca Adaları (swim stop)", lat: 36.7213, lng: 29.0119, time: "", type: "swim", notes: "" },
        { id: "s3", name: "Domuz Adası (overnight anchorage)", lat: 36.7423, lng: 28.9927, time: "", type: "anchorage", notes: "" },
      ],
    },
    {
      id: "day-2", title: "Göcek → Gemiler Island", date: "",
      stops: [
        { id: "s4", name: "Soğuksu (Cold Water Bay)", lat: 36.7736, lng: 28.9633, time: "", type: "swim", notes: "" },
        { id: "s5", name: "Gemiler Island (sunken city / St. Nicholas)", lat: 36.5589, lng: 29.1364, time: "", type: "sight", notes: "" },
      ],
    },
    {
      id: "day-3", title: "Butterfly Valley & Ölüdeniz", date: "",
      stops: [
        { id: "s6", name: "Butterfly Valley", lat: 36.5427, lng: 29.4991, time: "", type: "sight", notes: "" },
        { id: "s7", name: "Ölüdeniz / Blue Lagoon", lat: 36.5501, lng: 29.1197, time: "", type: "swim", notes: "" },
      ],
    },
    {
      id: "day-4", title: "Kabak & Faralya", date: "",
      stops: [
        { id: "s8", name: "Kabak Bay", lat: 36.5183, lng: 29.4694, time: "", type: "anchorage", notes: "" },
      ],
    },
    {
      id: "day-5", title: "Return to Fethiye", date: "",
      stops: [
        { id: "s9", name: "Fethiye Old Town / Amyntas Rock Tombs", lat: 36.6252, lng: 29.1173, time: "", type: "sight", notes: "" },
        { id: "s10", name: "Fethiye Harbor (return)", lat: 36.6217, lng: 29.1164, time: "", type: "town", notes: "" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Data store: Firestore if configured, else localStorage
// ---------------------------------------------------------------------------

const LOCAL_KEY = "fethiye-trip-data";
const usingFirebase = typeof firebaseConfig !== "undefined" && firebaseConfig.apiKey && firebaseConfig.apiKey !== "YOUR_API_KEY";

let db = null;
let tripRef = null;

function setSyncStatus(state) {
  const el = document.getElementById("syncStatus");
  el.className = "sync-status " + state;
  el.title = { live: "Live sync with Firebase", offline: "Local only — friends won't see edits (set up Firebase, see README)", pending: "Saving…" }[state] || "";
}

function initStore(onData) {
  if (usingFirebase) {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    tripRef = db.collection("trips").doc("fethiye");

    tripRef.onSnapshot((doc) => {
      if (doc.exists) {
        onData(doc.data());
      } else {
        tripRef.set(DEFAULT_TRIP).then(() => onData(DEFAULT_TRIP));
      }
      setSyncStatus("live");
    }, (err) => {
      console.error("Firestore error", err);
      setSyncStatus("offline");
    });
  } else {
    setSyncStatus("offline");
    const raw = localStorage.getItem(LOCAL_KEY);
    onData(raw ? JSON.parse(raw) : DEFAULT_TRIP);
    window.addEventListener("storage", (e) => {
      if (e.key === LOCAL_KEY && e.newValue) onData(JSON.parse(e.newValue));
    });
  }
}

function saveTrip(trip) {
  trip._updatedAt = Date.now();
  if (usingFirebase) {
    setSyncStatus("pending");
    tripRef.set(trip).then(() => setSyncStatus("live")).catch(() => setSyncStatus("offline"));
  } else {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(trip));
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let trip = DEFAULT_TRIP;
let map, markerLayer;
let addStopMode = false;
let editingContext = null; // { dayId, stopId } or { dayId } for new stop

function uid() {
  return "id-" + Math.random().toString(36).slice(2, 10);
}

function commit() {
  saveTrip(trip);
  render();
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
        (stop.notes ? `<br>${escapeHtml(stop.notes)}` : "")
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
      <input class="day-title" value="${escapeHtml(day.title)}" />
      <input class="day-date" type="text" placeholder="date" value="${escapeHtml(day.date || "")}" />
      <button class="del-day" title="Delete day">✕</button>
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
          ${stop.notes ? `<div class="stop-notes">${escapeHtml(stop.notes)}</div>` : ""}
        </div>
        <div class="stop-reorder">
          <button class="up" title="Move up" ${si === 0 ? "disabled" : ""}>▲</button>
          <button class="down" title="Move down" ${si === day.stops.length - 1 ? "disabled" : ""}>▼</button>
        </div>
      `;
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

  document.getElementById("tripTitle").value = trip.title || "Fethiye Boat Trip";
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
// Modal
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
    populateDaySelect();
    document.getElementById("stopDay").value = day.id;
  }

  overlay.classList.remove("hidden");
  overlay.dataset.pendingLat = ctx.lat ?? "";
  overlay.dataset.pendingLng = ctx.lng ?? "";
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
  const overlay = document.getElementById("modalOverlay");

  const targetDay = trip.days.find((d) => d.id === dayId);

  if (!editingContext.stopId) {
    const lat = parseFloat(overlay.dataset.pendingLat);
    const lng = parseFloat(overlay.dataset.pendingLng);
    targetDay.stops.push({ id: uid(), name, lat, lng, time, type, notes });
  } else {
    const originDay = trip.days.find((d) => d.id === editingContext.dayId);
    const idx = originDay.stops.findIndex((s) => s.id === editingContext.stopId);
    const stop = originDay.stops[idx];
    stop.name = name;
    stop.time = time;
    stop.type = type;
    stop.notes = notes;
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
  initMap();
  wireUi();
  initStore((data) => {
    trip = data;
    if (!trip.days) trip.days = [];
    render();
  });
});
