/* Vista 3D del recorrido: girar, acercar y pulsar cada parada. */
(function () {
  function create(canvas, hooks) {
    const THREE = window.THREE;
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x07080c, 1);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x07080c, 70, 240);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
    const routeGroup = new THREE.Group();
    const stopGroup = new THREE.Group();
    const busGroup = new THREE.Group();
    scene.add(routeGroup, stopGroup, busGroup);

    const orbit = { theta: 0.62, phi: 1.02, radius: 90, target: new THREE.Vector3() };
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projector = new THREE.Vector3();
    let originLat = 42.22;
    let originLon = -8.72;
    let scale = 0.008;
    let metersLon = 82000;
    let ready = false;
    let focus = null;
    let hover = null;
    const busMeshes = new Map();
    const flatPaths = new Map();
    const labelPool = [];
    const routes = [];
    const stops = [];

    const dotGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 18);
    const stopHaloGeo = new THREE.CircleGeometry(0.42, 22);
    const haloGeo = new THREE.SphereGeometry(0.48, 14, 10);
    const busGeo = new THREE.BoxGeometry(1.4, 0.42, 0.5);
    const roofGeo = new THREE.BoxGeometry(1.32, 0.06, 0.44);
    const windowGeo = new THREE.BoxGeometry(1.08, 0.15, 0.52);
    const screenGeo = new THREE.BoxGeometry(0.03, 0.2, 0.42);
    const wheelGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.07, 14);
    wheelGeo.rotateX(Math.PI / 2);
    const lampGeo = new THREE.BoxGeometry(0.03, 0.06, 0.09);
    const glassMat = new THREE.MeshBasicMaterial({ color: 0x1b2230 });
    const roofMat = new THREE.MeshBasicMaterial({ color: 0xf7f3ea });
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xe9e3d6 });
    const stopHaloMats = {
      0xfff6e8: new THREE.MeshBasicMaterial({ color: 0xfff6e8, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
      0xf0c14a: new THREE.MeshBasicMaterial({ color: 0xf0c14a, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
      0xff6a3c: new THREE.MeshBasicMaterial({ color: 0xff6a3c, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
    };
    const wheelMat = new THREE.MeshBasicMaterial({ color: 0x0b0c10 });
    const headMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a });
    const beamGeo = new THREE.CylinderGeometry(0.05, 0.16, 5, 10, 1, true);
    beamGeo.translate(0, 2.5, 0);
    const hitGeo = new THREE.SphereGeometry(1.15, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.25, 28),
      new THREE.MeshBasicMaterial({ color: 0xfff6e8, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ring.renderOrder = 8;
    scene.add(ring);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({ color: 0x10141c, transparent: true, opacity: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.4;
    scene.add(ground);

    function resize() {
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
        renderer.setSize(width, height, false);
      }
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }

    function project(lat, lon, y) {
      return {
        x: (lon - originLon) * metersLon * scale,
        y: y || 0,
        z: -(lat - originLat) * 111320 * scale,
      };
    }

    function init(pack) {
      let slat = 0;
      let slon = 0;
      let n = 0;
      let minLat = 90;
      let maxLat = -90;
      let minLon = 180;
      let maxLon = -180;
      pack.patterns.forEach((pattern) => {
        pattern.pts.forEach((pt) => {
          slat += pt[0];
          slon += pt[1];
          n += 1;
          minLat = Math.min(minLat, pt[0]);
          maxLat = Math.max(maxLat, pt[0]);
          minLon = Math.min(minLon, pt[1]);
          maxLon = Math.max(maxLon, pt[1]);
        });
      });
      if (!n) return;
      originLat = slat / n;
      originLon = slon / n;
      metersLon = 111320 * Math.cos((originLat * Math.PI) / 180);
      const span = Math.max((maxLat - minLat) * 111320, (maxLon - minLon) * metersLon, 1000);
      scale = 86 / span;
      ground.scale.set(span * scale * 0.9, span * scale * 0.9, 1);
      ready = true;
    }

    function decimate(pts) {
      if (pts.length < 3) return pts;
      const out = [pts[0]];
      let last = pts[0];
      for (let i = 1; i < pts.length - 1; i++) {
        const east = (pts[i][1] - last[1]) * metersLon;
        const north = (pts[i][0] - last[0]) * 111320;
        if (Math.hypot(east, north) >= 45) {
          out.push(pts[i]);
          last = pts[i];
        }
      }
      out.push(pts[pts.length - 1]);
      return out;
    }

    function offsetPath(path, amount) {
      if (!amount) return path;
      return path.map((point, index) => {
        const a = path[Math.max(0, index - 1)];
        const b = path[Math.min(path.length - 1, index + 1)];
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len;
        dz /= len;
        return { x: point.x + -dz * amount, z: point.z + dx * amount };
      });
    }

    function ribbonGeometry(path, halfWidth, y) {
      if (path.length < 2) return null;
      const positions = [];
      const indices = [];
      for (let i = 0; i < path.length; i++) {
        const prev = path[Math.max(0, i - 1)];
        const next = path[Math.min(path.length - 1, i + 1)];
        let dx = next.x - prev.x;
        let dz = next.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        const px = -dz / len * halfWidth;
        const pz = dx / len * halfWidth;
        positions.push(path[i].x + px, y, path[i].z + pz, path[i].x - px, y, path[i].z - pz);
      }
      for (let i = 0; i < path.length - 1; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      return geometry;
    }

    function disposeGroup(group) {
      group.children.slice().forEach((child) => {
        child.traverse((node) => {
          if (node.userData.ownGeo && node.geometry) node.geometry.dispose();
          if (node.userData.ownMat && node.material) node.material.dispose();
        });
        group.remove(child);
      });
    }

    function appearance(pattern, dim) {
      const color = pattern.line === "C3d" ? 0xf0c14a : 0xff6a3c;
      if (dim) return { color: 0x6e685e, core: 0.16, glow: 0.04 };
      const state = hooks.getState();
      const trips = pattern[state.day];
      const open = trips.some((times) => state.sec >= times[0] && state.sec <= times[times.length - 1]);
      const last = trips.length ? trips[trips.length - 1] : null;
      const started = last && state.sec >= trips[0][0] && state.sec <= last[last.length - 1];
      if (open) return { color: color, core: 1, glow: 0.34 };
      if (started) return { color: color, core: 0.62, glow: 0.16 };
      return { color: 0x9a9284, core: 0.4, glow: 0.08 };
    }

    function addRibbon(path, y, halfWidth, look, pattern, order, glow) {
      const geometry = ribbonGeometry(path, halfWidth, y);
      if (!geometry) return;
      const material = new THREE.MeshBasicMaterial({
        color: look.color,
        transparent: true,
        opacity: glow ? look.glow : look.core,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { ownGeo: true, ownMat: true, kind: glow ? "glow" : "route", pattern: pattern };
      mesh.renderOrder = order;
      if (glow) mesh.raycast = function () {};
      routeGroup.add(mesh);
      routes.push({ mesh: mesh, pattern: pattern, glow: glow });
    }

    function sync(shown) {
      if (!ready) return;
      disposeGroup(routeGroup);
      disposeGroup(stopGroup);
      routes.length = 0;
      stops.length = 0;
      flatPaths.clear();
      const state = hooks.getState();
      const served = new Map();
      shown.forEach((pattern, index) => {
        const dim = state.pattern !== null && pattern._i !== state.pattern;
        const path = decimate(pattern.pts).map((pt) => project(pt[0], pt[1], 0));
        flatPaths.set(pattern._i, path);
        const shifted = offsetPath(path, 0.5);
        const look = appearance(pattern, dim);
        addRibbon(shifted, 0.04, 0.34, look, pattern, index, true);
        addRibbon(shifted, 0.16, 0.13, look, pattern, 20 + index, false);
        pattern.stops.forEach(([stopId]) => {
          if (dim) return;
          if (!served.has(stopId)) served.set(stopId, { lines: new Set(), path: flatPaths.get(pattern._i) });
          served.get(stopId).lines.add(pattern.line);
        });
      });
      const pack = hooks.getData();
      served.forEach((entry, stopId) => {
        const stop = pack.stops[stopId];
        const at = curbPoint(project(stop.lat, stop.lon, 0.24), entry.path, entry.lines.size === 1 ? 0.86 : 0);
        let color = 0xfff6e8;
        if (entry.lines.size === 1) color = entry.lines.has("C3d") ? 0xf0c14a : 0xff6a3c;
        const mesh = new THREE.Mesh(dotGeo, dotMat);
        mesh.position.set(at.x, at.y, at.z);
        mesh.userData = { kind: "stop", stopId: stopId, name: stop.n };
        const halo = new THREE.Mesh(stopHaloGeo, stopHaloMats[color]);
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = -0.02;
        halo.raycast = function () {};
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.userData = mesh.userData;
        mesh.add(halo, hit);
        mesh.renderOrder = 6;
        stopGroup.add(mesh);
        stops.push(mesh);
      });
      const selected = stops.find((mesh) => mesh.userData.stopId === state.stop);
      ring.visible = Boolean(selected);
      if (selected) ring.position.set(selected.position.x, 0.2, selected.position.z);
    }

    function syncLight() {
      routes.forEach((entry) => {
        const state = hooks.getState();
        const dim = state.pattern !== null && entry.pattern._i !== state.pattern;
        const look = appearance(entry.pattern, dim);
        entry.mesh.material.color.setHex(look.color);
        entry.mesh.material.opacity = entry.glow ? look.glow : look.core;
      });
    }

    function curbPoint(point, path, amount) {
      if (!path || !path.length || !amount) return point;
      let best = 0;
      let bestD = Infinity;
      path.forEach((sample, index) => {
        const dist = (sample.x - point.x) ** 2 + (sample.z - point.z) ** 2;
        if (dist < bestD) {
          bestD = dist;
          best = index;
        }
      });
      const a = path[Math.max(0, best - 1)];
      const b = path[Math.min(path.length - 1, best + 1)];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      return {
        x: point.x + (-dz / len) * amount,
        y: point.y,
        z: point.z + (dx / len) * amount,
      };
    }

    function ride(pattern, lat, lon) {
      const point = project(lat, lon, 0.52);
      const path = flatPaths.get(pattern._i);
      return curbPoint(point, path, 0.5);
    }

    function syncBuses(active) {
      if (!ready) return;
      const seen = new Set();
      active.forEach((bus) => {
        if (!bus.pose.at) return;
        const key = bus.key || bus.pattern._i + ":" + bus.tripIndex;
        seen.add(key);
        let mesh = busMeshes.get(key);
        const color = bus.pattern.line === "C3d" ? 0xf0c14a : 0xff6a3c;
        const ghost = Boolean(bus.ghost);
        if (!mesh) {
          mesh = new THREE.Mesh(
            busGeo,
            new THREE.MeshBasicMaterial({ color: color, transparent: ghost, opacity: ghost ? 0.3 : 1, depthWrite: !ghost })
          );
          mesh.userData = { ownMat: true, kind: "bus", pattern: bus.pattern, trip: bus.tripIndex, ghost: ghost };
          const roof = new THREE.Mesh(roofGeo, roofMat);
          roof.position.y = 0.24;
          const band = new THREE.Mesh(windowGeo, glassMat);
          band.position.set(-0.08, 0.08, 0);
          const screen = new THREE.Mesh(screenGeo, glassMat);
          screen.position.set(0.71, 0.06, 0);
          mesh.add(roof, band, screen);
          [[0.44, 0.24], [0.44, -0.24], [-0.44, 0.24], [-0.44, -0.24]].forEach(([x, z]) => {
            const wheel = new THREE.Mesh(wheelGeo, wheelMat);
            wheel.position.set(x, -0.2, z);
            mesh.add(wheel);
          });
          [0.15, -0.15].forEach((z) => {
            const head = new THREE.Mesh(lampGeo, headMat);
            head.position.set(0.71, -0.12, z);
            const tail = new THREE.Mesh(lampGeo, tailMat);
            tail.position.set(-0.71, -0.12, z);
            mesh.add(head, tail);
          });
          const halo = new THREE.Mesh(
            haloGeo,
            new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.4, depthWrite: false })
          );
          halo.scale.set(2.2, 0.9, 1.4);
          halo.position.y = -0.25;
          halo.userData = { ownMat: true };
          halo.raycast = function () {};
          const beam = new THREE.Mesh(
            beamGeo,
            new THREE.MeshBasicMaterial({
              color: color,
              transparent: true,
              opacity: 0.45,
              depthWrite: false,
              blending: THREE.AdditiveBlending,
              side: THREE.DoubleSide,
            })
          );
          beam.userData = { ownMat: true };
          beam.raycast = function () {};
          if (ghost) mesh.children.forEach((child) => { child.visible = false; });
          beam.visible = !ghost;
          mesh.add(halo, beam);
          mesh.userData.parts = { halo: halo, beam: beam };
          mesh.renderOrder = 9;
          busGroup.add(mesh);
          busMeshes.set(key, mesh);
        }
        const at = ride(bus.pattern, bus.pose.at[0], bus.pose.at[1]);
        mesh.position.set(at.x, at.y, at.z);
        mesh.rotation.y = ((90 - bus.pose.heading) * Math.PI) / 180;
        const parts = mesh.userData.parts;
        parts.halo.material.opacity = ghost ? 0.12 : bus.pose.dwell ? 0.6 : 0.4;
        parts.beam.material.opacity = bus.pose.dwell ? 0.2 : bus.live ? 0.6 : 0.45;
        mesh.userData.pattern = bus.pattern;
        mesh.userData.trip = bus.tripIndex;
        mesh.userData.live = Boolean(bus.live);
        mesh.userData.note = bus.live ? (bus.delayText || "en vivo") : ghost ? "horario, sin bus en vivo" : "";
      });
      for (const key of busMeshes.keys()) {
        if (seen.has(key)) continue;
        const mesh = busMeshes.get(key);
        mesh.traverse((node) => {
          if (node.userData.ownMat && node.material) node.material.dispose();
        });
        busGroup.remove(mesh);
        busMeshes.delete(key);
      }
    }

    function boundsOf(patterns) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      patterns.forEach((pattern) => {
        pattern.pts.forEach((pt) => {
          const p = project(pt[0], pt[1], 0);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x);
          minZ = Math.min(minZ, p.z);
          maxZ = Math.max(maxZ, p.z);
        });
      });
      if (!Number.isFinite(minX)) return null;
      return {
        x: (minX + maxX) / 2,
        z: (minZ + maxZ) / 2,
        span: Math.max(maxX - minX, maxZ - minZ, 8),
      };
    }

    function frame(patterns) {
      const box = boundsOf(patterns);
      if (!box) return;
      focus = { x: box.x, z: box.z, radius: box.span * 1.55 };
      orbit.phi = 0.96;
      orbit.theta = 0.5;
    }

    function focusAt(lat, lon, radius) {
      const point = project(lat, lon, 0);
      focus = { x: point.x, z: point.z, radius: radius || Math.min(orbit.radius, 26) };
    }

    function applyCamera() {
      const sin = Math.sin(orbit.phi);
      const cos = Math.cos(orbit.phi);
      const st = Math.sin(orbit.theta);
      const ct = Math.cos(orbit.theta);
      camera.position.set(
        orbit.target.x + orbit.radius * sin * st,
        orbit.radius * cos,
        orbit.target.z + orbit.radius * sin * ct
      );
      camera.up.set(-cos * st, sin, -cos * ct);
      camera.lookAt(orbit.target);
    }

    function tick() {
      if (!ready || canvas.clientWidth === 0) return;
      resize();
      if (focus) {
        orbit.target.x += (focus.x - orbit.target.x) * 0.12;
        orbit.target.z += (focus.z - orbit.target.z) * 0.12;
        orbit.radius += (focus.radius - orbit.radius) * 0.12;
        if (Math.abs(focus.x - orbit.target.x) < 0.04 && Math.abs(focus.radius - orbit.radius) < 0.08) focus = null;
      }
      if (!dragging) {
        orbit.theta += spin.theta;
        orbit.phi += spin.phi;
        spin.theta *= 0.86;
        spin.phi *= 0.86;
        if (Math.abs(spin.theta) < 0.00005) spin.theta = 0;
        if (Math.abs(spin.phi) < 0.00005) spin.phi = 0;
      }
      orbit.phi = Math.max(0.34, Math.min(1.02, orbit.phi));
      orbit.radius = Math.max(6, Math.min(220, orbit.radius));
      applyCamera();
      const dotScale = Math.max(0.7, Math.min(1.6, orbit.radius / 56));
      const busScale = Math.max(1, Math.min(2.8, orbit.radius / 36));
      const selected = hooks.getState().stop;
      stops.forEach((mesh) => {
        mesh.scale.setScalar(mesh.userData.stopId === selected ? dotScale * 1.75 : dotScale);
      });
      busGroup.children.forEach((mesh) => {
        mesh.scale.setScalar(busScale);
      });
      if (ring.visible) ring.scale.setScalar(1 + Math.sin(performance.now() / 280) * 0.06);
      renderer.render(scene, camera);
      placeLabels();
      if (!dragging && hoverEvent) {
        const object = pick(hoverEvent);
        hover = object && object.userData.kind === "stop" ? object : null;
        canvas.classList.toggle("pointing", Boolean(object));
        showTip(hoverEvent, object);
      }
    }

    function placeLabels() {
      const root = document.getElementById("atlas-labels");
      if (!root) return;
      const rect = canvas.getBoundingClientRect();
      const state = hooks.getState();
      const picked = [];
      const zoomed = orbit.radius < 48;
      stops.forEach((mesh) => {
        const forced = mesh.userData.stopId === state.stop || mesh === hover;
        if (!forced && !zoomed) return;
        projector.set(mesh.position.x, mesh.position.y, mesh.position.z).project(camera);
        if (projector.z > 1) return;
        const x = (projector.x * 0.5 + 0.5) * rect.width;
        const y = (-projector.y * 0.5 + 0.5) * rect.height;
        if (x < 8 || y < 8 || x > rect.width - 8 || y > rect.height - 120) return;
        if (!forced && x < 440) return;
        picked.push({ mesh: mesh, x: x, y: y, forced: forced });
      });
      picked.sort((a, b) => Number(b.forced) - Number(a.forced));
      const placed = [];
      picked.forEach((item) => {
        if (!item.forced && placed.some((other) => Math.hypot(other.x - item.x, other.y - item.y) < 64)) return;
        if (placed.length > 22 && !item.forced) return;
        placed.push(item);
      });
      while (labelPool.length < placed.length) {
        const node = document.createElement("span");
        root.appendChild(node);
        labelPool.push(node);
      }
      labelPool.forEach((node, index) => {
        const item = placed[index];
        if (!item) {
          node.hidden = true;
          return;
        }
        node.hidden = false;
        node.textContent = item.mesh.userData.name;
        node.className = item.mesh.userData.stopId === state.stop ? "on" : "";
        node.style.left = item.x + "px";
        node.style.top = item.y + "px";
      });
    }

    function pick(event) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(busGroup.children.concat(stopGroup.children, routeGroup.children), true);
      if (!hits.length) return null;
      let object = hits[0].object;
      while (object && !object.userData.kind && object.parent) object = object.parent;
      return object && object.userData.kind ? object : null;
    }

    function showTip(event, object) {
      const tip = document.getElementById("atlas-tip");
      if (!tip) return;
      if (!object) {
        tip.classList.remove("on");
        return;
      }
      const data = object.userData;
      if (data.kind === "stop") tip.textContent = data.name;
      else if (data.kind === "bus") tip.textContent = data.pattern.line + " → " + data.pattern.to + (data.note ? " · " + data.note : "");
      else if (data.kind === "route") tip.textContent = data.pattern.line + " · " + data.pattern.head;
      else {
        tip.classList.remove("on");
        return;
      }
      tip.classList.add("on");
      const rect = canvas.getBoundingClientRect();
      tip.style.left = Math.min(rect.width - 220, event.clientX - rect.left + 14) + "px";
      tip.style.top = (event.clientY - rect.top + 16) + "px";
    }

    let dragging = false;
    const spin = { theta: 0, phi: 0 };
    const panRight = new THREE.Vector3();
    const panUp = new THREE.Vector3();
    let drag = null;
    let hoverEvent = null;

    function clampOrbit() {
      orbit.phi = Math.max(0.34, Math.min(1.02, orbit.phi));
      orbit.radius = Math.max(6, Math.min(220, orbit.radius));
    }

    function onPointerMove(event) {
      if (!drag) {
        hoverEvent = event;
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) > 3) drag.moved = true;
      if (!dx && !dy) return;
      focus = null;
      if (drag.button === 2 || drag.button === 1 || event.shiftKey) {
        applyCamera();
        camera.updateMatrixWorld();
        panRight.setFromMatrixColumn(camera.matrixWorld, 0);
        panUp.setFromMatrixColumn(camera.matrixWorld, 1);
        const scale = orbit.radius * 0.0018;
        orbit.target.addScaledVector(panRight, -dx * scale);
        orbit.target.addScaledVector(panUp, dy * scale);
        spin.theta = 0;
        spin.phi = 0;
      } else {
        const speed = (2 * Math.PI) / Math.max(canvas.clientHeight, 320);
        const dTheta = -dx * speed;
        const dPhi = -dy * speed * 0.72;
        orbit.theta += dTheta;
        orbit.phi += dPhi;
        spin.theta = dTheta * 0.4;
        spin.phi = dPhi * 0.4;
        clampOrbit();
      }
      applyCamera();
      renderer.render(scene, camera);
    }

    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("dragstart", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button > 2) return;
      event.preventDefault();
      focus = null;
      spin.theta = 0;
      spin.phi = 0;
      drag = {
        x: event.clientX,
        y: event.clientY,
        sx: event.clientX,
        sy: event.clientY,
        button: event.button,
        moved: false,
      };
      dragging = true;
      canvas.classList.add("dragging");
      try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* el arrastre sigue en window */ }
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) hoverEvent = event;
    });
    function endDrag(event) {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      if (!drag) return;
      canvas.classList.remove("dragging");
      const moved = drag.moved;
      dragging = false;
      drag = null;
      if (moved) return;
      const object = pick(event);
      if (!object) return;
      const data = object.userData;
      if (data.kind === "stop") hooks.onStop(data.stopId);
      else if (data.kind === "bus") hooks.onTrip(data.pattern._i, data.trip);
      else if (data.kind === "route") hooks.onPattern(data.pattern._i);
    }
    canvas.addEventListener("pointercancel", () => {
      dragging = false;
      drag = null;
      spin.theta = 0;
      spin.phi = 0;
      canvas.classList.remove("dragging");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
    });
    canvas.addEventListener("pointerleave", (event) => {
      if (drag) return;
      hover = null;
      hoverEvent = null;
      canvas.classList.remove("pointing");
      showTip(event, null);
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      focus = null;
      const line = event.deltaMode === 1 ? 16 : 1;
      orbit.radius *= Math.exp(event.deltaY * line * 0.0011);
      clampOrbit();
      applyCamera();
      renderer.render(scene, camera);
    }, { passive: false });

    return { init: init, resize: resize, sync: sync, syncLight: syncLight, syncBuses: syncBuses, frame: frame, focusAt: focusAt, tick: tick };
  }

  window.Atlas3D = create;
})();
