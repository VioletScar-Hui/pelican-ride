import * as THREE from 'three';

// ---------- math helpers ----------
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Damped spring used for secondary motion (pouch wobble, landing squash...)
export class Spring {
  constructor(k = 120, c = 12) { this.x = 0; this.v = 0; this.k = k; this.c = c; }
  update(dt, target = 0) {
    const a = -this.k * (this.x - target) - this.c * this.v;
    this.v += a * dt; this.x += this.v * dt;
    return this.x;
  }
  kick(v) { this.v += v; }
}

// ---------- terrain: identical on CPU and GPU (sum of sines, no hash precision issues) ----------
export const ROAD_HALF = 3.6;

export function terrainHeight(x, z) {
  const ax = Math.abs(x);
  let n = Math.sin(x * 0.045 + z * 0.031) * 3.2
        + Math.sin(x * 0.083 - z * 0.067 + 1.7) * 1.8
        + Math.sin(x * 0.17 + z * 0.13 + 4.1) * 0.7
        + Math.sin(-x * 0.29 + z * 0.23 + 2.3) * 0.35;
  n = (n + 6.05) * 0.55;
  let h = n * smoothstep(5.5, 18.0, ax);
  h += smoothstep(45.0, 140.0, ax) * 18.0;
  h -= 0.22 * smoothstep(3.9, 4.9, ax) * (1.0 - smoothstep(5.6, 7.5, ax));
  return h;
}

export const TERRAIN_GLSL = /* glsl */`
float terrainHeight(vec2 p){
  float x = p.x, z = p.y; float ax = abs(x);
  float n = sin(x*0.045 + z*0.031)*3.2 + sin(x*0.083 - z*0.067 + 1.7)*1.8
          + sin(x*0.17 + z*0.13 + 4.1)*0.7 + sin(-x*0.29 + z*0.23 + 2.3)*0.35;
  n = (n + 6.05)*0.55;
  float h = n * smoothstep(5.5, 18.0, ax);
  h += smoothstep(45.0, 140.0, ax) * 18.0;
  h -= 0.22 * smoothstep(3.9, 4.9, ax) * (1.0 - smoothstep(5.6, 7.5, ax));
  return h;
}`;

// ---------- procedural canvas textures ----------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

// Overlapping scallops -> bump map that reads as layered feathers
export function featherBumpTexture() {
  const S = 512;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, S, S);
  const cols = 10, rows = 14, w = S / cols, h = S / rows;
  for (let r = -1; r <= rows + 1; r++) {
    for (let col = -1; col <= cols + 1; col++) {
      const x = col * w + (r % 2 ? w / 2 : 0);
      const y = r * h;
      const grd = g.createRadialGradient(x, y - h * 0.3, 2, x, y, w * 0.8);
      grd.addColorStop(0, '#d0d0d0');
      grd.addColorStop(0.65, '#9a9a9a');
      grd.addColorStop(1, '#3a3a3a');
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(x, y, w * 0.62, h * 1.25, 0, 0, Math.PI); g.fill();
      // barbs
      g.strokeStyle = 'rgba(60,60,60,0.25)'; g.lineWidth = 1;
      for (let k = -3; k <= 3; k++) {
        g.beginPath(); g.moveTo(x, y + 2); g.lineTo(x + k * w * 0.12, y + h * 1.1); g.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function weaveTexture() {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#5a3a1c'; g.fillRect(0, 0, S, S);
  const n = 8, cell = S / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const horiz = (i + j) % 2 === 0;
      const x = i * cell, y = j * cell;
      const grd = horiz ? g.createLinearGradient(x, y, x, y + cell) : g.createLinearGradient(x, y, x + cell, y);
      grd.addColorStop(0, '#8a5e2e'); grd.addColorStop(0.5, '#d9a865'); grd.addColorStop(1, '#7a5026');
      g.fillStyle = grd;
      const pad = 3;
      g.beginPath();
      g.roundRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2, 8);
      g.fill();
      g.strokeStyle = 'rgba(70,40,15,0.35)';
      for (let k = 1; k < 4; k++) {
        g.beginPath();
        if (horiz) { g.moveTo(x + pad, y + k * cell / 4); g.lineTo(x + cell - pad, y + k * cell / 4); }
        else { g.moveTo(x + k * cell / 4, y + pad); g.lineTo(x + k * cell / 4, y + cell - pad); }
        g.stroke();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(4, 1);
  return t;
}

export function flagTexture() {
  const [c, g] = canvas(512, 256);
  const grd = g.createLinearGradient(0, 0, 512, 0);
  grd.addColorStop(0, '#ff6a2b'); grd.addColorStop(1, '#ffc23d');
  g.fillStyle = grd;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(512, 128); g.lineTo(0, 256); g.closePath(); g.fill();
  g.strokeStyle = '#fff7e0'; g.lineWidth = 10; g.stroke();
  g.font = '110px "Apple Color Emoji","Segoe UI Emoji",sans-serif';
  g.textBaseline = 'middle';
  g.fillText('🐟', 40, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function featherSpriteTexture() {
  const [c, g] = canvas(64, 160);
  g.translate(32, 80);
  const grd = g.createLinearGradient(-24, 0, 24, 0);
  grd.addColorStop(0, '#d9d6cf'); grd.addColorStop(0.5, '#ffffff'); grd.addColorStop(1, '#cfccc4');
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(0, -74);
  g.bezierCurveTo(26, -50, 24, 40, 4, 66);
  g.lineTo(-4, 66);
  g.bezierCurveTo(-24, 40, -26, -50, 0, -74);
  g.fill();
  g.strokeStyle = 'rgba(120,115,105,0.9)'; g.lineWidth = 2.2;
  g.beginPath(); g.moveTo(0, -70); g.lineTo(0, 78); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1;
  for (let y = -60; y < 60; y += 7) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(-18, y + 12); g.stroke();
    g.beginPath(); g.moveTo(0, y); g.lineTo(18, y + 12); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function blurDiscTexture() {
  const S = 256;
  const [c, g] = canvas(S, S);
  const cx = S / 2;
  for (let r = 10; r < cx; r += 3) {
    const a = 0.05 + 0.08 * Math.random() + (r > cx * 0.85 ? 0.15 : 0);
    g.strokeStyle = `rgba(200,205,215,${a})`;
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function signTexture(title, sub, color = '#1f7a4d') {
  const [c, g] = canvas(512, 288);
  g.fillStyle = color;
  g.beginPath(); g.roundRect(6, 6, 500, 276, 28); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 10;
  g.beginPath(); g.roundRect(20, 20, 472, 248, 20); g.stroke();
  g.fillStyle = '#ffffff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'bold 76px "PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif';
  g.fillText(title, 256, 112);
  g.font = '600 52px "PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif';
  g.fillText(sub, 256, 200);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- shared models ----------
export function makeFish(scale = 1) {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 22, 14);
  const pos = geo.attributes.position;
  const cols = [];
  const top = new THREE.Color('#2f5878'), belly = new THREE.Color('#e8eef3'), tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    tmp.copy(belly).lerp(top, smoothstep(-0.2, 0.6, y));
    cols.push(tmp.r, tmp.g, tmp.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.28 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x5f86a3, metalness: 0.3, roughness: 0.4, side: THREE.DoubleSide });
  const body = new THREE.Mesh(geo, mat);
  body.scale.set(0.024, 0.036, 0.09);
  g.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.055, 4), finMat);
  tail.rotation.x = -Math.PI / 2;
  tail.scale.set(0.25, 1, 1);
  tail.position.z = 0.1;
  g.add(tail);
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.04, 4), finMat);
  dorsal.scale.set(0.2, 1, 1); dorsal.position.set(0, 0.035, 0.01); dorsal.rotation.x = 0.5;
  g.add(dorsal);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 8, 6), eyeMat);
    e.position.set(s * 0.019, 0.01, -0.058);
    g.add(e);
  }
  g.scale.setScalar(scale);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}
