import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { featherSpriteTexture, rand } from './util.js';

// ---------------------------------------------------------------------------
// Soft point-sprite particle pool (dust, sparkles, splash)
// ---------------------------------------------------------------------------
export class Particles {
  constructor(max, { additive = false } = {}) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.base = new Float32Array(max * 4);
    this.size = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grow = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    this.uniforms = { uScale: { value: 800 } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(-mv.z, 0.05); vC = aColor; }`,
      fragmentShader: /* glsl */`
        varying vec4 vC;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vC.rgb, vC.a * a); }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(p, v, color, alpha, size, life, { gravity = 0, drag = 0, grow = 0 } = {}) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.base.set([color.r, color.g, color.b, alpha], i * 4);
    this.size0[i] = size;
    this.life[i] = 0;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.grow[i] = grow;
  }

  update(dt, windZ = 0) {
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        const last = --this.n;
        if (i !== last) this.copy(last, i);
        continue;
      }
      const k = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[k] *= dr;
      this.vel[k + 1] = this.vel[k + 1] * dr - this.grav[i] * dt;
      this.vel[k + 2] = (this.vel[k + 2] - windZ) * dr + windZ;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      const u = this.life[i] / this.maxLife[i];
      const fade = Math.min(1, u * 8) * (1 - u) * (1 - u);
      const c = i * 4;
      this.col[c] = this.base[c]; this.col[c + 1] = this.base[c + 1]; this.col[c + 2] = this.base[c + 2];
      this.col[c + 3] = this.base[c + 3] * fade;
      this.size[i] = this.size0[i] * (1 + this.grow[i] * u);
      i++;
    }
    this.points.geometry.setDrawRange(0, this.n);
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
  }

  copy(from, to) {
    for (const [arr, n] of [[this.pos, 3], [this.vel, 3], [this.base, 4]]) {
      for (let j = 0; j < n; j++) arr[to * n + j] = arr[from * n + j];
    }
    for (const arr of [this.size0, this.life, this.maxLife, this.grav, this.drag, this.grow]) arr[to] = arr[from];
  }
}

// ---------------------------------------------------------------------------
// Fluttering feathers (instanced textured quads)
// ---------------------------------------------------------------------------
export class Feathers {
  constructor(max = 60) {
    const mat = new THREE.MeshStandardMaterial({
      map: featherSpriteTexture(), alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.9,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.05, 0.13), mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.items = [];
    this.max = max;
    this.o = new THREE.Object3D();
    this.mesh.count = 0;
  }
  emit(p, v) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({
      p: p.clone(), v: v.clone(), life: 0, max: rand(3, 6),
      rot: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)),
      spin: new THREE.Vector3(rand(-4, 4), rand(-6, 6), rand(-4, 4)),
      ph: rand(0, 6), s: rand(0.7, 1.3),
    });
  }
  update(dt, windZ, groundY = 0) {
    const o = this.o;
    let k = 0;
    this.items = this.items.filter((f) => (f.life += dt) < f.max);
    for (const f of this.items) {
      const dr = Math.exp(-2.2 * dt);
      f.v.x = f.v.x * dr + Math.sin(f.life * 3 + f.ph) * 0.9 * dt;
      f.v.y = f.v.y * dr - 0.9 * dt;
      f.v.z = (f.v.z - windZ) * dr + windZ;
      f.p.addScaledVector(f.v, dt);
      if (f.p.y < groundY + 0.02) { f.p.y = groundY + 0.02; f.v.set(0, 0, windZ); f.spin.multiplyScalar(0.9); }
      f.rot.x += f.spin.x * dt; f.rot.y += f.spin.y * dt; f.rot.z += f.spin.z * dt;
      const fade = Math.min(1, (f.max - f.life) * 2);
      o.position.copy(f.p);
      o.rotation.copy(f.rot);
      o.scale.setScalar(f.s * fade);
      o.updateMatrix();
      this.mesh.setMatrixAt(k++, o.matrix);
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Post-processing: bloom + film grade (vignette, grain, chromatic aberration at speed)
// ---------------------------------------------------------------------------
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.035 },
    uCA: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform float uCA;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * uCA;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv - off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv + off).b;
      col *= 1.0 - uVignette * smoothstep(0.08, 0.55, r2 * 1.6);
      col += (hash(vUv * 1000.0 + fract(uTime) * 100.0) - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createPost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.55, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  return { composer, bloom, grade };
}
