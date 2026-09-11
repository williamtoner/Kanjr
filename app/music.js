/**
 * music.js — a tiny Game Boy-style sound chip and sequencer.
 *
 * Four channels, like the original hardware: two pulse waves (melody and
 * harmony), a triangle bass, and a noise channel for drums. Tunes are
 * written as note patterns below and scheduled a little ahead of time with
 * the Web Audio clock, so timing stays tight even on a busy phone.
 *
 * All tunes are original compositions for Kanjr.
 *
 * Pattern syntax (per channel): whitespace-separated tokens "note:len",
 * where note is like c5, f#4, bb3 or "-" for a rest, and len is in
 * sixteenth notes. Every channel of a tune must add up to the same length.
 */

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const SEMITONES = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Frequency of a note name like "c5", "f#4", "bb3". */
export function noteFreq(name) {
  const m = /^([a-g])([#b]?)(\d)$/i.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  let n = SEMITONES[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = 12 * (Number(m[3]) + 1) + n;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Parse a pattern string into [{ note|null, len, at }] with `at` in 16ths. */
export function parsePattern(str) {
  const out = [];
  let at = 0;
  for (const tok of String(str).trim().split(/\s+/)) {
    if (!tok) continue;
    const [note, lenStr] = tok.split(':');
    const len = Number(lenStr || 1);
    if (!(len > 0)) throw new Error(`bad length in ${tok}`);
    out.push({ note: note === '-' ? null : note.toLowerCase(), len, at });
    at += len;
  }
  return out;
}

export function patternLength(events) {
  return events.reduce((n, e) => Math.max(n, e.at + e.len), 0);
}

/* ------------------------------------------------------------------ */
/* Tunes                                                               */
/* ------------------------------------------------------------------ */

// Chords: I V vi IV | I V IV I in C. Whimsical overworld: bright pulse lead,
// bouncing bass, light hat. 112 bpm.
const OVERWORLD = {
  bpm: 112,
  lead: { duty: 0.5, gain: 0.16, pattern: `
    e5:4 g5:4 a5:4 g5:2 e5:2   d5:4 e5:4 c5:8   e5:4 g5:4 a5:4 c6:4   b5:6 a5:2 g5:8
    a5:4 g5:2 e5:2 d5:4 e5:4   g5:6 e5:2 d5:8   c5:4 d5:4 e5:4 g5:4   a5:2 g5:2 e5:4 d5:2 c5:6
    e5:2 e5:2 g5:4 a5:4 c6:4   b5:4 g5:4 e5:8   f5:4 a5:4 g5:4 e5:4   d5:6 e5:2 c5:8
    a5:4 c6:4 b5:2 a5:2 g5:4   e5:4 g5:4 a5:8   g5:4 e5:4 d5:4 e5:4   c5:12 -:4` },
  harmony: { duty: 0.25, gain: 0.07, pattern: `
    c4:2 e4:2 g4:2 e4:2 c4:2 e4:2 g4:2 e4:2   b3:2 d4:2 g4:2 d4:2 b3:2 d4:2 g4:2 d4:2   a3:2 c4:2 e4:2 c4:2 a3:2 c4:2 e4:2 c4:2   f3:2 a3:2 c4:2 a3:2 f3:2 a3:2 c4:2 a3:2
    c4:2 e4:2 g4:2 e4:2 c4:2 e4:2 g4:2 e4:2   b3:2 d4:2 g4:2 d4:2 b3:2 d4:2 g4:2 d4:2   f3:2 a3:2 c4:2 a3:2 f3:2 a3:2 c4:2 a3:2   c4:2 e4:2 g4:2 e4:2 c4:2 e4:2 g4:2 e4:2
    c4:2 e4:2 g4:2 e4:2 c4:2 e4:2 g4:2 e4:2   e3:2 g3:2 b3:2 g3:2 e3:2 g3:2 b3:2 g3:2   f3:2 a3:2 c4:2 a3:2 f3:2 a3:2 c4:2 a3:2   g3:2 b3:2 d4:2 b3:2 g3:2 b3:2 d4:2 b3:2
    a3:2 c4:2 e4:2 c4:2 a3:2 c4:2 e4:2 c4:2   f3:2 a3:2 c4:2 a3:2 f3:2 a3:2 c4:2 a3:2   g3:2 b3:2 d4:2 b3:2 g3:2 b3:2 d4:2 b3:2   c4:2 e4:2 g4:2 e4:2 c4:4 -:4` },
  bass: { gain: 0.22, pattern: `
    c3:4 g2:4 c3:4 g2:4   g2:4 d3:4 g2:4 d3:4   a2:4 e3:4 a2:4 e3:4   f2:4 c3:4 f2:4 c3:4
    c3:4 g2:4 c3:4 g2:4   g2:4 d3:4 g2:4 d3:4   f2:4 c3:4 f2:4 c3:4   c3:4 g2:4 c3:4 g2:4
    c3:4 g2:4 c3:4 g2:4   e2:4 b2:4 e2:4 b2:4   f2:4 c3:4 f2:4 c3:4   g2:4 d3:4 g2:4 d3:4
    a2:4 e3:4 a2:4 e3:4   f2:4 c3:4 f2:4 c3:4   g2:4 d3:4 g2:4 d3:4   c3:8 c3:4 -:4` },
  drums: { gain: 0.12, pattern: ('k:2 h:2 s:2 h:2 k:2 h:2 s:2 h:2 '.repeat(16)).trim() },
};

// Encounter: A minor, driving eighth-note bass, staccato lead. 140 bpm.
const ENCOUNTER = {
  bpm: 140,
  lead: { duty: 0.25, gain: 0.15, pattern: `
    a4:2 c5:2 e5:2 a5:2 g5:2 e5:2 d5:2 c5:2   b4:2 d5:2 g5:2 b5:2 a5:2 g5:2 e5:2 d5:2   c5:2 e5:2 g5:2 c6:2 b5:2 g5:2 e5:2 c5:2   b4:2 d5:2 f5:2 g5:4 e5:2 d5:4
    a4:2 c5:2 e5:2 a5:2 g5:2 e5:2 d5:2 c5:2   f5:2 a5:2 c6:2 a5:2 g5:2 e5:2 d5:2 c5:2   e5:2 g#5:2 b5:2 e6:2 d6:2 b5:2 g#5:2 e5:2   a5:4 e5:2 c5:2 a4:8` },
  harmony: { duty: 0.5, gain: 0.06, pattern: `
    a3:4 e4:4 a3:4 e4:4   f3:4 c4:4 f3:4 c4:4   c4:4 g4:4 c4:4 g4:4   g3:4 d4:4 g3:4 d4:4
    a3:4 e4:4 a3:4 e4:4   f3:4 c4:4 f3:4 c4:4   e3:4 b3:4 e3:4 b3:4   a3:4 e4:4 a3:8` },
  bass: { gain: 0.24, pattern: `
    a2:2 a2:2 a2:2 a2:2 a2:2 a2:2 a2:2 a2:2   f2:2 f2:2 f2:2 f2:2 f2:2 f2:2 f2:2 f2:2   c3:2 c3:2 c3:2 c3:2 c3:2 c3:2 c3:2 c3:2   g2:2 g2:2 g2:2 g2:2 g2:2 g2:2 g2:2 g2:2
    a2:2 a2:2 a2:2 a2:2 a2:2 a2:2 a2:2 a2:2   f2:2 f2:2 f2:2 f2:2 f2:2 f2:2 f2:2 f2:2   e2:2 e2:2 e2:2 e2:2 e2:2 e2:2 e2:2 e2:2   a2:2 a2:2 e3:2 e3:2 a2:8` },
  drums: { gain: 0.14, pattern: ('k:2 h:2 s:2 h:2 k:2 k:2 s:2 h:2 '.repeat(8)).trim() },
};

// New sightings: F major, gentle, arpeggiated. 96 bpm.
const SIGHTING = {
  bpm: 96,
  lead: { duty: 0.5, gain: 0.13, pattern: `
    a4:4 c5:4 f5:4 e5:4   d5:4 c5:4 a4:8   g4:4 bb4:4 d5:4 f5:4   e5:4 c5:4 a4:8
    a4:4 c5:4 f5:4 a5:4   g5:4 f5:4 e5:8   d5:4 f5:4 e5:4 c5:4   f5:12 -:4` },
  harmony: { duty: 0.25, gain: 0.06, pattern: `
    f3:2 a3:2 c4:2 a3:2 f3:2 a3:2 c4:2 a3:2   d3:2 f3:2 a3:2 f3:2 d3:2 f3:2 a3:2 f3:2   bb2:2 d3:2 f3:2 d3:2 bb2:2 d3:2 f3:2 d3:2   c3:2 e3:2 g3:2 e3:2 c3:2 e3:2 g3:2 e3:2
    f3:2 a3:2 c4:2 a3:2 f3:2 a3:2 c4:2 a3:2   c3:2 e3:2 g3:2 e3:2 c3:2 e3:2 g3:2 e3:2   bb2:2 d3:2 f3:2 d3:2 c3:2 e3:2 g3:2 e3:2   f3:2 a3:2 c4:2 a3:2 f3:4 -:4` },
  bass: { gain: 0.2, pattern: `
    f2:8 c3:8   d2:8 a2:8   bb1:8 f2:8   c2:8 g2:8
    f2:8 c3:8   c2:8 g2:8   bb1:8 c2:8   f2:12 -:4` },
  drums: { gain: 0.07, pattern: ('h:4 h:4 h:4 h:4 '.repeat(8)).trim() },
};

// Dex: D pentatonic, slow, sparse, dreamy. 84 bpm.
const DEX = {
  bpm: 84,
  lead: { duty: 0.5, gain: 0.11, pattern: `
    d5:6 e5:2 f#5:8   a5:6 f#5:2 e5:8   d5:4 e5:4 a4:8   b4:12 -:4
    f#5:6 e5:2 d5:8   b4:6 d5:2 e5:8   a4:4 b4:4 d5:8   d5:12 -:4` },
  harmony: { duty: 0.25, gain: 0.05, pattern: `
    d4:4 f#4:4 a4:4 f#4:4   d4:4 f#4:4 a4:4 f#4:4   b3:4 d4:4 f#4:4 d4:4   g3:4 b3:4 d4:4 b3:4
    d4:4 f#4:4 a4:4 f#4:4   b3:4 d4:4 f#4:4 d4:4   g3:4 b3:4 d4:4 b3:4   d4:4 f#4:4 a4:4 -:4` },
  bass: { gain: 0.18, pattern: `
    d2:16   d2:16   b1:16   g1:16
    d2:16   b1:16   g1:16   d2:12 -:4` },
  drums: { gain: 0.05, pattern: ('h:8 h:8 '.repeat(8)).trim() },
};

// Victory: a short fanfare, played once.
const VICTORY = {
  bpm: 132,
  lead: { duty: 0.5, gain: 0.18, pattern: `c5:2 e5:2 g5:2 c6:4 b5:2 c6:6 -:2 e6:4 c6:4 g5:4 c6:4` },
  harmony: { duty: 0.25, gain: 0.08, pattern: `e4:2 g4:2 c5:2 e5:4 g5:2 e5:6 -:2 g5:4 e5:4 c5:4 e5:4` },
  bass: { gain: 0.22, pattern: `c3:4 g2:4 c3:8 f2:4 g2:4 c3:4 c3:8` },
  drums: { gain: 0.12, pattern: `k:2 h:2 s:2 h:2 k:2 s:2 k:2 h:2 k:2 h:2 s:2 h:2 k:2 s:2 k:2 h:2 k:2 h:2` },
  once: true,
};

export const TUNES = { overworld: OVERWORLD, encounter: ENCOUNTER, sighting: SIGHTING, dex: DEX, victory: VICTORY };

/** Validate a tune: every channel must have the same length in 16ths. */
export function tuneLength(tune) {
  const lens = ['lead', 'harmony', 'bass', 'drums'].filter((k) => tune[k]).map((k) => patternLength(parsePattern(tune[k].pattern)));
  if (new Set(lens).size !== 1) throw new Error(`channel lengths differ: ${lens.join(', ')}`);
  return lens[0];
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

const state = { ctx: null, master: null, waves: {}, noise: null, current: null, wanted: null, timer: null, enabled: true, volume: 0.4, paused: false };

function getCtx() {
  if (state.ctx) return state.ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    state.ctx = new AC();
    state.master = state.ctx.createGain();
    state.master.gain.value = state.enabled ? state.volume : 0;
    state.master.connect(state.ctx.destination);
  } catch (_) { state.ctx = null; }
  return state.ctx;
}

function pulseWave(ctx, duty) {
  const key = String(duty);
  if (state.waves[key]) return state.waves[key];
  const n = 32;
  const real = new Float32Array(n), imag = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    real[i] = (2 / (i * Math.PI)) * Math.sin(i * Math.PI * duty);
  }
  state.waves[key] = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
  return state.waves[key];
}

function noiseBuffer(ctx) {
  if (state.noise) return state.noise;
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  state.noise = buf;
  return buf;
}

function playPulse(ctx, when, dur, freq, duty, gain) {
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(pulseWave(ctx, duty));
  osc.frequency.value = freq;
  const g = ctx.createGain();
  const a = 0.008, r = Math.min(0.06, dur * 0.3);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + a);
  g.gain.setValueAtTime(gain, when + Math.max(a, dur - r));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g); g.connect(state.master);
  osc.start(when); osc.stop(when + dur + 0.01);
}

function playTriangle(ctx, when, dur, freq, gain) {
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g); g.connect(state.master);
  osc.start(when); osc.stop(when + dur + 0.01);
}

function playDrum(ctx, when, kind, gain) {
  if (kind === 'k') {           // kick: a fast pitch drop on a triangle
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(160, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain * 2.2, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    osc.connect(g); g.connect(state.master);
    osc.start(when); osc.stop(when + 0.13);
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const filt = ctx.createBiquadFilter();
  if (kind === 'h') { filt.type = 'highpass'; filt.frequency.value = 7000; }
  else { filt.type = 'bandpass'; filt.frequency.value = 1800; filt.Q.value = 0.7; }
  const g = ctx.createGain();
  const dur = kind === 'h' ? 0.03 : 0.09;
  g.gain.setValueAtTime(kind === 'h' ? gain * 0.7 : gain * 1.6, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(filt); filt.connect(g); g.connect(state.master);
  src.start(when); src.stop(when + dur + 0.01);
}

function scheduleStep(ctx, seq, stepIndex, when, stepDur) {
  const { tune, channels } = seq;
  for (const ch of channels) {
    const ev = ch.byStep[stepIndex];
    if (!ev || !ev.note) continue;
    const dur = ev.len * stepDur * (ch.kind === 'drums' ? 1 : 0.92);
    if (ch.kind === 'lead' || ch.kind === 'harmony') playPulse(ctx, when, dur, noteFreq(ev.note), tune[ch.kind].duty || 0.5, tune[ch.kind].gain);
    else if (ch.kind === 'bass') playTriangle(ctx, when, dur, noteFreq(ev.note), tune.bass.gain);
    else if (ch.kind === 'drums') playDrum(ctx, when, ev.note, tune.drums.gain);
  }
}

function buildSequence(name) {
  const tune = TUNES[name];
  const length = tuneLength(tune);
  const channels = ['lead', 'harmony', 'bass', 'drums'].filter((k) => tune[k]).map((kind) => {
    const byStep = {};
    for (const ev of parsePattern(tune[kind].pattern)) byStep[ev.at] = ev;
    return { kind, byStep };
  });
  return { name, tune, length, channels, step: 0, nextTime: 0, stepDur: 60 / tune.bpm / 4 };
}

function tick() {
  const ctx = state.ctx, seq = state.current;
  if (!ctx || !seq || state.paused) return;
  if (ctx.state !== 'running') {
    // Keep the very first step scheduled (so a source exists from the
    // unlocking tap) but wait for the clock before scheduling more.
    if (seq.step > 0) { seq.nextTime = ctx.currentTime + 0.05; return; }
  }
  const horizon = ctx.currentTime + 0.15;
  while (seq.nextTime < horizon) {
    scheduleStep(ctx, seq, seq.step, seq.nextTime, seq.stepDur);
    seq.nextTime += seq.stepDur;
    seq.step += 1;
    if (seq.step >= seq.length) {
      if (seq.tune.once) { stopInternal(); if (state.wanted && state.wanted !== seq.name) startInternal(state.wanted); return; }
      seq.step = 0;
    }
  }
}

function startInternal(name) {
  const ctx = getCtx();
  if (!ctx || !TUNES[name]) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  stopInternal();
  state.current = buildSequence(name);
  state.current.nextTime = ctx.currentTime + 0.05;
  state.timer = setInterval(tick, 40);
  tick();
}

function stopInternal() {
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  state.current = null;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export const music = {
  /** Sets the tune that should be playing; starts it if audio is unlocked. */
  play(name) {
    state.wanted = name;
    if (!state.enabled) return;
    if (state.current && state.current.name === name) return;
    const ctx = getCtx();
    if (!ctx) return;
    // Start straight away, even if the context is still suspended: the
    // sources are created now (which is what iOS needs to happen inside a
    // tap) and simply begin sounding when the context runs.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    startInternal(name);
  },
  /** A one-shot jingle; the previous tune resumes afterwards. */
  jingle(name) {
    if (!state.enabled) return;
    const resumeTo = state.wanted;
    startInternal(name);
    state.wanted = resumeTo;
  },
  stop() { state.wanted = null; stopInternal(); },
  /** Call from a user gesture: unlocks audio and starts the wanted tune. */
  unlock() {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (state.wanted && state.enabled && !state.current) startInternal(state.wanted);
    else if (state.current && state.ctx) state.current.nextTime = Math.max(state.current.nextTime, state.ctx.currentTime + 0.05);
  },
  state() { return state.ctx ? state.ctx.state : 'not created'; },
  configure({ enabled, volume } = {}) {
    if (typeof enabled === 'boolean') {
      state.enabled = enabled;
      if (!enabled) stopInternal();
      else if (state.wanted && state.ctx && state.ctx.state === 'running') startInternal(state.wanted);
    }
    if (typeof volume === 'number') state.volume = Math.max(0, Math.min(1, volume));
    if (state.master) state.master.gain.value = state.enabled ? state.volume : 0;
  },
  pause() { state.paused = true; },
  resume() {
    if (!state.paused) return;
    state.paused = false;
    if (state.current && state.ctx) state.current.nextTime = state.ctx.currentTime + 0.05;
  },
  playing() { return state.current ? state.current.name : null; },
  wanted() { return state.wanted; },
};
