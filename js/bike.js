import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { weaveTexture, flagTexture, blurDiscTexture, makeFish, smoothstep } from './util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

// Bike-local coordinates: ground at y=0, forward is -Z, rider's right is +X.
export const GEO = {
  R: 0.34,
  rearAxle: V(0, 0.34, 0.52),
  frontAxle: V(0, 0.34, -0.5406),
  bb: V(0, 0.30, 0.10),
  seatTop: V(0, 0.70, 0.25),
  headTop: V(0, 0.80, -0.396),
  headBot: V(0, 0.66, -0.44),
  crankLen: 0.15,
  ringR: 0.1,
  cogR: 0.04,
  saddle: V(0, 0.80, 0.29),
  grip: V(0.268, 0.99, -0.17),
  basket: V(0, 0.865, -0.66),
};

function tube(a, b, r, mat, r2 = r, seg = 14) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, seg, 1), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  m.castShadow = true;
  return m;
}

function curveTube(points, r, mat, segs = 48) {
  const c = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const m = new THREE.Mesh(new THREE.TubeGeometry(c, segs, r, 12, false), mat);
  m.castShadow = true;
  return m;
}

function gearGeometry(r, teeth, depth, holeR) {
  const s = new THREE.Shape();
  const tooth = Math.max(0.004, r * 0.07);
  const st = (Math.PI * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * st;
    const pts = [[a, r], [a + st * 0.3, r + tooth], [a + st * 0.55, r + tooth], [a + st * 0.85, r]];
    pts.forEach(([ang, rad], j) => {
      const x = Math.cos(ang) * rad, y = Math.sin(ang) * rad;
      if (i === 0 && j === 0) s.moveTo(x, y); else s.lineTo(x, y);
    });
  }
  s.closePath();
  if (holeR) {
    const h = new THREE.Path();
    h.absarc(0, 0, holeR, 0, Math.PI * 2, true);
    s.holes.push(h);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, -depth / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

class Helix extends THREE.Curve {
  constructor(r, h, turns) { super(); this.r = r; this.h = h; this.turns = turns; }
  getPoint(t, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.r, t * this.h, Math.sin(a) * this.r);
  }
}

function makeWheel(M, blurTex) {
  const R = GEO.R;
  const wheel = new THREE.Group();
  const spin = new THREE.Group();
  wheel.add(spin);

  const tire = new THREE.Mesh(new THREE.TorusGeometry(R - 0.024, 0.024, 16, 80), M.tire);
  tire.rotation.y = Math.PI / 2;
  tire.castShadow = true;
  spin.add(tire);
  // cream gum-wall stripe
  const wall = new THREE.Mesh(new THREE.TorusGeometry(R - 0.036, 0.0185, 12, 80), M.gumwall);
  wall.rotation.y = Math.PI / 2;
  spin.add(wall);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(R - 0.052, 0.009, 8, 80), M.chrome);
  rim.rotation.y = Math.PI / 2;
  spin.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.1, 18), M.chrome);
  hub.rotation.z = Math.PI / 2;
  spin.add(hub);
  for (const s of [-1, 1]) {
    const fl = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 20), M.chrome);
    fl.rotation.z = Math.PI / 2; fl.position.x = s * 0.035;
    spin.add(fl);
  }

  const geos = [];
  const N = 32;
  for (let i = 0; i < N; i++) {
    const side = i % 2 ? 1 : -1;
    const a = (i / N) * Math.PI * 2;
    const lace = (i % 4 < 2 ? 1 : -1) * 0.45;
    const hubP = V(side * 0.035, Math.sin(a + lace) * 0.027, Math.cos(a + lace) * 0.027);
    const rimP = V(side * 0.004, Math.sin(a) * (R - 0.058), Math.cos(a) * (R - 0.058));
    const dir = rimP.clone().sub(hubP);
    const len = dir.length();
    const c = new THREE.CylinderGeometry(0.0022, 0.0022, len, 4, 1);
    c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
    c.translate((hubP.x + rimP.x) / 2, (hubP.y + rimP.y) / 2, (hubP.z + rimP.z) / 2);
    geos.push(c);
  }
  const spokes = new THREE.Mesh(mergeGeometries(geos), M.spoke);
  spokes.castShadow = true;
  spin.add(spokes);

  // spoke reflector
  const refl = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.05, 0.03), M.reflector);
  refl.position.set(0.0, R * 0.55, 0.0);
  spin.add(refl);

  // valve
  const valve = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.03, 6), M.chrome);
  valve.position.set(0, R - 0.07, 0);
  spin.add(valve);

  // motion-blur disc (fades in with speed)
  const blurMat = new THREE.MeshBasicMaterial({
    map: blurTex, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  const blur = new THREE.Mesh(new THREE.CircleGeometry(R - 0.056, 48), blurMat);
  blur.rotation.y = Math.PI / 2;
  wheel.add(blur);

  return { wheel, spin, blur };
}

function fenderGeo(thetaStart, thetaLength) {
  const g = new THREE.CylinderGeometry(GEO.R + 0.035, GEO.R + 0.035, 0.066, 48, 1, true, thetaStart, thetaLength);
  g.rotateZ(Math.PI / 2);
  return g;
}

// Closed chain path around chainring (c1, r1) and cog (c2, r2) in the z/y plane.
function buildChainPath(c1, r1, c2, r2) {
  const dz = c2.z - c1.z, dy = c2.y - c1.y;
  const d = Math.hypot(dz, dy);
  const phi = Math.atan2(dy, dz);
  const beta = Math.acos((r1 - r2) / d);
  const pts = [];
  const P = (c, r, a) => [c.z + Math.cos(a) * r, c.y + Math.sin(a) * r];
  const push = (p) => pts.push(p);
  const line = (a, b, n) => { for (let i = 0; i < n; i++) { const t = i / n; push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); } };
  const arc = (c, r, a0, a1, n) => { for (let i = 0; i < n; i++) push(P(c, r, a0 + (a1 - a0) * (i / n))); };
  const up = phi + beta, dn = phi - beta;
  line(P(c1, r1, up), P(c2, r2, up), 24);
  arc(c2, r2, up, dn, 16);
  line(P(c2, r2, dn), P(c1, r1, dn), 24);
  arc(c1, r1, dn, up - Math.PI * 2, 48);
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[pts.length];
  function at(s, out) {
    s = ((s % L) + L) % L;
    let lo = 0, hi = pts.length;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
    const a = pts[lo], b = pts[(lo + 1) % pts.length];
    const seg = cum[lo + 1] - cum[lo];
    const t = seg > 0 ? (s - cum[lo]) / seg : 0;
    out.z = a[0] + (b[0] - a[0]) * t;
    out.y = a[1] + (b[1] - a[1]) * t;
    out.tz = (b[0] - a[0]) / (seg || 1);
    out.ty = (b[1] - a[1]) / (seg || 1);
    return out;
  }
  return { L, at };
}

export function createBike() {
  const M = {
    frame: new THREE.MeshPhysicalMaterial({ color: 0x1fb3a2, metalness: 0.25, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xeef0f4, metalness: 1, roughness: 0.12 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x26282d, metalness: 0.6, roughness: 0.45 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.9 }),
    gumwall: new THREE.MeshStandardMaterial({ color: 0xd9bf8c, roughness: 0.85 }),
    leather: new THREE.MeshPhysicalMaterial({ color: 0x7a4426, roughness: 0.45, clearcoat: 0.4, clearcoatRoughness: 0.35 }),
    cream: new THREE.MeshPhysicalMaterial({ color: 0xf3ead2, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.1 }),
    spoke: new THREE.MeshStandardMaterial({ color: 0xd8dbe2, metalness: 1, roughness: 0.22 }),
    chain: new THREE.MeshStandardMaterial({ color: 0x5c6067, metalness: 0.9, roughness: 0.35 }),
    reflector: new THREE.MeshStandardMaterial({ color: 0xff8a1e, emissive: 0x552000, roughness: 0.3 }),
    lens: new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff1c8, emissiveIntensity: 0.2, roughness: 0.1 }),
    redLight: new THREE.MeshStandardMaterial({ color: 0xff2a2a, emissive: 0xff1010, emissiveIntensity: 0.3, roughness: 0.2 }),
    basket: new THREE.MeshStandardMaterial({ map: weaveTexture(), roughness: 0.85, side: THREE.DoubleSide }),
    wicker: new THREE.MeshStandardMaterial({ color: 0xa5763f, roughness: 0.8 }),
    flag: new THREE.MeshStandardMaterial({ map: flagTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }),
  };

  const group = new THREE.Group();
  group.name = 'bike';
  const blurTex = blurDiscTexture();

  // ---------- frame ----------
  const frame = new THREE.Group();
  group.add(frame);
  const { bb, seatTop, headTop, headBot, rearAxle } = GEO;
  const axis = new THREE.Vector3().subVectors(headTop, headBot).normalize();
  frame.add(tube(V(0, 0.685, 0.245), headTop.clone().add(V(0, -0.025, 0.004)), 0.019, M.frame, 0.019)); // top tube
  frame.add(tube(bb, headBot.clone().add(V(0, 0.025, 0.006)), 0.024, M.frame, 0.021)); // down tube
  frame.add(tube(bb, seatTop.clone().add(V(0, 0.02, 0.008)), 0.021, M.frame)); // seat tube
  frame.add(tube(headBot.clone().addScaledVector(axis, -0.03), headTop.clone().addScaledVector(axis, 0.03), 0.027, M.frame)); // head tube
  for (const s of [-1, 1]) {
    frame.add(tube(V(s * 0.025, bb.y, bb.z), V(s * 0.062, rearAxle.y, rearAxle.z), 0.012, M.frame, 0.009)); // chainstay
    frame.add(tube(V(s * 0.02, seatTop.y - 0.02, seatTop.z - 0.005), V(s * 0.062, rearAxle.y, rearAxle.z), 0.011, M.frame, 0.008)); // seatstay
  }
  // lugs (cream rings)
  for (const p of [headTop, headBot]) {
    const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.02, 18), M.cream);
    lug.position.copy(p);
    lug.quaternion.setFromUnitVectors(UP, axis);
    frame.add(lug);
  }
  const bbShell = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.08, 18), M.frame);
  bbShell.rotation.z = Math.PI / 2; bbShell.position.copy(bb);
  frame.add(bbShell);

  // seat post + saddle
  const stDir = new THREE.Vector3().subVectors(seatTop, bb).normalize();
  frame.add(tube(seatTop, seatTop.clone().addScaledVector(stDir, 0.1), 0.014, M.chrome));
  const sg = new THREE.SphereGeometry(1, 36, 18);
  {
    const p = sg.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const t = (z + 1) / 2; // 0 nose -> 1 back
      const w = 0.03 + 0.08 * Math.pow(t, 0.85);
      x *= w;
      y = y > 0 ? y * 0.034 : y * 0.022;
      y += 0.01 * Math.pow(t, 3) - 0.004 * Math.sin(t * Math.PI);
      z *= 0.145;
      p.setXYZ(i, x, y, z);
    }
    sg.computeVertexNormals();
  }
  const saddle = new THREE.Mesh(sg, M.leather);
  saddle.position.copy(GEO.saddle).add(V(0, 0.0, 0.01));
  saddle.castShadow = true;
  frame.add(saddle);
  for (const s of [-1, 1]) {
    const spring = new THREE.Mesh(new THREE.TubeGeometry(new Helix(0.013, 0.05, 5), 90, 0.0026, 6), M.chrome);
    spring.position.set(s * 0.045, GEO.saddle.y - 0.07, GEO.saddle.z + 0.09);
    frame.add(spring);
    for (let k = 0; k < 4; k++) {
      const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), M.chrome);
      rivet.position.set(s * (0.05 + k * 0.012), GEO.saddle.y + 0.012, GEO.saddle.z + 0.13 - k * 0.02);
      frame.add(rivet);
    }
  }

  // rear fender, rack, light, flag
  const rearFender = new THREE.Mesh(fenderGeo(-0.45, 2.45), M.cream);
  rearFender.position.copy(rearAxle);
  rearFender.castShadow = true;
  frame.add(rearFender);
  for (const s of [-1, 1]) {
    frame.add(tube(V(s * 0.05, 0.62, 0.33), V(s * 0.07, 0.745, 0.42), 0.006, M.chrome));
    frame.add(tube(V(s * 0.065, rearAxle.y, rearAxle.z + 0.01), V(s * 0.07, 0.745, 0.7), 0.006, M.chrome));
    frame.add(tube(V(s * 0.07, 0.745, 0.42), V(s * 0.07, 0.745, 0.75), 0.006, M.chrome));
  }
  for (let k = 0; k < 4; k++) frame.add(tube(V(-0.07, 0.745, 0.47 + k * 0.08), V(0.07, 0.745, 0.47 + k * 0.08), 0.005, M.chrome));
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, 0.02), M.redLight);
  tail.position.set(0, 0.725, 0.765);
  frame.add(tail);
  const pole = tube(V(0.05, 0.745, 0.73), V(0.06, 1.9, 0.8), 0.005, M.chrome);
  frame.add(pole);
  const flagGeo = new THREE.PlaneGeometry(0.44, 0.22, 18, 4);
  flagGeo.translate(0.22, 0, 0);
  flagGeo.rotateY(-Math.PI / 2);
  const flag = new THREE.Mesh(flagGeo, M.flag);
  flag.position.set(0.06, 1.78, 0.795);
  flag.castShadow = true;
  frame.add(flag);
  const flagBase = Float32Array.from(flagGeo.attributes.position.array);

  // ---------- rear wheel ----------
  const rw = makeWheel(M, blurTex);
  rw.wheel.position.copy(rearAxle);
  group.add(rw.wheel);
  const cog = new THREE.Mesh(gearGeometry(GEO.cogR, 14, 0.005, 0.012), M.chrome);
  cog.position.x = 0.065;
  rw.spin.add(cog);

  // ---------- steering assembly ----------
  const steerPivot = new THREE.Group();
  steerPivot.position.copy(headTop);
  steerPivot.quaternion.setFromUnitVectors(UP, axis);
  group.add(steerPivot);
  const steer = new THREE.Group();
  steerPivot.add(steer);
  steerPivot.updateMatrix();
  const inv = steerPivot.matrix.clone().invert();
  const addSteer = (o) => { o.applyMatrix4(inv); steer.add(o); return o; };

  const fw = makeWheel(M, blurTex);
  fw.wheel.position.copy(GEO.frontAxle);
  addSteer(fw.wheel);

  const crown = headBot.clone().addScaledVector(axis, -0.035);
  for (const s of [-1, 1]) {
    const mid = crown.clone().lerp(GEO.frontAxle, 0.5);
    addSteer(curveTube([
      V(s * 0.03, crown.y, crown.z),
      V(s * 0.052, mid.y, mid.z - 0.005),
      V(s * 0.055, GEO.frontAxle.y + 0.05, GEO.frontAxle.z - 0.03),
      V(s * 0.055, GEO.frontAxle.y, GEO.frontAxle.z - 0.03),
    ], 0.011, M.frame, 24));
  }
  const crownMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.05), M.chrome);
  crownMesh.position.copy(crown);
  crownMesh.quaternion.setFromUnitVectors(UP, axis);
  addSteer(crownMesh);

  const frontFender = new THREE.Mesh(fenderGeo(0.95, 2.6), M.cream);
  frontFender.position.copy(GEO.frontAxle);
  frontFender.castShadow = true;
  addSteer(frontFender);

  // stem + swept-back cruiser bars
  const stemTop = headTop.clone().addScaledVector(axis, 0.15);
  addSteer(tube(headTop, stemTop, 0.014, M.chrome));
  addSteer(tube(stemTop, V(0, 0.98, -0.405), 0.013, M.chrome));
  const bar = [];
  bar.push(V(-0.27, 0.99, -0.12), V(-0.262, 0.99, -0.22), V(-0.235, 0.988, -0.29), V(-0.16, 0.984, -0.37), V(-0.06, 0.98, -0.405), V(0, 0.98, -0.41));
  const barPts = [...bar, ...bar.slice(0, -1).reverse().map((p) => V(-p.x, p.y, p.z))];
  addSteer(curveTube(barPts, 0.011, M.chrome, 80));
  const grips = [];
  for (const s of [-1, 1]) {
    addSteer(tube(V(s * 0.262, 0.99, -0.23), V(s * 0.272, 0.99, -0.11), 0.017, M.leather, 0.018));
    const end = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), M.leather);
    end.position.set(s * 0.272, 0.99, -0.11);
    addSteer(end);
    const marker = new THREE.Object3D();
    marker.position.set(s * GEO.grip.x, GEO.grip.y, GEO.grip.z);
    addSteer(marker);
    grips.push(marker);
  }

  // bell
  const bell = new THREE.Group();
  bell.position.set(-0.18, 1.0, -0.355);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.024, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.chrome);
  dome.position.y = 0.006;
  bell.add(dome);
  const bellLever = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, 0.03), M.dark);
  bellLever.position.set(0.02, 0.008, 0.01);
  bell.add(bellLever);
  addSteer(bell);

  // basket with fish
  const basket = new THREE.Group();
  basket.position.copy(GEO.basket);
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.165, 0.135, 0.17, 28, 1, true), M.basket);
  shell.castShadow = true;
  basket.add(shell);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.135, 28), M.basket);
  bottom.rotation.x = -Math.PI / 2; bottom.position.y = -0.085;
  basket.add(bottom);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.011, 8, 40), M.wicker);
  lip.rotation.x = Math.PI / 2; lip.position.y = 0.085;
  basket.add(lip);
  const fishIn = [];
  [[-0.05, 0.06, 0.02, 0.5, 0.3], [0.05, 0.05, -0.03, -0.4, -0.5], [0.0, 0.08, 0.06, 0.2, 1.2]].forEach(([x, y, z, rz, ry]) => {
    const f = makeFish(0.95);
    f.position.set(x, y, z);
    f.rotation.set(-1.2, ry, rz);
    basket.add(f);
    fishIn.push(f);
  });
  addSteer(basket);
  for (const s of [-1, 1]) addSteer(tube(V(s * 0.07, 0.785, -0.64), V(s * 0.058, GEO.frontAxle.y, GEO.frontAxle.z), 0.0045, M.chrome));
  addSteer(tube(V(0, 0.84, -0.52), V(0, 0.95, -0.405), 0.006, M.chrome));

  // headlight
  const lamp = new THREE.Group();
  lamp.position.set(0, 0.79, -0.835);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.03, 0.07, 20), M.chrome);
  housing.rotation.x = Math.PI / 2;
  lamp.add(housing);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.034, 20), M.lens);
  lens.position.z = -0.036; lens.rotation.y = Math.PI;
  lamp.add(lens);
  addSteer(lamp);
  const headlight = new THREE.SpotLight(0xfff0d0, 0, 60, 0.55, 0.6, 1.2);
  headlight.position.set(0, 0.79, -0.88);
  const hlTarget = new THREE.Object3D();
  hlTarget.position.set(0, 0.0, -9);
  addSteer(headlight);
  addSteer(hlTarget);
  headlight.target = hlTarget;

  // ---------- drivetrain ----------
  const crank = new THREE.Group();
  crank.position.copy(bb);
  group.add(crank);
  const spindle = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 10), M.chrome);
  spindle.rotation.z = Math.PI / 2;
  crank.add(spindle);
  const ring = new THREE.Mesh(gearGeometry(GEO.ringR, 36, 0.005, 0.074), M.chrome);
  ring.position.x = 0.065;
  crank.add(ring);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.08, 0.014), M.chrome);
    arm.position.set(0.068, Math.cos(a) * 0.04, Math.sin(a) * 0.04);
    arm.rotation.x = -a;
    crank.add(arm);
  }
  const pedals = [];
  for (const s of [-1, 1]) {
    const dir = s > 0 ? -1 : 1; // right arm points down at angle 0
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.016, GEO.crankLen + 0.03, 0.028), M.chrome);
    arm.position.set(s * 0.095, dir * GEO.crankLen / 2, 0);
    arm.castShadow = true;
    crank.add(arm);
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.1, dir * GEO.crankLen, 0);
    crank.add(pivot);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.1, 8), M.chrome);
    axle.rotation.z = Math.PI / 2; axle.position.x = s * 0.05;
    pivot.add(axle);
    const plat = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.018, 0.065), M.dark);
    plat.position.x = s * 0.055;
    plat.castShadow = true;
    pivot.add(plat);
    for (const zz of [-1, 1]) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.006), M.reflector);
      r.position.set(s * 0.055, 0, zz * 0.034);
      pivot.add(r);
    }
    const foot = new THREE.Object3D();
    foot.position.set(s * 0.055, 0.009, 0);
    pivot.add(foot);
    pedals.push({ pivot, foot, side: s });
  }

  // chain
  const chainPath = buildChainPath(bb, GEO.ringR + 0.003, rearAxle, GEO.cogR + 0.003);
  const pitch = 0.0127;
  const linkCount = Math.floor(chainPath.L / pitch);
  const linkGeo = new THREE.BoxGeometry(0.009, 0.007, pitch * 1.05);
  const links = new THREE.InstancedMesh(linkGeo, M.chain, linkCount);
  links.position.x = 0.065;
  links.frustumCulled = false;
  group.add(links);
  const tmpObj = new THREE.Object3D();
  const tmpP = {};
  const chainColor = new THREE.Color();
  for (let i = 0; i < linkCount; i++) links.setColorAt(i, chainColor.setScalar(i % 2 ? 0.6 : 1.0));
  const realPitch = chainPath.L / linkCount;

  // chainguard
  const guard = curveTube([V(0.09, 0.39, 0.06), V(0.09, 0.42, 0.25), V(0.09, 0.40, 0.48)], 0.012, M.cream, 24);
  group.add(guard);

  group.traverse((o) => { if (o.isMesh && o.castShadow === false && !o.material.transparent) o.castShadow = true; });
  rw.blur.castShadow = fw.blur.castShadow = false;

  // ---------- update ----------
  const api = {
    group, steer, frame, M, grips, pedals, basket, fishIn, headlight, bell, flag, crank,
    rearWheel: rw, frontWheel: fw,
    bellT: 0,
    update(dt, s) {
      // s: {wheelAngle, crankAngle, speed, steerAngle, night, time}
      rw.spin.rotation.x = -s.wheelAngle;
      fw.spin.rotation.x = -s.wheelAngle * (GEO.R / GEO.R);
      const blurA = smoothstep(3, 12, s.speed) * 0.55;
      rw.blur.material.opacity = blurA;
      crank.rotation.x = -s.crankAngle;
      const tilt = Math.sin(s.crankAngle) * 0.25;
      for (const p of pedals) p.pivot.rotation.x = s.crankAngle + tilt * p.side;
      steer.rotation.y = s.steerAngle;

      // chain links glide along the path
      const off = -s.crankAngle * (GEO.ringR + 0.003);
      for (let i = 0; i < linkCount; i++) {
        chainPath.at(i * realPitch + off, tmpP);
        tmpObj.position.set(0, tmpP.y, tmpP.z);
        tmpObj.rotation.set(Math.atan2(-tmpP.ty, tmpP.tz), 0, 0);
        tmpObj.updateMatrix();
        links.setMatrixAt(i, tmpObj.matrix);
      }
      links.instanceMatrix.needsUpdate = true;

      // bell wiggle
      if (this.bellT > 0) {
        this.bellT -= dt;
        bellLever.rotation.y = Math.sin(this.bellT * 60) * 0.8 * Math.min(1, this.bellT * 4);
        dome.rotation.y += dt * 30;
      }

      // pennant waving in the wind
      const pos = flag.geometry.attributes.position;
      const wind = 0.3 + s.speed * 0.12;
      for (let i = 0; i < pos.count; i++) {
        const bx = flagBase[i * 3], by = flagBase[i * 3 + 1], bz = flagBase[i * 3 + 2];
        const u = bz / 0.44;
        const w = Math.sin(bz * 14 - s.time * (4 + s.speed * 0.8)) * 0.045 * u * Math.min(1, wind) +
                  Math.sin(bz * 23 - s.time * 9 + by * 8) * 0.012 * u;
        pos.setXYZ(i, bx + w, by - u * u * 0.05 * (1 - Math.min(1, wind * 0.6)), bz * (1 - 0.06 * Math.abs(w) * 10));
      }
      pos.needsUpdate = true;
      flag.geometry.computeVertexNormals();

      // lights
      const n = s.night;
      headlight.intensity = n * 160;
      M.lens.emissiveIntensity = 0.3 + n * 9;
      M.redLight.emissiveIntensity = 0.4 + n * (Math.sin(s.time * 9) > 0 ? 7 : 1.2);
    },
  };
  return api;
}
