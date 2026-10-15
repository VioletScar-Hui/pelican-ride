import * as THREE from 'three';
import { GEO } from './bike.js';
import { featherBumpTexture, clamp, lerp, smoothstep, damp, Spring } from './util.js';

const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);

// Segment lengths (metres)
const L_THIGH = 0.35, L_SHIN = 0.34;
const L_ARM = 0.24, L_FORE = 0.25;

// ---------------------------------------------------------------------------
// A tube whose spine & radius can be re-shaped every frame (the neck).
// Uses parallel-transport frames so it never twists.
// ---------------------------------------------------------------------------
class NeckTube {
  constructor(material, segs = 32, radial = 18) {
    this.segs = segs; this.radial = radial;
    const vc = (segs + 1) * (radial + 1);
    this.pos = new Float32Array(vc * 3);
    this.nor = new Float32Array(vc * 3);
    const uv = new Float32Array(vc * 2);
    for (let i = 0; i <= segs; i++) {
      for (let j = 0; j <= radial; j++) {
        const k = i * (radial + 1) + j;
        uv[k * 2] = (j / radial) * 2;
        uv[k * 2 + 1] = (i / segs) * 4;
      }
    }
    const idx = [];
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < radial; j++) {
        const a = i * (radial + 1) + j, b = (i + 1) * (radial + 1) + j, c = b + 1, d = a + 1;
        idx.push(a, d, b, b, d, c);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.points = [0, 1, 2, 3, 4].map(() => new V3());
    this.curve = new THREE.CatmullRomCurve3(this.points, false, 'centripetal');
    this._P = new V3(); this._T = new V3(); this._pT = new V3(); this._N = new V3(); this._B = new V3(); this._ax = new V3();
  }

  update(radiusFn) {
    const { segs, radial, pos, nor } = this;
    const P = this._P, T = this._T, pT = this._pT, N = this._N, B = this._B, ax = this._ax;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      this.curve.getPoint(t, P);
      this.curve.getTangent(t, T);
      if (i === 0) {
        N.set(1, 0, 0).addScaledVector(T, -T.x).normalize();
      } else {
        ax.crossVectors(pT, T);
        const l = ax.length();
        if (l > 1e-7) {
          ax.divideScalar(l);
          N.applyAxisAngle(ax, Math.acos(clamp(pT.dot(T), -1, 1)));
        }
      }
      B.crossVectors(T, N);
      pT.copy(T);
      const r = radiusFn(t);
      for (let j = 0; j <= radial; j++) {
        const th = (j / radial) * Math.PI * 2;
        const c = Math.cos(th), s = Math.sin(th);
        const nx = N.x * c + B.x * s, ny = N.y * c + B.y * s, nz = N.z * c + B.z * s;
        const k = (i * (radial + 1) + j) * 3;
        pos[k] = P.x + nx * r; pos[k + 1] = P.y + ny * r; pos[k + 2] = P.z + nz * r;
        nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
}

// Long flat pelican bill with a colour gradient (pink base -> yellow -> red hook)
function makeBillGeometry(len, w, h, upper) {
  const g = new THREE.CylinderGeometry(1, 1, 1, 24, 36);
  const p = g.attributes.position;
  const cols = [];
  const cBase = new THREE.Color('#f2a07c'), cMid = new THREE.Color('#f9c94e'), cTip = new THREE.Color('#e2553a');
  const tmp = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = y + 0.5;
    let wt = w * (1 - 0.42 * t);
    let ht = h * (1 - 0.3 * t);
    if (t > 0.9) {
      const k = Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.9) / 0.1, 2)));
      wt *= 0.35 + 0.65 * k; ht *= 0.5 + 0.5 * k;
    }
    let vy = z;
    if (upper) vy = vy < 0 ? vy * 0.3 : vy;
    else vy = vy > 0 ? vy * 0.3 : vy;
    const ny = vy * ht - 0.035 * t * t * (upper ? 1 : 0.92);
    p.setXYZ(i, x * wt, ny, -t * len);
    if (t < 0.55) tmp.copy(cBase).lerp(cMid, t / 0.55);
    else if (t < 0.9) tmp.copy(cMid);
    else tmp.copy(cMid).lerp(cTip, (t - 0.9) / 0.1);
    cols.push(tmp.r, tmp.g, tmp.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.computeVertexNormals();
  return g;
}

function makePouchGeometry() {
  const g = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i);
    const z = p.getZ(i);
    const depth = 0.22 + 0.78 * smoothstep(-1.0, 0.65, z);
    y *= depth;
    x *= 0.92 + 0.1 * -y;
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

function makeFootGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.02, -0.01);
  s.lineTo(-0.072, 0.092);
  s.quadraticCurveTo(-0.072, 0.108, -0.058, 0.1);
  s.quadraticCurveTo(-0.03, 0.08, -0.009, 0.118);
  s.quadraticCurveTo(0, 0.134, 0.009, 0.118);
  s.quadraticCurveTo(0.03, 0.08, 0.058, 0.1);
  s.quadraticCurveTo(0.072, 0.108, 0.072, 0.092);
  s.lineTo(0.02, -0.01);
  s.quadraticCurveTo(0, -0.028, -0.02, -0.01);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.006, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2, curveSegments: 10,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---------- tiny IK + orientation helpers ----------
const _d = new V3(), _p = new V3(), _X = new V3(), _Y = new V3(), _Z = new V3(), _m = new THREE.Matrix4();

function solveIK(A, C, a, b, pole, outB) {
  _d.subVectors(C, A);
  let len = _d.length();
  len = clamp(len, Math.abs(a - b) + 1e-4, a + b - 1e-4);
  _d.normalize();
  const cosA = clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)).normalize();
  outB.copy(A).addScaledVector(_d, a * cosA).addScaledVector(_p, a * sinA);
}

function orientSeg(obj, a, b, refDown) {
  _Y.subVectors(b, a).normalize();
  _X.copy(refDown).addScaledVector(_Y, -refDown.dot(_Y));
  if (_X.lengthSq() < 1e-8) _X.set(0, 0, 1);
  _X.normalize();
  _Z.crossVectors(_X, _Y);
  _m.makeBasis(_X, _Y, _Z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.copy(a);
}

function placeLimb(mesh, a, b, r) {
  _Y.subVectors(b, a);
  const len = _Y.length();
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(UP, _Y.divideScalar(len || 1));
  mesh.scale.set(r, len, r);
}

// ---------------------------------------------------------------------------
export function createPelican(scene, bike) {
  const bump = featherBumpTexture();
  bump.repeat.set(7, 7);
  const neckBump = bump.clone();
  neckBump.repeat.set(2, 2);
  neckBump.needsUpdate = true;

  const M = {
    feather: new THREE.MeshPhysicalMaterial({
      color: 0xf7f4ee, roughness: 0.8, bumpMap: bump, bumpScale: 0.6,
      sheen: 0.7, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xffffff),
    }),
    chest: new THREE.MeshPhysicalMaterial({
      color: 0xf7e2b4, roughness: 0.82, bumpMap: bump, bumpScale: 1.2, sheen: 0.6, sheenColor: new THREE.Color(0xfff2d0),
    }),
    dark: new THREE.MeshPhysicalMaterial({ color: 0x1d1e23, roughness: 0.55, sheen: 0.5, sheenColor: new THREE.Color(0x4a5060) }),
    bill: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.36, clearcoat: 0.5, clearcoatRoughness: 0.25 }),
    nail: new THREE.MeshPhysicalMaterial({ color: 0xd2402c, roughness: 0.3, clearcoat: 0.6 }),
    pouch: new THREE.MeshPhysicalMaterial({
      color: 0xf6a568, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.4,
      sheen: 0.6, sheenColor: new THREE.Color(0xffd2a8), side: THREE.DoubleSide,
    }),
    leg: new THREE.MeshPhysicalMaterial({ color: 0xf29a3c, roughness: 0.5, clearcoat: 0.2 }),
    eyeSkin: new THREE.MeshPhysicalMaterial({ color: 0xf6c27a, roughness: 0.45, clearcoat: 0.3 }),
    iris: new THREE.MeshPhysicalMaterial({ color: 0x8a3b17, roughness: 0.15, clearcoat: 1 }),
    pupil: new THREE.MeshPhysicalMaterial({ color: 0x050505, roughness: 0.1, clearcoat: 1 }),
    glint: new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 4, 4) }),
  };
  const neckMat = M.feather.clone();
  neckMat.bumpMap = neckBump;
  neckMat.bumpScale = 0.35;
  const limbMat = M.feather.clone();
  limbMat.bumpScale = 0.3;

  const sphere = new THREE.SphereGeometry(1, 40, 28);
  const sphereLo = new THREE.SphereGeometry(1, 16, 10);
  const mesh = (geo, mat, sx, sy, sz, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };

  // ---------- root sits on the saddle ----------
  const root = new THREE.Group();
  root.position.copy(GEO.saddle);
  bike.group.add(root);

  const body = new THREE.Group();
  body.position.set(0, 0.2, -0.02);
  body.rotation.x = 0.5;
  root.add(body);
  const bodyInner = new THREE.Group();
  body.add(bodyInner);
  bodyInner.add(mesh(sphere, M.feather, 0.2, 0.22, 0.36));
  bodyInner.add(mesh(sphere, M.chest, 0.16, 0.17, 0.2, 0, 0.06, -0.2));
  for (const s of [-1, 1]) {
    // folded coverts on the flanks
    const cov = mesh(sphere, M.feather, 0.06, 0.13, 0.27, s * 0.155, 0.05, 0.05);
    cov.rotation.set(0.1, s * 0.12, s * 0.15);
    bodyInner.add(cov);
  }
  for (let i = -2; i <= 2; i++) {
    const f = mesh(sphereLo, M.feather, 0.04, 0.014, 0.12, i * 0.03, -0.03, 0.36);
    f.rotation.set(-0.25, i * 0.18, 0);
    bodyInner.add(f);
  }
  const marker = (x, y, z) => { const o = new THREE.Object3D(); o.position.set(x, y, z); body.add(o); return o; };
  const shoulders = [marker(-0.17, 0.09, -0.14), marker(0.17, 0.09, -0.14)];
  const hips = [marker(-0.09, -0.15, 0.02), marker(0.09, -0.15, 0.02)];

  // ---------- neck ----------
  const neck = new NeckTube(neckMat);
  root.add(neck.mesh);
  const NECK_BASE = [new V3(0, 0.40, -0.17), new V3(0, 0.55, -0.245), new V3(0, 0.68, -0.19), new V3(0, 0.79, -0.17), new V3(0, 0.87, -0.22)];

  // ---------- head ----------
  const head = new THREE.Group();
  root.add(head);
  head.add(mesh(sphere, M.feather, 0.072, 0.076, 0.098, 0, 0.024, -0.036));
  // crest
  const crest = [];
  for (let i = 0; i < 5; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.075, 6), M.feather);
    c.position.set((i - 2) * 0.008, 0.075, 0.0 + Math.abs(i - 2) * 0.006);
    c.castShadow = true;
    head.add(c);
    crest.push({ m: c, base: 1.25 + Math.abs(i - 2) * 0.12, z: (i - 2) * 0.12 });
  }
  // eyes
  const eyes = [];
  for (const s of [-1, 1]) {
    const eg = new THREE.Group();
    eg.position.set(s * 0.055, 0.04, -0.072);
    eg.rotation.y = -s * 1.0;
    eg.scale.setScalar(1.35);
    eg.add(mesh(sphereLo, M.eyeSkin, 0.024, 0.02, 0.016, 0, 0, 0.004));
    eg.add(mesh(sphereLo, M.iris, 0.0155, 0.0155, 0.0155, 0, 0, -0.006));
    eg.add(mesh(sphereLo, M.pupil, 0.0085, 0.0085, 0.006, 0, 0, -0.019));
    const gl = mesh(sphereLo, M.glint, 0.0032, 0.0032, 0.0032, 0.004 * -s, 0.005, -0.021);
    gl.castShadow = false;
    eg.add(gl);
    head.add(eg);
    eyes.push(eg);
  }
  // bill
  const BILL_LEN = 0.41;
  const bill = new THREE.Group();
  bill.position.set(0, 0.008, -0.1);
  bill.rotation.x = -0.32;
  head.add(bill);
  const upper = new THREE.Mesh(makeBillGeometry(BILL_LEN, 0.05, 0.03, true), M.bill);
  upper.castShadow = true;
  bill.add(upper);
  const nail = mesh(sphereLo, M.nail, 0.011, 0.012, 0.02, 0, -0.04, -BILL_LEN + 0.004);
  bill.add(nail);
  const hook = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.022, 8), M.nail);
  hook.position.set(0, -0.05, -BILL_LEN - 0.002);
  hook.rotation.x = Math.PI + 0.5;
  bill.add(hook);
  const jaw = new THREE.Group();
  bill.add(jaw);
  const lower = new THREE.Mesh(makeBillGeometry(BILL_LEN * 0.97, 0.046, 0.016, false), M.bill);
  lower.position.y = -0.012;
  lower.castShadow = true;
  jaw.add(lower);
  const pouch = new THREE.Mesh(makePouchGeometry(), M.pouch);
  const POUCH = { w: 0.04, d: 0.085, l: 0.17 };
  pouch.scale.set(POUCH.w, POUCH.d, POUCH.l);
  pouch.position.set(0, -0.018, -0.19);
  pouch.castShadow = true;
  jaw.add(pouch);
  const mouth = new THREE.Object3D();
  mouth.position.set(0, -0.03, -0.2);
  bill.add(mouth);
  const billTip = new THREE.Object3D();
  billTip.position.set(0, -0.03, -BILL_LEN);
  bill.add(billTip);

  // ---------- limbs (world-space rig, solved with IK every frame) ----------
  const rig = new THREE.Group();
  rig.name = 'pelicanRig';
  scene.add(rig);

  const capGeo = new THREE.SphereGeometry(1, 20, 14);
  capGeo.translate(0, 1, 0); capGeo.scale(1, 0.5, 1);
  const shinGeo = new THREE.CylinderGeometry(0.85, 1, 1, 14);
  shinGeo.translate(0, 0.5, 0);
  const footGeo = makeFootGeometry();

  const legs = [-1, 1].map((s) => {
    const thigh = new THREE.Mesh(capGeo, limbMat);
    const shin = new THREE.Mesh(shinGeo, M.leg);
    const knee = mesh(sphereLo, M.leg, 0.032, 0.032, 0.032);
    const ankle = mesh(sphereLo, M.leg, 0.026, 0.026, 0.026);
    const foot = new THREE.Mesh(footGeo, M.leg);
    [thigh, shin, foot].forEach((m) => { m.castShadow = true; });
    rig.add(thigh, shin, knee, ankle, foot);
    return { s, thigh, shin, knee, ankle, foot, kneeP: new V3() };
  });

  const featherGeoX = new THREE.SphereGeometry(1, 12, 8); featherGeoX.translate(1, 0, 0);
  const featherGeoY = new THREE.SphereGeometry(1, 12, 8); featherGeoY.translate(0, 1, 0);
  const wings = [-1, 1].map((s) => {
    const upperArm = new THREE.Group(), fore = new THREE.Group(), hand = new THREE.Group();
    fore.add(hand);
    hand.position.y = L_FORE;
    upperArm.add(mesh(sphere, limbMat, 0.07, L_ARM * 0.58, 0.042, 0.02, L_ARM * 0.5, 0));
    fore.add(mesh(sphere, limbMat, 0.058, L_FORE * 0.56, 0.034, 0.018, L_FORE * 0.5, 0));
    for (let i = 0; i < 4; i++) {
      const tert = mesh(featherGeoX, M.feather, 0.05, 0.026, 0.008, 0.04, L_ARM * (0.15 + 0.22 * i), 0);
      tert.rotation.z = -0.5;
      upperArm.add(tert);
    }
    for (let i = 0; i < 6; i++) {
      const y = L_FORE * (0.06 + 0.17 * i);
      const sec = mesh(featherGeoX, M.dark, 0.06, 0.021, 0.006, 0.03, y, -0.002);
      sec.rotation.z = -0.6 - i * 0.03;
      fore.add(sec);
      const cov = mesh(featherGeoX, M.feather, 0.034, 0.025, 0.01, 0.03, y + 0.012, 0.004);
      cov.rotation.z = -0.45;
      fore.add(cov);
    }
    const prim = [];
    for (let i = 0; i < 5; i++) {
      const f = mesh(featherGeoY, M.dark, 0.017, 0.06 - i * 0.002, 0.006);
      hand.add(f);
      prim.push(f);
    }
    hand.add(mesh(sphereLo, M.feather, 0.04, 0.042, 0.03));
    rig.add(upperArm, fore);
    return { s, upperArm, fore, hand, prim, elbow: new V3() };
  });

  // ---------- state ----------
  const st = {
    yaw: 0, pitch: 0, jaw: 0, jawTarget: 0, reach: 0, inflate: 0,
    bulge: -1, bulgeT: 0, blinkT: 2 + Math.random() * 3, blink: 0,
    honkT: 0, waveW: 0, spread: 0, extraPitch: 0,
  };
  const squash = new Spring(160, 9);
  const pouchSpring = new Spring(90, 3.2);
  const headSpring = new Spring(140, 8);

  const tmp = new V3(), tmp2 = new V3(), tmp3 = new V3(), tq = new THREE.Quaternion(), bq = new THREE.Quaternion();
  const shoulderW = new V3(), hipW = new V3(), target = new V3(), pole = new V3(), wrist = new V3(), refDown = new V3();
  const heel = new V3(), ankleP = new V3();

  const api = {
    root, head, bill, mouth, billTip, jaw, pouch, rig, M,
    get state() { return st; },
    mouthWorld(out) { return mouth.getWorldPosition(out); },
    headWorld(out) { return head.getWorldPosition(out); },
    honk() { st.honkT = 0.9; headSpring.kick(-3); },
    swallow() {
      st.inflate = 1.0; st.bulge = 1; st.bulgeT = 0; pouchSpring.kick(4); headSpring.kick(4);
    },
    land(strength = 1) { squash.kick(-2.2 * strength); pouchSpring.kick(-6 * strength); headSpring.kick(-3 * strength); },
    bump(v) { pouchSpring.kick(v); },

    update(dt, c) {
      const t = c.time;
      // ---- body ----
      const sq = squash.update(dt);
      const breath = Math.sin(t * 1.9) * 0.012;
      const pump = Math.sin(c.crank);
      root.position.set(GEO.saddle.x, GEO.saddle.y + Math.abs(Math.cos(c.crank)) * 0.007 + sq * 0.05, GEO.saddle.z);
      root.rotation.set(0, pump * 0.03, pump * 0.03 - c.lean * 0.25);
      bodyInner.scale.set(1 - sq * 0.5 + breath, 1 + sq + breath * 0.6, 1 - sq * 0.3 + breath);

      // ---- gaze ----
      tmp.copy(c.gaze);
      root.worldToLocal(tmp);
      tmp.sub(head.position);
      const yawT = clamp(Math.atan2(-tmp.x, -tmp.z), -1.15, 1.15);
      const pitchT = clamp(Math.atan2(tmp.y, Math.hypot(tmp.x, tmp.z)), -0.6, c.gazeFast ? 0.75 : 0.5);
      const gk = c.gazeFast ? 12 : 5;
      st.yaw = damp(st.yaw, yawT, gk, dt);
      st.pitch = damp(st.pitch, pitchT + (c.gazeFast ? 0.32 : 0), gk, dt);

      // ---- honk / jaw ----
      if (st.honkT > 0) {
        st.honkT -= dt;
        const k = st.honkT;
        st.jawTarget = Math.max(c.jaw || 0, (Math.sin(k * 22) > -0.2 ? 0.9 : 0.25) * smoothstep(0, 0.1, k));
        st.extraPitch = damp(st.extraPitch, 0.5, 10, dt);
      } else {
        st.jawTarget = c.jaw || 0;
        st.extraPitch = damp(st.extraPitch, 0, 4, dt);
      }
      st.jaw = damp(st.jaw, st.jawTarget, st.jawTarget > st.jaw ? 18 : 26, dt);
      jaw.rotation.x = -st.jaw * 0.6;
      st.reach = damp(st.reach, c.gazeFast ? 1 : 0, 6, dt);

      // ---- pouch jiggle & inflation ----
      pouchSpring.kick((Math.random() - 0.5) * c.speed * 0.25 * dt * 10);
      const pj = pouchSpring.update(dt);
      st.inflate = damp(st.inflate, 0, 1.4, dt);
      pouch.scale.set(
        POUCH.w * (1 + st.inflate * 0.7 - pj * 0.15),
        POUCH.d * (1 + st.inflate * 1.3 + pj * 0.5 + st.jaw * 0.6),
        POUCH.l * (1 + st.inflate * 0.08),
      );

      // ---- neck ----
      const hs = headSpring.update(dt);
      const bob = Math.sin(c.crank * 2) * 0.006 + hs * 0.01;
      const sway = st.yaw * 0.045;
      const r = st.reach;
      const P = neck.points;
      P[0].copy(NECK_BASE[0]);
      P[1].copy(NECK_BASE[1]).add(tmp2.set(sway * 0.2, bob * 0.3, -r * 0.02));
      P[2].copy(NECK_BASE[2]).add(tmp2.set(sway * 0.5, bob * 0.6 + r * 0.03, -r * 0.06));
      P[3].copy(NECK_BASE[3]).add(tmp2.set(sway * 0.8, bob * 0.8 + r * 0.06, -r * 0.12));
      P[4].copy(NECK_BASE[4]).add(tmp2.set(sway, bob + r * 0.08 - sq * 0.02, -r * 0.18));
      head.position.copy(P[4]);

      if (st.bulge >= 0) {
        st.bulgeT += dt;
        st.bulge = 0.95 - st.bulgeT / 0.85;
        if (st.bulge < 0) st.bulge = -1;
      }
      const bulgeAmp = st.bulge >= 0 ? 0.035 * Math.sin(Math.PI * clamp(st.bulgeT / 0.85, 0, 1)) + 0.012 : 0;
      neck.update((u) => {
        let rr = lerp(0.085, 0.04, smoothstep(0, 0.78, u)) + 0.006 * Math.sin(u * 18 + t * 0.5) * 0.15;
        if (st.bulge >= 0) rr += bulgeAmp * Math.exp(-Math.pow((u - st.bulge) / 0.09, 2));
        return rr;
      });

      head.rotation.set(st.pitch + st.extraPitch - hs * 0.08, st.yaw, -st.yaw * 0.15 + Math.sin(t * 0.7) * 0.03, 'YXZ');

      // crest flutters in the wind
      for (const cf of crest) {
        cf.m.rotation.set(cf.base + Math.sin(t * (8 + c.speed) + cf.z * 10) * (0.04 + c.speed * 0.006) + c.speed * 0.015, 0, cf.z);
      }

      // blink
      st.blinkT -= dt;
      if (st.blinkT < 0) { st.blink = 0.16; st.blinkT = 2 + Math.random() * 4; }
      if (st.blink > 0) st.blink -= dt;
      const lid = st.blink > 0 ? Math.abs(Math.cos((st.blink / 0.16) * Math.PI)) * 0.9 + 0.1 : 1;
      for (const e of eyes) e.scale.y = lid * 1.35;

      // ---- limbs ----
      bike.group.getWorldQuaternion(bq);

      // legs follow the pedals
      legs.forEach((L, i) => {
        const ped = bike.pedals[i];
        hips[i].getWorldPosition(hipW);
        ped.foot.getWorldPosition(tmp);
        ped.foot.getWorldQuaternion(tq);
        heel.set(0, 0.004, 0.045).applyQuaternion(tq).add(tmp);
        ankleP.set(0, 0.042, 0.0).applyQuaternion(tq).add(heel);
        pole.set(L.s * 0.18, 0.35, -1).applyQuaternion(bq);
        solveIK(hipW, ankleP, L_THIGH, L_SHIN, pole, L.kneeP);
        tmp3.subVectors(L.kneeP, hipW).normalize();
        placeLimb(L.thigh, tmp2.copy(hipW).addScaledVector(tmp3, -0.03), L.kneeP, 0.068);
        L.thigh.scale.y += 0.03;
        placeLimb(L.shin, L.kneeP, ankleP, 0.022);
        L.knee.position.copy(L.kneeP);
        L.ankle.position.copy(ankleP);
        L.foot.position.copy(heel);
        L.foot.quaternion.copy(tq);
      });

      // wings hold the grips, spread when airborne, the right one waves on demand
      st.spread = damp(st.spread, c.airborne ? 1 : 0, c.airborne ? 9 : 6, dt);
      st.waveW = damp(st.waveW, c.waving ? 1 : 0, 7, dt);
      const flap = Math.sin(t * 17) * 0.16 * st.spread;
      refDown.set(0, -1, 0.7).normalize().applyQuaternion(bq);
      wings.forEach((W, i) => {
        const s = W.s;
        shoulders[i].getWorldPosition(shoulderW);
        bike.grips[i].getWorldPosition(target);
        tmp.set(s * 0.46, 0.08 + flap, 0.04).applyQuaternion(bq).add(shoulderW);
        target.lerp(tmp, st.spread);
        let fan = st.spread;
        if (s > 0 && st.waveW > 0.001) {
          tmp.set(0.2 + Math.sin(t * 13) * 0.07, 0.33, -0.17).applyQuaternion(bq).add(shoulderW);
          target.lerp(tmp, st.waveW);
          fan = Math.max(fan, st.waveW);
        }
        pole.set(s * 0.9, -0.35 + st.spread * 0.6, 0.55).applyQuaternion(bq);
        solveIK(shoulderW, target, L_ARM, L_FORE, pole, W.elbow);
        wrist.subVectors(target, W.elbow).normalize().multiplyScalar(L_FORE).add(W.elbow);
        orientSeg(W.upperArm, shoulderW, W.elbow, refDown);
        orientSeg(W.fore, W.elbow, wrist, refDown);
        W.prim.forEach((f, k) => {
          const grip = -0.55 - k * 0.3;
          const open = (k - 2) * 0.3 + (s > 0 ? Math.sin(t * 13 + k) * 0.08 * st.waveW : 0);
          f.rotation.set(0, 0, lerp(grip, open, fan));
          f.scale.y = lerp(0.05, 0.085 - k * 0.004, fan);
        });
      });
    },
  };
  return api;
}
