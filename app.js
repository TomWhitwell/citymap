const HOME = { lat: 51.460834, lon: -0.097488, label: "SE24 0AQ" };
const STORAGE_KEY = "se24-field-cards-v4";
const COLLECT_RADIUS_METERS = 5;
const MAX_LOCATION_ACCURACY_METERS = 35;
const MAX_LOCATION_AGE_MS = 120000;
const MAX_TARGETS = 5;
const MIN_TARGETS = 3;

const FAMILY_LABELS = {
  canopy: "Tree",
  memory: "History",
  street: "Street",
  culture: "Place",
  movement: "Transport"
};

let objects = [];
let activeView = "nearby";
let selectedId = null;
let collected = new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"));
let currentPosition = null;
let locationError = null;
let heading = 0;
let headingEnabled = false;

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
const targetTemplate = document.querySelector("#targetTemplate");

fetch("data/se24-objects.json")
  .then((response) => response.json())
  .then((payload) => {
    objects = payload.objects.map(normaliseGameObject);
    selectedId = getVisibleTargets()[0]?.id || null;
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
  const visibleTargets = getVisibleTargets();
  if (!selectedId || !visibleTargets.some((object) => object.id === selectedId)) {
    selectedId = visibleTargets[0]?.id || null;
  }
  renderStats(visibleTargets);
  renderLocationStatus();
  renderCompass(visibleTargets);
  renderFocus(visibleTargets);
  renderCollected();
  renderSets();
}

function renderStats(visibleTargets) {
  const found = objects.filter((object) => collected.has(object.id));
  targetCount.textContent = visibleTargets.length;
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
}

function renderCompass(visibleTargets) {
  targetLayer.innerHTML = "";
  signalList.innerHTML = "";
  const directionSlots = new Map();
  visibleTargets.forEach((object, index) => {
    const button = targetTemplate.content.firstElementChild.cloneNode(true);
    const bearing = bearingTo(object);
    const relativeBearing = normaliseDegrees(bearing - heading);
    const radius = staggeredRadius(relativeBearing, object, directionSlots);
    const point = polarToPercent(relativeBearing, radius);
    const distanceLabel = `${Math.round(distanceFromUser(object))}m`;
    button.style.left = `${point.x}%`;
    button.style.top = `${point.y}%`;
    button.classList.toggle("selected", object.id === selectedId);
    button.classList.add(targetClass(object));
    button.querySelector(".target-arrow").dataset.number = index + 1;
    button.querySelector(".target-arrow").style.transform = `rotate(${relativeBearing}deg)`;
    button.querySelector(".target-label").textContent = `${index + 1}`;
    button.title = `${object.name}, ${distanceLabel}`;
    button.addEventListener("click", () => {
      selectedId = object.id;
      renderAll();
    });
    targetLayer.appendChild(button);

    const signal = document.createElement("button");
    signal.className = "signal-button";
    signal.classList.toggle("selected", object.id === selectedId);
    signal.type = "button";
    signal.innerHTML = `
      <span class="signal-number">${index + 1}</span>
      <span>
        <span class="signal-name">${escapeHtml(shortName(object))}</span>
        <span class="signal-meta">${distanceLabel} · ${cardinalDirection(bearing)} · ${escapeHtml(displayFamily(object))}</span>
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

function staggeredRadius(relativeBearing, object, directionSlots) {
  const bucket = Math.round(relativeBearing / 18);
  const slot = directionSlots.get(bucket) || 0;
  directionSlots.set(bucket, slot + 1);
  if (object.game.value >= 50) return 41;
  const radii = [22, 30, 36, 16, 44];
  return radii[slot % radii.length];
}

function renderFocus(visibleTargets) {
  const object = visibleTargets.find((item) => item.id === selectedId);
  if (!object) {
    focusCard.innerHTML = '<div class="empty-card">No nearby targets in range. Walk a little and the compass will refresh.</div>';
    return;
  }

  const collectState = canCollect(object);
  focusCard.innerHTML = `
    <div class="card-topline">
      <span class="family">${escapeHtml(displayFamily(object))}</span>
      <span class="value">+${object.game.value}</span>
    </div>
    <h2>${escapeHtml(object.name)}</h2>
    <p class="kind">${escapeHtml(object.game.kind)}</p>
    <p class="distance-line">${Math.round(distanceFromUser(object))}m away · ${cardinalDirection(bearingTo(object))}</p>
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

function getVisibleTargets() {
  const allCandidates = objects
    .filter((object) => !collected.has(object.id))
    .map((object) => ({
      object,
      distance: distanceFromUser(object),
      signal: signalRadius(object)
    }))
    .sort((a, b) => targetPriority(a) - targetPriority(b));

  let candidates = allCandidates.filter((entry) => entry.distance <= entry.signal);
  let chosen = enforceHighLowMix(chooseTargets(candidates), allCandidates);

  for (const radius of [75, 150, 300, 600, 1200, 2500]) {
    if (chosen.length >= MIN_TARGETS) break;
    candidates = allCandidates.filter((entry) => entry.distance <= Math.max(entry.signal, radius));
    chosen = enforceHighLowMix(chooseTargets(candidates), allCandidates);
  }

  if (chosen.length < MIN_TARGETS) {
    chosen = enforceHighLowMix(chooseTargets(allCandidates), allCandidates);
  }

  return chosen.sort((a, b) => displayOrder(a) - displayOrder(b));
}

function chooseTargets(candidates) {
  const chosen = [];
  const seenKinds = new Set();
  const seenFamilies = new Set();

  for (const entry of candidates) {
    const kindKey = kindKeyFor(entry.object);
    if (seenKinds.has(kindKey)) continue;
    chosen.push(entry.object);
    seenKinds.add(kindKey);
    seenFamilies.add(entry.object.family);
    if (chosen.length >= MAX_TARGETS) break;
  }

  if (chosen.length < MIN_TARGETS) {
    for (const entry of candidates) {
      if (chosen.some((object) => object.id === entry.object.id)) continue;
      if (seenFamilies.has(entry.object.family) && chosen.length >= MIN_TARGETS - 1) continue;
      chosen.push(entry.object);
      seenFamilies.add(entry.object.family);
      if (chosen.length >= MIN_TARGETS) break;
    }
  }

  return chosen;
}

function enforceHighLowMix(chosen, candidates) {
  const targetObjects = [...chosen];
  const hasHigh = targetObjects.some((object) => isHighValue(object));
  const hasLow = targetObjects.some((object) => isLowValue(object));

  if (!hasHigh) {
    const high = candidates
      .filter((entry) => isHighValue(entry.object))
      .sort((a, b) => highValuePriority(a) - highValuePriority(b))[0]?.object;
    addRepresentative(targetObjects, high);
  }

  if (!hasLow) {
    const low = candidates
      .filter((entry) => isLowValue(entry.object))
      .sort((a, b) => a.distance - b.distance || a.object.game.value - b.object.game.value)[0]?.object;
    addRepresentative(targetObjects, low);
  }

  while (targetObjects.length > MAX_TARGETS) {
    const removableIndex = targetObjects.findIndex((object) => !isHighValue(object) && !isLowValue(object));
    targetObjects.splice(removableIndex >= 0 ? removableIndex : targetObjects.length - 1, 1);
  }

  return targetObjects;
}

function addRepresentative(targetObjects, object) {
  if (!object || targetObjects.some((item) => item.id === object.id)) return;
  const sameKindIndex = targetObjects.findIndex((item) => kindKeyFor(item) === kindKeyFor(object));
  if (sameKindIndex >= 0) {
    targetObjects[sameKindIndex] = object;
  } else {
    targetObjects.push(object);
  }
}

function isHighValue(object) {
  return object.game.value >= 30;
}

function isLowValue(object) {
  return object.game.value <= 2;
}

function highValuePriority(entry) {
  return entry.distance - entry.object.game.value * 1.5;
}

function targetPriority(entry) {
  const valueBias = Math.max(0, 120 - entry.object.game.value) * 0.8;
  const edgePenalty = (entry.distance / entry.signal) * 60;
  return entry.distance + valueBias + edgePenalty;
}

function displayOrder(object) {
  const valueBand = object.game.value >= 50 ? 0 : object.game.value >= 10 ? 1 : 2;
  return valueBand * 10000 + distanceFromUser(object);
}

function signalRadius(object) {
  const value = object.game.value;
  if (value >= 150) return 250;
  if (value >= 75) return 180;
  if (value >= 30) return 120;
  if (value >= 10) return 75;
  if (value >= 3) return 45;
  return 25;
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
  const signal = signalRadius(object);
  const visibility = meters > signal
    ? "The app is looking further because there are not enough closer things."
    : `It is visible now because its signal range is ${signal}m.`;
  return `Move within ${COLLECT_RADIUS_METERS}m to collect. ${visibility}`;
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
  renderCompass(getVisibleTargets());
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
