const HOME = { lat: 51.460834, lon: -0.097488, label: "SE24 0AQ" };
const STORAGE_KEY = "se24-field-cards-v4";
const COLLECT_RADIUS_METERS = 5;
const MAX_LOCATION_ACCURACY_METERS = 35;
const MAX_LOCATION_AGE_MS = 120000;
const MAX_TARGETS = 3;
const MIN_TARGETS = 3;
const FIELD_MAX_DISTANCE_METERS = 2500;
const MAX_FIELD_OBJECTS = 220;

const SIGNAL_MODES = [
  { name: "Everyday", threshold: 0.42 },
  { name: "Notable", threshold: 0.78 },
  { name: "Rare", threshold: 1.35 },
  { name: "Mythic", threshold: 2.25 }
];

const FAMILY_LABELS = {
  canopy: "Tree",
  memory: "History",
  street: "Street",
  culture: "Place",
  movement: "Transport"
};

const TYPE_SYMBOLS = [
  { match: "tree", symbol: "♣" },
  { match: "postbox", symbol: "✉" },
  { match: "library", symbol: "▣" },
  { match: "art", symbol: "✦" },
  { match: "sculpture", symbol: "✦" },
  { match: "mural", symbol: "✦" },
  { match: "memorial", symbol: "✚" },
  { match: "plaque", symbol: "✚" },
  { match: "crossing", symbol: "⇄" },
  { match: "bus", symbol: "⬢" },
  { match: "station", symbol: "⬢" },
  { match: "cafe", symbol: "◉" },
  { match: "place", symbol: "▣" }
];

const FAMILY_SYMBOLS = {
  canopy: "♣",
  memory: "✚",
  street: "●",
  culture: "▣",
  movement: "⬢"
};

let objects = [];
let activeView = "nearby";
let selectedId = null;
let collected = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
let currentPosition = null;
let locationError = null;
let heading = 0;
let headingEnabled = false;
let signalModeIndex = Math.min(3, Math.max(0, Number(localStorage.getItem("se24-signal-mode") || "0")));

const targetCount = document.querySelector("#targetCount");
const collectedCount = document.querySelector("#collectedCount");
const collectionValue = document.querySelector("#collectionValue");
const locationStatus = document.querySelector("#locationStatus");
const headingStatus = document.querySelector("#headingStatus");
const targetLayer = document.querySelector("#targetLayer");
const signalList = document.querySelector("#signalList");
const focusCard = document.querySelector("#focusCard");
const collectedSummary = document.querySelector("#collectedSummary");
const collectedList = document.querySelector("#collectedList");
const setsList = document.querySelector("#setsList");
const headingButton = document.querySelector("#headingButton");
const signalRange = document.querySelector("#signalRange");
const signalMode = document.querySelector("#signalMode");
const targetTemplate = document.querySelector("#targetTemplate");

signalRange.value = String(signalModeIndex);

fetch("data/se24-objects.json")
  .then((response) => response.json())
  .then((payload) => {
    objects = payload.objects.map(normaliseGameObject);
    selectedId = getStrongSignals(getFieldObjects())[0]?.object.id || null;
    renderAll();
    startLocationWatch();
  })
  .catch(() => {
    focusCard.innerHTML = '<div class="empty-card">Could not load the SE24 field data.</div>';
  });

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    activeView = button.dataset.view;
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${activeView}View`));
    document.querySelector("h1").textContent = button.textContent;
    renderAll();
  });
});

headingButton.addEventListener("click", requestHeading);
signalRange.addEventListener("input", () => {
  signalModeIndex = Number(signalRange.value);
  localStorage.setItem("se24-signal-mode", String(signalModeIndex));
  renderAll();
});

function normaliseGameObject(object) {
  const game = object.game || {};
  return {
    ...object,
    game: {
      rarity: game.rarity || object.tier || "Everyday",
      value: game.value || object.totalScore || 1,
      kind: game.kind || object.typeLabel || object.type,
      form: game.form || object.familyLabel || FAMILY_LABELS[object.family] || "Object",
      why: game.why || "A real object at this exact spot.",
      badges: game.badges || object.traits || []
    }
  };
}

function renderAll() {
  const fieldObjects = getFieldObjects();
  const strongSignals = getStrongSignals(fieldObjects);
  if (!selectedId || collected.has(selectedId)) {
    selectedId = strongSignals[0]?.object.id || fieldObjects[0]?.object.id || null;
  }
  renderStats(fieldObjects, strongSignals);
  renderLocationStatus();
  renderCompass(fieldObjects, strongSignals);
  renderFocus(fieldObjects, strongSignals);
  renderCollected();
  renderSets();
}

function renderStats(fieldObjects, strongSignals) {
  const found = objects.filter((object) => collected.has(object.id));
  targetCount.textContent = strongSignals.length || fieldObjects.filter((entry) => entry.opacity >= 0.12).length;
  collectedCount.textContent = found.length;
  collectionValue.textContent = found.reduce((sum, object) => sum + object.game.value, 0).toLocaleString();
}

function renderLocationStatus() {
  if (locationError) {
    locationStatus.textContent = locationError.includes("HTTPS") ? "HTTPS needed" : "GPS unavailable";
  } else if (!currentPosition) {
    locationStatus.textContent = "Using SE24 start";
  } else {
    locationStatus.textContent = `GPS ${Math.round(currentPosition.accuracy)}m`;
  }
  headingStatus.textContent = headingEnabled ? "Live compass" : "North-up";
  signalMode.textContent = SIGNAL_MODES[signalModeIndex].name;
}

function renderCompass(fieldObjects, strongSignals) {
  targetLayer.innerHTML = "";
  signalList.innerHTML = "";
  fieldObjects.forEach((entry) => {
    const { object, opacity, size, distance, bearing, relativeBearing, radius, signal } = entry;
    const button = targetTemplate.content.firstElementChild.cloneNode(true);
    const point = polarToPercent(relativeBearing, radius);
    button.style.left = `${point.x}%`;
    button.style.top = `${point.y}%`;
    button.style.width = `${size}px`;
    button.style.height = `${size}px`;
    button.style.setProperty("--symbol-size", `${Math.max(15, Math.round(size * 0.72))}px`);
    button.style.opacity = opacity.toFixed(3);
    button.style.zIndex = String(Math.round(signal * 100));
    button.classList.toggle("selected", object.id === selectedId);
    button.classList.add(targetClass(object));
    button.classList.add(object.family || "street");
    button.classList.toggle("too-quiet", opacity < 0.1);
    button.querySelector(".field-symbol").textContent = objectSymbol(object);
    button.querySelector(".field-value").textContent = compactValue(object.game.value);
    button.title = `${object.name}, ${Math.round(distance)}m, +${object.game.value}`;
    button.addEventListener("click", () => {
      selectedId = object.id;
      renderAll();
    });
    targetLayer.appendChild(button);
  });

  strongSignals.forEach((entry, index) => {
    const { object, distance, bearing } = entry;
    const signal = document.createElement("button");
    signal.className = "signal-button";
    signal.classList.toggle("selected", object.id === selectedId);
    signal.type = "button";
    signal.innerHTML = `
      <span class="signal-number">${objectSymbol(object)}</span>
      <span>
        <span class="signal-name">${escapeHtml(shortName(object))}</span>
        <span class="signal-meta">${Math.round(distance)}m · ${cardinalDirection(bearing)} · ${escapeHtml(displayFamily(object))}</span>
      </span>
      <span class="signal-value">+${object.game.value}</span>
    `;
    signal.addEventListener("click", () => {
      selectedId = object.id;
      renderAll();
    });
    signalList.appendChild(signal);
  });
}

function renderFocus(fieldObjects, strongSignals) {
  const object = objects.find((item) => item.id === selectedId && !collected.has(item.id));
  if (!object) {
    focusCard.innerHTML = '<div class="empty-card">No visible signals. Lower the Signal control or walk a little.</div>';
    return;
  }

  const collectState = canCollect(object);
  const entry = fieldObjects.find((item) => item.object.id === object.id);
  const signalText = entry
    ? `${SIGNAL_MODES[signalModeIndex].name} signal · ${Math.round(entry.distance)}m away`
    : `${Math.round(distanceFromUser(object))}m away`;
  focusCard.innerHTML = `
    <div class="card-topline">
      <span class="family">${escapeHtml(displayFamily(object))}</span>
      <span class="value">+${object.game.value}</span>
    </div>
    <h2>${escapeHtml(object.name)}</h2>
    <p class="kind">${escapeHtml(object.game.kind)}</p>
    <p class="distance-line">${signalText} · ${cardinalDirection(bearingTo(object))}</p>
    <p class="reason">${escapeHtml(focusReason(object))}</p>
    <button id="collectButton" class="collect-button" type="button" ${collectState.allowed ? "" : "disabled"}>${escapeHtml(collectState.label)}</button>
  `;
  document.querySelector("#collectButton")?.addEventListener("click", () => collectObject(object.id));
}

function renderCollected() {
  const found = objects
    .filter((object) => collected.has(object.id))
    .sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0) || b.game.value - a.game.value);

  collectedSummary.textContent = found.length
    ? `${found.length} found · ${found.reduce((sum, object) => sum + object.game.value, 0)} total value`
    : "Collected items leave the compass and move here.";

  collectedList.innerHTML = "";
  if (!found.length) {
    collectedList.innerHTML = '<div class="empty-card">Nothing collected yet.</div>';
    return;
  }

  found.forEach((object) => {
    const card = document.createElement("article");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-meta">
        <span>${escapeHtml(displayFamily(object))}</span>
        <span>+${object.game.value}</span>
      </div>
      <h3>${escapeHtml(object.name)}</h3>
      <p>${escapeHtml(object.game.kind)}</p>
    `;
    collectedList.appendChild(card);
  });
}

function renderSets() {
  const sets = new Map();
  objects.forEach((object) => {
    (object.sets || []).forEach((setName) => {
      if (!sets.has(setName)) sets.set(setName, []);
      sets.get(setName).push(object);
    });
  });

  setsList.innerHTML = "";
  [...sets.entries()]
    .sort((a, b) => countCollected(b[1]) - countCollected(a[1]) || bestValue(b[1]) - bestValue(a[1]))
    .forEach(([name, members]) => {
      const found = countCollected(members);
      const next = members
        .filter((object) => !collected.has(object.id))
        .sort((a, b) => distanceFromUser(a) - distanceFromUser(b) || b.game.value - a.game.value)[0];
      const card = document.createElement("article");
      card.className = "set-card";
      card.innerHTML = `
        <h3>${escapeHtml(name)}</h3>
        <progress class="set-progress" value="${found}" max="${members.length}"></progress>
        <p>${found}/${members.length} found${next ? ` · next ${escapeHtml(shortName(next))}` : " · complete"}</p>
      `;
      setsList.appendChild(card);
    });
}

function getFieldObjects() {
  const threshold = SIGNAL_MODES[signalModeIndex].threshold;
  const entries = objects
    .filter((object) => !collected.has(object.id))
    .map((object) => {
      const distance = distanceFromUser(object);
      const bearing = bearingTo(object);
      const relativeBearing = normaliseDegrees(bearing - heading);
      const signal = signalStrength(object, distance);
      const opacity = signalOpacity(object, signal, threshold);
      return {
        object,
        distance,
        bearing,
        relativeBearing,
        signal,
        opacity,
        radius: distanceRadius(distance),
        size: symbolSize(object, signal)
      };
    })
    .filter((entry) => entry.opacity > 0.018)
    .sort((a, b) => a.signal - b.signal);

  return entries.slice(-MAX_FIELD_OBJECTS);
}

function getStrongSignals(fieldObjects) {
  const byStrength = [...fieldObjects]
    .filter((entry) => entry.opacity >= 0.1)
    .sort((a, b) => b.signal - a.signal || a.distance - b.distance);

  let chosen = chooseSignalEntries(byStrength);
  chosen = enforceHighLowSignalMix(chosen, byStrength);

  if (chosen.length < MIN_TARGETS) {
    const wider = [...fieldObjects].sort((a, b) => b.signal - a.signal || a.distance - b.distance);
    chosen = enforceHighLowSignalMix(chooseSignalEntries(wider), wider);
  }

  return chosen
    .slice(0, MAX_TARGETS)
    .sort((a, b) => b.signal - a.signal || a.distance - b.distance);
}

function chooseSignalEntries(candidates) {
  const chosen = [];
  const seenKinds = new Set();
  const seenFamilies = new Set();

  for (const entry of candidates) {
    const kindKey = kindKeyFor(entry.object);
    if (seenKinds.has(kindKey)) continue;
    chosen.push(entry);
    seenKinds.add(kindKey);
    seenFamilies.add(entry.object.family);
    if (chosen.length >= MAX_TARGETS) break;
  }

  if (chosen.length < MIN_TARGETS) {
    for (const entry of candidates) {
      if (chosen.some((item) => item.object.id === entry.object.id)) continue;
      if (seenFamilies.has(entry.object.family) && chosen.length >= MIN_TARGETS - 1) continue;
      chosen.push(entry);
      seenFamilies.add(entry.object.family);
      if (chosen.length >= MIN_TARGETS) break;
    }
  }

  return chosen;
}

function enforceHighLowSignalMix(chosen, candidates) {
  const targetEntries = [...chosen];
  const hasHigh = targetEntries.some((entry) => isHighValue(entry.object));
  const hasLow = targetEntries.some((entry) => isLowValue(entry.object));

  if (!hasHigh) {
    const high = candidates
      .filter((entry) => isHighValue(entry.object))
      .sort((a, b) => b.signal - a.signal || b.object.game.value - a.object.game.value)[0];
    addSignalRepresentative(targetEntries, high);
  }

  if (!hasLow) {
    const low = candidates
      .filter((entry) => isLowValue(entry.object))
      .sort((a, b) => a.distance - b.distance || b.signal - a.signal)[0];
    addSignalRepresentative(targetEntries, low);
  }

  while (targetEntries.length > MAX_TARGETS) {
    const removableIndex = targetEntries.findIndex((entry) => !isHighValue(entry.object) && !isLowValue(entry.object));
    targetEntries.splice(removableIndex >= 0 ? removableIndex : targetEntries.length - 1, 1);
  }

  return targetEntries;
}

function addSignalRepresentative(targetEntries, entry) {
  if (!entry || targetEntries.some((item) => item.object.id === entry.object.id)) return;
  const sameKindIndex = targetEntries.findIndex((item) => kindKeyFor(item.object) === kindKeyFor(entry.object));
  if (sameKindIndex >= 0) {
    targetEntries[sameKindIndex] = entry;
  } else {
    targetEntries.push(entry);
  }
}

function isHighValue(object) {
  return object.game.value >= 30;
}

function isLowValue(object) {
  return object.game.value <= 2;
}

function signalStrength(object, meters) {
  const valueSignal = Math.log2(object.game.value + 1);
  return valueSignal * 18 / Math.pow(meters + 20, 0.75);
}

function signalOpacity(object, signal, threshold) {
  if (signal >= threshold) {
    return clamp(0.16 + (signal - threshold) / (threshold * 2.4), 0.16, 0.96);
  }
  const highValueGhost = object.game.value >= 100 && signal >= threshold * 0.24;
  const closeLowGhost = object.game.value <= 2 && distanceFromUser(object) <= 35 && signal >= threshold * 0.5;
  if (highValueGhost || closeLowGhost) return clamp(signal / threshold * 0.12, 0.035, 0.13);
  return 0.012;
}

function distanceRadius(meters) {
  const capped = Math.min(meters, FIELD_MAX_DISTANCE_METERS);
  return 7 + 42 * Math.log(capped + 1) / Math.log(FIELD_MAX_DISTANCE_METERS + 1);
}

function symbolSize(object, signal) {
  const valueBoost = Math.min(12, Math.log2(object.game.value + 1) * 1.5);
  const signalBoost = Math.min(8, signal * 2);
  return Math.round(20 + valueBoost + signalBoost);
}

function objectSymbol(object) {
  const haystack = `${object.type || ""} ${object.typeLabel || ""} ${object.game.kind || ""} ${object.name || ""}`.toLowerCase();
  const match = TYPE_SYMBOLS.find((entry) => haystack.includes(entry.match));
  return match?.symbol || FAMILY_SYMBOLS[object.family] || "●";
}

function compactValue(value) {
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function canCollect(object) {
  if (collected.has(object.id)) {
    return { allowed: false, label: "Collected" };
  }
  if (locationError) {
    return { allowed: false, label: locationError.includes("HTTPS") ? "HTTPS needed" : "GPS needed" };
  }
  if (!currentPosition) {
    return { allowed: false, label: "Waiting for GPS" };
  }
  if (Date.now() - currentPosition.timestamp > MAX_LOCATION_AGE_MS) {
    return { allowed: false, label: "Refresh GPS" };
  }
  if (currentPosition.accuracy > MAX_LOCATION_ACCURACY_METERS) {
    return { allowed: false, label: `GPS accuracy ${Math.round(currentPosition.accuracy)}m` };
  }
  const meters = distance(currentPosition, object);
  if (meters > COLLECT_RADIUS_METERS) {
    return { allowed: false, label: `${Math.round(meters)}m away` };
  }
  return { allowed: true, label: `Collect +${object.game.value}` };
}

function collectObject(id) {
  const object = objects.find((item) => item.id === id);
  if (!object || !canCollect(object).allowed) return;
  object.collectedAt = Date.now();
  collected.add(id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...collected]));
  renderAll();
}

function focusReason(object) {
  if (collected.has(object.id)) return "Collected.";
  const collectState = canCollect(object);
  if (collectState.allowed) return "You are close enough to collect it.";
  if (!currentPosition && !locationError) return "GPS is not ready yet. You can look around, but collection is locked.";
  if (locationError) return locationError;
  const meters = Math.round(distance(currentPosition, object));
  return `Move within ${COLLECT_RADIUS_METERS}m to collect. Its signal is based on value and distance.`;
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    locationError = "GPS is not available in this browser.";
    renderAll();
    return;
  }
  if (!window.isSecureContext) {
    locationError = "GPS needs HTTPS to verify finds.";
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
      renderAll();
    },
    (error) => {
      locationError = error.message || "GPS permission denied.";
      renderAll();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 12000
    }
  );
}

async function requestHeading() {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") return;
    }
    window.addEventListener("deviceorientation", handleOrientation, true);
    headingEnabled = true;
    renderAll();
  } catch {
    headingEnabled = false;
    renderAll();
  }
}

function handleOrientation(event) {
  const webkitHeading = event.webkitCompassHeading;
  if (typeof webkitHeading === "number") {
    heading = webkitHeading;
  } else if (typeof event.alpha === "number") {
    heading = 360 - event.alpha;
  }
  const fieldObjects = getFieldObjects();
  renderCompass(fieldObjects, getStrongSignals(fieldObjects));
  renderLocationStatus();
}

function distanceFromUser(object) {
  const origin = currentPosition || HOME;
  return distance(origin, object);
}

function distance(a, b) {
  const lat = (a.lat - b.lat) * 111320;
  const lon = (a.lon - b.lon) * 69400;
  return Math.sqrt(lat * lat + lon * lon);
}

function bearingTo(object) {
  const origin = currentPosition || HOME;
  const lat1 = toRadians(origin.lat);
  const lat2 = toRadians(object.lat);
  const deltaLon = toRadians(object.lon - origin.lon);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return normaliseDegrees(toDegrees(Math.atan2(y, x)));
}

function polarToPercent(degrees, radius) {
  const radians = toRadians(degrees);
  return {
    x: 50 + Math.sin(radians) * radius,
    y: 50 - Math.cos(radians) * radius
  };
}

function cardinalDirection(degrees) {
  const directions = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return directions[Math.round(normaliseDegrees(degrees) / 45) % 8];
}

function targetClass(object) {
  if (object.game.value >= 50) return "prize";
  if (object.game.value >= 10) return "good";
  return "everyday";
}

function displayFamily(object) {
  return FAMILY_LABELS[object.family] || object.game.form || "Object";
}

function shortName(object) {
  const named = object.name && !/^Tree #/.test(object.name) ? object.name : object.game.kind;
  return named.length > 18 ? `${named.slice(0, 17)}...` : named;
}

function kindKeyFor(object) {
  return `${object.family}:${object.game.kind}`.toLowerCase();
}

function countCollected(members) {
  return members.filter((object) => collected.has(object.id)).length;
}

function bestValue(members) {
  return Math.max(...members.map((object) => object.game.value));
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function toDegrees(value) {
  return value * 180 / Math.PI;
}

function normaliseDegrees(value) {
  return (value % 360 + 360) % 360;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
