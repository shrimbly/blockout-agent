// The 3D viewport: ground, grid, primitives, the free (orbit) camera, the shot camera driven by the
// timeline, selection + gizmos, and an offscreen renderer for snapshots and video export.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { buildGeometry } from './geometry.js';
import { sampleCamera } from '/core/curves.js';
import { store } from './store.js';

const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 1000) / 1000;
const ACCENT = new THREE.Color('#ff5a1f');
const SAFE = { top: 52, bottom: 124, side: 16, chat: 364 }; // keep the shot frame clear of the floating UI

export class Viewport {
  constructor(stage) {
    this.stage = stage;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    stage.append(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.objects = new THREE.Group(); this.objects.name = 'objects';
    this.helpers = new THREE.Group(); this.helpers.name = 'helpers';
    this.scene.add(this.objects, this.helpers);
    this.meshes = new Map(); // id -> { mesh, edges, geoKey }

    this._buildEnvironment();
    this._buildCameras();
    this._buildGizmo();
    this._buildShotHelpers();
    this._bindPicking();

    this.layout();
    addEventListener('resize', () => this.layout());
    store.on('state', (c) => {
      if (c.view) this._applyView();
      if (c.selection) this._applySelection();
      if (c.gizmo) this.gizmo.setMode(store.state.gizmo);
      if (c.key) this._rebuildPath();
      if (c.chat) this.layout();
    });
  }

  // ---------- setup ----------
  _buildEnvironment() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x8a857c, 1.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera; sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 0.5; sc.far = 120;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.02; this.sun.shadow.radius = 3;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.groundMat = new THREE.MeshStandardMaterial({ color: 0xdedbd4, roughness: 1 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 60, 60).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.receiveShadow = true; this.ground.name = 'ground';
    this.scene.add(this.ground);

    // Infinite-looking ground grid: 1 m minor, 5 m major lines, X/Z axes tinted, fading with distance.
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(600, 600, 60, 60).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { uColor: { value: new THREE.Color(0x000000) }, uFade: { value: 70 } },
      vertexShader: `varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `
        uniform vec3 uColor; uniform float uFade; varying vec3 vWorld;
        float line(float size, float width) {
          vec2 c = vWorld.xz / size; vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
          return 1.0 - min(min(g.x, g.y) / width, 1.0);
        }
        float axis(float v) { return 1.0 - min(abs(v) / fwidth(v) / 1.5, 1.0); }
        void main() {
          float d = length(vWorld.xz - cameraPosition.xz);
          float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
          float a = max(line(1.0, 1.0) * 0.07, line(5.0, 1.1) * 0.15);
          vec3 col = uColor;
          float ax = axis(vWorld.z), az = axis(vWorld.x);
          if (ax > 0.01) { col = mix(col, vec3(0.85, 0.25, 0.2), ax); a = max(a, ax * 0.45); }
          if (az > 0.01) { col = mix(col, vec3(0.2, 0.4, 0.85), az); a = max(a, az * 0.45); }
          gl_FragColor = vec4(col, a * fade);
          if (gl_FragColor.a < 0.003) discard;
        }`,
    }));
    this.grid.position.y = 0.002;
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);
  }

  _buildCameras() {
    this.freeCam = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    this.shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);
    this.freeOrbit = new OrbitControls(this.freeCam, this.canvas);
    this.freeOrbit.enableDamping = true; this.freeOrbit.dampingFactor = 0.12;
    this.shotOrbit = new OrbitControls(this.shotCam, this.canvas);
    this.shotOrbit.enabled = false;
    this.shotOrbit.addEventListener('start', () => {
      if (store.state.playing) store.set({ playing: false });
      store.set({ camDirty: true });
    });
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem('cc-freecam') || 'null'); } catch {}
    this.freeCam.position.fromArray(saved?.p || [11, 7.5, 13]);
    this.freeOrbit.target.fromArray(saved?.t || [0, 1, 0]);
    this.freeOrbit.update();
    addEventListener('beforeunload', () => {
      try { sessionStorage.setItem('cc-freecam', JSON.stringify({ p: this.freeCam.position.toArray(), t: this.freeOrbit.target.toArray() })); } catch {}
    });
  }

  _buildGizmo() {
    this.gizmo = new TransformControls(this.freeCam, this.canvas);
    this.gizmo.setSize(0.85);
    this.gizmo.setMode(store.state.gizmo);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.freeOrbit.enabled = !e.value && store.state.view === 'free';
      this.shotOrbit.enabled = !e.value && store.state.view === 'shot';
      this.dragging = e.value;
      if (!e.value) this._commitTransform();
    });
  }

  _buildShotHelpers() {
    const line = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: true });
    // camera body: frustum pyramid + "up" notch, drawn in the camera's local space
    this.rig = new THREE.Group();
    this.rigLines = new THREE.LineSegments(new THREE.BufferGeometry(), line(0x1c1c1a, 0.85));
    this.rig.add(this.rigLines);
    this.aimLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), line(0xff5a1f, 0.6));
    this.targetDot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff5a1f }));
    this.path = new THREE.Line(new THREE.BufferGeometry(), line(0xff5a1f, 0.7));
    this.targetPath = new THREE.Line(new THREE.BufferGeometry(), line(0xff5a1f, 0.25));
    this.keyDots = new THREE.Group();
    this.helpers.add(this.rig, this.aimLine, this.targetDot, this.path, this.targetPath, this.keyDots);
  }

  _bindPicking() {
    const ray = new THREE.Raycaster();
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      down = (this.gizmo.axis && store.state.selection) ? null : { x: e.clientX, y: e.clientY, button: e.button };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || down.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || this.dragging) { down = null; return; }
      down = null;
      const rect = this.canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, this.activeCam);
      const hit = ray.intersectObjects([...this.meshes.values()].map((m) => m.mesh), false)[0];
      // Ctrl/Cmd-click selects (or clears the selection on empty space). Plain click aims the camera
      // at the clicked point: the object surface, else the ground.
      if (e.ctrlKey || e.metaKey) { store.set({ selection: hit ? hit.object.userData.id : null }); return; }
      const point = hit ? hit.point : ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      if (point && point.distanceTo(this.activeCam.position) < 1500) this.aimAt(point);
    });
    // On macOS Ctrl-click also fires a context menu: suppress it over the canvas.
    this.canvas.addEventListener('contextmenu', (e) => { if (e.ctrlKey) e.preventDefault(); });
    this.canvas.addEventListener('dblclick', () => { if (store.state.selection) this.frame(store.state.selection); });
  }

  get activeCam() { return store.state.view === 'shot' ? this.shotCam : this.freeCam; }
  get activeOrbit() { return store.state.view === 'shot' ? this.shotOrbit : this.freeOrbit; }

  // ---------- layout ----------
  layout() {
    const W = innerWidth, H = innerHeight;
    let x = 0, y = 0, w = W, h = H;
    if (store.state.view === 'shot' && store.doc) {
      const A = store.doc.meta.width / store.doc.meta.height;
      const right = store.state.chat ? SAFE.chat : SAFE.side;
      const aw = W - SAFE.side - right, ah = H - SAFE.top - SAFE.bottom;
      if (aw / ah > A) { h = ah; w = ah * A; } else { w = aw; h = aw / A; }
      x = SAFE.side + (aw - w) / 2; y = SAFE.top + (ah - h) / 2;
    }
    Object.assign(this.stage.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    this.stage.classList.toggle('is-shot', store.state.view === 'shot');
    this.renderer.setSize(Math.round(w), Math.round(h), true);
    this.freeCam.aspect = w / h; this.freeCam.updateProjectionMatrix();
    this.shotCam.aspect = store.doc ? store.doc.meta.width / store.doc.meta.height : w / h;
    this.shotCam.updateProjectionMatrix();
  }

  _applyView() {
    const shot = store.state.view === 'shot';
    this.freeOrbit.enabled = !shot;
    this.shotOrbit.enabled = shot;
    this.gizmo.camera = this.activeCam;
    this.helpers.visible = !shot;
    store.set({ camDirty: false });
    this.layout();
  }

  // ---------- document sync ----------
  sync(doc) {
    const env = doc.env;
    const bg = new THREE.Color(env.background);
    this.scene.background = bg;
    document.documentElement.style.setProperty('--cc-bg', env.background);
    this.groundMat.color.copy(bg).multiplyScalar(0.93);
    this.ground.visible = env.ground;
    this.grid.visible = env.grid;
    this.scene.fog = env.fog > 0 ? new THREE.FogExp2(bg, env.fog) : null;
    this.sun.position.fromArray(env.sun).normalize().multiplyScalar(40);

    const seen = new Set();
    for (const o of doc.objects) {
      seen.add(o.id);
      let m = this.meshes.get(o.id);
      const geoKey = o.type + JSON.stringify(o.params);
      if (!m) {
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, color: o.color });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        mesh.castShadow = mesh.receiveShadow = true;
        const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }));
        mesh.add(edges);
        this.objects.add(mesh);
        m = { mesh, edges, geoKey: null };
        this.meshes.set(o.id, m);
      }
      const { mesh, edges } = m;
      mesh.userData.id = o.id;
      mesh.name = o.name;
      if (m.geoKey !== geoKey) {
        mesh.geometry.dispose(); edges.geometry.dispose();
        mesh.geometry = buildGeometry(o.type, o.params);
        edges.geometry = new THREE.EdgesGeometry(mesh.geometry, 28);
        m.geoKey = geoKey;
      }
      mesh.material.color.set(o.color);
      if (!(this.dragging && this.gizmo.object === mesh)) {
        mesh.position.fromArray(o.position);
        mesh.rotation.set(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG, 'XYZ');
        mesh.scale.fromArray(o.scale);
      }
    }
    for (const [id, m] of this.meshes) {
      if (seen.has(id)) continue;
      if (this.gizmo.object === m.mesh) this.gizmo.detach();
      m.mesh.geometry.dispose(); m.edges.geometry.dispose(); m.mesh.material.dispose();
      this.objects.remove(m.mesh);
      this.meshes.delete(id);
    }
    if (store.state.selection && !this.meshes.has(store.state.selection)) store.set({ selection: null });
    this._applySelection();
    this._rebuildPath();
    this.layout();
  }

  _applySelection() {
    const id = store.state.selection;
    for (const [mid, m] of this.meshes) {
      const sel = mid === id;
      m.edges.material.color.set(sel ? ACCENT : 0x000000);
      m.edges.material.opacity = sel ? 1 : 0.22;
    }
    const m = id && this.meshes.get(id);
    if (m) this.gizmo.attach(m.mesh); else this.gizmo.detach();
  }

  _commitTransform() {
    const mesh = this.gizmo.object;
    if (!mesh) return;
    const id = mesh.userData.id;
    store.op({
      op: 'update', id,
      position: mesh.position.toArray().map(r3),
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z].map((v) => Math.round((v / DEG) * 100) / 100),
      scale: mesh.scale.toArray().map(r3),
    }, `move ${id}`).catch(() => {});
  }

  _rebuildPath() {
    const tl = store.doc?.timeline;
    if (!tl) return;
    const N = Math.max(2, Math.ceil(tl.duration * 30));
    const pts = [], tps = [];
    for (let i = 0; i <= N; i++) {
      const s = sampleCamera(tl, (i / N) * tl.duration);
      if (!s) break;
      pts.push(new THREE.Vector3(...s.position)); tps.push(new THREE.Vector3(...s.target));
    }
    this.path.geometry.dispose(); this.path.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.targetPath.geometry.dispose(); this.targetPath.geometry = new THREE.BufferGeometry().setFromPoints(tps);
    this.keyDots.clear();
    for (const k of tl.keys) {
      const sel = k.id === store.state.key;
      const dot = new THREE.Mesh(new THREE.OctahedronGeometry(sel ? 0.16 : 0.11), new THREE.MeshBasicMaterial({ color: sel ? 0xff5a1f : 0x1c1c1a }));
      dot.position.fromArray(k.position);
      this.keyDots.add(dot);
    }
  }

  // ---------- camera ----------
  /** Put a camera at the timeline pose for time t. */
  poseCamera(cam, t, orbit) {
    const s = sampleCamera(store.doc.timeline, t);
    if (!s) return null;
    cam.position.fromArray(s.position);
    cam.up.set(0, 1, 0);
    cam.lookAt(...s.target);
    if (s.roll) cam.rotateZ(s.roll * DEG);
    if (cam.fov !== s.fov) { cam.fov = s.fov; cam.updateProjectionMatrix(); }
    if (orbit) orbit.target.fromArray(s.target);
    return s;
  }

  /** Current pose of the camera the user is looking through. */
  getPose() {
    const shot = store.state.view === 'shot';
    const cam = this.activeCam, orbit = this.activeOrbit;
    return { position: cam.position.toArray().map(r3), target: orbit.target.toArray().map(r3), fov: Math.round(cam.fov * 100) / 100, view: shot ? 'shot' : 'free', time: store.state.time };
  }

  /** Point the active camera at an object (or the whole set). */
  frame(id) {
    const box = new THREE.Box3();
    if (id && this.meshes.get(id)) box.setFromObject(this.meshes.get(id).mesh);
    else if (this.objects.children.length) box.setFromObject(this.objects);
    else box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2, 2));
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(0.5, box.getSize(new THREE.Vector3()).length() / 2);
    const cam = this.activeCam, orbit = this.activeOrbit;
    const dir = cam.position.clone().sub(orbit.target).normalize();
    const dist = radius / Math.sin((cam.fov * DEG) / 2) * 1.1;
    orbit.target.copy(center);
    cam.position.copy(center).addScaledVector(dir, dist);
    orbit.update();
    if (store.state.view === 'shot') store.set({ camDirty: true });
  }

  /** Smoothly turn the active camera to look at a world point (it stays where it is). */
  aimAt(point, ms = 280) {
    const orbit = this.activeOrbit;
    this.aim = { orbit, from: orbit.target.clone(), to: point.clone(), start: performance.now(), ms };
    if (store.state.view === 'shot') {
      if (store.state.playing) store.set({ playing: false });
      store.set({ camDirty: true }); // press K to key the new framing
    }
  }

  _stepAim() {
    const a = this.aim;
    if (!a) return;
    const u = Math.min(1, (performance.now() - a.start) / a.ms);
    const k = 1 - Math.pow(1 - u, 3);
    a.orbit.target.lerpVectors(a.from, a.to, k);
    a.orbit.update();
    if (u >= 1 || a.orbit !== this.activeOrbit) this.aim = null;
  }

  // ---------- per frame ----------
  tick() {
    const { view, time, camDirty } = store.state;
    if (!store.doc) return;
    this._stepAim();
    // shot camera follows the timeline unless the user is hand-framing it
    if (!(view === 'shot' && camDirty)) this.poseCamera(this.shotCam, time, view === 'shot' ? this.shotOrbit : null);
    if (view === 'free') {
      this.freeOrbit.update();
      this._updateRig();
    }
    this.renderer.render(this.scene, this.activeCam);
  }

  _updateRig() {
    const cam = this.shotCam;
    const has = store.doc.timeline.keys.length > 0;
    this.rig.visible = this.aimLine.visible = this.targetDot.visible = has;
    if (!has) return;
    this.rig.position.copy(cam.position);
    this.rig.quaternion.copy(cam.quaternion);
    const d = 0.9, hh = Math.tan((cam.fov * DEG) / 2) * d, hw = hh * cam.aspect;
    const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, -d));
    const o = new THREE.Vector3();
    const seg = [o, c[0], o, c[1], o, c[2], o, c[3], c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0],
      new THREE.Vector3(-hw * 0.35, hh * 1.08, -d), new THREE.Vector3(0, hh * 1.4, -d),
      new THREE.Vector3(0, hh * 1.4, -d), new THREE.Vector3(hw * 0.35, hh * 1.08, -d)];
    this.rigLines.geometry.setFromPoints(seg);
    const s = sampleCamera(store.doc.timeline, store.state.time);
    this.targetDot.position.fromArray(s.target);
    this.aimLine.geometry.setFromPoints([cam.position, this.targetDot.position]);
  }

  // ---------- offscreen rendering (snapshots, storyboard, export) ----------
  /**
   * Render the shot camera at time t into an offscreen canvas of width × height.
   * Helpers and gizmos are hidden; the grid follows opts.grid (default: the scene setting).
   */
  renderShot(t, width, height, { grid, view = 'shot' } = {}) {
    if (!this.off || this.off.w !== width || this.off.h !== height) {
      this.off?.renderer.dispose();
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      this.off = { renderer, w: width, h: height, cam: new THREE.PerspectiveCamera(40, width / height, 0.05, 2000) };
    }
    const { renderer, cam } = this.off;
    if (view === 'free') { cam.position.copy(this.freeCam.position); cam.quaternion.copy(this.freeCam.quaternion); cam.fov = this.freeCam.fov; }
    else this.poseCamera(cam, t);
    cam.aspect = width / height; cam.updateProjectionMatrix();
    const restore = [[this.helpers, this.helpers.visible], [this.gizmoHelper, this.gizmoHelper.visible], [this.grid, this.grid.visible]];
    this.helpers.visible = false; this.gizmoHelper.visible = false;
    if (grid != null) this.grid.visible = !!grid;
    const sel = store.state.selection && this.meshes.get(store.state.selection);
    if (sel) { sel.edges.material.color.set(0x000000); sel.edges.material.opacity = 0.22; }
    renderer.render(this.scene, cam);
    for (const [o, v] of restore) o.visible = v;
    if (sel) this._applySelection();
    return renderer.domElement;
  }
}
