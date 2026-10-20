// scene.js — de 3D-sterrenkaart: notities als sterren, Claude als kern,
// activiteit als lichtsporen en open acties als baan eromheen.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const STAR_VERT = /* glsl */`
  attribute float size;
  attribute float alpha;
  attribute float pulse;
  attribute vec3 color;
  uniform float uTime;
  uniform float uScale;
  uniform float uMotion;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vPulse;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float beat = 1.0 + uMotion * 0.28 * pulse * sin(uTime * 2.6 + position.x * 0.07 + position.y * 0.05);
    gl_PointSize = max(1.5, size * beat * uScale / -mv.z);
    gl_Position = projectionMatrix * mv;
    vColor = color;
    vAlpha = alpha;
    vPulse = pulse;
  }
`;

const STAR_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  varying float vPulse;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = smoothstep(0.2, 0.0, d);
    float halo = pow(smoothstep(0.5, 0.0, d), 2.2) * (0.55 + 0.45 * vPulse);
    vec3 col = mix(vColor, vec3(1.0), core * 0.55);
    gl_FragColor = vec4(col, (core + halo) * vAlpha);
  }
`;

function starMaterial(uniforms) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function pointCloud(count, uniforms) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(count), 1));
  g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(count), 1));
  g.setAttribute('pulse', new THREE.BufferAttribute(new Float32Array(count), 1));
  const pts = new THREE.Points(g, starMaterial(uniforms));
  pts.frustumCulled = false;
  return pts;
}

const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const col = hex => new THREE.Color(hex);

export class BrainScene {
  constructor(host, { labelLayer, reducedMotion = false, onHover, onSelect } = {}) {
    this.host = host;
    this.labelLayer = labelLayer;
    this.reduced = reducedMotion;
    this.onHover = onHover || (() => {});
    this.onSelect = onSelect || (() => {});

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    host.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);
    this.camera.position.set(0, 90, 560);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 1600;
    this.controls.autoRotate = !this.reduced;
    this.controls.autoRotateSpeed = 0.32;
    this.controls.addEventListener('start', () => { this.userAt = performance.now(); this.controls.autoRotate = false; this.fly = null; });

    this.uniforms = {
      uTime: { value: 0 },
      uScale: { value: 400 },
      uMotion: { value: this.reduced ? 0 : 1 },
    };

    this.nodes = [];
    this.byId = new Map();
    this.edges = [];
    this.tasks = [];
    this.hidden = new Set();
    this.focus = -1;
    this.hover = null;
    this.alpha = 0;
    this.particles = [];
    this.labels = new Map();

    this.#buildBackdrop();
    this.#buildCore();
    this.#buildParticles();

    this.taskGroup = new THREE.Group();
    this.taskGroup.rotation.x = 0.34;
    this.taskGroup.rotation.z = -0.08;
    this.scene.add(this.taskGroup);

    this.marker = this.#buildMarker();
    this.scene.add(this.marker);

    this.#bindPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();

    this.insets = { left: 0, right: 0, top: 0, bottom: 0 };
    this.last = performance.now();
    this.elapsed = 0;
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ---------- opbouw ----------

  #buildBackdrop() {
    const n = 1400;
    const dust = pointCloud(n, this.uniforms);
    const pos = dust.geometry.attributes.position.array;
    const c = dust.geometry.attributes.color.array;
    const s = dust.geometry.attributes.size.array;
    const a = dust.geometry.attributes.alpha.array;
    const tints = [col('#A9B6CF'), col('#FFF4D6'), col('#69B2E3'), col('#B9A4FF')];
    for (let i = 0; i < n; i++) {
      const r = 1100 + Math.random() * 1700;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const q = Math.sqrt(1 - u * u);
      pos.set([r * q * Math.cos(th), r * u, r * q * Math.sin(th)], i * 3);
      const t = tints[Math.random() < 0.7 ? 0 : 1 + Math.floor(Math.random() * 3)];
      c.set([t.r, t.g, t.b], i * 3);
      s[i] = 3 + Math.random() * 6;
      a[i] = 0.18 + Math.random() * 0.4;
    }
    this.scene.add(dust);
  }

  #buildCore() {
    this.core = new THREE.Group();
    const glow = pointCloud(2, this.uniforms);
    const g = glow.geometry.attributes;
    const warm = col('#FFF4D6');
    g.color.array.set([warm.r, warm.g, warm.b, 1, 0.86, 0.62]);
    g.size.array.set([84, 34]);
    g.alpha.array.set([0.42, 0.95]);
    g.pulse.array.set([0.6, 1]);
    this.coreGlow = glow;
    this.core.add(glow);

    const wireMat = new THREE.LineBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
    this.coreWire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(13, 1)), wireMat);
    this.core.add(this.coreWire);

    const ringPts = [];
    for (let i = 0; i <= 128; i++) {
      const t = (i / 128) * Math.PI * 2;
      ringPts.push(new THREE.Vector3(Math.cos(t) * 24, 0, Math.sin(t) * 24));
    }
    this.coreRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts),
      new THREE.LineBasicMaterial({ color: 0xfff4d6, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.coreRing.rotation.x = 1.1;
    this.core.add(this.coreRing);
    this.scene.add(this.core);
    this.coreLabel = this.#label('core', 'Claude', 'label label-core');
  }

  #buildParticles() {
    this.P = 140;
    this.TRAIL = 6;
    this.trails = pointCloud(this.P * this.TRAIL, this.uniforms);
    this.scene.add(this.trails);
    for (let i = 0; i < this.P; i++) {
      this.particles.push({ live: false, t: 0, speed: 0, target: -1, ctrl: new THREE.Vector3(), color: new THREE.Color() });
    }
  }

  #buildMarker() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const x = cv.getContext('2d');
    x.strokeStyle = 'rgba(255,244,214,0.95)';
    x.lineWidth = 5;
    x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
    x.lineWidth = 2;
    x.setLineDash([6, 10]);
    x.beginPath(); x.arc(64, 64, 61, 0, Math.PI * 2); x.stroke();
    const tex = new THREE.CanvasTexture(cv);
    const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false;
    return m;
  }

  #label(key, text, cls) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    const entry = { el, pos: new THREE.Vector3(), visible: true };
    this.labels.set(key, entry);
    return entry;
  }

  // ---------- data ----------

  /**
   * model.nodes: [{ id, title, cluster, color, size, isHub, activity, action }]
   * model.edges: [[i, j]]
   * model.clusters: { key: { label, color, count } }
   * model.tasks: [{ key, kind, color, urgent, target }]
   */
  setData(model) {
    const first = this.nodes.length === 0;
    const old = this.byId;
    this.clusters = model.clusters;
    this.#placeAnchors(model);

    this.nodes = model.nodes.map((n, i) => {
      const prev = old.get(n.id);
      const anchor = this.anchors[n.cluster] || new THREE.Vector3();
      const node = {
        ...n,
        i,
        color: col(n.color),
        anchor,
        flash: 0,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      };
      if (prev) {
        Object.assign(node, { x: prev.x, y: prev.y, z: prev.z });
      } else if (first) {
        const d = new THREE.Vector3().randomDirection();
        node.x = d.x * 6; node.y = d.y * 6; node.z = d.z * 6;
        const out = anchor.clone().sub(new THREE.Vector3(node.x, node.y, node.z)).normalize().multiplyScalar(4 + Math.random() * 6);
        node.vx = out.x; node.vy = out.y; node.vz = out.z;
      } else {
        node.x = anchor.x + (Math.random() - 0.5) * 30;
        node.y = anchor.y + (Math.random() - 0.5) * 30;
        node.z = anchor.z + (Math.random() - 0.5) * 30;
      }
      return node;
    });
    this.byId = new Map(this.nodes.map(n => [n.id, n]));
    this.edges = model.edges;
    this.neighbors = this.nodes.map(() => new Set());
    for (const [a, b] of this.edges) { this.neighbors[a].add(b); this.neighbors[b].add(a); }

    this.#buildNodeCloud();
    this.#buildEdges();
    this.#buildClusterLabels();
    this.setTasks(model.tasks || []);

    this.hotList = null;
    this.alpha = first ? 1 : 0.35;
    if (this.reduced || !first) {
      // zonder animatie: meteen de eindopstelling
      for (let k = 0; k < (first ? 420 : 140); k++) this.#step();
      this.alpha = 0;
    }
    if (this.focus >= this.nodes.length) this.focus = -1;
    this.#refreshAttributes();
    if (first) this.fitView(true);
  }

  #placeAnchors(model) {
    const keys = Object.keys(model.clusters).sort((a, b) => model.clusters[b].count - model.clusters[a].count);
    this.anchors = {};
    const n = keys.length;
    keys.forEach((k, i) => {
      // fibonacci-bol, wat afgeplat zodat de kaart breed in beeld komt
      const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = i * Math.PI * (3 - Math.sqrt(5));
      const R = 125 + Math.sqrt(model.clusters[k].count) * 9;
      this.anchors[k] = new THREE.Vector3(Math.cos(th) * r * R, y * R * 0.42, Math.sin(th) * r * R);
    });
  }

  #buildNodeCloud() {
    if (this.cloud) { this.scene.remove(this.cloud); this.cloud.geometry.dispose(); }
    this.cloud = pointCloud(this.nodes.length, this.uniforms);
    this.scene.add(this.cloud);
  }

  #buildEdges() {
    if (this.edgeLines) { this.scene.remove(this.edgeLines); this.edgeLines.geometry.dispose(); }
    if (this.hiLines) { this.scene.remove(this.hiLines); this.hiLines.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.edges.length * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.edges.length * 6), 3));
    this.edgeLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.edgeLines.frustumCulled = false;
    this.scene.add(this.edgeLines);

    const h = new THREE.BufferGeometry();
    h.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, this.edges.length) * 6), 3));
    h.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, this.edges.length) * 6), 3));
    h.setDrawRange(0, 0);
    this.hiLines = new THREE.LineSegments(h, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.hiLines.frustumCulled = false;
    this.scene.add(this.hiLines);
  }

  #buildClusterLabels() {
    for (const [k, l] of this.labels) {
      if (k.startsWith('cluster:') || k.startsWith('hot:')) { l.el.remove(); this.labels.delete(k); }
    }
    for (const [k, c] of Object.entries(this.clusters)) {
      const l = this.#label('cluster:' + k, c.label, 'label label-cluster');
      l.el.style.color = c.color;
    }
    // de drie pagina's waar Claude het meest aan werkte
    this.nodes.filter(n => n.activity > 0.05).sort((a, b) => b.activity - a.activity).slice(0, 3)
      .forEach(n => { this.#label('hot:' + n.i, n.title, 'label label-hot'); });
  }

  setTasks(tasks) {
    for (const t of this.tasks) { this.taskGroup.remove(t.mesh); this.taskGroup.remove(t.edge); }
    if (this.taskLines) { this.scene.remove(this.taskLines); this.taskLines.geometry.dispose(); }
    if (this.ring) { this.taskGroup.remove(this.ring); }
    this.ringRadius = this.#graphRadius() * 1.04 + 26;
    const R = this.ringRadius;

    const pts = [];
    for (let i = 0; i <= 256; i++) { const t = (i / 256) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t) * R, 0, Math.sin(t) * R)); }
    this.ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({ color: 0x8c97b5, dashSize: 6, gapSize: 10, transparent: true, opacity: 0.35, depthWrite: false }));
    this.ring.computeLineDistances();
    this.taskGroup.add(this.ring);

    this.tasks = tasks.map((t, i) => {
      const geo = t.kind === 'question' ? new THREE.TetrahedronGeometry(6.5) : new THREE.OctahedronGeometry(5.5);
      const c = col(t.color);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.22, depthWrite: false }));
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.95 }));
      const ang = (i / Math.max(1, tasks.length)) * Math.PI * 2;
      mesh.position.set(Math.cos(ang) * R, 0, Math.sin(ang) * R);
      edge.position.copy(mesh.position);
      mesh.userData.spin = 0.4 + Math.random() * 0.6;
      this.taskGroup.add(mesh, edge);
      return { ...t, i, mesh, edge, c, world: new THREE.Vector3() };
    });

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, this.tasks.length) * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, this.tasks.length) * 6), 3));
    this.taskLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.taskLines.frustumCulled = false;
    this.scene.add(this.taskLines);
  }

  setHiddenClusters(set) {
    this.hidden = new Set(set);
    if (this.focus >= 0 && this.hidden.has(this.nodes[this.focus].cluster)) this.select(-1);
    this.#refreshAttributes();
  }

  // ---------- layout ----------

  #step() {
    const N = this.nodes.length;
    const a = Math.max(this.alpha, 0.02);
    const ns = this.nodes;
    for (let i = 0; i < N; i++) {
      const p = ns[i];
      for (let j = i + 1; j < N; j++) {
        const q = ns[j];
        const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
        const d2 = dx * dx + dy * dy + dz * dz + 4;
        if (d2 > 40000) continue;
        const d = Math.sqrt(d2);
        const f = (p.cluster === q.cluster ? 360 : 700) / d2 * a;
        const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
        p.vx += fx; p.vy += fy; p.vz += fz;
        q.vx -= fx; q.vy -= fy; q.vz -= fz;
      }
    }
    for (const [i, j] of this.edges) {
      const p = ns[i], q = ns[j];
      const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
      const same = p.cluster === q.cluster;
      const L = same ? 22 : 120;
      const k = (same ? 0.04 : 0.0015) * a;
      const f = (d - L) * k;
      const fx = (dx / d) * f, fy = (dy / d) * f, fz = (dz / d) * f;
      p.vx += fx; p.vy += fy; p.vz += fz;
      q.vx -= fx; q.vy -= fy; q.vz -= fz;
    }
    for (const p of ns) {
      const k = (p.isHub ? 0.08 : 0.04) * a;
      p.vx += (p.anchor.x - p.x) * k;
      p.vy += (p.anchor.y - p.y) * k;
      p.vz += (p.anchor.z - p.z) * k;
      const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) + 0.01;
      if (r < 70) { const push = (70 - r) * 0.05; p.vx += (p.x / r) * push; p.vy += (p.y / r) * push; p.vz += (p.z / r) * push; }
      p.vx *= 0.6; p.vy *= 0.6; p.vz *= 0.6;
      p.x += p.vx; p.y += p.vy; p.z += p.vz;
    }
    this.alpha *= 0.986;
  }

  #graphRadius() {
    let r = 120;
    for (const n of this.nodes) r = Math.max(r, Math.hypot(n.x, n.y, n.z));
    return r;
  }

  // ---------- attributen ----------

  #refreshAttributes() {
    if (!this.cloud) return;
    const g = this.cloud.geometry.attributes;
    const nb = this.focus >= 0 ? this.neighbors[this.focus] : null;
    this.nodes.forEach((n, i) => {
      g.color.array.set([n.color.r, n.color.g, n.color.b], i * 3);
      let al = 0.95;
      if (this.hidden.has(n.cluster)) al = 0.05;
      else if (nb && i !== this.focus && !nb.has(i)) al = 0.22;
      g.alpha.array[i] = al;
      g.pulse.array[i] = Math.min(1, n.activity * 1.4);
    });
    g.color.needsUpdate = g.alpha.needsUpdate = g.pulse.needsUpdate = true;

    const ec = this.edgeLines.geometry.attributes.color.array;
    this.edges.forEach(([a, b], k) => {
      const A = this.nodes[a], B = this.nodes[b];
      const off = this.hidden.has(A.cluster) || this.hidden.has(B.cluster);
      const m = off ? 0 : (nb ? 0.04 : 0.12);
      ec.set([A.color.r * m, A.color.g * m, A.color.b * m, B.color.r * m, B.color.g * m, B.color.b * m], k * 6);
    });
    this.edgeLines.geometry.attributes.color.needsUpdate = true;

    // gemarkeerde verbindingen van de geselecteerde ster
    const hc = this.hiLines.geometry.attributes.color.array;
    let c = 0;
    if (this.focus >= 0) {
      this.hiEdges = this.edges.map((e, k) => k).filter(k => this.edges[k][0] === this.focus || this.edges[k][1] === this.focus);
      for (const k of this.hiEdges) {
        const [a, b] = this.edges[k];
        const A = this.nodes[a], B = this.nodes[b];
        hc.set([A.color.r * 0.9, A.color.g * 0.9, A.color.b * 0.9, B.color.r * 0.9, B.color.g * 0.9, B.color.b * 0.9], c * 6);
        c++;
      }
    } else this.hiEdges = [];
    this.hiLines.geometry.setDrawRange(0, c * 2);
    this.hiLines.geometry.attributes.color.needsUpdate = true;
  }

  #syncPositions() {
    const g = this.cloud.geometry.attributes;
    const pos = g.position.array;
    const size = g.size.array;
    this.nodes.forEach((n, i) => {
      pos[i * 3] = n.x; pos[i * 3 + 1] = n.y; pos[i * 3 + 2] = n.z;
      size[i] = n.size * (1 + 1.1 * n.flash) * (i === this.focus ? 1.35 : 1);
    });
    g.position.needsUpdate = g.size.needsUpdate = true;

    const ep = this.edgeLines.geometry.attributes.position.array;
    this.edges.forEach(([a, b], k) => {
      const A = this.nodes[a], B = this.nodes[b];
      ep[k * 6] = A.x; ep[k * 6 + 1] = A.y; ep[k * 6 + 2] = A.z;
      ep[k * 6 + 3] = B.x; ep[k * 6 + 4] = B.y; ep[k * 6 + 5] = B.z;
    });
    this.edgeLines.geometry.attributes.position.needsUpdate = true;

    const hp = this.hiLines.geometry.attributes.position.array;
    this.hiEdges.forEach((k, c) => {
      const [a, b] = this.edges[k];
      const A = this.nodes[a], B = this.nodes[b];
      hp.set([A.x, A.y, A.z, B.x, B.y, B.z], c * 6);
    });
    this.hiLines.geometry.attributes.position.needsUpdate = true;
  }

  #syncTasks(dt, t) {
    if (!this.reduced) this.taskGroup.rotation.y += dt * 0.035;
    this.taskGroup.updateMatrixWorld();
    const tp = this.taskLines.geometry.attributes.position.array;
    const tc = this.taskLines.geometry.attributes.color.array;
    this.tasks.forEach((tk, k) => {
      const s = tk.urgent && !this.reduced ? 1 + 0.25 * Math.sin(t * 4 + k) : 1;
      tk.mesh.scale.setScalar(s);
      tk.edge.scale.setScalar(s);
      if (!this.reduced) { tk.mesh.rotation.y += dt * tk.mesh.userData.spin; tk.mesh.rotation.x += dt * 0.3; }
      tk.edge.rotation.copy(tk.mesh.rotation);
      tk.mesh.getWorldPosition(tk.world);
      const target = tk.target >= 0 ? this.nodes[tk.target] : null;
      const hot = this.hover && this.hover.kind === 'task' && this.hover.index === k;
      const m = !target || this.hidden.has(target.cluster) ? 0 : hot ? 0.95 : 0.16;
      tp.set([tk.world.x, tk.world.y, tk.world.z, target ? target.x : 0, target ? target.y : 0, target ? target.z : 0], k * 6);
      tc.set([tk.c.r * m, tk.c.g * m, tk.c.b * m, tk.c.r * m * 0.4, tk.c.g * m * 0.4, tk.c.b * m * 0.4], k * 6);
    });
    this.taskLines.geometry.setDrawRange(0, this.tasks.length * 2);
    this.taskLines.geometry.attributes.position.needsUpdate = true;
    this.taskLines.geometry.attributes.color.needsUpdate = true;
  }

  // ---------- lichtsporen ----------

  #spawn(target, color, delay = 0) {
    const p = this.particles.find(q => !q.live);
    if (!p) return;
    const n = this.nodes[target];
    p.live = true;
    p.target = target;
    p.t = -delay;
    p.speed = 0.45 + Math.random() * 0.35;
    p.color.copy(color || n.color);
    const mid = new THREE.Vector3(n.x, n.y, n.z).multiplyScalar(0.5);
    const off = new THREE.Vector3().randomDirection().multiplyScalar(30 + mid.length() * 0.35);
    p.ctrl.copy(mid).add(off);
  }

  /** Lichtsporen vanaf Claude naar deze pagina's (ids). */
  burst(ids, colorHex) {
    const c = colorHex ? col(colorHex) : null;
    ids.forEach((id, k) => {
      const n = this.byId.get(id);
      if (!n) return;
      const count = this.reduced ? 2 : 7;
      for (let j = 0; j < count; j++) this.#spawn(n.i, c, k * 0.08 + j * 0.06 + Math.random() * 0.05);
    });
    this.coreKick = 1;
  }

  #ambient(dt) {
    if (this.reduced || !this.nodes.length) return;
    const hot = this.hotList || (this.hotList = this.nodes.filter(n => n.activity > 0.03));
    if (!hot.length) return;
    const live = this.particles.reduce((s, p) => s + (p.live ? 1 : 0), 0);
    const want = Math.min(26, 6 + hot.length * 2);
    if (live < want && Math.random() < dt * 5) {
      let r = Math.random() * hot.reduce((s, n) => s + n.activity, 0);
      for (const n of hot) { r -= n.activity; if (r <= 0) { this.#spawn(n.i, n.actionColor ? col(n.actionColor) : null); break; } }
    }
  }

  #syncParticles(dt) {
    const g = this.trails.geometry.attributes;
    const T = this.TRAIL;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), P = new THREE.Vector3();
    this.particles.forEach((p, k) => {
      if (p.live) {
        p.t += dt * p.speed;
        if (p.t >= 1) {
          p.live = false;
          const n = this.nodes[p.target];
          if (n) n.flash = 1;
        }
      }
      const n = p.live ? this.nodes[p.target] : null;
      for (let s = 0; s < T; s++) {
        const idx = k * T + s;
        const t = p.t - s * 0.035;
        if (!n || t < 0 || t > 1) { g.alpha.array[idx] = 0; continue; }
        B.set(n.x, n.y, n.z);
        A.copy(B).normalize().multiplyScalar(14);
        const u = 1 - t;
        P.copy(A).multiplyScalar(u * u).addScaledVector(p.ctrl, 2 * u * t).addScaledVector(B, t * t);
        g.position.array.set([P.x, P.y, P.z], idx * 3);
        g.color.array.set([p.color.r, p.color.g, p.color.b], idx * 3);
        g.size.array[idx] = (s === 0 ? 12 : 9 - s * 1.1);
        g.alpha.array[idx] = (s === 0 ? 1 : 0.6 * (1 - s / T));
        g.pulse.array[idx] = 0;
      }
    });
    g.position.needsUpdate = g.color.needsUpdate = g.size.needsUpdate = g.alpha.needsUpdate = true;
    for (const n of this.nodes) if (n.flash > 0) n.flash = Math.max(0, n.flash - dt * 1.6);
  }

  // ---------- camera ----------

  /** Ruimte die panelen over het canvas innemen (px); de kaart wordt in het vrije midden gecentreerd. */
  setInsets(insets) {
    this.insets = { left: 0, right: 0, top: 0, bottom: 0, ...insets };
    this.resize();
  }

  fitView(instant = false) {
    const R = Math.max(this.#graphRadius(), this.ringRadius || 0) * 1.02;
    const { left, right, top, bottom } = this.insets;
    const safeW = Math.max(160, this.w - left - right);
    const safeH = Math.max(160, this.h - top - bottom);
    const f = (this.h / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const dist = (R * f) / (0.46 * Math.min(safeW, safeH * 1.15));
    const lift = safeW / safeH < 0.9 ? 0.62 : 0.32;  // smal scherm: meer van bovenaf
    const dir = this.camera.position.clone().sub(this.controls.target);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    dir.y = lift;
    dir.normalize();
    this.#flyTo(new THREE.Vector3(), dir.multiplyScalar(Math.min(dist, 1500)), instant ? 0 : 1100);
  }

  focusNode(i) {
    const n = this.nodes[i];
    if (!n) return;
    const target = new THREE.Vector3(n.x, n.y, n.z);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.#flyTo(target, dir.multiplyScalar(210), this.reduced ? 0 : 1000);
  }

  #flyTo(target, offset, dur) {
    this.controls.autoRotate = false;
    this.userAt = performance.now();
    if (!dur) {
      this.controls.target.copy(target);
      this.camera.position.copy(target).add(offset);
      this.fly = null;
      return;
    }
    this.fly = {
      t0: performance.now(), dur,
      fromT: this.controls.target.clone(), toT: target,
      fromP: this.camera.position.clone(), toP: target.clone().add(offset),
    };
  }

  select(i, { fly = true } = {}) {
    this.focus = i;
    this.#refreshAttributes();
    if (i >= 0 && fly) this.focusNode(i);
    this.onSelect(i >= 0 ? this.nodes[i] : null);
  }

  // ---------- interactie ----------

  #bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointermove', e => {
      this.pointer = { x: e.offsetX, y: e.offsetY };
    });
    el.addEventListener('pointerleave', () => { this.pointer = null; });
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return;
      const hit = this.pick(e.offsetX, e.offsetY);
      if (hit && hit.kind === 'node') this.select(hit.index);
      else if (hit && hit.kind === 'task') this.onSelect(null, this.tasks[hit.index]);
      else this.select(-1, { fly: false });
    });
    el.addEventListener('dblclick', () => { this.select(-1, { fly: false }); this.fitView(); });
  }

  #screen(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, z: p.z };
  }

  pick(x, y) {
    let best = null;
    const v = new THREE.Vector3();
    this.nodes.forEach((n, i) => {
      if (this.hidden.has(n.cluster)) return;
      const s = this.#screen(v.set(n.x, n.y, n.z));
      if (s.z > 1) return;
      const d = Math.hypot(s.x - x, s.y - y);
      const reach = 9 + n.size * 0.6;
      if (d < reach && (!best || d < best.d)) best = { kind: 'node', index: i, d, sx: s.x, sy: s.y };
    });
    this.tasks.forEach((t, i) => {
      const s = this.#screen(t.world);
      if (s.z > 1) return;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < 16 && (!best || d < best.d)) best = { kind: 'task', index: i, d, sx: s.x, sy: s.y };
    });
    return best;
  }

  // ---------- frame ----------

  resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const { left = 0, right = 0, top = 0, bottom = 0 } = this.insets || {};
    // schuif het middelpunt naar het vrije gebied tussen de panelen
    this.camera.setViewOffset(w, h, (right - left) / 2, (bottom - top) / 2, w, h);
    this.camera.updateProjectionMatrix();
    const dpr = this.renderer.getPixelRatio();
    this.uniforms.uScale.value = (h * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
  }

  #frame() {
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - this.last) / 1000);
    this.last = nowMs;
    this.elapsed += dt;
    const t = this.elapsed;
    this.uniforms.uTime.value = t;

    if (this.alpha > 0.02 && this.nodes.length) {
      for (let k = 0; k < 3; k++) this.#step();
      if (this.alpha <= 0.02) { this.alpha = 0; this.setTasks(this.tasks.map(({ mesh, edge, c, world, i, ...rest }) => rest)); this.fitView(); }
    }

    if (this.fly) {
      const k = Math.min(1, (performance.now() - this.fly.t0) / this.fly.dur);
      const e = ease(k);
      this.controls.target.lerpVectors(this.fly.fromT, this.fly.toT, e);
      this.camera.position.lerpVectors(this.fly.fromP, this.fly.toP, e);
      if (k >= 1) this.fly = null;
    }
    if (!this.reduced && !this.controls.autoRotate && this.focus < 0 && !this.fly && this.userAt && performance.now() - this.userAt > 12000) {
      this.controls.autoRotate = true;
    }
    this.controls.update();

    // kern
    this.coreKick = Math.max(0, (this.coreKick || 0) - dt * 1.5);
    if (!this.reduced) {
      this.coreWire.rotation.y += dt * 0.25;
      this.coreWire.rotation.x += dt * 0.1;
      this.coreRing.rotation.z += dt * 0.4;
    }
    const cg = this.coreGlow.geometry.attributes.size;
    cg.array[0] = 84 * (1 + 0.35 * this.coreKick);
    cg.array[1] = 34 * (1 + 0.5 * this.coreKick);
    cg.needsUpdate = true;

    if (this.nodes.length) {
      this.#ambient(dt);
      this.#syncParticles(dt);
      this.#syncPositions();
      this.#syncTasks(dt, t);
      if (this.focus >= 0) {
        const n = this.nodes[this.focus];
        this.marker.visible = true;
        this.marker.position.set(n.x, n.y, n.z);
        this.marker.scale.setScalar(n.size * 2.6 * (1 + (this.reduced ? 0 : 0.06 * Math.sin(t * 3))));
      } else this.marker.visible = false;
    }

    // hover
    if (this.pointer && !this.fly) {
      const hit = this.pick(this.pointer.x, this.pointer.y);
      const key = hit ? hit.kind + hit.index : '';
      if (key !== this.hoverKey) { this.hoverKey = key; this.hover = hit; this.renderer.domElement.style.cursor = hit ? 'pointer' : ''; }
      if (hit) this.hover = hit;
      this.onHover(hit ? (hit.kind === 'node' ? { kind: 'node', node: this.nodes[hit.index], x: hit.sx, y: hit.sy } : { kind: 'task', task: this.tasks[hit.index], x: hit.sx, y: hit.sy }) : null);
    } else if (this.hover && !this.pointer) { this.hover = null; this.hoverKey = ''; this.onHover(null); }

    this.renderer.render(this.scene, this.camera);
    this.#syncLabels();
  }

  #syncLabels() {
    const v = new THREE.Vector3();
    const placed = [];
    const overlaps = b => placed.some(o => b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
    // volgorde = voorrang: kern, gebieden, daarna de drukste pagina's
    for (const [k, l] of this.labels) {
      let show = true;
      if (k === 'core') v.set(0, -30, 0);
      else if (k.startsWith('cluster:')) {
        const key = k.slice(8);
        let cx = 0, cy = 0, cz = 0, c = 0;
        for (const n of this.nodes) if (n.cluster === key) { cx += n.x; cy += n.y; cz += n.z; c++; }
        if (!c || this.hidden.has(key)) show = false;
        else {
          cx /= c; cy /= c; cz /= c;
          let spread = 0;
          for (const n of this.nodes) if (n.cluster === key) spread += Math.hypot(n.x - cx, n.y - cy, n.z - cz);
          v.set(cx, cy + spread / c + 16, cz);
        }
      } else if (k.startsWith('hot:')) {
        const n = this.nodes[+k.slice(4)];
        if (!n || this.hidden.has(n.cluster) || n.i === this.focus) show = false;
        else v.set(n.x, n.y - n.size - 6, n.z);
      }
      if (show) {
        const s = this.#screen(v);
        show = s.z < 1 && s.x > -50 && s.x < this.w + 50 && s.y > -20 && s.y < this.h + 20;
        if (show) {
          if (!l.w) { l.el.hidden = false; l.w = l.el.offsetWidth || 80; l.h = l.el.offsetHeight || 18; }
          const box = { x1: s.x - l.w / 2 - 4, x2: s.x + l.w / 2 + 4, y1: s.y - l.h / 2 - 2, y2: s.y + l.h / 2 + 2 };
          if (overlaps(box)) show = false;
          else {
            placed.push(box);
            l.el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px) translate(-50%, -50%)`;
          }
        }
      }
      if (show !== l.visible) { l.el.hidden = !show; l.visible = show; }
    }
  }
}
