/* Vista 3D del recorrido: girar, acercar y pulsar cada parada. */
(function () {
  function create(canvas, hooks) {
    const THREE = window.THREE;
    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x07080c, 0.004);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
    const routeGroup = new THREE.Group();
    const stopGroup = new THREE.Group();
    const busGroup = new THREE.Group();
    scene.add(routeGroup, stopGroup, busGroup);

    scene.add(new THREE.HemisphereLight(0xa9bce6, 0x2a2016, 0.85));
    const sun = new THREE.DirectionalLight(0xfff1dc, 0.75);
    sun.position.set(-30, 60, 25);
    scene.add(sun);

    const orbit = { theta: 0.5, phi: 0.96, radius: 90, target: new THREE.Vector3() };
    const goal = { theta: 0.5, phi: 0.96, radius: 90, target: new THREE.Vector3() };
    const PHI_MIN = 0.04;
    const PHI_MAX = 1.12;
    const OBLIQUE = 0.96;
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const projector = new THREE.Vector3();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const groundHit = new THREE.Vector3();
    let originLat = 42.22;
    let originLon = -8.72;
    let scale = 0.008;
    let metersLon = 82000;
    let ready = false;
    let hover = null;
    let hoverBus = null;
    let follow = null;
    let lastTick = 0;
    const busMeshes = new Map();
    const flatPaths = new Map();
    const labelPool = [];
    const routes = [];
    const stops = [];
    const dotBatches = [];
    const dummy = new THREE.Object3D();
    const AXIS_Y = new THREE.Vector3(0, 1, 0);

    function canvasTexture(width, height, paint) {
      const node = document.createElement("canvas");
      node.width = width;
      node.height = height;
      paint(node.getContext("2d"), width, height);
      return new THREE.CanvasTexture(node);
    }

    function radial(stops) {
      return canvasTexture(64, 64, (ctx, w, h) => {
        const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        stops.forEach(([at, color]) => g.addColorStop(at, color));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      });
    }

    const glowTex = radial([[0, "rgba(255,255,255,1)"], [0.3, "rgba(255,255,255,0.42)"], [1, "rgba(255,255,255,0)"]]);
    const shadowTex = radial([[0, "rgba(0,0,0,0.9)"], [0.45, "rgba(0,0,0,0.5)"], [1, "rgba(0,0,0,0)"]]);
    const bandTex = canvasTexture(4, 64, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.32, "rgba(255,255,255,0.3)");
      g.addColorStop(0.5, "rgba(255,255,255,1)");
      g.addColorStop(0.68, "rgba(255,255,255,0.3)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    const flowTex = canvasTexture(128, 4, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.5, "rgba(255,255,255,0)");
      g.addColorStop(0.86, "rgba(255,255,255,0.75)");
      g.addColorStop(0.92, "rgba(255,255,255,1)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
    flowTex.wrapS = THREE.RepeatWrapping;
    const fadeTex = canvasTexture(4, 64, (ctx, w, h) => {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(1, "rgba(255,255,255,1)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });

    const LINE_COLOR = { C3d: 0xf0c14a, C3i: 0xff6a3c };
    const noRay = function () {};

    function flatPlane(material, sx, sz, y) {
      const mesh = new THREE.Mesh(planeGeo, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.scale.set(sx, sz, 1);
      mesh.position.y = y;
      mesh.raycast = noRay;
      return mesh;
    }

    const planeGeo = new THREE.PlaneGeometry(1, 1);
    const dotGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.05, 20);
    const dotMats = {};
    [0xfff6e8, LINE_COLOR.C3d, LINE_COLOR.C3i].forEach((color) => {
      dotMats[color] = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 1 });
    });
    const hitGeo = new THREE.SphereGeometry(1.15, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });

    const additive = (color, map, opacity) => new THREE.MeshBasicMaterial({
      color: color,
      map: map,
      transparent: true,
      opacity: opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });

    const marker = new THREE.Group();
    const markerRing = new THREE.Mesh(
      new THREE.RingGeometry(0.62, 0.74, 40),
      new THREE.MeshBasicMaterial({ color: 0xfff6e8, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false })
    );
    markerRing.rotation.x = -Math.PI / 2;
    markerRing.raycast = noRay;
    const columnGeo = new THREE.CylinderGeometry(0.03, 0.03, 3.4, 10, 1, true);
    columnGeo.translate(0, 1.7, 0);
    const markerColumn = new THREE.Mesh(columnGeo, additive(0xfff6e8, fadeTex, 0.7));
    markerColumn.raycast = noRay;
    const markerGlow = flatPlane(additive(0xfff6e8, glowTex, 0.55), 2.6, 2.6, -0.02);
    const markerShadow = flatPlane(new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.55, depthWrite: false }), 2.2, 2.2, -0.04);
    marker.add(markerShadow, markerGlow, markerRing, markerColumn);
    marker.visible = false;
    marker.renderOrder = 8;
    scene.add(marker);

    const hoverGlow = flatPlane(additive(0xfff6e8, glowTex, 0.6), 1.7, 1.7, 0.2);
    hoverGlow.visible = false;
    scene.add(hoverGlow);

    const bodyGeo = (function () {
      const L = 0.7;
      const W = 0.25;
      const r = 0.1;
      const shape = new THREE.Shape();
      shape.moveTo(-L + r, -W);
      shape.lineTo(L - r, -W);
      shape.quadraticCurveTo(L, -W, L, -W + r);
      shape.lineTo(L, W - r);
      shape.quadraticCurveTo(L, W, L - r, W);
      shape.lineTo(-L + r, W);
      shape.quadraticCurveTo(-L, W, -L, W - r);
      shape.lineTo(-L, -W + r);
      shape.quadraticCurveTo(-L, -W, -L + r, -W);
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: 0.34,
        bevelEnabled: true,
        bevelThickness: 0.04,
        bevelSize: 0.03,
        bevelSegments: 2,
        curveSegments: 5,
      });
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, -0.17, 0);
      return geometry;
    })();
    function mergeParts(parts) {
      const positions = [];
      const normals = [];
      const colors = [];
      const tint = new THREE.Color();
      parts.forEach(([geometry, color, x, y, z]) => {
        const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
        flat.translate(x, y, z);
        tint.setHex(color);
        const pos = flat.attributes.position;
        const nor = flat.attributes.normal;
        for (let i = 0; i < pos.count; i++) {
          positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
          normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
          colors.push(tint.r, tint.g, tint.b);
        }
        flat.dispose();
      });
      const merged = new THREE.BufferGeometry();
      merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
      merged.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
      return merged;
    }

    const roofGeo = new THREE.BoxGeometry(1.26, 0.05, 0.44);
    const stripeGeo = new THREE.BoxGeometry(1.47, 0.035, 0.57);
    const windowGeo = new THREE.BoxGeometry(1.08, 0.14, 0.565);
    const screenGeo = new THREE.BoxGeometry(0.03, 0.2, 0.46);
    const wheelGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.07, 16);
    wheelGeo.rotateX(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.075, 10);
    hubGeo.rotateX(Math.PI / 2);
    const lampGeo = new THREE.BoxGeometry(0.03, 0.06, 0.09);
    const busGeos = {};
    Object.values(LINE_COLOR).forEach((color) => {
      const parts = [
        [bodyGeo, color, 0, 0, 0],
        [roofGeo, new THREE.Color(0xf7f3ea).lerp(new THREE.Color(color), 0.3).getHex(), -0.02, 0.235, 0],
        [stripeGeo, 0xfff6e8, 0, -0.07, 0],
        [windowGeo, 0x161c28, -0.06, 0.07, 0],
        [screenGeo, 0x1c2434, 0.735, 0.05, 0],
      ];
      [[0.44, 0.245], [0.44, -0.245], [-0.44, 0.245], [-0.44, -0.245]].forEach(([x, z]) => {
        parts.push([wheelGeo, 0x0b0c10, x, -0.2, z], [hubGeo, 0x9a9fa8, x, -0.2, z]);
      });
      [0.16, -0.16].forEach((z) => {
        parts.push([lampGeo, 0xffffff, 0.735, -0.12, z], [lampGeo, 0xff2a1a, -0.735, -0.12, z]);
      });
      busGeos[color] = mergeParts(parts);
    });
    const beamGeo = new THREE.CylinderGeometry(0.03, 0.14, 2.2, 12, 1, true);
    beamGeo.translate(0, 1.1 + 0.26, 0);
    const liveRingGeo = new THREE.RingGeometry(0.62, 0.72, 40);
    liveRingGeo.rotateX(-Math.PI / 2);

    const ghostMats = {};
    const busGlowMats = {};
    Object.values(LINE_COLOR).forEach((color) => {
      ghostMats[color] = new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.28, depthWrite: false });
      busGlowMats[color] = additive(color, glowTex, 0.38);
    });
    const busMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
    const headGlowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xfff3d6, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending });
    const tailGlowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xff3a22, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending });
    const busShadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.7, depthWrite: false });
    const liveRingMat = additive(0xffffff, null, 0.5);

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

    function segNormal(a, b) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      return len ? { x: -dz / len, z: dx / len } : null;
    }

    function miters(path) {
      return path.map((point, i) => {
        const n0 = i > 0 ? segNormal(path[i - 1], point) : null;
        const n1 = i < path.length - 1 ? segNormal(point, path[i + 1]) : null;
        const a = n0 || n1;
        const b = n1 || n0;
        if (!a) return { x: 0, z: 0, k: 1 };
        let mx = a.x + b.x;
        let mz = a.z + b.z;
        let len = Math.hypot(mx, mz);
        if (len < 1e-6) {
          mx = a.x;
          mz = a.z;
          len = 1;
        }
        mx /= len;
        mz /= len;
        const k = Math.min(2.2, 1 / Math.max(mx * b.x + mz * b.z, 0.2));
        return { x: mx, z: mz, k: k };
      });
    }

    function offsetPath(path, amount) {
      if (!amount) return path;
      const m = miters(path);
      return path.map((point, i) => ({ x: point.x + m[i].x * amount * m[i].k, z: point.z + m[i].z * amount * m[i].k }));
    }

    function ribbonGeometry(path, halfWidth, y, period) {
      if (path.length < 2) return null;
      const m = miters(path);
      const positions = [];
      const uvs = [];
      const indices = [];
      let dist = 0;
      for (let i = 0; i < path.length; i++) {
        if (i > 0) dist += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
        const w = halfWidth * m[i].k;
        positions.push(path[i].x + m[i].x * w, y, path[i].z + m[i].z * w, path[i].x - m[i].x * w, y, path[i].z - m[i].z * w);
        uvs.push(dist / period, 1, dist / period, 0);
      }
      for (let i = 0; i < path.length - 1; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      return geometry;
    }

    function disposeNode(node) {
      if (node.userData.ownGeo && node.geometry) node.geometry.dispose();
      if (node.userData.ownTex && node.material && node.material.map) node.material.map.dispose();
      if (node.userData.ownMat && node.material) node.material.dispose();
      if (node.isInstancedMesh && node.dispose) node.dispose();
    }

    function disposeGroup(group) {
      group.children.slice().forEach((child) => {
        child.traverse(disposeNode);
        group.remove(child);
      });
    }

    function appearance(pattern, dim) {
      const color = LINE_COLOR[pattern.line] || LINE_COLOR.C3i;
      if (dim) return { color: 0x6e685e, core: 0.16, glow: 0.05, open: false };
      const state = hooks.getState();
      const trips = pattern[state.day];
      const open = trips.some((times) => state.sec >= times[0] && state.sec <= times[times.length - 1]);
      const last = trips.length ? trips[trips.length - 1] : null;
      const started = last && state.sec >= trips[0][0] && state.sec <= last[last.length - 1];
      if (open) return { color: color, core: 1, glow: 0.6, open: true };
      if (started) return { color: color, core: 0.62, glow: 0.28, open: false };
      return { color: 0x9a9284, core: 0.4, glow: 0.12, open: false };
    }

    const RIBBON = {
      glow: { y: 0.03, half: 0.5, period: 4, order: 0 },
      core: { y: 0.16, half: 0.07, period: 4, order: 20 },
      flow: { y: 0.18, half: 0.06, period: 3.2, order: 40 },
    };

    function paintRibbon(entry, look) {
      const material = entry.mesh.material;
      if (entry.kind === "flow") {
        entry.mesh.visible = look.open;
        material.color.setHex(0xffffff);
        material.opacity = 0.75;
        return;
      }
      material.color.setHex(look.color);
      material.opacity = entry.kind === "glow" ? look.glow : look.core;
    }

    function addRibbon(path, kind, look, pattern, index) {
      const spec = RIBBON[kind];
      const geometry = ribbonGeometry(path, spec.half, spec.y, spec.period);
      if (!geometry) return;
      const material = kind === "core"
        ? new THREE.MeshBasicMaterial({ color: look.color, transparent: true, depthWrite: false, side: THREE.DoubleSide })
        : additive(look.color, kind === "glow" ? bandTex : flowTex, 1);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData = { ownGeo: true, ownMat: true, kind: kind === "core" ? "route" : kind, pattern: pattern };
      mesh.renderOrder = spec.order + index;
      if (kind !== "core") mesh.raycast = noRay;
      routeGroup.add(mesh);
      const entry = { mesh: mesh, pattern: pattern, kind: kind };
      paintRibbon(entry, look);
      routes.push(entry);
    }

    function sync(shown) {
      if (!ready) return;
      disposeGroup(routeGroup);
      disposeGroup(stopGroup);
      routes.length = 0;
      stops.length = 0;
      flatPaths.clear();
      hover = null;
      const state = hooks.getState();
      const served = new Map();
      shown.forEach((pattern, index) => {
        const dim = state.pattern !== null && pattern._i !== state.pattern;
        const path = decimate(pattern.pts).map((pt) => project(pt[0], pt[1], 0));
        flatPaths.set(pattern._i, path);
        const shifted = offsetPath(path, 0.5);
        const look = appearance(pattern, dim);
        addRibbon(shifted, "glow", look, pattern, index);
        addRibbon(shifted, "core", look, pattern, index);
        addRibbon(shifted, "flow", look, pattern, index);
        pattern.stops.forEach(([stopId]) => {
          if (dim) return;
          if (!served.has(stopId)) served.set(stopId, { lines: new Set(), path: flatPaths.get(pattern._i) });
          served.get(stopId).lines.add(pattern.line);
        });
      });
      const pack = hooks.getData();
      served.forEach((entry, stopId) => {
        const stop = pack.stops[stopId];
        const at = curbPoint(project(stop.lat, stop.lon, 0.22), entry.path, entry.lines.size === 1 ? 0.86 : 0);
        let color = 0xfff6e8;
        if (entry.lines.size === 1) color = entry.lines.has("C3d") ? LINE_COLOR.C3d : LINE_COLOR.C3i;
        const mesh = new THREE.Mesh(hitGeo, hitMat);
        mesh.position.set(at.x, at.y, at.z);
        mesh.userData = { kind: "stop", stopId: stopId, name: stop.n, color: color };
        stopGroup.add(mesh);
        stops.push(mesh);
      });
      dotBatches.length = 0;
      Object.keys(dotMats).forEach((color) => {
        const members = stops.filter((mesh) => String(mesh.userData.color) === color);
        if (!members.length) return;
        const batch = new THREE.InstancedMesh(dotGeo, dotMats[color], members.length);
        batch.userData = { batch: true };
        batch.renderOrder = 6;
        batch.raycast = noRay;
        stopGroup.add(batch);
        dotBatches.push({ mesh: batch, members: members });
      });
      const selected = stops.find((mesh) => mesh.userData.stopId === state.stop);
      marker.visible = Boolean(selected);
      if (selected) marker.position.set(selected.position.x, 0.2, selected.position.z);
    }

    function syncLight() {
      const state = hooks.getState();
      routes.forEach((entry) => {
        const dim = state.pattern !== null && entry.pattern._i !== state.pattern;
        paintRibbon(entry, appearance(entry.pattern, dim));
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

    function shortDelay(bus) {
      if (!bus.live) return bus.ghost ? "horario" : "";
      if (bus.delay == null) return "en vivo";
      const min = Math.round(bus.delay / 60);
      if (!min) return "en hora";
      return (min > 0 ? "+" : "−") + Math.abs(min) + " min";
    }

    function paintLabel(sprite, line, note, color) {
      const node = sprite.userData.canvas;
      const ctx = node.getContext("2d");
      const w = node.width;
      const h = node.height;
      ctx.clearRect(0, 0, w, h);
      ctx.font = "700 34px system-ui, sans-serif";
      const lineW = ctx.measureText(line).width;
      ctx.font = "500 28px system-ui, sans-serif";
      const noteW = note ? ctx.measureText(note).width + 18 : 0;
      const boxW = Math.min(w - 4, lineW + noteW + 36);
      const x = (w - boxW) / 2;
      ctx.fillStyle = "rgba(8,9,12,0.86)";
      ctx.strokeStyle = "#" + color.toString(16).padStart(6, "0");
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, 8, boxW, h - 16, (h - 16) / 2);
      else ctx.rect(x, 8, boxW, h - 16);
      ctx.fill();
      ctx.stroke();
      ctx.textBaseline = "middle";
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = "700 34px system-ui, sans-serif";
      ctx.fillText(line, x + 18, h / 2 + 1);
      if (note) {
        ctx.fillStyle = "#d9d3c7";
        ctx.font = "500 28px system-ui, sans-serif";
        ctx.fillText(note, x + 18 + lineW + 18, h / 2 + 1);
      }
      sprite.material.map.needsUpdate = true;
    }

    function buildBus(color, ghost) {
      const mesh = new THREE.Mesh(ghost ? bodyGeo : busGeos[color], ghost ? ghostMats[color] : busMat);
      const parts = {};
      parts.shadow = flatPlane(busShadowMat, 2.1, 1.05, -0.3);
      parts.glow = flatPlane(busGlowMats[color], 2.9, 1.6, -0.29);
      mesh.add(parts.shadow, parts.glow);
      const solid = [];
      const head = new THREE.Sprite(headGlowMat);
      head.position.set(0.86, -0.12, 0);
      head.scale.set(0.62, 0.42, 1);
      const tail = new THREE.Sprite(tailGlowMat);
      tail.position.set(-0.86, -0.12, 0);
      tail.scale.set(0.5, 0.34, 1);
      head.raycast = noRay;
      tail.raycast = noRay;
      mesh.add(head, tail);
      solid.push(head, tail);
      parts.beam = new THREE.Mesh(beamGeo, additive(color, fadeTex, 0.5));
      parts.beam.userData = { ownMat: true };
      parts.beam.raycast = noRay;
      parts.ring = new THREE.Mesh(liveRingGeo, liveRingMat);
      parts.ring.position.y = -0.28;
      parts.ring.raycast = noRay;
      const labelCanvas = document.createElement("canvas");
      labelCanvas.width = 320;
      labelCanvas.height = 80;
      parts.label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(labelCanvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }));
      parts.label.userData = { ownMat: true, ownTex: true, canvas: labelCanvas, sig: "" };
      parts.label.position.set(0, 1.25, 0);
      parts.label.scale.set(3.2, 0.8, 1);
      parts.label.renderOrder = 30;
      parts.label.raycast = noRay;
      mesh.add(parts.beam, parts.ring, parts.label);
      parts.solid = solid;
      solid.forEach((part) => { part.visible = !ghost; });
      parts.shadow.visible = !ghost;
      parts.glow.visible = !ghost;
      parts.beam.visible = !ghost;
      mesh.renderOrder = 9;
      mesh.userData = { kind: "bus", parts: parts, ghost: ghost, color: color, phase: Math.random() * Math.PI * 2 };
      return mesh;
    }

    function syncBuses(active) {
      if (!ready) return;
      const seen = new Set();
      active.forEach((bus) => {
        if (!bus.pose.at) return;
        const key = bus.key || bus.pattern._i + ":" + bus.tripIndex;
        seen.add(key);
        const color = LINE_COLOR[bus.pattern.line] || LINE_COLOR.C3i;
        const ghost = Boolean(bus.ghost);
        let mesh = busMeshes.get(key);
        if (mesh && (mesh.userData.ghost !== ghost || mesh.userData.color !== color)) {
          mesh.traverse(disposeNode);
          busGroup.remove(mesh);
          mesh = null;
        }
        if (!mesh) {
          mesh = buildBus(color, ghost);
          busGroup.add(mesh);
          busMeshes.set(key, mesh);
        }
        const at = ride(bus.pattern, bus.pose.at[0], bus.pose.at[1]);
        const aim = ((90 - bus.pose.heading) * Math.PI) / 180;
        const jumpM = Math.hypot(at.x - mesh.position.x, at.z - mesh.position.z) / scale;
        mesh.position.set(at.x, at.y, at.z);
        const data = mesh.userData;
        if (!data.posed || jumpM > 250) {
          mesh.rotation.y = aim;
          data.posed = true;
        }
        data.aim = aim;
        data.pattern = bus.pattern;
        data.trip = bus.tripIndex;
        data.live = Boolean(bus.live);
        data.dwell = Boolean(bus.pose.dwell);
        data.note = bus.live ? (bus.delayText || "en vivo") : ghost ? "horario, sin bus en vivo" : "";
        data.parts.ring.visible = data.live;
        const note = shortDelay(bus);
        const sig = bus.pattern.line + "|" + note;
        if (data.parts.label.userData.sig !== sig) {
          data.parts.label.userData.sig = sig;
          paintLabel(data.parts.label, bus.pattern.line, note, color);
        }
      });
      for (const key of busMeshes.keys()) {
        if (seen.has(key)) continue;
        const mesh = busMeshes.get(key);
        mesh.traverse(disposeNode);
        busGroup.remove(mesh);
        busMeshes.delete(key);
        if (hoverBus === mesh) hoverBus = null;
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

    function clampGoal() {
      goal.phi = Math.max(PHI_MIN, Math.min(PHI_MAX, goal.phi));
      goal.radius = Math.max(5, Math.min(220, goal.radius));
    }

    function stopMotion() {
      spin.theta = 0;
      spin.phi = 0;
    }

    function frame(patterns) {
      const box = boundsOf(patterns);
      if (!box) return;
      follow = null;
      stopMotion();
      goal.target.set(box.x, 0, box.z);
      goal.radius = box.span * 1.55;
      goal.phi = OBLIQUE;
      goal.theta = Math.round(orbit.theta / (Math.PI * 2)) * Math.PI * 2 + 0.5;
      clampGoal();
    }

    function focusAt(lat, lon, radius) {
      const point = project(lat, lon, 0);
      follow = null;
      stopMotion();
      goal.target.set(point.x, 0, point.z);
      goal.radius = radius || Math.min(goal.radius, 26);
      clampGoal();
    }

    function setFollow(trip) {
      follow = trip ? { p: trip.p, i: trip.i } : null;
      if (follow) {
        stopMotion();
        goal.radius = Math.min(goal.radius, 22);
      }
    }

    function zoomBy(factor) {
      goal.radius *= factor;
      clampGoal();
    }

    function toggleTilt() {
      goal.phi = goal.phi < 0.5 ? OBLIQUE : PHI_MIN;
      spin.phi = 0;
    }

    function resetNorth() {
      spin.theta = 0;
      goal.theta = Math.round(orbit.theta / (Math.PI * 2)) * Math.PI * 2;
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

    function followedMesh() {
      if (!follow) return null;
      for (const mesh of busGroup.children) {
        const data = mesh.userData;
        if (data.pattern && data.pattern._i === follow.p && data.trip === follow.i) return mesh;
      }
      return null;
    }

    const controls = {
      north: document.getElementById("atlas-north"),
      needle: document.querySelector("#atlas-north .needle"),
      tilt: document.getElementById("atlas-tilt"),
      follow: document.getElementById("atlas-follow"),
    };

    function paintControls() {
      if (controls.needle) controls.needle.style.transform = "rotate(" + orbit.theta.toFixed(3) + "rad)";
      if (controls.tilt) {
        const flat = goal.phi < 0.5;
        controls.tilt.setAttribute("aria-pressed", String(flat));
        controls.tilt.classList.toggle("on", flat);
      }
      if (controls.follow) {
        const trip = hooks.getState().trip;
        controls.follow.hidden = !trip;
        controls.follow.classList.toggle("on", Boolean(follow));
        controls.follow.setAttribute("aria-pressed", String(Boolean(follow)));
      }
    }

    function screenOf(x, y, z, width, height) {
      projector.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      if (projector.z > -0.2) return null;
      projector.applyMatrix4(camera.projectionMatrix);
      return {
        x: (projector.x * 0.5 + 0.5) * width,
        y: (-projector.y * 0.5 + 0.5) * height,
      };
    }

    function unproject(x, z) {
      return {
        lat: originLat - z / (111320 * scale),
        lon: originLon + x / (metersLon * scale),
      };
    }

    function reportGround() {
      if (!hooks.onGround) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      let half = Math.max(6, orbit.radius * 0.55);
      for (let attempt = 0; attempt < 5; attempt++) {
        const corners = [
          [orbit.target.x - half, orbit.target.z - half],
          [orbit.target.x + half, orbit.target.z - half],
          [orbit.target.x + half, orbit.target.z + half],
          [orbit.target.x - half, orbit.target.z + half],
        ];
        const quad = [];
        let visible = true;
        for (let i = 0; i < 4; i++) {
          const at = screenOf(corners[i][0], 0, corners[i][1], width, height);
          if (!at) {
            visible = false;
            break;
          }
          const geo = unproject(corners[i][0], corners[i][1]);
          quad.push({ lat: geo.lat, lon: geo.lon, x: at.x, y: at.y });
        }
        if (visible) {
          hooks.onGround(quad);
          return;
        }
        half *= 0.55;
      }
    }

    function tick() {
      if (!ready || canvas.clientWidth === 0) return;
      resize();
      const now = performance.now();
      const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0.016;
      lastTick = now;
      const trip = hooks.getState().trip;
      if (follow && (!trip || trip.p !== follow.p || trip.i !== follow.i)) follow = null;
      const followed = followedMesh();
      if (followed) goal.target.set(followed.position.x, 0, followed.position.z);
      if (!dragging) {
        goal.theta += spin.theta;
        goal.phi += spin.phi;
        const decay = Math.pow(0.0002, dt);
        spin.theta *= decay;
        spin.phi *= decay;
        if (Math.abs(spin.theta) < 0.00005) spin.theta = 0;
        if (Math.abs(spin.phi) < 0.00005) spin.phi = 0;
      }
      clampGoal();
      const k = 1 - Math.pow(1e-8, dt);
      orbit.theta += (goal.theta - orbit.theta) * k;
      orbit.phi += (goal.phi - orbit.phi) * k;
      orbit.radius *= Math.pow(goal.radius / orbit.radius, k);
      orbit.target.lerp(goal.target, k);
      applyCamera();
      reportGround();
      scene.fog.density = 0.3 / orbit.radius;

      const dotScale = Math.max(0.7, Math.min(1.6, orbit.radius / 56));
      const busScale = Math.max(1, Math.min(2.3, orbit.radius / 40));
      const fade = Math.max(0.4, Math.min(1, 1.3 - orbit.radius / 140));
      Object.values(dotMats).forEach((material) => { material.opacity = fade; });
      const selected = hooks.getState().stop;
      stops.forEach((mesh) => {
        mesh.scale.setScalar(mesh.userData.stopId === selected ? dotScale * 1.6 : dotScale);
      });
      dotBatches.forEach((batch) => {
        batch.members.forEach((mesh, index) => {
          dummy.position.copy(mesh.position);
          dummy.scale.copy(mesh.scale);
          dummy.updateMatrix();
          batch.mesh.setMatrixAt(index, dummy.matrix);
        });
        batch.mesh.instanceMatrix.needsUpdate = true;
      });
      flowTex.offset.x = (flowTex.offset.x - dt * 0.55) % 1;

      const t = now / 1000;
      if (marker.visible) {
        marker.scale.setScalar(dotScale);
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
        markerRing.scale.setScalar(1 + pulse * 0.18);
        markerRing.material.opacity = 0.85 - pulse * 0.45;
        markerGlow.material.opacity = 0.4 + pulse * 0.2;
      }
      hoverGlow.visible = Boolean(hover) && hover.userData.stopId !== selected;
      if (hoverGlow.visible) {
        hoverGlow.position.set(hover.position.x, 0.2, hover.position.z);
        hoverGlow.scale.set(1.7 * dotScale, 1.7 * dotScale, 1);
      }

      const beamFade = Math.max(0, Math.min(1, (orbit.radius - 14) / 30));
      const showLabels = orbit.radius < 42;
      liveRingMat.opacity = 0.55 * (1 - ((t * 0.8) % 1));
      const maxTurn = (240 * Math.PI / 180) * dt;
      busGroup.children.forEach((mesh) => {
        mesh.scale.setScalar(busScale);
        const data = mesh.userData;
        if (data.aim != null) {
          let delta = Math.atan2(Math.sin(data.aim - mesh.rotation.y), Math.cos(data.aim - mesh.rotation.y));
          if (Math.abs(delta) > maxTurn) delta = Math.sign(delta) * maxTurn;
          mesh.rotation.y += delta;
        }
        const parts = data.parts;
        if (!data.ghost) {
          parts.beam.material.opacity = (data.dwell ? 0.18 : data.live ? 0.55 : 0.4) * beamFade;
          parts.beam.visible = beamFade > 0.01;
        }
        if (parts.ring.visible) parts.ring.scale.setScalar(0.8 + ((t * 0.8 + data.phase) % 1) * 0.9);
        parts.label.visible = showLabels || mesh === hoverBus || mesh === followed;
        if (parts.label.visible) {
          parts.label.position.copy(camera.up).multiplyScalar(1.1).applyAxisAngle(AXIS_Y, -mesh.rotation.y);
          parts.label.position.y += 0.35;
        }
      });

      paintControls();
      renderer.render(scene, camera);
      placeLabels();
      if (!dragging && hoverEvent) {
        const object = pick(hoverEvent);
        hover = object && object.userData.kind === "stop" ? object : null;
        hoverBus = object && object.userData.kind === "bus" ? object : null;
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
      const narrow = rect.width < 860;
      stops.forEach((mesh) => {
        const forced = mesh.userData.stopId === state.stop || mesh === hover;
        if (!forced && !zoomed) return;
        projector.set(mesh.position.x, mesh.position.y, mesh.position.z).project(camera);
        if (projector.z > 1) return;
        const x = (projector.x * 0.5 + 0.5) * rect.width;
        const y = (-projector.y * 0.5 + 0.5) * rect.height;
        if (x < 8 || y < 8 || x > rect.width - 8 || y > rect.height - 120) return;
        if (!forced && !narrow && x < 440) return;
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

    function aim(event) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
    }

    function pick(event) {
      aim(event);
      const hits = raycaster.intersectObjects(busGroup.children.concat(stopGroup.children, routeGroup.children), true);
      if (!hits.length) return null;
      let object = hits[0].object;
      while (object && !object.userData.kind && object.parent) object = object.parent;
      return object && (object.userData.kind === "stop" || object.userData.kind === "bus" || object.userData.kind === "route") ? object : null;
    }

    function groundAt(event) {
      aim(event);
      return raycaster.ray.intersectPlane(groundPlane, groundHit);
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
    const touches = new Map();
    let drag = null;
    let pinch = null;
    let hoverEvent = null;

    function panBy(dx, dy) {
      const s = goal.radius * 0.0017;
      const st = Math.sin(orbit.theta);
      const ct = Math.cos(orbit.theta);
      goal.target.x += -dx * s * ct + dy * s * -st;
      goal.target.z += dx * s * st + dy * s * -ct;
      follow = null;
      stopMotion();
    }

    function rotateBy(dx, dy) {
      const speed = (2 * Math.PI) / Math.max(canvas.clientHeight, 320);
      const dTheta = -dx * speed;
      const dPhi = -dy * speed * 0.72;
      goal.theta += dTheta;
      goal.phi += dPhi;
      orbit.theta += dTheta * 0.5;
      spin.theta = dTheta * 0.35;
      spin.phi = dPhi * 0.35;
      clampGoal();
    }

    function pinchState() {
      const pts = Array.from(touches.values());
      return {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
    }

    function onPointerMove(event) {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size >= 2 && pinch) {
        const next = pinchState();
        goal.radius *= pinch.dist / next.dist;
        clampGoal();
        panBy(next.x - pinch.x, next.y - pinch.y);
        pinch = next;
        if (drag) drag.moved = true;
        return;
      }
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) > 3) drag.moved = true;
      if (!dx && !dy) return;
      if (drag.button === 2 || drag.button === 1 || event.shiftKey) panBy(dx, dy);
      else rotateBy(dx, dy);
    }

    function release(event) {
      if (!touches.has(event.pointerId)) return;
      touches.delete(event.pointerId);
      if (touches.size >= 2) {
        pinch = pinchState();
        return;
      }
      pinch = null;
      if (touches.size === 1 && drag) {
        const rest = touches.values().next().value;
        drag.x = rest.x;
        drag.y = rest.y;
        drag.moved = true;
        return;
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", cancelDrag);
      canvas.classList.remove("dragging");
      dragging = false;
      const done = drag;
      drag = null;
      return done;
    }

    function endDrag(event) {
      const done = release(event);
      if (!done || done.moved) return;
      const object = pick(event);
      if (!object) return;
      const data = object.userData;
      if (data.kind === "stop") hooks.onStop(data.stopId);
      else if (data.kind === "bus") hooks.onTrip(data.pattern._i, data.trip);
      else if (data.kind === "route") hooks.onPattern(data.pattern._i);
    }

    function cancelDrag(event) {
      release(event);
      stopMotion();
    }

    canvas.tabIndex = 0;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("dragstart", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button > 2) return;
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* el arrastre sigue en window */ }
      if (touches.size === 2) {
        pinch = pinchState();
        if (drag) drag.moved = true;
        stopMotion();
        return;
      }
      if (touches.size > 2) return;
      stopMotion();
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
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", cancelDrag);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drag) hoverEvent = event;
    });
    canvas.addEventListener("pointerleave", (event) => {
      if (drag) return;
      hover = null;
      hoverBus = null;
      hoverEvent = null;
      canvas.classList.remove("pointing");
      showTip(event, null);
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const line = event.deltaMode === 1 ? 16 : 1;
      const before = goal.radius;
      goal.radius *= Math.exp(event.deltaY * line * 0.0011);
      clampGoal();
      const point = follow ? null : groundAt(event);
      if (point) {
        const t = 1 - goal.radius / before;
        goal.target.x += (point.x - goal.target.x) * t;
        goal.target.z += (point.z - goal.target.z) * t;
      }
    }, { passive: false });
    canvas.addEventListener("dblclick", (event) => {
      event.preventDefault();
      const point = groundAt(event);
      if (!point) return;
      follow = null;
      stopMotion();
      goal.target.set(point.x, 0, point.z);
      goal.radius = Math.max(8, goal.radius * 0.5);
    });
    canvas.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key;
      if (key === "ArrowLeft") goal.theta += 0.18;
      else if (key === "ArrowRight") goal.theta -= 0.18;
      else if (key === "ArrowUp") goal.phi -= 0.1;
      else if (key === "ArrowDown") goal.phi += 0.1;
      else if (key === "+" || key === "=") zoomBy(0.8);
      else if (key === "-" || key === "_") zoomBy(1.25);
      else if (key === "n" || key === "N") resetNorth();
      else if (key === "0") {
        if (hooks.onFit) hooks.onFit();
      } else return;
      event.preventDefault();
      stopMotion();
      clampGoal();
    });

    const on = (node, fn) => { if (node) node.addEventListener("click", fn); };
    on(controls.north, resetNorth);
    on(document.getElementById("atlas-zoom-in"), () => zoomBy(0.7));
    on(document.getElementById("atlas-zoom-out"), () => zoomBy(1.4));
    on(controls.tilt, toggleTilt);
    on(controls.follow, () => {
      const trip = hooks.getState().trip;
      setFollow(follow || !trip ? null : trip);
    });

    return {
      init: init,
      resize: resize,
      sync: sync,
      syncLight: syncLight,
      syncBuses: syncBuses,
      frame: frame,
      focusAt: focusAt,
      follow: setFollow,
      zoomBy: zoomBy,
      toggleTilt: toggleTilt,
      resetNorth: resetNorth,
      tick: tick,
    };
  }

  window.Atlas3D = create;
})();
