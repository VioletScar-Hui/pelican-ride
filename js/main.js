import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWorld, U } from './world.js';
import { createBike, GEO } from './bike.js';
import { createPelican } from './pelican.js';
import { Particles, Feathers, createPost } from './fx.js';
import { AudioEngine } from './audio.js';
import { clamp, lerp, damp, smoothstep, rand, easeInOutCubic, makeFish } from './util.js';

const $ = (s) => document.querySelector(s);
const V3 = THREE.Vector3;

// ============================================================================
// Renderer / scene / camera
// ============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.65;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('#app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.05, 6000);
camera.position.set(9, 5.5, -12);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.2;
controls.maxDistance = 30;
controls.maxPolarAngle = Math.PI * 0.49;
controls.target.set(0, 1, 0);
controls.autoRotateSpeed = 0.5;
controls.enabled = false;

const world = createWorld(scene, renderer);
const bike = createBike();
scene.add(bike.group);
const pelican = createPelican(scene, bike);

const dust = new Particles(500);
const sparkles = new Particles(300, { additive: true });
const feathers = new Feathers(60);
scene.add(dust.points, sparkles.points, feathers.mesh);

const post = createPost(renderer, scene, camera);
const audio = new AudioEngine();

// ============================================================================
// State
// ============================================================================
const S = {
  t: 0,
  speed: 0, targetKmh: 22,
  travel: 0, wheel: 0, crank: 0,
  x: 0, vx: 0, targetX: 0, yaw: 0, lean: 0, steer: 0, lastYaw: 0,
  y: 0, vy: 0, airborne: false, airT: 0, pitch: 0,
  hour: 16.6, autoCycle: true, hoursPerSec: 1 / 20,
  fish: 0, fxOn: true,
  waveT: 0,
  lastInput: -99,
  keys: {},
  camMode: 'orbit',
  uiHidden: false,
};

const thrown = { active: false, t: 0, T: 0.95, p0: new V3(), v0: new V3(), mesh: makeFish(1.05) };
thrown.mesh.visible = false;
bike.group.add(thrown.mesh);

// ============================================================================
// UI wiring
// ============================================================================
const ui = {
  spd: $('#spd'), cad: $('#cad'), dist: $('#dist'), clock: $('#clock'), sunIcon: $('#sunIcon'), fish: $('#fish'),
  needle: $('#needle'), arc: $('#arcVal'), spdR: $('#spdR'), spdO: $('#spdO'), timeR: $('#timeR'), timeO: $('#timeO'),
  fps: $('#fps'), toasts: $('#toasts'),
};
const fmtClock = (h) => {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
const ARC_LEN = 2 * Math.PI * 48 * (240 / 360);
ui.arc.style.strokeDasharray = `0 ${ARC_LEN * 2}`;

function toast(html) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  ui.toasts.appendChild(el);
  setTimeout(() => el.classList.add('out'), 1800);
  setTimeout(() => el.remove(), 2400);
}

ui.spdR.addEventListener('input', () => { S.targetKmh = +ui.spdR.value; ui.spdO.textContent = ui.spdR.value; });
ui.timeR.addEventListener('input', () => { S.hour = +ui.timeR.value; world.setTime(S.hour); });

function setToggle(id, on) { const b = $(id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
$('#tCycle').addEventListener('click', () => { S.autoCycle = !S.autoCycle; setToggle('#tCycle', S.autoCycle); toast(S.autoCycle ? '🌗 昼夜循环：开' : '⏸ 时间已暂停'); });
$('#tSound').addEventListener('click', () => { audio.init(); audio.setSfx(!audio.sfxOn); setToggle('#tSound', audio.sfxOn); });
$('#tMusic').addEventListener('click', () => { audio.init(); audio.setMusic(!audio.musicOn); setToggle('#tMusic', audio.musicOn); if (audio.musicOn) toast('🎵 音乐节拍跟随踏频'); });
$('#tFx').addEventListener('click', () => { S.fxOn = !S.fxOn; setToggle('#tFx', S.fxOn); });
setToggle('#tCycle', true); setToggle('#tSound', true); setToggle('#tMusic', false); setToggle('#tFx', true);

document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => { action(b.dataset.act); b.blur(); }));
document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => { setCam(b.dataset.cam); b.blur(); }));
document.querySelectorAll('button').forEach((b) => b.addEventListener('pointerup', () => b.blur()));

$('#keysToggle').addEventListener('click', () => $('#keys').classList.toggle('collapsed'));

// ============================================================================
// Actions
// ============================================================================
function action(a) {
  audio.init();
  S.lastInput = S.t;
  switch (a) {
    case 'fish': throwFish(); break;
    case 'bell': bike.bellT = 0.6; audio.bell(); toast('🔔 叮铃铃～'); break;
    case 'honk': pelican.honk(); audio.honk(); break;
    case 'wave': S.waveT = 2.6; toast('👋 鹈鹕向你挥挥翅膀'); break;
    case 'jump': jump(); break;
    case 'photo': photo(); break;
  }
}

function throwFish() {
  if (thrown.active) return;
  const mouth = pelican.mouthWorld(new V3());
  bike.group.worldToLocal(mouth);
  thrown.p0.set(rand(-0.05, 0.05), GEO.basket.y + 0.1, GEO.basket.z);
  thrown.T = 0.9;
  const T = thrown.T;
  const target = mouth.clone().add(new V3(0, 0.25, -0.05));
  thrown.v0.copy(target).sub(thrown.p0).sub(new V3(0, -9.8 * 0.5 * T * T, 0)).divideScalar(T);
  thrown.t = 0;
  thrown.active = true;
  thrown.mesh.visible = true;
  thrown.mesh.position.copy(thrown.p0);
  audio.boing();
}

function jump() {
  if (S.airborne) return;
  S.vy = 3.4;
  S.airborne = true;
  S.airT = 0;
  audio.whoosh();
  for (let i = 0; i < 4; i++) emitFeather(0.6);
}

function photo() {
  render();
  const url = renderer.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `pelican-ride-${Date.now()}.png`;
  a.click();
  const f = $('#flash');
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  audio.shutter();
  toast('📸 照片已保存');
}

const tmpV = new V3(), tmpV2 = new V3();
function emitFeather(up = 0.3) {
  pelican.root.getWorldPosition(tmpV);
  tmpV.add(tmpV2.set(rand(-0.25, 0.25), rand(0.1, 0.5), rand(-0.2, 0.3)));
  feathers.emit(tmpV, tmpV2.set(rand(-0.8, 0.8), rand(0.3, 1.2) + up, rand(0, 1.5)));
}

// ============================================================================
// Camera rigs
// ============================================================================
const cam = {
  look: new V3(0, 0.8, -6), intro: 0, introDur: 4.2, introArc: 1.2, introLookFrom: new V3(0, 0.8, -6), introFrom: new V3(9, 5.5, -12), introTo: new V3(3.4, 1.55, -3.2),
  shot: 0, shotT: 0, shotOrder: [1, 0, 2, 5, 3, 4, 6], flyZ: 0, fov: 42, shake: 0,
};

function setCam(mode, keepView = false) {
  const prev = S.camMode;
  S.camMode = mode;
  if (mode === 'orbit' && prev !== 'orbit' && !keepView && cam.intro >= 1) {
    // glide back to a flattering 3/4 view instead of inheriting a random shot
    cam.introFrom.copy(camera.position);
    cam.introLookFrom.copy(cam.look);
    cam.introTo.set(3.4, 1.55, -3.2);
    cam.introDur = 1.6; cam.introArc = 0.3; cam.intro = 0;
    controls.autoRotate = false;
  }
  document.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('on', b.dataset.cam === mode));
  document.body.classList.toggle('cine', mode === 'cinematic');
  controls.enabled = mode === 'orbit' && cam.intro >= 1;
  if (mode === 'orbit') {
    controls.target.copy(focusPoint(new V3()));
    controls.update();
  }
  if (mode === 'cinematic') { cam.shotT = 0; cam.shot = 0; startShot(); }
}

function focusPoint(out) {
  return out.set(bike.group.position.x, 1.0 + bike.group.position.y * 0.6, -0.05);
}

function startShot() {
  const id = cam.shotOrder[cam.shot % cam.shotOrder.length];
  if (id === 5) cam.flyZ = -Math.max(8, (S.speed) * 3.2) - S.travel;
}

const _f = new V3(), _h = new V3(), _p = new V3(), _l = new V3();
function updateCamera(dt) {
  const focus = focusPoint(_f);
  const bp = bike.group.position;
  let fov = 42;

  if (S.camMode === 'orbit') {
    if (cam.intro < 1) {
      cam.intro = Math.min(1, cam.intro + dt / cam.introDur);
      const k = easeInOutCubic(cam.intro);
      _l.copy(cam.introTo).add(tmpV.set(bp.x, 0, 0));
      camera.position.lerpVectors(cam.introFrom, _l, k);
      camera.position.y += Math.sin(k * Math.PI) * cam.introArc;
      cam.look.lerpVectors(cam.introLookFrom, focus, k);
      camera.lookAt(cam.look);
      controls.target.copy(focus);
      if (cam.intro >= 1) { controls.enabled = true; controls.autoRotate = true; }
    } else {
      const d = _p.subVectors(focus, controls.target);
      camera.position.add(d);
      controls.target.add(d);
      controls.update();
      cam.look.copy(controls.target);
    }
  } else if (S.camMode === 'chase') {
    _p.set(0.85, 2.0, 4.6).applyAxisAngle(THREE.Object3D.DEFAULT_UP, S.yaw).add(bp);
    _p.y = Math.max(_p.y, 1.6);
    camera.position.x = damp(camera.position.x, _p.x, 4, dt);
    camera.position.y = damp(camera.position.y, _p.y, 4, dt);
    camera.position.z = damp(camera.position.z, _p.z, 4, dt);
    _l.copy(focus).add(tmpV.set(0, 0.1, -2.5).applyAxisAngle(THREE.Object3D.DEFAULT_UP, S.yaw));
    cam.look.lerp(_l, 1 - Math.exp(-8 * dt));
    camera.lookAt(cam.look);
    fov = 50 + S.speed * 0.5;
  } else if (S.camMode === 'side') {
    _p.set(bp.x + 5.4, 1.15, -0.2);
    camera.position.lerp(_p, 1 - Math.exp(-5 * dt));
    cam.look.lerp(_l.set(bp.x, 0.95 + bp.y * 0.5, -0.2), 1 - Math.exp(-8 * dt));
    camera.lookAt(cam.look);
    fov = 38;
  } else if (S.camMode === 'cinematic') {
    cam.shotT += dt;
    const DUR = 6.5;
    if (cam.shotT > DUR) { cam.shotT = 0; cam.shot++; startShot(); }
    const u = cam.shotT / DUR;
    const id = cam.shotOrder[cam.shot % cam.shotOrder.length];
    pelican.headWorld(_h);
    switch (id) {
      case 0: _p.set(bp.x + 1.1 + u * 0.4, 0.42, -3.8 + u * 0.8); _l.set(bp.x, 1.2, -0.1); fov = 40; break;
      case 1: { const a = 0.6 + u * 1.3; _p.set(bp.x + Math.cos(a) * 4.3, 1.3 + u * 0.7, Math.sin(a) * 4.3); _l.set(bp.x, 0.95, 0); fov = 38; break; }
      case 2: _p.set(bp.x + 0.95 - u * 0.25, 1.78 + u * 0.05, -1.55 + u * 0.25); _l.copy(_h).add(tmpV.set(0, -0.05, -0.12)); fov = 30; break;
      case 3: _p.set(bp.x + 1.05, 0.42, 0.95 - u * 0.9); _l.set(bp.x + 0.05, 0.38, 0.2 - u * 0.2); fov = 36; break;
      case 4: _p.set(bp.x - 7 + u * 3, 7.5 - u * 1.8, 7 - u * 1); _l.set(bp.x, 0.8, -1); fov = 42; break;
      case 5: _p.set(4.3, 0.85, cam.flyZ + S.travel); _l.copy(focus); fov = 28; break;
      case 6: _p.set(bp.x - 0.85, 0.32, 2.5 - u * 0.6); _l.set(bp.x, 0.8, -1.2); fov = 42; break;
    }
    if (cam.shotT < dt * 1.5) { camera.position.copy(_p); cam.look.copy(_l); cam.fov = fov; }
    camera.position.lerp(_p, 1 - Math.exp(-6 * dt));
    cam.look.lerp(_l, 1 - Math.exp(-6 * dt));
    camera.lookAt(cam.look);
  }

  if (cam.shake > 0) {
    cam.shake = Math.max(0, cam.shake - dt * 2.5);
    camera.position.y += (Math.random() - 0.5) * cam.shake * 0.06;
    camera.position.x += (Math.random() - 0.5) * cam.shake * 0.04;
  }
  if (S.camMode !== 'orbit') {
    cam.fov = damp(cam.fov, fov, 3, dt);
    if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
  } else if (Math.abs(camera.fov - 42) > 0.01) {
    cam.fov = camera.fov = damp(camera.fov, 42, 4, dt); camera.updateProjectionMatrix();
  }
}

renderer.domElement.addEventListener('pointerdown', () => {
  audio.init();
  $('#hint').classList.add('hide');
  if (S.camMode !== 'orbit') {
    setCam('orbit', true);
    controls.target.copy(focusPoint(new V3()));
    controls.enabled = true;
  }
  if (cam.intro < 1) { cam.intro = 1; controls.enabled = true; controls.target.copy(focusPoint(new V3())); }
  controls.autoRotate = false;
});

// ============================================================================
// Keyboard
// ============================================================================
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  audio.init();
  $('#hint').classList.add('hide');
  S.keys[e.code] = true;
  S.lastInput = S.t;
  switch (e.code) {
    case 'Space': e.preventDefault(); action('jump'); break;
    case 'KeyF': action('fish'); break;
    case 'KeyB': action('bell'); break;
    case 'KeyH': action('honk'); break;
    case 'KeyW': action('wave'); break;
    case 'KeyP': action('photo'); break;
    case 'Digit1': setCam('cinematic'); break;
    case 'Digit2': setCam('orbit'); break;
    case 'Digit3': setCam('chase'); break;
    case 'Digit4': setCam('side'); break;
    case 'KeyN': $('#tCycle').click(); break;
    case 'KeyM': $('#tMusic').click(); break;
    case 'KeyU': S.uiHidden = !S.uiHidden; document.body.classList.toggle('noui', S.uiHidden); applyViewOffset(); break;
    case 'ArrowUp': e.preventDefault(); break;
    case 'ArrowDown': e.preventDefault(); break;
  }
});
window.addEventListener('keyup', (e) => { S.keys[e.code] = false; });

// ============================================================================
// Simulation
// ============================================================================
const gaze = { mode: 'road', t: 3, pos: new V3(0, 1.4, -10) };
const autoAct = { t: 6 };

function updateSim(dt) {
  const k = S.keys;
  // speed
  if (k.ArrowUp) S.targetKmh = clamp(S.targetKmh + 15 * dt, 0, 60);
  if (k.ArrowDown) S.targetKmh = clamp(S.targetKmh - 20 * dt, 0, 60);
  if (k.ArrowUp || k.ArrowDown) { ui.spdR.value = Math.round(S.targetKmh); ui.spdO.textContent = Math.round(S.targetKmh); }
  const v = (S.speed = damp(S.speed, S.targetKmh / 3.6, 1.6, dt));

  S.travel += v * dt;
  S.wheel += (v / GEO.R) * dt;
  S.crank += (v / GEO.R / 2.5) * dt;

  // steering / weaving
  const steerIn = (k.ArrowRight || k.KeyD ? 1 : 0) - (k.ArrowLeft || k.KeyA ? 1 : 0);
  if (steerIn) { S.targetX = clamp(S.targetX + steerIn * 2.6 * dt, -2.8, 2.8); S.lastSteer = S.t; }
  else if (S.t - (S.lastSteer ?? -99) > 4) S.targetX = Math.sin(S.t * 0.21) * 1.3 + Math.sin(S.t * 0.53) * 0.35;
  const ax = (S.targetX - S.x) * 2.2 - S.vx * 2.4;
  S.vx += ax * dt;
  S.x += S.vx * dt;
  S.yaw = -Math.atan2(S.vx, Math.max(v, 0.8));
  const yawRate = (S.yaw - S.lastYaw) / Math.max(dt, 1e-4);
  S.lastYaw = S.yaw;
  S.lean = damp(S.lean, -Math.atan(ax * 0.9 / 9.8) * 1.4 - S.vx * v * 0.02, 6, dt);
  S.steer = damp(S.steer, clamp(S.yaw * 1.2 + yawRate * 0.15, -0.5, 0.5) + Math.sin(S.t * 1.7) * 0.015 * (v > 0.5 ? 1 : 0), 8, dt);

  // jumping
  if (S.airborne) {
    S.airT += dt;
    S.vy -= 9.8 * dt;
    S.y += S.vy * dt;
    S.pitch = damp(S.pitch, S.vy * 0.06, 8, dt);
    if (S.y <= 0) {
      S.y = 0;
      const impact = Math.min(1.5, Math.abs(S.vy) / 3.4);
      S.vy = 0;
      S.airborne = false;
      pelican.land(impact);
      audio.thump(impact);
      cam.shake = 0.8 * impact;
      for (let i = 0; i < 6; i++) emitFeather(0.4);
      for (let i = 0; i < 40; i++) {
        tmpV.set(S.x + rand(-0.3, 0.3), 0.03, rand(-0.6, 0.6));
        dust.emit(tmpV, tmpV2.set(rand(-1.5, 1.5), rand(0.2, 1.2), rand(-1, 1) + v), DUST, 0.45, rand(0.15, 0.3), rand(0.8, 1.4), { gravity: 0.6, drag: 2.5, grow: 2.5 });
      }
    }
  } else {
    S.pitch = damp(S.pitch, 0, 6, dt);
    // road texture: tiny vibration
    S.y = Math.abs(Math.sin(S.travel * 7.3) * Math.sin(S.travel * 2.1)) * 0.002 * Math.min(1, v / 5);
  }

  bike.group.position.set(S.x, S.y, 0);
  bike.group.rotation.set(S.pitch, S.yaw, S.lean, 'YXZ');

  if (S.waveT > 0) S.waveT -= dt;

  // time of day
  if (S.autoCycle) {
    S.hour = (S.hour + dt * S.hoursPerSec) % 24;
    world.setTime(S.hour);
  }
  U.uTravel.value = S.travel;
  U.uTime.value = S.t;

  bike.update(dt, {
    wheelAngle: S.wheel, crankAngle: S.crank, speed: v, steerAngle: S.steer, night: world.night, time: S.t,
  });
  bike.group.updateMatrixWorld(true);

  // thrown fish
  let jawOpen = 0, gazeFast = false;
  if (thrown.active) {
    thrown.t += dt;
    const T = thrown.T, t = thrown.t;
    const p = thrown.mesh.position;
    p.copy(thrown.p0).addScaledVector(thrown.v0, t);
    p.y += -0.5 * 9.8 * t * t;
    const m = pelican.mouthWorld(tmpV);
    bike.group.worldToLocal(m);
    const kk = smoothstep(0.55, 1, t / T);
    p.lerp(m, kk);
    thrown.mesh.rotation.x += dt * 14;
    thrown.mesh.rotation.y += dt * 5;
    jawOpen = smoothstep(0.25, 0.75, t / T);
    gazeFast = true;
    if (t >= T) {
      thrown.active = false;
      thrown.mesh.visible = false;
      pelican.swallow();
      audio.gulp();
      S.fish++;
      ui.fish.textContent = S.fish;
      ui.fish.parentElement.classList.remove('pop'); void ui.fish.offsetWidth; ui.fish.parentElement.classList.add('pop');
      const msgs = ['🐟 好吃！', '🐟 咕嘟～', '🐟 再来一条！', '🐟 完美接住！', '🐟 鲜美！'];
      toast(`${msgs[S.fish % msgs.length]} <b>×${S.fish}</b>`);
      pelican.mouthWorld(tmpV);
      for (let i = 0; i < 40; i++) {
        sparkles.emit(tmpV, tmpV2.set(rand(-1.5, 1.5), rand(0.2, 2.2), rand(-1.5, 1.5)), i % 2 ? GOLD : SPARK_W, 1, rand(0.03, 0.06), rand(0.5, 1.1), { gravity: 2.5, drag: 1.5 });
      }
    }
  }

  // gaze
  gaze.t -= dt;
  if (gaze.t < 0) {
    const r = Math.random();
    gaze.mode = r < 0.5 ? 'road' : r < 0.75 ? 'camera' : r < 0.92 ? 'side' : 'bird';
    gaze.side = Math.random() < 0.5 ? -1 : 1;
    gaze.t = rand(1.8, 4.5);
  }
  let target = tmpV2;
  if (thrown.active) target.copy(thrown.mesh.position).applyMatrix4(bike.group.matrixWorld);
  else if (S.waveT > 0 || gaze.mode === 'camera') target.copy(camera.position);
  else if (gaze.mode === 'side') target.set(S.x + gaze.side * 8, 1.6, -5);
  else if (gaze.mode === 'bird' && world.birds[0]) target.copy(world.birds[0].g.position);
  else target.set(S.x + Math.sin(S.t * 0.3) * 1.5, 1.2, -12);
  gaze.pos.lerp(target, 1 - Math.exp(-(gazeFast ? 25 : 5) * dt));

  pelican.update(dt, {
    time: S.t, crank: S.crank, speed: v, lean: S.lean, airborne: S.airborne && S.airT > 0.05,
    gaze: gaze.pos, gazeFast, jaw: jawOpen, waving: S.waveT > 0,
  });

  // dust from the rear tyre (dimmed at night — particles are unlit)
  DUST.copy(DUST_BASE).multiplyScalar(lerp(1, 0.1, world.night));
  if (!S.airborne && v > 2.5) {
    const rate = (v - 2.5) * 4 * dt;
    if (Math.random() < rate) {
      tmpV.set(0, 0.03, GEO.rearAxle.z + 0.05).applyMatrix4(bike.group.matrixWorld);
      dust.emit(tmpV, tmpV2.set(rand(-0.3, 0.3), rand(0.1, 0.5), v * 0.6), DUST, 0.22, rand(0.1, 0.22), rand(0.8, 1.6), { gravity: -0.05, drag: 1.8, grow: 3 });
    }
  }
  if (v > 9 && Math.random() < dt * 0.4) emitFeather(0.2);
  dust.update(dt, v);
  sparkles.update(dt, 0);
  feathers.update(dt, v, 0);

  // demo actions in cinematic mode
  if (S.camMode === 'cinematic') {
    autoAct.t -= dt;
    if (autoAct.t < 0) {
      const acts = ['fish', 'fish', 'wave', 'bell', 'honk', 'jump'];
      action(acts[Math.floor(Math.random() * acts.length)]);
      autoAct.t = rand(4, 7);
    }
  }

  focusPoint(tmpV);
  world.update(dt, S.t, S.travel, tmpV);
  audio.update(dt, { speed: v, crank: S.crank, night: world.night, cadence: (v / GEO.R / 2.5) * 60 / (Math.PI * 2) });
}
const DUST_BASE = new THREE.Color(0.55, 0.48, 0.38);
const DUST = DUST_BASE.clone();
const GOLD = new THREE.Color(3, 2.1, 0.6);
const SPARK_W = new THREE.Color(2.5, 2.5, 2.8);

// ============================================================================
// HUD
// ============================================================================
let hudT = 0;
function updateHUD(dt) {
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;
  const kmh = S.speed * 3.6;
  ui.spd.textContent = Math.round(kmh);
  const frac = clamp(kmh / 60, 0, 1);
  ui.needle.style.transform = `rotate(${-120 + frac * 240}deg)`;
  ui.arc.style.strokeDasharray = `${frac * ARC_LEN} ${ARC_LEN * 2}`;
  ui.cad.textContent = Math.round((S.speed / GEO.R / 2.5) * 60 / (Math.PI * 2));
  ui.dist.textContent = (S.travel / 1000).toFixed(2);
  ui.clock.textContent = fmtClock(S.hour);
  ui.sunIcon.textContent = world.night > 0.5 ? '🌙' : world.golden > 0.5 ? '🌇' : '☀️';
  if (document.activeElement !== ui.timeR) { ui.timeR.value = S.hour.toFixed(2); }
  ui.timeO.textContent = fmtClock(S.hour);
  document.body.classList.toggle('night', world.night > 0.5);
}

// ============================================================================
// Render loop + adaptive quality
// ============================================================================
function render() {
  if (S.fxOn) {
    post.grade.uniforms.uTime.value = S.t;
    post.grade.uniforms.uCA.value = smoothstep(8, 16, S.speed) * 0.012;
    post.bloom.strength = lerp(0.3, 0.85, world.night);
    post.composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

function applyViewOffset() {
  const w = window.innerWidth, h = window.innerHeight;
  if (S.uiHidden) camera.clearViewOffset();
  else camera.setViewOffset(w, h, 0, h * (w < 640 ? 0.1 : 0.075), w, h);
  camera.updateProjectionMatrix();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  applyViewOffset();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h);
  post.composer.setPixelRatio(pixelRatio);
  post.composer.setSize(w, h);
  const scale = (h * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  dust.uniforms.uScale.value = sparkles.uniforms.uScale.value = scale;
}
window.addEventListener('resize', onResize);

let last = performance.now();
let fpsAcc = 0, fpsN = 0, fpsShown = 60, slowT = 0;
let firstFrame = true;
function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 1 / 20);
  S.t += dt;
  updateSim(dt);
  updateCamera(dt);
  updateHUD(dt);
  const scale = (window.innerHeight * pixelRatio) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  dust.uniforms.uScale.value = sparkles.uniforms.uScale.value = scale;
  render();

  // fps + adaptive resolution
  fpsAcc += raw; fpsN++;
  if (fpsAcc > 0.5) {
    fpsShown = fpsN / fpsAcc;
    ui.fps.textContent = `${Math.round(fpsShown)} FPS · ${pixelRatio.toFixed(2)}x`;
    if (S.t > 6 && fpsShown < 38 && pixelRatio > 0.75) slowT += fpsAcc; else slowT = 0;
    if (slowT > 3) { pixelRatio = Math.max(0.75, pixelRatio - 0.25); onResize(); slowT = 0; toast(`⚙️ 自动降低分辨率以保持流畅 (${pixelRatio.toFixed(2)}x)`); }
    fpsAcc = 0; fpsN = 0;
  }

  if (firstFrame) {
    firstFrame = false;
    setTimeout(() => $('#loader').classList.add('done'), 300);
    setTimeout(() => $('#hint').classList.add('show'), 1200);
  }
}

// ============================================================================
// Boot
// ============================================================================
world.setTime(S.hour, true);
ui.timeR.value = S.hour;
setCam('orbit');
onResize();
requestAnimationFrame((t) => { last = t; frame(t); });

// debug handle
window.__pelican = { S, scene, camera, renderer, world, bike, pelican, setCam, action, cam };
