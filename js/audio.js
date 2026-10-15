// Everything here is synthesised with the Web Audio API — no sound files.
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sfxOn = true;
    this.musicOn = false;
    this.nextNote = 0;
    this.step = 0;
    this.lastTickAngle = 0;
    this.ambT = 2;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.sfxOn ? 0.8 : 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);

    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0; this.musicBus.connect(this.master);

    // small hall reverb from a generated impulse response
    this.reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.2;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb.buffer = ir;
    this.revGain = ctx.createGain(); this.revGain.gain.value = 0.35;
    this.reverb.connect(this.revGain).connect(this.master);

    // white noise buffer for wind / clicks
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noise = nb;

    const wind = ctx.createBufferSource();
    wind.buffer = nb; wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    wind.start();

    // tyre hum on asphalt
    const hum = ctx.createBufferSource();
    hum.buffer = nb; hum.loop = true; hum.playbackRate.value = 0.5;
    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass'; this.humFilter.frequency.value = 180;
    this.humGain = ctx.createGain(); this.humGain.gain.value = 0;
    hum.connect(this.humFilter).connect(this.humGain).connect(this.sfx);
    hum.start();
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  setSfx(on) {
    this.sfxOn = on;
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.1);
  }
  setMusic(on) {
    this.musicOn = on;
    if (this.ctx) {
      this.musicBus.gain.setTargetAtTime(on ? 0.5 : 0, this.ctx.currentTime, 0.3);
      if (on) this.nextNote = this.ctx.currentTime + 0.1;
    }
  }

  env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  bell() {
    if (!this.ready) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    [0, 0.17].forEach((dt) => {
      const t = t0 + dt;
      [[1, 0.5], [1.0035, 0.35], [2.76, 0.22], [5.4, 0.1], [8.93, 0.05]].forEach(([r, a]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 2150 * r;
        this.env(g, t, 0.003, a * 0.5, 1.3 / Math.sqrt(r));
        o.connect(g); g.connect(this.sfx); g.connect(this.reverb);
        o.start(t); o.stop(t + 1.6);
      });
    });
  }

  honk() {
    if (!this.ready) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    [0, 0.28].forEach((dt, k) => {
      const t = t0 + dt;
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      const f0 = k ? 190 : 230;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.62, t + 0.24);
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 28; lg.gain.value = 18;
      lfo.connect(lg).connect(o.frequency);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 950; bp.Q.value = 3;
      const bp2 = ctx.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 2400; bp2.Q.value = 5;
      const g = ctx.createGain();
      this.env(g, t, 0.02, 0.45, 0.26);
      o.connect(bp).connect(g); o.connect(bp2).connect(g);
      g.connect(this.sfx); g.connect(this.reverb);
      o.start(t); lfo.start(t); o.stop(t + 0.35); lfo.stop(t + 0.35);
    });
  }

  gulp() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(420, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    const g = ctx.createGain(); this.env(g, t, 0.01, 0.7, 0.32);
    o.connect(g).connect(this.sfx);
    o.start(t); o.stop(t + 0.4);
    // happy sparkle
    [1318, 1568, 2093].forEach((f, i) => {
      const s = ctx.createOscillator(), sg = ctx.createGain();
      s.type = 'triangle'; s.frequency.value = f;
      this.env(sg, t + 0.18 + i * 0.07, 0.005, 0.12, 0.35);
      s.connect(sg); sg.connect(this.sfx); sg.connect(this.reverb);
      s.start(t + 0.18 + i * 0.07); s.stop(t + 0.8 + i * 0.07);
    });
  }

  boing() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(300, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.12);
    const g = ctx.createGain(); this.env(g, t, 0.005, 0.3, 0.18);
    o.connect(g).connect(this.sfx);
    o.start(t); o.stop(t + 0.25);
  }

  thump(strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.2);
    const g = ctx.createGain(); this.env(g, t, 0.004, 0.8 * strength, 0.25);
    o.connect(g).connect(this.sfx);
    o.start(t); o.stop(t + 0.3);
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const ng = ctx.createGain(); this.env(ng, t, 0.002, 0.35 * strength, 0.15);
    n.connect(f).connect(ng).connect(this.sfx);
    n.start(t, Math.random()); n.stop(t + 0.2);
  }

  whoosh() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(2200, t + 0.25);
    const g = ctx.createGain(); this.env(g, t, 0.05, 0.25, 0.3);
    n.connect(f).connect(g).connect(this.sfx);
    n.start(t, Math.random()); n.stop(t + 0.4);
  }

  shutter() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    [0, 0.06].forEach((dt) => {
      const n = ctx.createBufferSource(); n.buffer = this.noise;
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
      const g = ctx.createGain(); this.env(g, t + dt, 0.001, 0.4, 0.05);
      n.connect(f).connect(g).connect(this.sfx);
      n.start(t + dt, Math.random()); n.stop(t + dt + 0.08);
    });
  }

  tick() {
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3500;
    const g = ctx.createGain(); this.env(g, t, 0.001, 0.035, 0.025);
    n.connect(f).connect(g).connect(this.sfx);
    n.start(t, Math.random()); n.stop(t + 0.04);
  }

  chirp() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.sfx); pan.connect(this.reverb);
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1600;
    for (let i = 0; i < notes; i++) {
      const t = t0 + i * (0.09 + Math.random() * 0.05);
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.3), t);
      o.frequency.exponentialRampToValueAtTime(base * (0.7 + Math.random() * 0.6), t + 0.07);
      const g = ctx.createGain(); this.env(g, t, 0.005, 0.05, 0.07);
      o.connect(g).connect(pan);
      o.start(t); o.stop(t + 0.1);
    }
  }

  cricket() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 2 - 1;
    pan.connect(this.sfx);
    const f = 4200 + Math.random() * 600;
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.055;
      const o = ctx.createOscillator(); o.frequency.value = f;
      const g = ctx.createGain(); this.env(g, t, 0.004, 0.025, 0.035);
      o.connect(g).connect(pan);
      o.start(t); o.stop(t + 0.05);
    }
  }

  pluck(freq, t, vol = 0.18, dur = 0.6, type = 'triangle') {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq * 2.001;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(freq * 8, t); f.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    const g = ctx.createGain(); this.env(g, t, 0.006, vol, dur);
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o.connect(f); o2.connect(g2).connect(f);
    f.connect(g); g.connect(this.musicBus); g.connect(this.reverb);
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }

  // A cheerful pentatonic tune whose tempo follows the pedalling cadence
  scheduleMusic(cadence) {
    const ctx = this.ctx;
    const bpm = 84 + Math.min(60, cadence * 0.45);
    const eighth = 30 / bpm;
    const chords = [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]];
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];
    const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
    if (this.nextNote < ctx.currentTime) this.nextNote = ctx.currentTime + 0.05;
    while (this.nextNote < ctx.currentTime + 0.15) {
      const s = this.step;
      const bar = Math.floor(s / 8) % 4;
      const ch = chords[bar];
      const root = 60;
      if (s % 8 === 0) this.pluck(midi(root - 24 + ch[0]), this.nextNote, 0.22, eighth * 7, 'sine');
      if (s % 8 === 4) this.pluck(midi(root - 12 + ch[0]), this.nextNote, 0.12, eighth * 3, 'sine');
      if (s % 2 === 0) this.pluck(midi(root + ch[(s / 2) % 3]), this.nextNote, 0.06, eighth * 1.5);
      if (Math.random() < 0.55) {
        const pick = Math.random() < 0.5 ? ch[Math.floor(Math.random() * 3)] + 12 : scale[Math.floor(Math.random() * scale.length)] + 12;
        this.pluck(midi(root + pick), this.nextNote + (Math.random() < 0.2 ? eighth / 2 : 0), 0.1, eighth * 2.2);
      }
      this.nextNote += eighth;
      this.step++;
    }
  }

  update(dt, { speed, crank, night, cadence }) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const v = speed;
    this.windGain.gain.setTargetAtTime(Math.min(0.5, v * v * 0.0022), t, 0.2);
    this.windFilter.frequency.setTargetAtTime(300 + v * 60, t, 0.2);
    this.humGain.gain.setTargetAtTime(Math.min(0.25, v * 0.018), t, 0.2);
    this.humFilter.frequency.setTargetAtTime(120 + v * 14, t, 0.2);

    // freewheel / chain clicks
    const step = Math.PI / 4;
    if (v > 0.3 && Math.floor(crank / step) !== Math.floor(this.lastTickAngle / step)) this.tick();
    this.lastTickAngle = crank;

    // ambience: birds by day, crickets by night
    this.ambT -= dt;
    if (this.ambT < 0) {
      if (night > 0.5) { this.cricket(); this.ambT = 0.3 + Math.random() * 1.2; }
      else { this.chirp(); this.ambT = 1.5 + Math.random() * 4; }
    }

    if (this.musicOn) this.scheduleMusic(cadence);
  }
}
