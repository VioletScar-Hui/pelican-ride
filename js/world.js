import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainHeight, TERRAIN_GLSL, mulberry32, smoothstep, clamp, lerp, signTexture } from './util.js';

// Uniforms shared by every scrolling shader
export const U = {
  uTravel: { value: 0 },
  uTime: { value: 0 },
  uLamp: { value: 0 },
};

const SCROLL_COMMON = /* glsl */`
uniform float uTravel; uniform float uTime; uniform float uZMin; uniform float uSpan; uniform float uSway;
${TERRAIN_GLSL}`;

// Patch a built-in material so instanced objects scroll endlessly toward the camera
// (z wraps around inside [zMin, zMin+span]) and sit on the procedural terrain.
function patchScroll(mat, zMin, span, sway = 0) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTravel = U.uTravel;
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uZMin = { value: zMin };
    shader.uniforms.uSpan = { value: span };
    shader.uniforms.uSway = { value: sway };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SCROLL_COMMON)
      .replace('#include <beginnormal_vertex>', `
        mat4 wIM = mat4(1.0);
        #ifdef USE_INSTANCING
          wIM = instanceMatrix;
          float wz = mod(wIM[3].z + uTravel - uZMin, uSpan) + uZMin;
          wIM[3].y += terrainHeight(vec2(wIM[3].x, wz - uTravel));
          wIM[3].z = wz;
        #endif
        #include <beginnormal_vertex>`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (uSway > 0.0) {
          float sw = max(position.y - 1.0, 0.0);
          transformed.x += sin(uTime * 1.3 + wIM[3].z * 0.15 + wIM[3].x) * uSway * sw * sw;
          transformed.z += cos(uTime * 1.1 + wIM[3].x * 0.3) * uSway * 0.6 * sw * sw;
        }`)
      .replace('#include <project_vertex>', THREE.ShaderChunk.project_vertex.replaceAll('instanceMatrix', 'wIM'))
      .replace('#include <worldpos_vertex>', THREE.ShaderChunk.worldpos_vertex.replaceAll('instanceMatrix', 'wIM'));
  };
  mat.customProgramCacheKey = () => 'scroll-v2';
  return mat;
}

function colorize(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function jitter(geo, amt, seed) {
  const r = mulberry32(seed);
  const p = geo.attributes.position;
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!map.has(key)) map.set(key, [(r() - 0.5) * amt, (r() - 0.5) * amt, (r() - 0.5) * amt]);
    const o = map.get(key);
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

// Distribute instances; x chosen by xFn, landscape z uniformly in [zMin, zMin+span]
function scatter(mesh, count, zMin, span, seed, xFn, setup) {
  const r = mulberry32(seed);
  const o = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    o.position.set(xFn(r), 0, zMin + r() * span);
    o.rotation.set(0, r() * Math.PI * 2, 0);
    o.scale.setScalar(1);
    setup && setup(o, r, col, i);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
    if (mesh.instanceColor || setup) mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

export function createWorld(scene, renderer) {
  const world = { night: 0, sunDir: new THREE.Vector3(), birds: [] };

  // ================= Sky, sun, moon, stars =================
  const sky = new Sky();
  sky.scale.setScalar(4000);
  scene.add(sky);
  const skyU = sky.material.uniforms;
  skyU.mieCoefficient.value = 0.004;
  skyU.mieDirectionalG.value = 0.82;

  const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a5d33, 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -3.2; sc.right = 3.2; sc.top = 3.2; sc.bottom = -3.2; sc.near = 1; sc.far = 60;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // stars
  {
    const N = 2200, r = mulberry32(7);
    const pos = new Float32Array(N * 3), size = new Float32Array(N), ph = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = r() * 2 - 1, th = r() * Math.PI * 2;
      const y = Math.abs(u) * 0.95 + 0.03;
      const s = Math.sqrt(1 - y * y);
      pos.set([Math.cos(th) * s * 3500, y * 3500, Math.sin(th) * s * 3500], i * 3);
      size[i] = 0.6 + Math.pow(r(), 4) * 3.2;
      ph[i] = r() * 100;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uTime: U.uTime, uPR: { value: renderer.getPixelRatio() } },
      vertexShader: /* glsl */`
        attribute float aSize; attribute float aPhase; uniform float uTime; uniform float uPR; varying float vTw;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mv;
          vTw = 0.6 + 0.4 * sin(uTime * (1.5 + fract(aPhase) * 3.0) + aPhase);
          gl_PointSize = aSize * uPR * (0.8 + 0.4 * vTw); }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; varying float vTw;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * 2.0, a * uOpacity * vTw); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const stars = new THREE.Points(g, m);
    stars.frustumCulled = false;
    scene.add(stars);
    world.stars = stars;
  }
  const moon = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.5, 2.2), fog: false, transparent: true }));
  scene.add(moon);

  // ================= Terrain with road painted in the shader =================
  const terrainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  terrainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTravel = U.uTravel;
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uLamp = U.uLamp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTravel; varying vec2 vLand; varying float vH; varying float vSlope;
        ${TERRAIN_GLSL}`)
      .replace('#include <beginnormal_vertex>', `
        vec2 land = vec2(position.x, position.z - uTravel);
        float e = 0.35;
        float hC = terrainHeight(land);
        float hL = terrainHeight(land - vec2(e, 0.)), hR = terrainHeight(land + vec2(e, 0.));
        float hD = terrainHeight(land - vec2(0., e)), hU = terrainHeight(land + vec2(0., e));
        vec3 objectNormal = normalize(vec3(hL - hR, 2.0 * e, hD - hU));
        vLand = land; vH = hC; vSlope = 1.0 - objectNormal.y;
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3( tangent.xyz );
        #endif`)
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position.x, hC, position.z);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform float uLamp; varying vec2 vLand; varying float vH; varying float vSlope;
        float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
          return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float s = 0., a = .5; for(int i = 0; i < 4; i++){ s += a * vnoise(p); p *= 2.03; a *= .5; } return s; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ax = abs(vLand.x);
        vec2 lp = vec2(vLand.x, mod(vLand.y, 4096.0));
        float n1 = fbm(lp * 0.06), n2 = fbm(lp * 0.5), n3 = vnoise(lp * 5.0);
        vec3 grass = mix(vec3(0.10, 0.24, 0.045), vec3(0.26, 0.40, 0.09), n1);
        grass = mix(grass, vec3(0.45, 0.42, 0.18), smoothstep(0.55, 0.8, n2) * 0.45);
        grass *= 0.82 + 0.3 * n3;
        grass = mix(grass, vec3(0.33, 0.31, 0.27) * (0.8 + 0.4 * n3), smoothstep(0.22, 0.42, vSlope));
        grass = mix(grass, grass * 1.15 + vec3(0.03, 0.03, 0.0), smoothstep(8.0, 22.0, vH) * 0.5);
        vec3 dirt = vec3(0.40, 0.34, 0.25) * (0.75 + 0.45 * n3);
        float grain = hash12(floor(lp * 45.0));
        vec3 asphalt = vec3(0.075, 0.078, 0.085) * (0.8 + 0.35 * grain) * (0.88 + 0.25 * n2);
        asphalt = mix(asphalt, asphalt * 0.7, smoothstep(0.62, 0.72, n2));
        float tyre = exp(-pow((ax - 1.6) / 0.35, 2.0)) * 0.25;
        asphalt *= 1.0 - tyre;
        vec3 col = grass;
        float shoulder = 1.0 - smoothstep(4.3, 5.1, ax + (n3 - 0.5) * 0.5);
        col = mix(col, dirt, shoulder);
        float road = 1.0 - smoothstep(3.56, 3.62, ax);
        col = mix(col, asphalt, road);
        float edge = smoothstep(3.22, 3.25, ax) * (1.0 - smoothstep(3.37, 3.40, ax));
        float dash = step(fract(vLand.y / 9.0), 0.45);
        float center = (1.0 - smoothstep(0.065, 0.085, ax)) * dash;
        float wear = 0.7 + 0.3 * n3;
        col = mix(col, vec3(0.82) * wear, edge * road);
        col = mix(col, vec3(0.92, 0.66, 0.1) * wear, center);
        diffuseColor.rgb = col;
        float roadMask = road;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(0.97, 0.72, roadMask);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float nearest = floor(vLand.y / 30.0 + 0.5) * 30.0;
        vec2 dl = vec2(vLand.x - 3.75, vLand.y - nearest);
        float pool = exp(-dot(dl, dl) / 7.0);
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.3) * pool * uLamp * (0.08 + col * 0.9);`);
  };
  terrainMat.customProgramCacheKey = () => 'terrain-v2';
  {
    const W = 640, D = 420;
    const g = new THREE.PlaneGeometry(W, D, 230, 240);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / (W / 2);
      p.setX(i, Math.sign(u) * Math.pow(Math.abs(u), 1.7) * (W / 2));
      p.setZ(i, p.getZ(i) - 150);
    }
    const terrain = new THREE.Mesh(g, terrainMat);
    terrain.receiveShadow = true;
    terrain.frustumCulled = false;
    scene.add(terrain);
  }

  // ================= Grass (GPU instanced, wind-swept, endlessly scrolling) =================
  const grassU = {
    uTravel: U.uTravel, uTime: U.uTime,
    uZMin: { value: -90 }, uSpan: { value: 115 },
    uSun: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.4, 0.45, 0.5) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  };
  {
    const N = 42000;
    const base = new THREE.BufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, 0, 0, 0.5, 0, 0, -0.38, 0.45, 0, 0.38, 0.45, 0, -0.18, 0.8, 0, 0.18, 0.8, 0, 0, 1, 0,
    ], 3));
    base.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6]);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.attributes.position = base.attributes.position;
    const off = new Float32Array(N * 2), prm = new Float32Array(N * 4);
    const r = mulberry32(11);
    for (let i = 0; i < N; i++) {
      const side = r() < 0.5 ? -1 : 1;
      off[i * 2] = side * (4.7 + Math.pow(r(), 1.8) * 34);
      off[i * 2 + 1] = -90 + r() * 115;
      prm[i * 4] = 0.22 + r() * 0.45;
      prm[i * 4 + 1] = r() * Math.PI * 2;
      prm[i * 4 + 2] = (r() - 0.5) * 0.5;
      prm[i * 4 + 3] = r();
    }
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 2));
    g.setAttribute('aParams', new THREE.InstancedBufferAttribute(prm, 4));
    g.instanceCount = N;
    const m = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: /* glsl */`
        uniform float uTravel; uniform float uTime; uniform float uZMin; uniform float uSpan;
        attribute vec2 aOffset; attribute vec4 aParams;
        varying float vTip; varying float vVar; varying float vLight;
        uniform vec3 uSunDir;
        ${TERRAIN_GLSL}
        #include <fog_pars_vertex>
        void main(){
          float z = mod(aOffset.y + uTravel - uZMin, uSpan) + uZMin;
          vec2 land = vec2(aOffset.x, z - uTravel);
          float gy = terrainHeight(land);
          float h = aParams.x;
          float tip = position.y;
          vec3 p = vec3(position.x * 0.075 * (1.0 - tip * 0.6), position.y * h, 0.0);
          float c = cos(aParams.y), s = sin(aParams.y);
          p = vec3(p.x * c, p.y, p.x * s);
          float wind = sin(uTime * 1.8 + land.x * 0.35 + land.y * 0.22) * 0.6 + sin(uTime * 3.3 + land.x * 1.3 + land.y * 0.7) * 0.25;
          float bend = (wind * 0.22 + aParams.z) * tip * tip * h;
          p.x += bend; p.z += bend * 0.4 + tip * tip * 0.04;
          vec3 world = vec3(aOffset.x, gy, z) + p;
          vec4 mvPosition = viewMatrix * vec4(world, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vTip = tip; vVar = aParams.w;
          vec3 n = normalize(vec3(-s, 0.6, c));
          vLight = 0.55 + 0.45 * abs(dot(n, uSunDir));
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uSun; uniform vec3 uAmb;
        varying float vTip; varying float vVar; varying float vLight;
        #include <fog_pars_fragment>
        void main(){
          vec3 baseC = mix(vec3(0.035, 0.09, 0.015), vec3(0.06, 0.13, 0.025), vVar);
          vec3 tipC = mix(vec3(0.24, 0.40, 0.07), vec3(0.45, 0.48, 0.15), vVar * vVar);
          vec3 col = mix(baseC, tipC, smoothstep(0.0, 1.0, vTip));
          vec3 lit = col * (uAmb + uSun * vLight * (0.35 + 0.65 * vTip));
          lit += uSun * pow(vTip, 3.0) * 0.06;
          gl_FragColor = vec4(lit, 1.0);
          #include <fog_fragment>
        }`,
      side: THREE.DoubleSide,
      fog: true,
    });
    Object.assign(m.uniforms, grassU);
    const grass = new THREE.Mesh(g, m);
    grass.frustumCulled = false;
    scene.add(grass);
  }

  // ================= Scattered scenery (all scrolled on the GPU) =================
  const TZ = -330, TSPAN = 370;
  // round trees
  {
    const trunk = colorize(new THREE.CylinderGeometry(0.12, 0.2, 2.0, 6).translate(0, 1.0, 0), 0x6b4a2e);
    const crown = colorize(jitter(new THREE.IcosahedronGeometry(1.5, 1), 0.45, 3).translate(0, 2.9, 0), 0xffffff);
    const crown2 = colorize(jitter(new THREE.IcosahedronGeometry(1.0, 1), 0.3, 4).translate(0.7, 3.6, 0.3), 0xffffff);
    const geo = mergeGeometries([trunk, crown, crown2]);
    const mat = patchScroll(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }), TZ, TSPAN, 0.06);
    const trees = new THREE.InstancedMesh(geo, mat, 300);
    const pal = [0x3f7a2a, 0x5c8f2e, 0x2f6b3a, 0x7a9a35, 0xb88a2a, 0x4d7f24];
    scatter(trees, 300, TZ, TSPAN, 21, (r) => (r() < 0.5 ? -1 : 1) * (9 + Math.pow(r(), 1.4) * 115), (o, r, col) => {
      o.scale.setScalar(0.8 + r() * 1.0);
      col.set(pal[Math.floor(r() * pal.length)]);
    });
    trees.receiveShadow = true;
    scene.add(trees);
  }
  // pines
  {
    const parts = [colorize(new THREE.CylinderGeometry(0.1, 0.16, 1.4, 6).translate(0, 0.7, 0), 0x5a3d26)];
    for (let k = 0; k < 4; k++) {
      parts.push(colorize(new THREE.ConeGeometry(1.5 - k * 0.3, 1.8, 8).translate(0, 1.6 + k * 0.95, 0), 0xffffff));
    }
    const geo = mergeGeometries(parts);
    const mat = patchScroll(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }), TZ, TSPAN, 0.04);
    const pines = new THREE.InstancedMesh(geo, mat, 240);
    const pal = [0x1f5a3a, 0x2a6a40, 0x194d33, 0x2e7048];
    scatter(pines, 240, TZ, TSPAN, 33, (r) => (r() < 0.5 ? -1 : 1) * (11 + Math.pow(r(), 1.2) * 125), (o, r, col) => {
      o.scale.set(0.8 + r() * 0.5, 0.9 + r() * 0.9, 0.8 + r() * 0.5);
      col.set(pal[Math.floor(r() * pal.length)]);
    });
    scene.add(pines);
  }
  // bushes + rocks
  {
    const bushGeo = colorize(jitter(new THREE.IcosahedronGeometry(0.6, 1), 0.25, 9).scale(1.3, 0.75, 1.1).translate(0, 0.25, 0), 0xffffff);
    const bushes = new THREE.InstancedMesh(bushGeo, patchScroll(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }), TZ, TSPAN), 220);
    const pal = [0x3c6e25, 0x557f2a, 0x6a8a30, 0x2d5e2a];
    scatter(bushes, 220, TZ, TSPAN, 44, (r) => (r() < 0.5 ? -1 : 1) * (5.6 + Math.pow(r(), 1.6) * 60), (o, r, col) => {
      o.scale.setScalar(0.5 + r() * 1.1);
      col.set(pal[Math.floor(r() * pal.length)]);
    });
    scene.add(bushes);

    const rockGeo = colorize(jitter(new THREE.DodecahedronGeometry(0.5, 0), 0.2, 5).scale(1.2, 0.7, 1).translate(0, 0.08, 0), 0xffffff);
    const rocks = new THREE.InstancedMesh(rockGeo, patchScroll(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }), TZ, TSPAN), 90);
    scatter(rocks, 90, TZ, TSPAN, 55, (r) => (r() < 0.5 ? -1 : 1) * (5.5 + Math.pow(r(), 1.3) * 70), (o, r, col) => {
      o.scale.setScalar(0.3 + Math.pow(r(), 2) * 1.6);
      o.rotation.set(r(), r() * 6, r());
      const v = 0.45 + r() * 0.25;
      col.setRGB(v, v * 0.97, v * 0.92);
    });
    scene.add(rocks);
  }
  // wildflowers
  {
    const fGeo = colorize(new THREE.IcosahedronGeometry(0.055, 0).translate(0, 0.3, 0), 0xffffff);
    const stem = colorize(new THREE.CylinderGeometry(0.006, 0.006, 0.3, 3).translate(0, 0.15, 0), 0x3a6a20);
    const geo = mergeGeometries([fGeo, stem]);
    const flowers = new THREE.InstancedMesh(geo, patchScroll(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, emissive: 0x111111 }), -95, 120), 2400);
    const pal = [0xffffff, 0xffe066, 0xff8fb1, 0xb18cff, 0xff6b6b, 0x8fd3ff];
    scatter(flowers, 2400, -95, 120, 66, (r) => (r() < 0.5 ? -1 : 1) * (4.9 + Math.pow(r(), 1.5) * 26), (o, r, col) => {
      o.scale.setScalar(0.7 + r() * 0.9);
      col.set(pal[Math.floor(r() * pal.length)]);
    });
    scene.add(flowers);
  }
  // street lamps every 30 m on the right side
  const lampSpan = 390, lampZ = -350;
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffb860, emissiveIntensity: 0 });
  {
    const parts = [
      new THREE.CylinderGeometry(0.06, 0.09, 5.2, 10).translate(0, 2.6, 0),
      new THREE.CylinderGeometry(0.035, 0.035, 1.1, 8).rotateZ(Math.PI / 2).translate(-0.5, 5.1, 0),
      new THREE.BoxGeometry(0.5, 0.12, 0.26).translate(-1.05, 5.05, 0),
      new THREE.CylinderGeometry(0.16, 0.2, 0.25, 10).translate(0, 0.12, 0),
    ];
    const geo = mergeGeometries(parts);
    const mat = patchScroll(new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.6, roughness: 0.45 }), lampZ, lampSpan);
    const n = lampSpan / 30;
    const poles = new THREE.InstancedMesh(geo, mat, n);
    const bulbs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.4, 0.04, 0.2).translate(-1.05, 4.98, 0), patchScroll(bulbMat, lampZ, lampSpan), n);
    const o = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      o.position.set(4.9, 0, lampZ + i * 30);
      o.updateMatrix();
      poles.setMatrixAt(i, o.matrix);
      bulbs.setMatrixAt(i, o.matrix);
    }
    poles.frustumCulled = bulbs.frustumCulled = false;
    scene.add(poles, bulbs);
  }
  // wooden fence on the left
  {
    const sec = 2.6;
    const parts = [
      new THREE.BoxGeometry(0.12, 1.05, 0.12).translate(0, 0.45, 0),
      new THREE.BoxGeometry(0.05, 0.09, sec).translate(0, 0.78, sec / 2),
      new THREE.BoxGeometry(0.05, 0.09, sec).translate(0, 0.42, sec / 2),
    ];
    const geo = mergeGeometries(parts);
    const span = sec * 70, z0 = -150;
    const mat = patchScroll(new THREE.MeshStandardMaterial({ color: 0x8a6440, roughness: 0.85 }), z0, span);
    const fence = new THREE.InstancedMesh(geo, mat, 70);
    const o = new THREE.Object3D();
    for (let i = 0; i < 70; i++) {
      o.position.set(-6.4, -0.05, z0 + i * sec);
      o.rotation.set(0, 0, (Math.sin(i * 12.9) * 0.03));
      o.updateMatrix();
      fence.setMatrixAt(i, o.matrix);
    }
    fence.frustumCulled = false;
    scene.add(fence);
  }

  // ================= Fireflies (night only) =================
  const fireflyMat = new THREE.ShaderMaterial({
    uniforms: { uTravel: U.uTravel, uTime: U.uTime, uOpacity: { value: 0 }, uPR: { value: renderer.getPixelRatio() } },
    vertexShader: /* glsl */`
      attribute vec4 aData; uniform float uTravel; uniform float uTime; uniform float uPR; varying float vA;
      ${TERRAIN_GLSL}
      void main(){
        float z = mod(aData.y + uTravel + 70.0, 100.0) - 70.0;
        vec2 land = vec2(aData.x, z - uTravel);
        float gy = terrainHeight(land);
        vec3 p = vec3(aData.x + sin(uTime * 0.7 + aData.w * 3.0) * 0.6,
                      gy + aData.z + sin(uTime * 1.3 + aData.w) * 0.3,
                      z + cos(uTime * 0.5 + aData.w * 2.0) * 0.6);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vA = pow(0.5 + 0.5 * sin(uTime * 2.2 + aData.w * 6.28), 3.0);
        gl_PointSize = 150.0 * uPR / -mv.z;
      }`,
    fragmentShader: /* glsl */`
      uniform float uOpacity; varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); a *= a;
        gl_FragColor = vec4(vec3(1.0, 0.85, 0.35) * 4.0 * a * vA * uOpacity, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  {
    const N = 220, r = mulberry32(99);
    const d = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) d.set([(r() < 0.5 ? -1 : 1) * (4.2 + r() * 22), -70 + r() * 100, 0.3 + r() * 1.6, r() * 50], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aData', new THREE.BufferAttribute(d, 4));
    const ff = new THREE.Points(g, fireflyMat);
    ff.frustumCulled = false;
    scene.add(ff);
  }

  // ================= Distant mountains (two hazy rings) =================
  const hazeU = { uHaze: { value: new THREE.Color() } };
  function mountainRing(radius, base, hMin, hMax, seed, color, hazeBase) {
    const r = mulberry32(seed);
    const seg = 180;
    const pos = [], idx = [];
    const ph = [r() * 6, r() * 6, r() * 6];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n = 0.5 + 0.25 * Math.sin(a * 3 + ph[0]) + 0.15 * Math.sin(a * 7 + ph[1]) + 0.1 * Math.sin(a * 17 + ph[2]);
      const h = lerp(hMin, hMax, clamp(n + (r() - 0.5) * 0.18, 0, 1.2));
      const ca = Math.cos(a), sa = Math.sin(a);
      const rr = radius * (1 + (r() - 0.5) * 0.04);
      pos.push(ca * rr, base, sa * rr);
      pos.push(ca * rr * 0.97, base + h * 0.55 + (r() - 0.5) * h * 0.15, sa * rr * 0.97);
      pos.push(ca * rr * 0.92, base + h, sa * rr * 0.92);
    }
    for (let i = 0; i < seg; i++) {
      for (let k = 0; k < 2; k++) {
        const a = i * 3 + k, b = (i + 1) * 3 + k;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g = g.toNonIndexed();
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ color, fog: false, flatShading: true, side: THREE.DoubleSide });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uHaze = hazeU.uHaze;
      shader.uniforms.uY0 = { value: base }; shader.uniforms.uY1 = { value: base + hMax };
      shader.uniforms.uHB = { value: hazeBase };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying float vWY;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWY = (modelMatrix * vec4(transformed, 1.0)).y;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vWY; uniform vec3 uHaze; uniform float uY0; uniform float uY1; uniform float uHB;')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          float hz = clamp(uHB + (1.0 - smoothstep(uY0, uY1, vWY)) * (1.0 - uHB) * 0.95, 0.0, 1.0);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, hz);`);
    };
    m.customProgramCacheKey = () => 'mountain' + seed;
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  }
  mountainRing(2300, -60, 160, 520, 3, 0x6d8299, 0.45);
  mountainRing(1400, -40, 60, 240, 8, 0x3f5b4a, 0.2);

  // ================= Clouds =================
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, fog: false, emissive: 0x222222 });
  const clouds = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 3), cloudMat, 170);
  {
    const r = mulberry32(123);
    const o = new THREE.Object3D();
    let k = 0;
    for (let c = 0; c < 22 && k < 170; c++) {
      const a = r() * Math.PI * 2, d = 500 + r() * 900, h = 160 + r() * 220;
      const cx = Math.cos(a) * d, cz = Math.sin(a) * d;
      const puffs = 5 + Math.floor(r() * 4);
      const sz = 25 + r() * 25;
      for (let p = 0; p < puffs && k < 170; p++, k++) {
        o.position.set(cx + (r() - 0.5) * sz * 3.2, h + (r() - 0.3) * sz * 0.5, cz + (r() - 0.5) * sz * 1.6);
        const s = sz * (0.6 + r() * 0.7);
        o.scale.set(s * 1.3, s * 0.7, s);
        o.rotation.set(0, r() * 6, 0);
        o.updateMatrix();
        clouds.setMatrixAt(k, o.matrix);
      }
    }
    clouds.count = k;
    clouds.frustumCulled = false;
    scene.add(clouds);
  }

  // ================= Gulls that follow the bike =================
  {
    const gullMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8, side: THREE.DoubleSide });
    const tipMat = new THREE.MeshStandardMaterial({ color: 0x333740, roughness: 0.8, side: THREE.DoubleSide });
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.18, 0, 0, 0.18, 0.9, 0, 0.1, 0.9, 0, -0.08], 3));
    wingGeo.setIndex([0, 1, 2, 0, 2, 3]);
    wingGeo.computeVertexNormals();
    const tipGeo = new THREE.BufferGeometry();
    tipGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.08, 0, 0, 0.1, 0.5, 0, 0.12, 0.6, 0, 0.0], 3));
    tipGeo.setIndex([0, 1, 2, 0, 2, 3]);
    tipGeo.computeVertexNormals();
    const r = mulberry32(5);
    for (let i = 0; i < 8; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), gullMat);
      body.scale.set(0.16, 0.14, 0.5);
      g.add(body);
      const wings = [];
      for (const s of [-1, 1]) {
        const w = new THREE.Group();
        const m = new THREE.Mesh(wingGeo, gullMat);
        const tipG = new THREE.Group();
        tipG.position.x = 0.88;
        tipG.add(new THREE.Mesh(tipGeo, tipMat));
        w.add(m, tipG);
        w.scale.x = s;
        g.add(w);
        wings.push({ w, tipG, s });
      }
      g.scale.setScalar(1.6);
      scene.add(g);
      world.birds.push({ g, wings, R: 18 + r() * 30, h: 16 + r() * 22, w: 0.12 + r() * 0.12, ph: r() * 6.28, cz: -20 - r() * 40, flapPh: r() * 6 });
    }
  }

  // ================= Roadside sign (recycled, new text every time) =================
  const signs = [
    ['🐟 鱼市场', '前方 2.5 km →'],
    ['⚠ 鹈鹕出没', '请减速慢行'],
    ['限速 60', '鹈鹕也不例外'],
    ['🌊 海边', '还有 12 km'],
    ['🚲 骑行友好', '欢迎光临'],
    ['🍦 冰淇淋', '下一个路口'],
  ];
  const signColors = ['#1f7a4d', '#c78a12', '#2b62b8', '#1f7a4d', '#8a3fb8', '#c2462f'];
  const sign = new THREE.Group();
  const boardMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.07), boardMat);
  board.position.y = 2.1;
  const back = new THREE.Mesh(new THREE.BoxGeometry(1.96, 1.12, 0.04), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.4 }));
  back.position.set(0, 2.1, -0.025);
  sign.add(board, back);
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.7, 8), back.material);
    p.position.set(s * 0.7, 1.3, -0.05);
    sign.add(p);
  }
  sign.rotation.y = 0.18;
  sign.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
  scene.add(sign);
  let signIdx = 0, signL = -120;
  const setSign = () => {
    const [a, b] = signs[signIdx % signs.length];
    if (boardMat.map) boardMat.map.dispose();
    boardMat.map = signTexture(a, b, signColors[signIdx % signColors.length]);
    boardMat.needsUpdate = true;
    signIdx++;
  };
  setSign();

  // ================= Environment map (sky -> PMREM) =================
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(80, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x404a30 }));
  envGround.position.y = -2;
  envScene.add(envGround);
  let envRT = null;
  function refreshEnv() {
    envScene.add(sky);
    const rt = pmrem.fromScene(envScene, 0, 0.1, 5000);
    scene.add(sky);
    if (envRT) envRT.dispose();
    envRT = rt;
    scene.environment = rt.texture;
  }

  // ================= Time of day =================
  const C = (h) => new THREE.Color(h);
  const pal = {
    fogDay: C(0xb7cde0), fogSet: C(0xe8a77a), fogNight: C(0x0b1424), fogDawn: C(0xd9b8c8),
    hemiDay: C(0xcfe3ff), hemiSet: C(0xffb98f), hemiNight: C(0x23365a),
    gndDay: C(0x5a6b3a), gndNight: C(0x0a0d12),
    sunHigh: C(0xfff3e2), sunLow: C(0xff8a45), moon: C(0x9fb4ff),
  };
  const fogColor = new THREE.Color();
  scene.fog = new THREE.Fog(fogColor, 70, 280);
  let lastEnvHour = -99;
  const sunDir = world.sunDir, moonDir = new THREE.Vector3();
  const tmpC = new THREE.Color(), tmpC2 = new THREE.Color();

  world.setTime = (hour, force = false) => {
    const ang = ((hour - 6) / 12) * Math.PI;
    sunDir.set(-Math.cos(ang), Math.sin(ang) * 0.92, 0.42).normalize();
    moonDir.set(Math.cos(ang) * 0.7, -Math.sin(ang) * 0.75 + 0.12, -0.55).normalize();
    const y = sunDir.y;
    const day = smoothstep(-0.06, 0.22, y);
    const night = smoothstep(0.04, -0.16, y);
    const golden = clamp(1 - Math.abs(y - 0.06) / 0.28, 0, 1);
    world.night = night;
    world.golden = golden;

    skyU.sunPosition.value.copy(sunDir);
    skyU.turbidity.value = lerp(2.4, 6.5, golden);
    skyU.rayleigh.value = lerp(1.1, 2.8, golden) * (1 - night * 0.6);

    // fog / horizon colour
    fogColor.copy(pal.fogNight).lerp(pal.fogSet, smoothstep(-0.14, 0.02, y)).lerp(pal.fogDay, smoothstep(0.08, 0.38, y));
    const morning = hour < 12 ? 1 : 0;
    if (morning) fogColor.lerp(pal.fogDawn, golden * 0.35);
    scene.fog.color.copy(fogColor);
    hazeU.uHaze.value.copy(fogColor);

    hemi.color.copy(pal.hemiNight).lerp(pal.hemiSet, smoothstep(-0.12, 0.04, y)).lerp(pal.hemiDay, smoothstep(0.1, 0.4, y));
    hemi.groundColor.copy(pal.gndNight).lerp(pal.gndDay, day);
    hemi.intensity = lerp(0.55, 1.15, day);

    const sunI = smoothstep(-0.03, 0.18, y);
    const moonI = night;
    if (sunI > 0.001) {
      sun.color.copy(pal.sunLow).lerp(pal.sunHigh, smoothstep(0.02, 0.5, y));
      sun.intensity = sunI * 3.4;
      world.lightDir = sunDir;
    } else {
      sun.color.copy(pal.moon);
      sun.intensity = moonI * 0.9;
      world.lightDir = moonDir;
    }
    renderer.toneMappingExposure = lerp(0.62, 0.95, night);

    world.stars.material.uniforms.uOpacity.value = night;
    moon.position.copy(moonDir).multiplyScalar(3000);
    moon.material.opacity = smoothstep(0.0, 0.25, moonDir.y) * clamp(night * 1.2, 0, 1);
    moon.visible = moon.material.opacity > 0.01;

    U.uLamp.value = smoothstep(0.1, -0.08, y);
    bulbMat.emissiveIntensity = U.uLamp.value * 14;
    fireflyMat.uniforms.uOpacity.value = night;

    // grass lighting
    grassU.uSun.value.copy(sun.color).multiplyScalar(sun.intensity * 0.45);
    grassU.uAmb.value.copy(hemi.color).multiplyScalar(hemi.intensity * 0.55);
    grassU.uSunDir.value.copy(world.lightDir);

    // clouds tinted by the sky
    tmpC.copy(pal.sunLow).lerp(C(0xffffff), smoothstep(0.05, 0.4, y));
    cloudMat.color.copy(tmpC).multiplyScalar(lerp(0.3, 1.05, day));
    cloudMat.emissive.copy(fogColor).lerp(tmpC, golden * 0.4).multiplyScalar(lerp(0.4, 0.75, day));
    tmpC2.copy(fogColor);

    envGround.material.color.setRGB(0.22, 0.27, 0.14).multiplyScalar(lerp(0.05, 1, day));
    let dh = Math.abs(hour - lastEnvHour);
    dh = Math.min(dh, 24 - dh);
    if (force || dh > 0.2) { refreshEnv(); lastEnvHour = hour; }
  };

  // ================= per-frame =================
  world.update = (dt, t, travel, focus) => {
    // shadow camera follows the bike
    sun.position.copy(focus).addScaledVector(world.lightDir, 30);
    sun.target.position.copy(focus);

    clouds.rotation.y += dt * 0.004;

    for (const b of world.birds) {
      const a = t * b.w + b.ph;
      b.g.position.set(Math.cos(a) * b.R + focus.x, b.h + Math.sin(t * 0.4 + b.ph) * 2, Math.sin(a) * b.R * 0.6 + b.cz);
      b.g.rotation.set(0, -a, 0.35);
      const glide = 0.5 + 0.5 * Math.sin(t * 0.5 + b.ph * 3);
      const flap = Math.sin(t * 7 + b.flapPh) * (0.15 + 0.5 * glide);
      for (const w of b.wings) { w.w.rotation.z = flap * w.s; w.tipG.rotation.z = flap * 0.6; }
    }

    // sign recycling
    const z = signL + travel;
    if (z > 30) { signL -= 260 + Math.random() * 120; setSign(); }
    sign.position.set(-5.3, terrainHeight(-5.3, signL), signL + travel);
  };

  return world;
}
