const HOME_CENTRE = [51.460834, -0.097488];
const STORAGE_KEY = "se24-field-cards-v3";
const GEOFENCE_METERS = 25;
const MAX_LOCATION_ACCURACY_METERS = 40;
const MAX_LOCATION_AGE_MS = 120000;
const rarityRank = {
  Everyday: 1,
  "Useful find": 2,
  "Good find": 3,
  "Prize find": 4,
  Landmark: 5
};
const rarityColors = {
  Everyday: "#66746f",
  "Useful find": "#34785f",
  "Good find": "#277981",
  "Prize find": "#b57924",
  Landmark: "#6b5d8d"
};
const familyGlyphs = {
  canopy: "T",
  memory: "M",
  street: "S",
  culture: "C",
  movement: "W"
};

let objects = [];
let selectedId = null;
let activeView = "nearby";
let activeFilter = "all";
let mapMode = false;
let collected = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
let currentPosition = null;
let locationError = null;
let userLocationLayer = null;

const map = L.map("map", {
  zoomControl: false
}).setView(HOME_CENTRE, 15);

L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
L.circleMarker(HOME_CENTRE, {
  radius: 8,
  color: "#17211d",
  fillColor: "#fffaf0",
  fillOpacity: 1,
  weight: 3
}).bindTooltip("SE24 0AQ", { direction: "top" }).addTo(map);

const content = document.querySelector("#content");
const cardTemplate = document.querySelector("#cardTemplate");
const collectedCount = document.querySelector("#collectedCount");
const collectionKinds = document.querySelector("#collectionKinds");
const collectionValue = document.querySelector("#collectionValue");
const mapStatus = document.querySelector("#mapStatus");

fetch("data/se24-objects.json")
  .then((response) => response.json())
  .then((payload) => {
    objects = payload.objects.map(normaliseGameObject);
    selectedId = objects[0]?.id || null;
    renderAll();
    refreshMapSize();
    startLocationWatch();
  })
  .catch(() => {
    content.innerHTML = '<div class="empty-state">Could not load the SE24 field data.</div>';
  });

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    activeView = button.dataset.view;
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    renderContent();
  });
});

document.querySelectorAll(".chip").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll(".chip").forEach((chip) => chip.classList.toggle("active", chip === button));
    renderAll();
  });
});

document.querySelector("#locateButton").addEventListener("click", () => {
  map.setView(HOME_CENTRE, 17);
  refreshMapSize();
});

document.querySelector("#questButton").addEventListener("click", () => {
  const next = getNextHunt();
  if (next) focusObject(next.id);
});

document.querySelector("#mapModeButton").addEventListener("click", () => {
  mapMode = !mapMode;
  document.querySelector(".shell").classList.toggle("map-mode", mapMode);
  document.querySelector("#mapModeButton").textContent = mapMode ? "List" : "Map";
  refreshMapSize();
});

map.on("locationfound", (event) => {
  L.circleMarker(event.latlng, {
    radius: 7,
    color: "#17211d",
    fillColor: "#fffaf0",
    fillOpacity: 1,
    weight: 3
  }).addTo(map);
});

window.addEventListener("resize", () => {
  refreshMapSize();
});

window.addEventListener("orientationchange", refreshMapSize);
window.addEventListener("load", refreshMapSize);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshMapSize();
});

function normaliseGameObject(object) {
  const game = object.game || {};
  return {
    ...object,
    game: {
      rarity: game.rarity || object.tier || "Everyday",
      rarityRank: game.rarityRank || rarityRank[object.tier] || 1,
      value: game.value || object.totalScore || 1,
      kind: game.kind || object.typeLabel || object.type,
      form: game.form || object.familyLabel,
      why: game.why || object.cardText || "A real object at this exact spot.",
      spot: game.spot || "Open the map, walk to the marker, and check the object against the name.",
      hunt: game.hunt || object.escalationHint || "Find another item from the same category.",
      badges: game.badges || object.traits || []
    }
  };
}

function renderAll() {
  renderMarkers();
  renderStats();
  renderContent();
  renderMapStatus();
  refreshMapSize();
}

function filteredObjects() {
  const pool = activeFilter === "all" ? objects : objects.filter((object) => object.family === activeFilter);
  return [...pool].sort((a, b) => {
    if (collected.has(a.id) !== collected.has(b.id)) return collected.has(a.id) ? 1 : -1;
    return proximityBand(a) - proximityBand(b) || homeDistance(a) - homeDistance(b) || b.game.value - a.game.value;
  });
}

function renderMarkers() {
  markerLayer.clearLayers();
  filteredObjects().forEach((object) => {
    const marker = L.marker([object.lat, object.lon], { icon: markerIcon(object) });
    marker.bindTooltip(`${object.name} · ${object.game.rarity}`, { direction: "top" });
    marker.bindPopup(markerPopup(object));
    marker.on("click", () => selectObjectFromMap(object.id));
    markerLayer.addLayer(marker);
  });
}

function selectObjectFromMap(id) {
  const object = objects.find((item) => item.id === id);
  if (!object) return;
  selectedId = id;
  activeView = "nearby";
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === activeView));
  renderStats();
  renderContent();
  renderMapStatus();
  L.popup().setLatLng([object.lat, object.lon]).setContent(markerPopup(object)).openOn(map);
}

function markerPopup(object) {
  return `
    <strong>${escapeHtml(object.name)}</strong>
    <span>${escapeHtml(object.game.kind)} · +${object.game.value}</span>
    <small>${object.distanceFromHome}m from SE24 0AQ</small>
  `;
}

function markerIcon(object) {
  const color = rarityColors[object.game.rarity] || rarityColors.Everyday;
  const collectedClass = collected.has(object.id) ? " marker-collected" : "";
  return L.divIcon({
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    html: `<div class="marker-pin${collectedClass}" style="background:${color}"><span>${familyGlyphs[object.family] || "?"}</span></div>`
  });
}

function renderStats() {
  const found = objects.filter((object) => collected.has(object.id));
  collectedCount.textContent = found.length;
  collectionKinds.textContent = new Set(found.map((object) => object.game.kind)).size;
  collectionValue.textContent = found.reduce((sum, object) => sum + object.game.value, 0).toLocaleString();
}

function renderContent() {
  content.innerHTML = "";
  if (activeView === "sets") {
    renderSets();
    return;
  }
  const pool = activeView === "collection"
    ? filteredObjects().filter((object) => collected.has(object.id))
    : visibleNearbyObjects();

  if (!pool.length) {
    content.innerHTML = '<div class="empty-state">Nothing logged yet. Pick a nearby item and log it.</div>';
    return;
  }
  pool.forEach((object) => content.appendChild(renderCard(object)));
}

function renderMapStatus() {
  const object = objects.find((item) => item.id === selectedId);
  if (!object) {
    mapStatus.innerHTML = "";
    return;
  }
  mapStatus.innerHTML = `
    <strong>${escapeHtml(object.name)}</strong>
    <span>+${object.game.value} · ${escapeHtml(object.game.kind)} · ${object.distanceFromHome}m away</span>
    <small>${escapeHtml(object.game.hunt)}</small>
  `;
}

function visibleNearbyObjects() {
  const deck = deckObjects();
  const visible = deck.slice(0, 28);
  const selected = objects.find((object) => object.id === selectedId);
  if (selected && !visible.some((object) => object.id === selected.id)) {
    return [selected, ...visible.slice(0, 27)];
  }
  return visible;
}

function renderCard(object) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  node.classList.toggle("selected", object.id === selectedId);
  node.querySelector(".family").textContent = object.game.form;
  node.querySelector(".rarity").textContent = object.game.rarity;
  node.querySelector(".rarity").style.background = rarityColors[object.game.rarity] || rarityColors.Everyday;
  node.querySelector(".worth").textContent = `+${object.game.value}`;
  node.querySelector("h2").textContent = object.name;
  node.querySelector(".kind").textContent = object.game.kind;
  node.querySelector(".why").textContent = object.game.why;
  node.querySelector(".spot").textContent = object.game.spot;
  node.querySelector(".hunt").textContent = object.game.hunt;
  node.querySelector(".range").textContent = rangeText(object);

  const traits = node.querySelector(".traits");
  object.game.badges.slice(0, 5).forEach((trait) => {
    const chip = document.createElement("span");
    chip.className = "trait";
    chip.textContent = trait;
    traits.appendChild(chip);
  });

  const collect = node.querySelector(".collect");
  const isCollected = collected.has(object.id);
  const collectState = canCollect(object);
  collect.classList.toggle("done", isCollected);
  collect.disabled = !isCollected && !collectState.allowed;
  collect.textContent = isCollected ? "Logged" : collectState.label;
  collect.title = isCollected ? "Already logged" : collectState.reason;
  collect.addEventListener("click", () => logFind(object.id));
  node.querySelector(".focus").addEventListener("click", () => focusObject(object.id));
  return node;
}

function deckObjects() {
  if (activeFilter !== "all") return filteredObjects();
  const familyOrder = ["canopy", "memory", "street", "culture", "movement"];
  const buckets = new Map(familyOrder.map((family) => [family, []]));
  filteredObjects().forEach((object) => buckets.get(object.family)?.push(object));
  familyOrder.forEach((family) => buckets.set(family, diversifyByKind(buckets.get(family) || [])));

  const mixed = [];
  let added = true;
  while (added) {
    added = false;
    familyOrder.forEach((family) => {
      const next = buckets.get(family)?.shift();
      if (next) {
        mixed.push(next);
        added = true;
      }
    });
  }
  return mixed;
}

function diversifyByKind(items) {
  const firstByKind = [];
  const rest = [];
  const seen = new Set();
  items.forEach((item) => {
    if (seen.has(item.game.kind)) {
      rest.push(item);
    } else {
      seen.add(item.game.kind);
      firstByKind.push(item);
    }
  });
  return [...firstByKind, ...rest];
}

function renderSets() {
  const sets = new Map();
  objects.forEach((object) => {
    object.sets.forEach((setName) => {
      if (!sets.has(setName)) sets.set(setName, []);
      sets.get(setName).push(object);
    });
  });

  [...sets.entries()]
    .sort((a, b) => countCollected(b[1]) - countCollected(a[1]) || bestValue(b[1]) - bestValue(a[1]))
    .forEach(([name, members]) => {
      const found = countCollected(members);
      const card = document.createElement("article");
      card.className = "set-card";
      card.innerHTML = `
        <h2>${name}</h2>
        <p>${setDescription(name, members)}</p>
        <progress value="${found}" max="${members.length}"></progress>
        <p>${found}/${members.length} logged · next: ${bestUncollectedName(members)}</p>
      `;
      content.appendChild(card);
    });
}

function countCollected(members) {
  return members.filter((object) => collected.has(object.id)).length;
}

function bestValue(members) {
  return Math.max(...members.map((object) => object.game.value));
}

function bestUncollectedName(members) {
  const object = members.filter((item) => !collected.has(item.id)).sort((a, b) => proximityBand(a) - proximityBand(b) || homeDistance(a) - homeDistance(b) || b.game.value - a.game.value)[0];
  return object ? `${object.name} (+${object.game.value})` : "complete";
}

function setDescription(name, members) {
  const kinds = [...new Set(members.map((object) => object.game.kind))].slice(0, 4).join(", ");
  return `${members.length} items: ${kinds}.`;
}

function logFind(id) {
  if (collected.has(id)) return;
  const object = objects.find((item) => item.id === id);
  if (!object || !canCollect(object).allowed) return;
  collected.add(id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...collected]));
  renderAll();
}

function focusObject(id) {
  const object = objects.find((item) => item.id === id);
  if (!object) return;
  selectedId = id;
  map.setView([object.lat, object.lon], Math.max(map.getZoom(), 17), { animate: true });
  activeView = "nearby";
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === activeView));
  renderAll();
  requestAnimationFrame(() => {
    document.querySelector(".card.selected")?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function getNextHunt() {
  const selected = objects.find((object) => object.id === selectedId);
  const candidates = objects.filter((object) => !collected.has(object.id));
  if (!selected) return candidates.sort((a, b) => proximityBand(a) - proximityBand(b) || homeDistance(a) - homeDistance(b) || b.game.value - a.game.value)[0];
  const nearby = candidates.filter((object) => distance(selected, object) <= 650 || homeDistance(object) <= 650);
  const strongerSameFamily = candidates
    .filter((object) => nearby.includes(object) && object.family === selected.family && object.game.value > selected.game.value)
    .sort((a, b) => distance(selected, a) - distance(selected, b) || b.game.value - a.game.value)[0];
  return strongerSameFamily || nearby.sort((a, b) => homeDistance(a) - homeDistance(b) || b.game.value - a.game.value)[0] || candidates.sort((a, b) => homeDistance(a) - homeDistance(b))[0];
}

function distance(a, b) {
  const lat = (a.lat - b.lat) * 111320;
  const lon = (a.lon - b.lon) * 69400;
  return Math.sqrt(lat * lat + lon * lon);
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    locationError = "GPS is not available in this browser.";
    renderAll();
    return;
  }
  if (!window.isSecureContext) {
    locationError = "GPS needs HTTPS on iPhone. Local HTTP can show the map but cannot verify finds.";
    renderAll();
    return;
  }
  navigator.geolocation.watchPosition(
    (position) => {
      currentPosition = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: position.coords.accuracy,
        timestamp: position.timestamp
      };
      locationError = null;
      renderUserLocation();
      renderStats();
      renderContent();
      renderMapStatus();
    },
    (error) => {
      locationError = error.message || "GPS permission denied.";
      renderContent();
      renderMapStatus();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 12000
    }
  );
}

function renderUserLocation() {
  if (!currentPosition) return;
  if (userLocationLayer) userLocationLayer.remove();
  userLocationLayer = L.layerGroup([
    L.circle([currentPosition.lat, currentPosition.lon], {
      radius: currentPosition.accuracy,
      color: "#277981",
      fillColor: "#277981",
      fillOpacity: 0.08,
      weight: 1
    }),
    L.circleMarker([currentPosition.lat, currentPosition.lon], {
      radius: 6,
      color: "#17211d",
      fillColor: "#277981",
      fillOpacity: 1,
      weight: 2
    })
  ]).addTo(map);
}

function canCollect(object) {
  if (collected.has(object.id)) {
    return { allowed: false, label: "Logged", reason: "Already logged" };
  }
  if (locationError) {
    const label = locationError.includes("HTTPS") ? "HTTPS needed" : "GPS needed";
    return { allowed: false, label, reason: locationError };
  }
  if (!currentPosition) {
    return { allowed: false, label: "Finding GPS", reason: "Waiting for current location." };
  }
  if (Date.now() - currentPosition.timestamp > MAX_LOCATION_AGE_MS) {
    return { allowed: false, label: "GPS stale", reason: "Move outside or refresh location." };
  }
  if (currentPosition.accuracy > MAX_LOCATION_ACCURACY_METERS) {
    return { allowed: false, label: "Weak GPS", reason: `GPS accuracy is ${Math.round(currentPosition.accuracy)}m; needs ${MAX_LOCATION_ACCURACY_METERS}m or better.` };
  }
  const metersAway = distance(currentPosition, object);
  if (metersAway > GEOFENCE_METERS) {
    return { allowed: false, label: `${Math.round(metersAway)}m away`, reason: `Move within ${GEOFENCE_METERS}m to log this item.` };
  }
  return { allowed: true, label: `Log +${object.game.value}`, reason: `Within ${Math.round(metersAway)}m.` };
}

function rangeText(object) {
  if (collected.has(object.id)) return "Logged.";
  if (locationError) return locationError;
  if (!currentPosition) return `Move within ${GEOFENCE_METERS}m to log. Waiting for GPS.`;
  const metersAway = Math.round(distance(currentPosition, object));
  const accuracy = Math.round(currentPosition.accuracy);
  if (currentPosition.accuracy > MAX_LOCATION_ACCURACY_METERS) {
    return `GPS accuracy ${accuracy}m. Need ${MAX_LOCATION_ACCURACY_METERS}m or better to log.`;
  }
  return `${metersAway}m from you. Log when within ${GEOFENCE_METERS}m.`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function refreshMapSize() {
  [0, 80, 220, 500].forEach((delay) => {
    setTimeout(() => map.invalidateSize(), delay);
  });
}

function homeDistance(object) {
  return object.distanceFromHome || distance({ lat: HOME_CENTRE[0], lon: HOME_CENTRE[1] }, object);
}

function proximityBand(object) {
  const d = homeDistance(object);
  if (d <= 250) return 0;
  if (d <= 500) return 1;
  if (d <= 800) return 2;
  return 3;
}
