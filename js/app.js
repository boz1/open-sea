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
  generalNotes:
    "GÖCEK MOORING (TONOZ) SYSTEM — active since 2026: to protect the seagrass, the coves inside Göcek now use fixed mooring buoys instead of free anchoring. 1250 TL/night. Reservations open 1 month ahead; you're assigned a buoy sized to your boat (or told none is free). On arrival, call the mooring crew on VHF channel 71 — they tie you to the buoy and run your stern lines ashore too; call them again when leaving. Max 3 nights per buoy. Check-in/out like a hotel: in from 13:00, out by 12:00 next day. Crew on call 24/7. Source: deria.gov.tr",
  days: [
    {
      id: "day-1", title: "Depart Fethiye → Tersane Koyu", date: "15.08.2026",
      stops: [
        { id: "s1", name: "Fethiye Harbor (departure)", lat: 36.6217, lng: 29.1164, time: "", type: "town", notes: "" },
        { id: "s2", name: "Tersane Koyu", lat: 36.6684, lng: 28.9180, time: "", type: "anchorage", notes: "First night anchorage, next to Tersane Adası (Dockyard Island)." },
      ],
    },
    {
      id: "day-2", title: "Bedri Rahmi Koyu", date: "16.08.2026",
      stops: [
        { id: "s3", name: "Bedri Rahmi Koyu", lat: 36.715, lng: 28.830, time: "", type: "anchorage",
          notes: "⚠ Approximate pin — please confirm/reposition once you have exact bearings. To do: Bedri Rahmi Eyüboğlu rock paintings + Kral Mezarı (rock-cut king's tomb). Dinner: Miori — https://maps.app.goo.gl/RsWEk475oTUy6Xi26" },
      ],
    },
    {
      id: "day-3", title: "Hamam Koyu (Kleopatra)", date: "17.08.2026",
      stops: [
        { id: "s4", name: "Hamam Koyu — Kleopatra", lat: 36.7257, lng: 28.8131, time: "", type: "swim",
          notes: "Cleopatra's bath / hot-spring swim stop (matched to \"Kapıkargın Kükürt Kaplıcası\" — double-check on arrival)." },
      ],
    },
    {
      id: "day-4", title: "Sarsala Koyu", date: "18.08.2026",
      stops: [
        { id: "s5", name: "Sarsala Koyu", lat: 36.6631, lng: 28.8499, time: "", type: "anchorage",
          notes: "Dinner: Alperen Gözde Restaurant, Küçük Sarsala ☎ 0543 384 76 12 — https://maps.app.goo.gl/Qxsu9uMdsj592iZa6\nAlso consider Adaia Göcek — https://maps.app.goo.gl/Sx3hT6oy8eixZSJ6A (exact bay unconfirmed)." },
      ],
    },
    {
      id: "day-5", title: "Büyük Ova Koyu", date: "19.08.2026",
      stops: [
        { id: "s6", name: "Büyük Ova Koyu", lat: 36.703168, lng: 28.898972, time: "", type: "anchorage", notes: "" },
      ],
    },
    {
      id: "day-6", title: "Gemiler Adası", date: "20.08.2026",
      stops: [
        { id: "s7", name: "Gemiler Adası", lat: 36.5533, lng: 29.0699, time: "", type: "sight",
          notes: "Sunken city / St. Nicholas ruins. Tesis yok (no facilities on the island) — bring water, snacks, sun cover." },
      ],
    },
    {
      id: "day-7", title: "Free day — revisit a favourite bay", date: "21.08.2026",
      stops: [],
    },
    {
      id: "day-8", title: "Return to Fethiye", date: "22.08.2026",
      stops: [
        { id: "s8", name: "Fethiye Harbor (return)", lat: 36.6217, lng: 29.1164, time: "", type: "town", notes: "" },
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

  document.getElementById("tripTitle").value = trip.title || "Fethiye Boat Trip";
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
  initMap();
  wireUi();
  initStore((data) => {
    trip = data;
    if (!trip.days) trip.days = [];
    render();
  });
});
