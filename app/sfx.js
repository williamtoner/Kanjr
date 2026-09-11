/**
 * sfx.js — sounds and haptics, synthesised with the Web Audio API.
 *
 * No audio files: every sound is a few short sine/triangle notes with an
 * exponential decay, so it works offline and weighs nothing. The
 * AudioContext is created lazily and resumed on the first user gesture,
 * which is what iOS requires.
 *
 * The note tables below are pure and unit tested; `play*` functions are
 * side effects.
 */

let ctx = null;
let master = null;
const prefs = { enabled: true, volume: 0.7, haptics: true };

export function configure({ enabled, volume, haptics } = {}) {
  if (typeof enabled === 'boolean') prefs.enabled = enabled;
  if (typeof volume === 'number') prefs.volume = Math.max(0, Math.min(1, volume));
  if (typeof haptics === 'boolean') prefs.haptics = haptics;
  if (master) master.gain.value = prefs.volume;
}

export function isEnabled() { return prefs.enabled; }

function getCtx() {
  if (ctx) return ctx;
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = prefs.volume;
    master.connect(ctx.destination);
  } catch (_) { ctx = null; }
  return ctx;
}

const SILENT_WAV = 'data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
let silentEl = null;
let unlocked = false;

/**
 * Call from a user gesture (click, touchend or keydown; iOS ignores
 * touchstart) so the browser lets audio play. Besides resuming the
 * AudioContext, this starts a looping, silent <audio> element: on iPhone
 * that switches the audio session to "playback", which is what lets Web
 * Audio be heard even when the ringer switch is on silent.
 */
export function unlock() {
  const c = getCtx();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  if (unlocked) return;
  try {
    if (!silentEl) {
      silentEl = document.createElement('audio');
      silentEl.src = SILENT_WAV;
      silentEl.loop = true;
      silentEl.setAttribute('playsinline', '');
      silentEl.volume = 0.01;
    }
    const p = silentEl.play();
    if (p && p.then) p.then(() => { unlocked = true; }).catch(() => {});
  } catch (_) { /* no media element support */ }
}

/** Current state of the sound engine, for the settings screen. */
export function audioState() {
  return { context: ctx ? ctx.state : 'not created', unlocked };
}

/* ------------------------------------------------------------------ */
/* Pure note tables                                                    */
/* ------------------------------------------------------------------ */

/** Frequency of a MIDI note number. */
export function midi(n) { return 440 * Math.pow(2, (n - 69) / 12); }

const C5 = 72, E5 = 76, G5 = 79, A5 = 81, C6 = 84, E6 = 88, G6 = 91;

/**
 * The "ding" for a correct answer. A two-note chime that climbs a little
 * with the streak, so a run of correct answers feels like it is going
 * somewhere: every correct answer in a streak raises the pitch by a
 * semitone, up to an octave.
 * Returns [{ note, at, dur, gain, wave }] with `at` in seconds.
 */
export function correctNotes(streak = 0) {
  const lift = Math.min(12, Math.max(0, streak - 1));
  return [
    { note: A5 + lift, at: 0, dur: 0.16, gain: 0.5, wave: 'sine' },
    { note: E6 + lift, at: 0.07, dur: 0.28, gain: 0.45, wave: 'sine' },
  ];
}

export const NOTES = {
  typo: [{ note: A5, at: 0, dur: 0.22, gain: 0.35, wave: 'sine' }],
  wrong: [
    { note: 64, at: 0, dur: 0.16, gain: 0.32, wave: 'triangle' },
    { note: 59, at: 0.13, dur: 0.26, gain: 0.28, wave: 'triangle' },
  ],
  click: [{ note: 96, at: 0, dur: 0.035, gain: 0.18, wave: 'sine' }],
  tap: [{ note: 91, at: 0, dur: 0.05, gain: 0.14, wave: 'sine' }],
  combo: [
    { note: C5, at: 0, dur: 0.1, gain: 0.35, wave: 'sine' },
    { note: E5, at: 0.06, dur: 0.1, gain: 0.35, wave: 'sine' },
    { note: G5, at: 0.12, dur: 0.1, gain: 0.35, wave: 'sine' },
    { note: C6, at: 0.18, dur: 0.3, gain: 0.4, wave: 'sine' },
  ],
  stageUp: [
    { note: G5, at: 0, dur: 0.09, gain: 0.3, wave: 'sine' },
    { note: C6, at: 0.07, dur: 0.09, gain: 0.3, wave: 'sine' },
    { note: E6, at: 0.14, dur: 0.09, gain: 0.3, wave: 'sine' },
    { note: G6, at: 0.21, dur: 0.35, gain: 0.35, wave: 'sine' },
  ],
  complete: [
    { note: C5, at: 0, dur: 0.14, gain: 0.35, wave: 'triangle' },
    { note: E5, at: 0.12, dur: 0.14, gain: 0.35, wave: 'triangle' },
    { note: G5, at: 0.24, dur: 0.14, gain: 0.35, wave: 'triangle' },
    { note: C6, at: 0.36, dur: 0.5, gain: 0.4, wave: 'triangle' },
    { note: E6, at: 0.36, dur: 0.5, gain: 0.25, wave: 'sine' },
    { note: G6, at: 0.36, dur: 0.5, gain: 0.2, wave: 'sine' },
  ],
  lessonDone: [
    { note: E5, at: 0, dur: 0.12, gain: 0.32, wave: 'sine' },
    { note: G5, at: 0.1, dur: 0.12, gain: 0.32, wave: 'sine' },
    { note: C6, at: 0.2, dur: 0.4, gain: 0.38, wave: 'sine' },
  ],
  burned: [
    { note: C6, at: 0, dur: 0.1, gain: 0.3, wave: 'sine' },
    { note: G6, at: 0.08, dur: 0.1, gain: 0.3, wave: 'sine' },
    { note: C6 + 12, at: 0.16, dur: 0.6, gain: 0.35, wave: 'sine' },
    { note: E6, at: 0.16, dur: 0.6, gain: 0.2, wave: 'sine' },
  ],
};

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

function playNotes(notes) {
  if (!prefs.enabled) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === 'suspended') { c.resume().catch(() => {}); }
  const t0 = c.currentTime + 0.01;
  for (const n of notes) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = n.wave || 'sine';
    osc.frequency.value = midi(n.note);
    const start = t0 + n.at;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(n.gain, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + n.dur + 0.02);
    // A soft second harmonic gives the sines a bell-like body.
    if (n.wave === 'sine' && n.dur >= 0.1) {
      const o2 = c.createOscillator();
      const g2 = c.createGain();
      o2.type = 'sine';
      o2.frequency.value = midi(n.note) * 2;
      g2.gain.setValueAtTime(0.0001, start);
      g2.gain.exponentialRampToValueAtTime(n.gain * 0.18, start + 0.008);
      g2.gain.exponentialRampToValueAtTime(0.0001, start + n.dur * 0.6);
      o2.connect(g2); g2.connect(master);
      o2.start(start); o2.stop(start + n.dur);
    }
  }
}

function buzz(pattern) {
  if (!prefs.haptics) return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) { /* unsupported */ }
}

export const sfx = {
  correct(streak = 0) { playNotes(correctNotes(streak)); buzz(12); if (streak > 0 && streak % 5 === 0) setTimeout(() => playNotes(NOTES.combo), 180); },
  typo() { playNotes(NOTES.typo); buzz(12); },
  wrong() { playNotes(NOTES.wrong); buzz([30, 40, 30]); },
  click() { playNotes(NOTES.click); },
  tap() { playNotes(NOTES.tap); buzz(6); },
  stageUp() { playNotes(NOTES.stageUp); buzz([15, 30, 15]); },
  burned() { playNotes(NOTES.burned); buzz([20, 40, 20, 40, 40]); },
  complete() { playNotes(NOTES.complete); buzz([20, 50, 20, 50, 60]); },
  lessonDone() { playNotes(NOTES.lessonDone); buzz([15, 40, 25]); },
};
