/* Mapa de horarios de la C3 de Vitrasa. Los buses se colocan con el horario teórico. */
(function () {
  const DAY_LABEL = { L: "Laborable", S: "Sábado", D: "Domingo" };
  const state = {
    lines: new Set(["C3d", "C3i"]),
    day: "L",
    rare: false,
    pattern: null,
    stop: null,
    trip: null,
    query: "",
    liveScope: "c3",
    liveMore: false,
    eta: null,
    live: true,
    playing: false,
    sec: 12 * 3600,
    view: "map",
  };

  let data = null;
  let map, lineLayer, stopLayer, busLayer, atlas;
  const busMarkers = new Map();
  let lastListMinute = -1;
  let lastFrame = 0;
  let playAnchor = 0;
  let scrollPending = false;
  let nearNote = null;

  const $ = (id) => document.getElementById(id);
  const routeInk = [];
  let lightMinute = -2;

  function madridParts(date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type).value;
    return {
      weekday: get("weekday"),
      sec: (+get("hour") * 3600) + (+get("minute") * 60) + (+get("second")),
    };
  }

  function fmt(sec) {
    const total = Math.floor(sec / 60);
    const h = Math.floor(total / 60) % 24;
    const m = total % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  function fold(value) {
    return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  }

  function catalogPatterns() {
    return data.patterns.filter((pattern, index) => {
      pattern._i = index;
      if (!state.lines.has(pattern.line)) return false;
      if (!state.rare && pattern.rare) return false;
      return pattern[state.day].length > 0;
    });
  }

  function medianGap(trips) {
    if (trips.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < trips.length; i++) gaps.push(trips[i][0] - trips[i - 1][0]);
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  }

  function tripSpan(times) {
    return times[times.length - 1] - times[0];
  }

  function placeOnShape(pts, dist) {
    if (!pts.length) return null;
    if (dist <= pts[0][2]) return [pts[0][0], pts[0][1]];
    for (let i = 1; i < pts.length; i++) {
      if (dist <= pts[i][2]) {
        const a = pts[i - 1];
        const b = pts[i];
        const span = b[2] - a[2] || 1;
        const t = (dist - a[2]) / span;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    const last = pts[pts.length - 1];
    return [last[0], last[1]];
  }

  function bearing(a, b) {
    const toR = Math.PI / 180;
    const y = Math.sin((b[1] - a[1]) * toR) * Math.cos(b[0] * toR);
    const x = Math.cos(a[0] * toR) * Math.sin(b[0] * toR) -
      Math.sin(a[0] * toR) * Math.cos(b[0] * toR) * Math.cos((b[1] - a[1]) * toR);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  const DWELL = 20;
  const ease = (f) => f * f * (3 - 2 * f);

  function busPose(pattern, times, now) {
    if (now < times[0] || now > times[times.length - 1]) return null;
    let i = 0;
    while (i < times.length - 1 && times[i + 1] <= now) i++;
    const stops = pattern.stops;
    if (i >= times.length - 1) {
      const at = placeOnShape(pattern.pts, stops[i][1]);
      return { i, at, heading: 0, next: stops[i][0], dwell: true, done: true };
    }
    const t0 = times[i];
    const t1 = times[i + 1];
    const hold = Math.min(DWELL, (t1 - t0) * 0.35);
    const dwell = now - t0 < hold;
    const f = dwell ? 0 : ease((now - t0 - hold) / (t1 - t0 - hold));
    const dist = stops[i][1] + (stops[i + 1][1] - stops[i][1]) * f;
    const at = placeOnShape(pattern.pts, dist);
    const ahead = placeOnShape(pattern.pts, dist + 40);
    const rawHeading = at && ahead ? bearing(at, ahead) : 0;
    const heading = Number.isFinite(rawHeading) ? rawHeading : 0;
    return { i, at, heading, next: stops[i + 1][0], dwell, done: false };
  }

  const FLEET_POLL = 20000;
  const FLEET_FRESH = 90;
  const FLEET_REACH = 3200;
  const MATCH_EARLY = 6 * 60;
  const MATCH_LATE = 25 * 60;
  const MATCH_OFF_ROUTE = 120;
  const fleet = { at: 0, stale: false, error: null, loading: false, buses: [], seq: 0 };

  function destKey(text) {
    return fold(text).split(" por ")[0].replace(/[^a-z]+/g, " ").trim();
  }

  function metersApart(a, b) {
    const dLat = (a[0] - b[0]) * 111320;
    const dLon = (a[1] - b[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180);
    return Math.hypot(dLat, dLon);
  }

  function stopDistOn(pattern, stopId) {
    const hit = pattern.stops.find(([id]) => id === stopId);
    return hit ? hit[1] : null;
  }

  function locateOn(pattern, at) {
    const pts = pattern.pts;
    const cos = Math.cos((at[0] * Math.PI) / 180);
    let best = { dist: 0, off: Infinity };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const ax = (a[1] - at[1]) * 111320 * cos;
      const ay = (a[0] - at[0]) * 111320;
      const dx = (b[1] - a[1]) * 111320 * cos;
      const dy = (b[0] - a[0]) * 111320;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const off = Math.hypot(ax + dx * t, ay + dy * t);
      if (off < best.off) best = { dist: a[2] + (b[2] - a[2]) * t, off };
    }
    return best;
  }

  function scheduledAt(pattern, times, dist) {
    const stops = pattern.stops;
    if (dist <= stops[0][1]) return times[0];
    for (let i = 1; i < stops.length; i++) {
      if (dist <= stops[i][1]) {
        const span = stops[i][1] - stops[i - 1][1] || 1;
        return times[i - 1] + (times[i] - times[i - 1]) * ((dist - stops[i - 1][1]) / span);
      }
    }
    return times[times.length - 1];
  }

  function fleetFresh() {
    return state.live && fleet.at > 0 && Date.now() / 1000 - fleet.at < FLEET_FRESH;
  }

  function readFleet(snapshot) {
    const patterns = data.patterns.filter((pattern) => pattern[state.day].length);
    const readings = [];
    snapshot.probes.forEach((probe) => {
      probe.est.forEach((row) => {
        if (row.metros < 0 || row.metros > FLEET_REACH) return;
        const onLine = patterns.filter((pattern) => pattern.line === row.linea && stopDistOn(pattern, probe.stop) !== null);
        const dest = destKey(row.ruta);
        const named = onLine.filter((pattern) => destKey(pattern.head) === dest);
        const places = [];
        (named.length ? named : onLine).forEach((pattern) => {
          const dist = stopDistOn(pattern, probe.stop) - row.metros;
          if (dist < pattern.stops[0][1] - 30) return;
          const at = placeOnShape(pattern.pts, dist);
          if (at) places.push({ pattern, dist, at });
        });
        if (!places.length) return;
        const speed = row.minutos > 0 ? Math.max(2, Math.min(11, row.metros / (row.minutos * 60))) : 0;
        readings.push({ line: row.linea, dest, metros: row.metros, speed, places });
      });
    });

    readings.sort((a, b) => a.metros - b.metros);
    const buses = [];
    readings.forEach((reading) => {
      const twin = buses.find((bus) => bus.line === reading.line && bus.dest === reading.dest &&
        reading.places.some((place) => bus.places.some((other) => metersApart(place.at, other.at) < 450)));
      if (!twin) {
        buses.push(reading);
        return;
      }
      const shared = twin.places.filter((place) => reading.places.some((other) => other.pattern === place.pattern));
      if (shared.length) twin.places = shared;
    });

    const scheduled = [];
    patterns.forEach((pattern) => {
      pattern[state.day].forEach((times, tripIndex) => {
        if (state.sec < times[0] - MATCH_EARLY || state.sec > times[times.length - 1] + MATCH_LATE) return;
        scheduled.push({ pattern, tripIndex, times, dest: destKey(pattern.head) });
      });
    });
    const pairs = [];
    buses.forEach((bus, b) => {
      const projected = new Map();
      scheduled.forEach((trip, s) => {
        if (trip.pattern.line !== bus.line) return;
        let place = bus.places.find((item) => item.pattern === trip.pattern);
        let cost = 0;
        if (!place) {
          if (trip.dest !== bus.dest) return;
          if (!projected.has(trip.pattern)) projected.set(trip.pattern, locateOn(trip.pattern, bus.places[0].at));
          const hit = projected.get(trip.pattern);
          if (hit.off > MATCH_OFF_ROUTE) return;
          place = { pattern: trip.pattern, dist: hit.dist, at: placeOnShape(trip.pattern.pts, hit.dist) };
          cost = 60;
        }
        const delay = state.sec - scheduledAt(trip.pattern, trip.times, place.dist);
        if (delay < -MATCH_EARLY || delay > MATCH_LATE) return;
        pairs.push({ b, s, cost: Math.abs(delay) + cost, place, delay });
      });
    });
    pairs.sort((a, b) => a.cost - b.cost);
    const takenBus = new Set();
    const takenTrip = new Set();
    pairs.forEach(({ b, s, place, delay }) => {
      if (takenBus.has(b) || takenTrip.has(s)) return;
      takenBus.add(b);
      takenTrip.add(s);
      const bus = buses[b];
      bus.trip = scheduled[s];
      bus.place = place;
      bus.delay = delay;
    });

    const age = Math.max(0, Math.min(30, Date.now() / 1000 - snapshot.at));
    const t = performance.now();
    const previous = fleet.buses;
    const used = new Set();
    buses.forEach((bus) => {
      if (!bus.place) bus.place = bus.places[0];
      bus.pattern = bus.place.pattern;
      let old = bus.trip && previous.find((item) => !used.has(item) && item.trip &&
        item.trip.pattern === bus.trip.pattern && item.trip.tripIndex === bus.trip.tripIndex);
      if (!old) {
        let best = 800;
        previous.forEach((item) => {
          if (used.has(item) || item.line !== bus.line || item.dest !== bus.dest || !item.shownAt) return;
          const d = metersApart(item.shownAt, bus.place.at);
          if (d < best) {
            best = d;
            old = item;
          }
        });
      }
      if (old) used.add(old);
      bus.id = old ? old.id : ++fleet.seq;
      bus.target = bus.place.dist;
      if (old && old.pattern === bus.pattern && old.shown != null) bus.from = old.shown;
      else if (old && old.shownAt && metersApart(old.shownAt, bus.place.at) <= 250) bus.from = locateOn(bus.pattern, old.shownAt).dist;
      else bus.from = bus.target;
      bus.t0 = t - age * 1000;
      bus.r0 = t;
    });
    fleet.buses = buses;
  }

  function fleetPose(bus) {
    const t = performance.now();
    const end = bus.pattern.stops[bus.pattern.stops.length - 1][1];
    let target = Math.min(end, bus.target + Math.min(45, (t - bus.t0) / 1000) * bus.speed);
    if (bus.from > target && bus.from - target < 200) target = bus.from;
    const k = Math.min(1, (t - bus.r0) / 3000);
    const dist = bus.from + (target - bus.from) * ease(k);
    const at = placeOnShape(bus.pattern.pts, dist);
    const ahead = placeOnShape(bus.pattern.pts, dist + 40);
    const rawHeading = at && ahead ? bearing(at, ahead) : 0;
    bus.shown = dist;
    bus.shownAt = at;
    return { at, heading: Number.isFinite(rawHeading) ? rawHeading : 0, dwell: bus.speed === 0, done: false };
  }

  function fleetBusFor(patternIndex, tripIndex) {
    if (!fleetFresh()) return null;
    return fleet.buses.find((bus) => bus.trip && bus.trip.pattern._i === patternIndex && bus.trip.tripIndex === tripIndex) || null;
  }

  function punctuality(delay) {
    if (delay == null) return { kind: "live", text: "En vivo", chip: "en vivo" };
    const min = Math.round(delay / 60);
    if (!min) return { kind: "ontime", text: "En hora", chip: "en hora" };
    if (min > 0) return { kind: "late", text: min + " min tarde", chip: "+" + min };
    return { kind: "early", text: Math.abs(min) + " min adelantado", chip: "−" + Math.abs(min) };
  }

  function delayLabel(delay) {
    const status = punctuality(delay);
    return status.kind === "live" ? "en vivo" : "en vivo · " + status.text.toLowerCase();
  }

  async function loadFleet() {
    if (!state.live || fleet.loading || !data) return;
    fleet.loading = true;
    try {
      const response = await fetch("api/live.php", { cache: "no-store" });
      if (!response.ok) throw new Error("respuesta " + response.status);
      const snapshot = await response.json();
      if (!Array.isArray(snapshot.probes)) throw new Error("sin datos");
      fleet.at = snapshot.at;
      fleet.stale = Boolean(snapshot.stale);
      fleet.error = null;
      readFleet(snapshot);
    } catch (error) {
      fleet.error = error.message;
    } finally {
      fleet.loading = false;
    }
    if (state.trip) renderBody();
    updateBuses();
  }

  function shiftLine(pts, pixels) {
    const meters = (156543.03392 * Math.cos((42.22 * Math.PI) / 180) / 2 ** map.getZoom()) * pixels;
    const moved = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts[Math.max(0, i - 1)];
      const next = pts[Math.min(pts.length - 1, i + 1)];
      const lat0 = (prev[0] * Math.PI) / 180;
      const x1 = prev[1] * Math.cos(lat0) * 111320;
      const y1 = prev[0] * 111320;
      const x2 = next[1] * Math.cos(lat0) * 111320;
      const y2 = next[0] * 111320;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const east = -dy / len;
      const north = dx / len;
      moved.push([
        pts[i][0] + (north * meters) / 111320,
        pts[i][1] + (east * meters) / (111320 * Math.cos((pts[i][0] * Math.PI) / 180)),
      ]);
    }
    return moved;
  }

  function fitPatterns(patterns) {
    const bounds = L.latLngBounds([]);
    patterns.forEach((pattern) => pattern.pts.forEach((pt) => bounds.extend([pt[0], pt[1]])));
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.12));
    if (state.view === "3d" && atlas) atlas.frame(patterns);
  }

  function drawMap(zoomOnly) {
    lineLayer.clearLayers();
    if (!zoomOnly) stopLayer.clearLayers();
    routeInk.length = 0;
    lightMinute = -2;
    const shown = catalogPatterns().slice().sort((a, b) => (a.line === "C3i" ? -1 : 1) - (b.line === "C3i" ? -1 : 1));
    const focused = state.pattern !== null;
    const both = state.lines.size === 2 && !focused;
    shown.forEach((pattern) => {
      const dim = focused && pattern._i !== state.pattern;
      const color = pattern.line === "C3d" ? "#e6ae00" : "#e4572e";
      const base = pattern.pts.map((pt) => [pt[0], pt[1]]);
      const latlngs = both ? shiftLine(base, pattern.line === "C3d" ? 3.5 : -3.5) : base;
      const glow = L.polyline(latlngs, {
        color,
        weight: dim ? 6 : 16,
        opacity: dim ? 0.05 : 0.28,
        interactive: false,
      }).addTo(lineLayer);
      const line = L.polyline(latlngs, {
        color: dim ? "#8a8478" : color,
        weight: dim ? 2 : 3.5,
        opacity: dim ? 0.35 : 0.95,
      }).addTo(lineLayer);
      routeInk.push({ glow, line, pattern, color, dim });
      line.on("click", () => selectPattern(pattern._i));
      line.bindTooltip(pattern.line + " · " + pattern.head, { sticky: true });
    });

    if (!zoomOnly) {
      const served = new Map();
      shown.forEach((pattern) => {
        if (focused && pattern._i !== state.pattern) return;
        pattern.stops.forEach(([stopId]) => {
          if (!served.has(stopId)) served.set(stopId, new Set());
          served.get(stopId).add(pattern.line);
        });
      });
      served.forEach((lines, stopId) => {
        const stop = data.stops[stopId];
        let fill = "#1c1915";
        if (lines.size === 1) fill = lines.has("C3d") ? "#e6ae00" : "#e4572e";
        const marker = L.circleMarker([stop.lat, stop.lon], {
          radius: state.stop === stopId ? 8 : 5,
          color: "#fffaf2",
          weight: 2,
          fillColor: fill,
          fillOpacity: 1,
        }).addTo(stopLayer);
        marker.on("click", () => selectStop(stopId));
        marker.bindTooltip(stop.n, { direction: "top", offset: [0, -6] });
      });
      if (atlas) atlas.sync(shown);
    }
    paintServiceLight();
  }

  function openBus(item) {
    if (item.tripIndex == null) selectPattern(item.pattern._i);
    else selectTrip(item.pattern._i, item.tripIndex);
  }

  function busTitle(item) {
    const base = item.pattern.line + " → " + item.pattern.to;
    if (item.live) return base + " · " + delayLabel(item.delay);
    if (item.ghost) return base + " · horario, sin bus en vivo";
    return base;
  }

  function busItems() {
    const now = state.sec;
    const visible = data.patterns.filter((pattern) => state.lines.has(pattern.line) && pattern[state.day].length &&
      (state.pattern === null || pattern._i === state.pattern));
    const scheduled = [];
    visible.forEach((pattern) => {
      pattern[state.day].forEach((times, tripIndex) => {
        const pose = busPose(pattern, times, now);
        if (!pose) return;
        scheduled.push({ pattern, tripIndex, times, pose, key: pattern._i + ":" + tripIndex });
      });
    });

    const live = fleetFresh();
    let active = scheduled;
    let liveCount = 0;
    if (live) {
      const allowed = (pattern) => state.lines.has(pattern.line) && (state.pattern === null || pattern._i === state.pattern);
      const matched = new Set();
      active = [];
      fleet.buses.forEach((bus) => {
        const pattern = bus.trip ? bus.trip.pattern : bus.pattern;
        if (bus.trip) matched.add(bus.trip.pattern._i + ":" + bus.trip.tripIndex);
        if (!allowed(pattern) && !allowed(bus.pattern)) return;
        const pose = fleetPose(bus);
        active.push({
          pattern,
          tripIndex: bus.trip ? bus.trip.tripIndex : null,
          times: bus.trip ? bus.trip.times : null,
          pose,
          live: true,
          delay: bus.delay,
          delayText: delayLabel(bus.delay),
          key: "v" + bus.id,
        });
        liveCount++;
      });
      scheduled.forEach((item) => {
        if (!matched.has(item.key)) active.push(Object.assign(item, { ghost: true, key: "g" + item.key }));
      });
    }
    return { active: active, live: live, liveCount: liveCount };
  }

  function poseFleet() {
    if (!atlas || state.view !== "3d" || (!fleetFresh() && !state.playing)) return;
    atlas.syncBuses(busItems().active);
  }

  function updateBuses() {
    const pack = busItems();
    const active = pack.active;
    const live = pack.live;
    const liveCount = pack.liveCount;

    const seen = new Set();
    active.forEach((item) => {
      const { pattern, tripIndex, pose, key } = item;
      seen.add(key);
      const cls = "bus " + (pattern.line === "C3d" ? "d" : "i") +
        (item.live ? " live" : "") +
        (item.ghost ? " ghost" : "") +
        (pose.dwell ? " stopped" : "") +
        (tripIndex != null && state.trip && state.trip.p === pattern._i && state.trip.i === tripIndex ? " sel" : "");
      const heading = Math.round(pose.heading / 12) * 12;
      const selected = tripIndex != null && state.trip && state.trip.p === pattern._i && state.trip.i === tripIndex;
      const chip = item.live && selected ? punctuality(item.delay).chip : "";
      const html = '<div class="' + cls + '" style="--r:' + heading + 'deg">' + pattern.line +
        (chip ? "<em>" + chip + "</em>" : "") + "</div>";
      const iconSize = chip ? [86, 24] : [52, 24];
      let marker = busMarkers.get(key);
      if (!pose.at || !Number.isFinite(pose.at[0]) || !Number.isFinite(pose.at[1])) return;
      if (!marker) {
        marker = L.marker(pose.at, {
          icon: L.divIcon({ className: "bus-ico", html, iconSize: iconSize, iconAnchor: [20, 12] }),
          zIndexOffset: item.ghost ? 600 : 800,
          keyboard: false,
        }).addTo(busLayer);
        marker._sig = cls + heading + chip;
        marker.on("click", () => openBus(marker._item));
        marker.bindTooltip(busTitle(item), { direction: "top", offset: [0, -14] });
        busMarkers.set(key, marker);
      } else {
        marker.setLatLng(pose.at);
        if (marker._sig !== cls + heading + chip) {
          marker._sig = cls + heading + chip;
          marker.setIcon(L.divIcon({ className: "bus-ico", html, iconSize: iconSize, iconAnchor: [20, 12] }));
        }
        marker.setTooltipContent(busTitle(item));
      }
      marker._item = item;
    });
    for (const key of busMarkers.keys()) {
      if (!seen.has(key)) {
        busLayer.removeLayer(busMarkers.get(key));
        busMarkers.delete(key);
      }
    }
    const scope = state.pattern !== null ? " de este recorrido" : "";
    let label;
    if (live) {
      const age = Math.max(0, Math.round(Date.now() / 1000 - fleet.at));
      label = (liveCount
        ? liveCount + (liveCount === 1 ? " bus en vivo" : " buses en vivo")
        : "Ningún bus en vivo") + scope + " · hace " + age + " s";
    } else {
      label = active.length
        ? active.length + (active.length === 1 ? " bus en hora" : " buses en hora") + scope
        : "Línea apagada" + scope;
      if (state.live && (fleet.error || fleet.at)) label += " · sin datos en vivo";
    }
    if (nearNote && performance.now() < nearNote.until) label = nearNote.text;
    else nearNote = null;
    $("running").textContent = label;
    paintServiceLight(active.length > 0);
    if (atlas) atlas.syncBuses(active);
    return active;
  }

  function paintServiceLight(awake) {
    if (awake !== undefined) {
      document.body.classList.toggle("asleep", !awake && state.pattern === null);
    }
    const minute = Math.floor(state.sec / 60);
    if (minute === lightMinute) return;
    lightMinute = minute;
    routeInk.forEach(({ glow, line, pattern, color, dim }) => {
      if (dim) return;
      const trips = pattern[state.day];
      const open = trips.some((times) => state.sec >= times[0] && state.sec <= times[times.length - 1]);
      const started = trips.length && state.sec >= trips[0][0] && state.sec <= trips[trips.length - 1][trips[trips.length - 1].length - 1];
      glow.setStyle({ opacity: open ? 0.42 : started ? 0.18 : 0.1 });
      line.setStyle({ color: started || open ? color : "#9a9284", opacity: open ? 1 : started ? 0.62 : 0.5 });
    });
    if (atlas) atlas.syncLight();
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderBody() {
    const body = $("body");
    const keep = body.scrollTop;
    body.replaceChildren();
    if (state.query.trim()) renderSearch(body);
    else if (state.trip) renderTrip(body);
    else if (state.stop !== null) renderStop(body);
    else renderOverview(body);
    if (scrollPending) {
      const node = body.querySelector(".pass.next, .stops .here");
      if (node) node.scrollIntoView({ block: "nearest" });
      else body.scrollTop = keep;
      scrollPending = false;
    } else {
      body.scrollTop = keep;
    }
  }

  function renderOverview(body) {
    body.append(
      h("p", "kicker", "Recorridos de " + DAY_LABEL[state.day].toLowerCase()),
      h("p", "lead", "Cada ficha es un recorrido con su cabecera. En el centro se alternan, así que el bus pasa más a menudo que el intervalo de una sola ficha.")
    );
    const patterns = catalogPatterns();
    if (!patterns.length) {
      body.append(h("p", "empty", "No hay servicio con estos filtros."));
      return;
    }
    patterns.forEach((pattern) => {
      const trips = pattern[state.day];
      const next = trips.find((times) => times[0] >= state.sec);
      const running = trips.filter((times) => state.sec >= times[0] && state.sec <= times[times.length - 1]).length;
      const gap = medianGap(trips);
      const button = h("button", "prow" + (state.pattern === pattern._i ? " on" : ""));
      button.type = "button";
      const title = h("div", "h");
      title.append(h("i", "dot " + (pattern.line === "C3d" ? "d" : "i")));
      title.append(document.createTextNode(pattern.line + " · " + pattern.head));
      if (pattern.rare) title.append(h("span", "badge", "especial"));
      button.append(title);
      button.append(h("div", "meta", pattern.from + " → " + pattern.to));
      button.append(h("div", "meta",
        fmt(trips[0][0]) + "–" + fmt(trips[trips.length - 1][0]) +
        " · " + trips.length + (trips.length === 1 ? " salida" : " salidas") +
        (gap ? " · cada " + Math.round(gap / 60) + " min" : "")
      ));
      button.append(h("div", "meta", running ? running + " en ruta" : next ? "siguiente " + fmt(next[0]) : "servicio terminado"));
      button.addEventListener("click", () => selectPattern(pattern._i));
      body.append(button);
      if (state.pattern === pattern._i) {
        const chips = h("div", "times");
        trips.forEach((trip, index) => {
          const onRoad = state.sec >= trip[0] && state.sec <= trip[trip.length - 1];
          const time = h("button", onRoad ? "next" : trip[0] < state.sec ? "past" : "", fmt(trip[0]));
          time.type = "button";
          time.addEventListener("click", () => selectTrip(pattern._i, index));
          chips.append(time);
        });
        body.append(h("p", "meta", "Salidas de cabecera. Pulsa una hora para ver las paradas de ese servicio."), chips);
      }
    });
  }

  function renderSearch(body) {
    const q = fold(state.query.trim());
    const hits = [];
    data.stops.forEach((stop, index) => {
      if (fold(stop.n).includes(q)) hits.push(index);
    });
    body.append(h("p", "kicker", "Paradas"));
    if (!hits.length) {
      body.append(h("p", "empty", "Ninguna parada coincide."));
      return;
    }
    hits.slice(0, 40).forEach((index) => {
      const button = h("button", "stop-hit" + (state.stop === index ? " on" : ""));
      button.type = "button";
      button.append(h("strong", null, data.stops[index].n));
      const lines = new Set();
      data.patterns.forEach((pattern) => {
        if (pattern.stops.some(([id]) => id === index)) lines.add(pattern.line);
      });
      button.append(h("div", "meta", [...lines].sort().join(" · ") || "fuera del filtro"));
      button.addEventListener("click", () => selectStop(index));
      body.append(button);
    });
  }

  function passages(stopId) {
    const rows = [];
    catalogPatterns().forEach((pattern) => {
      const at = pattern.stops.findIndex(([id]) => id === stopId);
      if (at < 0) return;
      pattern[state.day].forEach((times, tripIndex) => {
        rows.push({
          sec: times[at],
          line: pattern.line,
          head: pattern.head,
          to: pattern.to,
          p: pattern._i,
          i: tripIndex,
        });
      });
    });
    rows.sort((a, b) => a.sec - b.sec || a.line.localeCompare(b.line));
    return rows;
  }

  function routeLabel(raw) {
    const scheduled = raw.includes("*");
    let text = raw.replace(/\*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    text = text.replace(/(^|\s)([a-záéíóúüñ])/g, (match, space, letter) => space + letter.toUpperCase());
    text = text.replace(/\bPor\b/g, "por").replace(/\bDe\b/g, "de").replace(/\bDel\b/g, "del");
    text = text.replace(/Garcia/g, "García").replace(/Barbon/g, "Barbón").replace(/America/g, "América");
    return { text, scheduled };
  }

  function etaBits(min) {
    if (min <= 0) return { big: "ya", unit: "en parada" };
    if (min < 60) return { big: String(min), unit: min === 1 ? "minuto" : "minutos" };
    const hours = Math.floor(min / 60);
    const rest = min % 60;
    return { big: hours + " h", unit: rest ? rest + " min" : "" };
  }

  function arrivalClock(min) {
    return new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(Date.now() + min * 60000));
  }

  function estimatesFor(payload) {
    const rows = (payload && payload.estimaciones) || [];
    if (state.liveScope === "all") return rows;
    return rows.filter((row) => state.lines.has(row.linea));
  }

  function paintLive(box) {
    box.replaceChildren();
    const head = h("div", "live-top");
    const titles = h("div");
    titles.append(h("h3", null, "Tiempo real"));
    const stop = data.stops[state.stop];
    const note = h("p", "ghost");
    if (!stop.code) {
      note.textContent = "Esta parada no tiene código para consultar la API.";
      titles.append(note);
      head.append(titles);
      box.append(head);
      return;
    }
    if (state.eta && state.eta.code === stop.code && !state.eta.error) {
      const age = Math.max(0, Math.round((Date.now() - state.eta.at) / 1000));
      note.textContent = "Parada " + stop.code + " · hace " + age + " s";
    } else if (state.eta && state.eta.error && state.eta.code === stop.code) {
      note.textContent = state.eta.error;
    } else {
      note.textContent = "Consultando la parada " + stop.code + "…";
    }
    titles.append(note);
    const switcher = h("div", "live-switch");
    [["c3", "C3"], ["all", "Todas"]].forEach(([id, label]) => {
      const button = h("button", state.liveScope === id ? "on" : "", label);
      button.type = "button";
      button.addEventListener("click", () => {
        state.liveScope = id;
        state.liveMore = false;
        paintLive(box);
      });
      switcher.append(button);
    });
    head.append(titles, switcher);
    box.append(head);

    if (!state.eta || state.eta.code !== stop.code || state.eta.error || !state.eta.payload) {
      if (state.eta && state.eta.error) {
        const retry = h("button", "live-retry", "Reintentar");
        retry.type = "button";
        retry.addEventListener("click", () => loadLive(true));
        box.append(retry);
      }
      return;
    }

    const rows = estimatesFor(state.eta.payload);
    const hidden = ((state.eta.payload.estimaciones || []).length) - rows.length;
    if (!rows.length) {
      const empty = h("p", "ghost", hidden
        ? "La C3 no tiene estimación ahora. Hay " + hidden + " de otras líneas."
        : "La API no devuelve llegadas para esta parada.");
      box.append(empty);
      return;
    }
    const shown = state.liveMore ? rows : rows.slice(0, 5);
    shown.forEach((row) => {
      const route = routeLabel(row.ruta || "");
      const bits = etaBits(row.minutos);
      const button = h("button", "eta");
      button.type = "button";
      const time = h("b", null, bits.big);
      if (bits.unit) time.append(h("span", null, bits.unit));
      const who = h("span", "who", row.linea || "");
      const detail = route.text || "Sin destino";
      const small = h("small", null, detail);
      who.append(small);
      const when = h("span", "when", arrivalClock(row.minutos));
      const tag = row.metros >= 0 ? "a " + row.metros + " m" : "previsto";
      when.append(h("em", null, tag));
      button.append(time, who, when);
      box.append(button);
    });
    if (rows.length > 5) {
      const more = h("button", "live-more", state.liveMore ? "Ver menos" : "Ver " + (rows.length - 5) + " más");
      more.type = "button";
      more.addEventListener("click", () => {
        state.liveMore = !state.liveMore;
        paintLive(box);
      });
      box.append(more);
    }
  }

  let liveToken = 0;

  async function loadLive(force) {
    if (state.stop === null) return;
    const index = state.stop;
    const stop = data.stops[index];
    const box = document.getElementById("live");
    if (!box || !stop.code) return;
    const fresh = state.eta && state.eta.code === stop.code && !state.eta.error && Date.now() - state.eta.at < 25000;
    if (fresh && !force) {
      paintLive(box);
      return;
    }
    const token = ++liveToken;
    if (!state.eta || state.eta.code !== stop.code) paintLive(box);
    try {
      const response = await fetch("https://datos.vigo.org/vci_api_app/api2.jsp?tipo=TRANSPORTE-ESTIMACION-PARADA&id=" + stop.code);
      if (!response.ok) throw new Error("respuesta " + response.status);
      const text = new TextDecoder("iso-8859-1").decode(await response.arrayBuffer());
      const payload = JSON.parse(text);
      if (token !== liveToken || state.stop !== index) return;
      state.eta = { code: stop.code, at: Date.now(), payload };
      const current = document.getElementById("live");
      if (current) paintLive(current);
    } catch (error) {
      if (token !== liveToken || state.stop !== index) return;
      state.eta = { code: stop.code, at: Date.now(), error: "No se ha podido consultar el tiempo real." };
      const current = document.getElementById("live");
      if (current) paintLive(current);
    }
  }

  function renderStop(body) {
    const stop = data.stops[state.stop];
    const back = h("button", "back", "← Todos los recorridos");
    back.type = "button";
    back.addEventListener("click", () => {
      state.stop = null;
      state.trip = null;
      renderBody();
      drawMap();
      updateBuses();
    });
    const title = h("h2", null, stop.n);
    body.append(back, title);
    const live = h("div", "live");
    live.id = "live";
    body.append(live);
    paintLive(live);
    loadLive(false);
    const rows = passages(state.stop);
    if (!rows.length) {
      body.append(h("p", "empty", "Esta parada no tiene paso de la C3 con el filtro actual."));
      return;
    }
    const next = rows.find((row) => row.sec >= state.sec);
    const dayName = state.day === "L" ? "laborables" : state.day === "S" ? "sábados" : "domingos";
    body.append(
      h("p", "kicker", "Horario teórico"),
      h("p", "lead", rows.length + " pasos los " + dayName + ". Pulsa una hora para seguir ese servicio.")
    );
    rows.forEach((row) => {
      const button = h("button", "pass" + (row === next ? " next" : row.sec < state.sec ? " past" : ""));
      button.type = "button";
      const time = h("time", null, fmt(row.sec));
      time.dateTime = fmt(row.sec);
      const pill = h("span", "pill" + (row.line === "C3i" ? " i" : ""), row.line);
      const label = h("span", null, row.head);
      if (row === next) label.append(document.createTextNode(" · " + waitLabel(row.sec - state.sec)));
      button.append(time, pill, label);
      button.addEventListener("click", () => selectTrip(row.p, row.i));
      body.append(button);
    });
  }

  function waitLabel(delta) {
    const min = Math.round(delta / 60);
    if (min <= 0) return "en la parada";
    if (min < 60) return "dentro de " + min + " min";
    return "dentro de " + Math.floor(min / 60) + " h " + (min % 60) + " min";
  }

  function renderTrip(body) {
    const pattern = data.patterns[state.trip.p];
    const times = pattern && pattern[state.day][state.trip.i];
    if (!times) {
      state.trip = null;
      renderOverview(body);
      return;
    }
    const back = h("button", "back", "← Volver");
    back.type = "button";
    back.addEventListener("click", () => {
      state.trip = null;
      renderBody();
      updateBuses();
    });
    const head = h("div", "trip-head");
    const title = h("h2", null, pattern.line + " · " + pattern.head);
    head.append(back, title);
    const liveBus = fleetBusFor(pattern._i, state.trip.i);
    if (liveBus) {
      const status = punctuality(liveBus.delay);
      head.append(h("p", "punctual " + status.kind, status.text));
    }
    const card = h("div", "card");
    card.append(
      h("div", "meta", "Sale " + fmt(times[0]) + " de " + pattern.from + " y llega " + fmt(times[times.length - 1]) + " a " + pattern.to + ". Duración " + Math.round(tripSpan(times) / 60) + " min.")
    );
    const chips = h("div", "times");
    pattern[state.day].forEach((trip, index) => {
      const button = h("button", index === state.trip.i ? "next" : trip[0] < state.sec ? "past" : "", fmt(trip[0]));
      button.type = "button";
      button.addEventListener("click", () => selectTrip(pattern._i, index, false));
      chips.append(button);
    });
    card.append(h("div", "meta", "Salidas de cabecera"), chips);
    const list = h("ol", "stops");
    let current = 0;
    while (current < times.length - 1 && times[current + 1] <= state.sec) current++;
    pattern.stops.forEach(([stopId], index) => {
      const item = h("li", index < current ? "done" : index === current ? "here" : "");
      const button = h("button", null, data.stops[stopId].n);
      button.type = "button";
      button.addEventListener("click", () => selectStop(stopId));
      item.append(button, h("time", null, fmt(times[index])));
      list.append(item);
    });
    body.append(head, card, list);
  }

  function revealRare(index) {
    if (state.rare || !data.patterns[index].rare) return;
    state.rare = true;
    $("rare").checked = true;
  }

  function selectPattern(index) {
    revealRare(index);
    state.pattern = state.pattern === index ? null : index;
    state.trip = null;
    state.stop = null;
    state.query = "";
    $("q").value = "";
    drawMap();
    const chosen = state.pattern === null ? catalogPatterns() : [data.patterns[state.pattern]];
    fitPatterns(chosen);
    renderBody();
    updateBuses();
  }

  function selectStop(index) {
    state.stop = index;
    state.trip = null;
    state.query = "";
    $("q").value = "";
    state.liveMore = false;
    scrollPending = true;
    const stop = data.stops[index];
    map.setView([stop.lat, stop.lon], Math.max(map.getZoom(), 16), { animate: true });
    drawMap();
    renderBody();
    updateBuses();
    if (state.view === "3d" && atlas) atlas.focusAt(stop.lat, stop.lon);
  }

  function selectTrip(patternIndex, tripIndex, pan = true) {
    revealRare(patternIndex);
    state.pattern = patternIndex;
    state.trip = { p: patternIndex, i: tripIndex };
    state.stop = null;
    scrollPending = true;
    drawMap();
    renderBody();
    updateBuses();
    if (!pan) return;
    const pattern = data.patterns[patternIndex];
    const liveBus = fleetBusFor(patternIndex, tripIndex);
    const pose = liveBus ? fleetPose(liveBus) : busPose(pattern, pattern[state.day][tripIndex], state.sec);
    if (pose) {
      if (state.view === "3d" && atlas) atlas.follow(state.trip);
      else map.setView(pose.at, Math.max(map.getZoom(), 15), { animate: true });
    } else if (state.view === "3d" && atlas) atlas.frame([pattern]);
    else fitPatterns([pattern]);
  }

  function setSec(sec, manual) {
    state.sec = Math.max(0, Math.min(24 * 3600, sec));
    if (manual) {
      state.live = false;
      state.playing = false;
      $("play").setAttribute("aria-pressed", "false");
      $("play").textContent = "Recorrer";
    }
    $("slider").value = String(Math.round(state.sec));
    paintClock();
    const minute = Math.floor(state.sec / 60);
    if (minute !== lastListMinute) {
      lastListMinute = minute;
      if (state.playing && state.trip) scrollPending = true;
      renderBody();
    }
    updateBuses();
  }

  function paintClock() {
    const label = fmt(state.sec);
    $("clock-time").textContent = label;
    const bar = $("timebar-clock");
    if (bar) bar.textContent = label;
    $("clock-note").textContent = state.live ? "ahora · " + DAY_LABEL[state.day].toLowerCase() : state.playing ? "recorriendo el día" : "hora elegida";
    $("now").classList.toggle("on", state.live);
  }

  function loop(ts) {
    if (state.playing) {
      const dt = Math.min(0.25, (ts - playAnchor) / 1000);
      playAnchor = ts;
      setSec(state.sec + dt * 90, false);
      if (state.sec >= 24 * 3600) {
        state.playing = false;
        $("play").setAttribute("aria-pressed", "false");
        $("play").textContent = "Recorrer";
      }
    } else if (state.live && ts - lastFrame > 1000) {
      lastFrame = ts;
      setSec(madridParts(new Date()).sec, false);
    } else if (state.view === "3d") poseFleet();
    if (state.view === "3d" && atlas) atlas.tick();
    requestAnimationFrame(loop);
  }

  function nearestStop(lat, lon) {
    let best = null;
    let bestD = Infinity;
    data.stops.forEach((stop, index) => {
      const dLat = (stop.lat - lat) * 111320;
      const dLon = (stop.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
      const dist = Math.hypot(dLat, dLon);
      if (dist < bestD) {
        bestD = dist;
        best = index;
      }
    });
    return { index: best, meters: bestD };
  }

  function bootMap() {
    map = L.map("map", { zoomControl: true, minZoom: 12 }).setView([42.22, -8.73], 13);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    lineLayer = L.layerGroup().addTo(map);
    stopLayer = L.layerGroup().addTo(map);
    busLayer = L.layerGroup().addTo(map);
    map.on("zoomend", () => {
      if (state.view === "3d") return;
      if (state.lines.size === 2 && state.pattern === null) drawMap(true);
    });
    window.addEventListener("resize", () => {
      map.invalidateSize();
      if (atlas) atlas.resize();
    });
    atlas = window.Atlas3D($("atlas"), {
      getState: () => state,
      getData: () => data,
      onStop: (id) => selectStop(id),
      onPattern: (index) => selectPattern(index),
      onTrip: (patternIndex, tripIndex) => (tripIndex == null ? selectPattern(patternIndex) : selectTrip(patternIndex, tripIndex)),
      onFit: () => fitPatterns(state.pattern === null ? catalogPatterns() : [data.patterns[state.pattern]]),
      onGround: lockGround,
    });
  }

  function wire() {
    document.querySelectorAll("[data-line]").forEach((button) => {
      button.addEventListener("click", () => {
        const line = button.dataset.line;
        state.lines = new Set(line === "both" ? ["C3d", "C3i"] : [line]);
        document.querySelectorAll("[data-line]").forEach((item) => {
          const on = item === button;
          item.classList.toggle("on", on);
          item.setAttribute("aria-pressed", String(on));
        });
        state.pattern = null;
        state.trip = null;
        drawMap();
        fitPatterns(catalogPatterns());
        renderBody();
        updateBuses();
      });
    });
    document.querySelectorAll("[data-day]").forEach((button) => {
      button.addEventListener("click", () => {
        state.day = button.dataset.day;
        document.querySelectorAll("[data-day]").forEach((item) => item.classList.toggle("on", item === button));
        if (state.pattern !== null && !data.patterns[state.pattern][state.day].length) {
          state.pattern = null;
          state.trip = null;
        }
        if (state.trip && !data.patterns[state.trip.p][state.day][state.trip.i]) state.trip = null;
        drawMap();
        fitPatterns(state.pattern === null ? catalogPatterns() : [data.patterns[state.pattern]]);
        renderBody();
        updateBuses();
        paintClock();
      });
    });
    $("rare").addEventListener("change", () => {
      state.rare = $("rare").checked;
      if (!state.rare && state.pattern !== null && data.patterns[state.pattern].rare) {
        state.pattern = null;
        state.trip = null;
      }
      drawMap();
      renderBody();
      updateBuses();
    });
    $("q").addEventListener("input", () => {
      state.query = $("q").value;
      renderBody();
    });
    $("slider").addEventListener("input", () => setSec(+$("slider").value, true));
    $("now").addEventListener("click", () => {
      state.live = true;
      state.playing = false;
      $("play").setAttribute("aria-pressed", "false");
      $("play").textContent = "Recorrer";
      const now = madridParts(new Date());
      const day = now.weekday.startsWith("Sat") ? "S" : now.weekday.startsWith("Sun") ? "D" : "L";
      if (day !== state.day) document.querySelector('[data-day="' + day + '"]').click();
      setSec(now.sec, false);
      state.live = true;
      paintClock();
      loadFleet();
    });
    $("play").addEventListener("click", () => {
      state.playing = !state.playing;
      state.live = false;
      playAnchor = performance.now();
      $("play").setAttribute("aria-pressed", String(state.playing));
      $("play").textContent = state.playing ? "Pausa" : "Recorrer";
      paintClock();
    });
    $("step-back").addEventListener("click", () => setSec(state.sec - 15 * 60, true));
    $("step-fwd").addEventListener("click", () => setSec(state.sec + 15 * 60, true));
    $("fit").addEventListener("click", () => fitPatterns(state.pattern === null ? catalogPatterns() : [data.patterns[state.pattern]]));
    document.querySelectorAll("[data-view]").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });
    $("near").addEventListener("click", () => {
      const say = (text) => {
        nearNote = { text: text, until: performance.now() + 7000 };
        $("running").textContent = text;
      };
      if (!navigator.geolocation || !window.isSecureContext) {
        say("El navegador no permite usar tu posición en esta página.");
        return;
      }
      say("Buscando tu posición…");
      navigator.geolocation.getCurrentPosition((pos) => {
        const found = nearestStop(pos.coords.latitude, pos.coords.longitude);
        const stop = data.stops[found.index];
        if (found.meters > 2500) {
          const km = (found.meters / 1000).toFixed(1).replace(".", ",");
          say("Estás a " + km + " km de la C3. La parada más cercana es " + stop.n + ".");
          return;
        }
        say("Parada más cercana: " + stop.n + ".");
        selectStop(found.index);
      }, () => {
        say("No se ha podido obtener tu posición. Revisa el permiso del navegador.");
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
    });
  }

  function solve8(rows, values) {
    const n = 8;
    const m = rows.map((row, index) => row.concat(values[index]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
      }
      if (Math.abs(m[pivot][col]) < 1e-8) return null;
      if (pivot !== col) {
        const swap = m[col];
        m[col] = m[pivot];
        m[pivot] = swap;
      }
      const div = m[col][col];
      for (let c = col; c <= n; c++) m[col][c] /= div;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = m[row][col];
        for (let c = col; c <= n; c++) m[row][c] -= factor * m[col][c];
      }
    }
    return m.map((row) => row[n]);
  }

  function groundMatrix(from, to) {
    const rows = [];
    const values = [];
    from.forEach((point, index) => {
      const dest = to[index];
      rows.push([point.x, point.y, 1, 0, 0, 0, -point.x * dest.x, -point.y * dest.x]);
      rows.push([0, 0, 0, point.x, point.y, 1, -point.x * dest.y, -point.y * dest.y]);
      values.push(dest.x, dest.y);
    });
    const h = solve8(rows, values);
    if (!h) return "";
    const cell = [
      h[0], h[3], 0, h[6],
      h[1], h[4], 0, h[7],
      0, 0, 1, 0,
      h[2], h[5], 0, 1,
    ];
    return "matrix3d(" + cell.map((value) => value.toFixed(6)).join(",") + ")";
  }

  function lockGround(quad) {
    if (state.view !== "3d" || !map || !quad || quad.length !== 4) return;
    const el = map.getContainer();
    const lat = quad.reduce((sum, point) => sum + point.lat, 0) / 4;
    const lon = quad.reduce((sum, point) => sum + point.lon, 0) / 4;
    const sources = () => quad.map((point) => {
      const at = map.latLngToContainerPoint([point.lat, point.lon]);
      return { x: at.x, y: at.y };
    });
    let from = sources();
    const to = quad.map((point) => ({ x: point.x, y: point.y }));
    const size = map.getSize();
    const mid = map.latLngToContainerPoint([lat, lon]);
    const outside = mid.x < size.x * 0.2 || mid.x > size.x * 0.8 || mid.y < size.y * 0.2 || mid.y > size.y * 0.8;
    const span = Math.hypot(from[1].x - from[0].x, from[1].y - from[0].y) || 1;
    const seen = Math.hypot(to[1].x - to[0].x, to[1].y - to[0].y);
    const ratio = seen / span;
    let zoom = map.getZoom();
    if (ratio > 1.8 || ratio < 0.55) {
      const next = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), zoom + (ratio > 1 ? 1 : -1)));
      if (next !== zoom) zoom = next;
    }
    if (outside || zoom !== map.getZoom()) {
      map.setView([lat, lon], zoom, { animate: false });
      from = sources();
    }
    const css = groundMatrix(from, to);
    if (!css) return;
    el.style.transformOrigin = "0 0";
    el.style.transform = css;
  }

  function setView(view) {
    if (view === state.view) return;
    state.view = view;
    document.body.classList.toggle("view-3d", view === "3d");
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("on", button.dataset.view === view));
    map.getContainer().style.transform = "";
    map.getContainer().style.transformOrigin = "";
    if (view === "3d") {
      atlas.resize();
      const shown = state.pattern === null ? catalogPatterns() : [data.patterns[state.pattern]];
      atlas.frame(shown);
      map.invalidateSize();
      const bounds = L.latLngBounds([]);
      shown.forEach((pattern) => pattern.pts.forEach((pt) => bounds.extend([pt[0], pt[1]])));
      if (bounds.isValid()) map.fitBounds(bounds.pad(0.12), { animate: false });
      showAtlasHint();
      return;
    }
    const tip = $("atlas-tip");
    if (tip) tip.classList.remove("on");
    setTimeout(() => map.invalidateSize(), 60);
  }

  function showAtlasHint() {
    const hint = $("atlas-hint");
    let seen = false;
    try { seen = localStorage.getItem("c3-hint-3d") === "1"; } catch (error) { /* sin almacenamiento */ }
    if (!hint || seen) return;
    try { localStorage.setItem("c3-hint-3d", "1"); } catch (error) { /* sin almacenamiento */ }
    hint.classList.add("show");
    setTimeout(() => hint.classList.remove("show"), 7000);
  }

  async function main() {
    const response = await fetch("data/c3.json");
    if (!response.ok) throw new Error("sin datos");
    data = await response.json();
    data.patterns.forEach((pattern, index) => { pattern._i = index; });
    const now = madridParts(new Date());
    state.day = now.weekday.startsWith("Sat") ? "S" : now.weekday.startsWith("Sun") ? "D" : "L";
    state.sec = now.sec;
    document.querySelectorAll("[data-day]").forEach((button) => button.classList.toggle("on", button.dataset.day === state.day));
    $("slider").value = String(state.sec);
    bootMap();
    wire();
    atlas.init(data);
    drawMap();
    fitPatterns(catalogPatterns());
    paintClock();
    renderBody();
    updateBuses();
    requestAnimationFrame(loop);
    setInterval(() => loadLive(false), 30000);
    loadFleet();
    setInterval(loadFleet, FLEET_POLL);
    setTimeout(() => map.invalidateSize(), 200);
  }

  main().catch((error) => {
    $("body").append(h("p", "empty", "No se han podido cargar los horarios (" + error.message + ")."));
  });
})();
