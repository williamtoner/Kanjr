/**
 * app.js — screens, hash routing and rendering for Kanjr.
 *
 * This is the only module with side effects: it owns the DOM, the clock,
 * persistence calls and the service worker. All decisions about queues,
 * scheduling and answer checking live in the pure modules it imports.
 *
 * Layout of this file
 *   1. State, utilities, formatting
 *   2. Persistence glue (setProgress, backups, theme)
 *   3. Small UI pieces (toasts, modal, chips, badges, charts)
 *   4. The quiz view shared by reviews and the lesson quiz
 *   5. Screens (home, lessons, reviews, item, levels, stats, settings)
 *   6. Router and boot
 */

import * as srs from './srs.js';
import * as engine from './engine.js';
import { isCorrect, acceptedFor, findCollision, normalise } from './match.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { sfx, configure as configureSfx, unlock as unlockAudio, audioState } from './sfx.js';
import { music } from './music.js';
import * as scan from './scan.js';
import * as visual from './visual.js';
import * as game from './game.js';

// ===========================================================================
// 1. State and utilities
// ===========================================================================

const DATA_URL = '../data/kanji.json';
const SAMPLE_URL = '../tests/fixture.json';
const LAST_EXPORT_KEY = 'kanjr.lastExport';
const EXPORT_REMINDER_DAYS = 7;
const LIGHTNING_DELAY_MS = 550;

/** Global application state. */
const app = {
  data: null,          // parsed kanji.json
  progress: null,      // persisted progress (see store.js)
  sample: false,       // true when the test fixture is loaded instead of real data
  session: null,       // in-flight review session
  lesson: null,        // in-flight lesson batch
  keyHandler: null,    // document-level keydown handler for the current screen
  cleanup: null,       // per-screen teardown
  lastBackupDay: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const main = $('#main');

const now = () => new Date();

/** Escape text for insertion into HTML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** "14:00" in local time. */
function fmtTime(when) {
  const d = new Date(srs.toMillis(when));
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "8 Sep 2026". */
function fmtDate(when) {
  const d = new Date(srs.toMillis(when));
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Tue 8 Sep, 14:00". */
function fmtDateTime(when) {
  const d = new Date(srs.toMillis(when));
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${fmtTime(d)}`;
}

/** Friendly phrase for a future time: "at 14:00", "tomorrow at 09:00", "Thu at 10:00". */
function whenPhrase(when, ref = now()) {
  if (!when) return null;
  const days = engine.calendarDaysBetween(ref, when);
  if (days <= 0) return `at ${fmtTime(when)}`;
  if (days === 1) return `tomorrow at ${fmtTime(when)}`;
  if (days < 7) {
    const wd = new Date(srs.toMillis(when)).toLocaleDateString(undefined, { weekday: 'long' });
    return `${wd} at ${fmtTime(when)}`;
  }
  return `on ${fmtDate(when)}`;
}

/** "in 3 h", "in 2 days", "now". */
function relPhrase(when, ref = now()) {
  if (!when) return '';
  const diff = srs.toMillis(when) - srs.toMillis(ref);
  if (diff <= 0) return 'now';
  const h = diff / 3600000;
  if (h < 1) return `in ${Math.max(1, Math.round(diff / 60000))} min`;
  if (h < 48) return `in ${Math.round(h)} h`;
  return `in ${Math.round(h / 24)} days`;
}

function pct(ratio) {
  return `${Math.round((ratio || 0) * 100)}%`;
}

function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

function greeting() {
  const h = now().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function dexNumberOf(id) {
  if (!app.dex) app.dex = game.dexNumbers(app.data);
  return app.dex[id] || 0;
}

function rarityBadge(item) {
  const r = game.rarityOf(item);
  return `<span class="rarity r-${r.key}" title="${r.key === 'part' ? 'A building block, not a kanji' : `Rarity by how often it appears in real text`}">${r.stars ? `<span class="stars">${'★'.repeat(r.stars)}</span>` : ''}${esc(r.label)}</span>`;
}

function caughtCount() {
  let n = 0;
  for (const id in app.progress.items) if (app.progress.items[id].stage > 0 && app.data.items[id] && app.data.items[id].type === 'kanji') n++;
  return n;
}

function shinyCount() {
  let n = 0;
  for (const id in app.progress.items) if (app.progress.items[id].shiny) n++;
  return n;
}

function itemOf(id) {
  return app.data && app.data.items ? app.data.items[id] : null;
}

function typeLabel(item) {
  return item.type === 'radical' ? 'Radical' : 'Kanji';
}

function itemHref(id) {
  return `#/item/${encodeURIComponent(id)}`;
}

/** Nudge screen readers and keep the level badge current. */
function updateLevelBadge() {
  // (label set below)
  const badge = $('#level-badge');
  if (!badge || !app.data) return;
  const level = engine.currentLevel(app.data, app.progress);
  badge.textContent = `Trainer Lv ${level}`;
  badge.href = `#/levels/${level}`;
}

// ===========================================================================
// 2. Persistence glue
// ===========================================================================

/** Replace the progress object, persist it and refresh dependent chrome. */
function setProgress(next, { immediate = false } = {}) {
  app.progress = next;
  if (immediate) store.writeNow(next); else store.save(next);
  updateLevelBadge();
  applySfxSettings();
  scheduleSync();
}

function applySfxSettings() {
  const st = app.progress && app.progress.settings;
  if (!st) return;
  configureSfx({ enabled: st.sounds !== false, volume: (Number(st.volume) || 0) / 100, haptics: st.haptics !== false });
  music.configure({ enabled: st.music !== false, volume: (Number(st.musicVolume) || 0) / 100 });
}

/** Which tune belongs to which screen. */
function sceneFor(head) {
  return { reviews: 'encounter', drill: 'encounter', lessons: 'sighting', grid: 'dex', scan: 'dex', item: 'dex', levels: 'dex' }[head] || 'overworld';
}

/* ---------- Juice: little visual rewards ---------- */

function reducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A short burst of coloured specks from the middle of an element. */
function burst(el, { count = 14, colour = 'var(--ok)' } = {}) {
  if (!el || reducedMotion() || app.progress.settings.celebrations === false) return;
  const host = document.createElement('div');
  host.className = 'burst';
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const dist = 60 + Math.random() * 70;
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.setProperty('--c', colour);
    p.style.animationDelay = `${Math.random() * 60}ms`;
    host.appendChild(p);
  }
  el.appendChild(host);
  setTimeout(() => host.remove(), 900);
}

/** Text that floats up out of an element and fades ("+1", "×5 streak!"). */
function floatText(el, text, cls = '') {
  if (!el || reducedMotion() || app.progress.settings.celebrations === false) return;
  const f = document.createElement('div');
  f.className = `float-text ${cls}`;
  f.textContent = text;
  el.appendChild(f);
  setTimeout(() => f.remove(), 1100);
}

/** A red seal stamp thumps onto an element: the "caught" mark. */
function stampHit(el, text = 'Caught', gold = false) {
  if (!el || reducedMotion() || app.progress.settings.celebrations === false) return;
  const st = document.createElement('div');
  st.className = `stamp-hit${gold ? ' gold' : ''}`;
  st.textContent = text;
  el.appendChild(st);
  setTimeout(() => st.remove(), 800);
}

/** Confetti across the whole screen for a finished session. */
function confetti(duration = 1800) {
  if (reducedMotion() || app.progress.settings.celebrations === false) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.width = window.innerWidth * dpr, H = canvas.height = window.innerHeight * dpr;
  const colours = ['#ec4899', '#a855f7', '#3b82f6', '#06b6d4', '#f59e0b', '#22c55e'];
  const bits = Array.from({ length: 140 }, () => ({
    x: Math.random() * W, y: -20 * dpr - Math.random() * H * 0.3, vx: (Math.random() - 0.5) * 3 * dpr, vy: (2 + Math.random() * 3) * dpr,
    w: (6 + Math.random() * 6) * dpr, h: (8 + Math.random() * 8) * dpr, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, c: colours[Math.floor(Math.random() * colours.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const k = (t - t0) / duration;
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.vy += 0.05 * dpr; b.r += b.vr;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.r); ctx.globalAlpha = Math.max(0, 1 - Math.max(0, k - 0.6) / 0.4);
      ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); ctx.restore();
    }
    if (k < 1) requestAnimationFrame(frame); else canvas.remove();
  })(t0);
}

/* ---------- Device sync (GitHub Gist) ---------- */

const syncState = { timer: null, busy: false, lastResult: '', lastAt: null, error: '' };

function scheduleSync(delay = 4000) {
  if (!sync.loadSyncConfig()) return;
  if (syncState.timer) clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => { syncState.timer = null; runSync({ quiet: true }); }, delay);
}

/**
 * Pull, merge, push. Remote changes are only applied when no review session
 * is in progress, so a half-finished session on this device is never
 * disturbed; they are picked up at the next sync.
 */
async function runSync({ quiet = false } = {}) {
  const cfg = sync.loadSyncConfig();
  if (!cfg || syncState.busy) return null;
  if (!navigator.onLine) { syncState.error = 'Offline'; return null; }
  syncState.busy = true;
  syncState.error = '';
  try {
    store.flush();
    const r = await sync.syncOnce(cfg, app.progress, store.validateProgress);
    const midSession = app.session && app.session.queue && app.session.queue.length;
    if (r.pulledChanges && !midSession) {
      app.progress = r.progress;
      store.writeNow(r.progress);
      applyTheme(r.progress.settings.theme);
      updateLevelBadge();
      if ((parseRoute()[0] || 'home') !== 'reviews') route();
    }
    syncState.lastAt = new Date();
    syncState.lastResult = r.pulledChanges ? 'Merged changes from another device' : r.pushed ? 'Uploaded' : 'Up to date';
    sync.saveSyncConfig(Object.assign({}, cfg, { lastSyncedAt: syncState.lastAt.toISOString() }));
    if (!quiet) toast(`Synced — ${syncState.lastResult.toLowerCase()}`, 'ok');
    else if (r.pulledChanges) toast('Synced changes from another device', 'ok');
    return r;
  } catch (err) {
    syncState.error = err && err.message ? err.message : String(err);
    if (!quiet) toast(`Sync failed: ${syncState.error}`, 'error');
    else console.warn('Sync failed:', err);
    return null;
  } finally {
    syncState.busy = false;
    const el = $('[data-role="sync-status"]');
    if (el) el.innerHTML = syncStatusHtml();
  }
}

function syncStatusHtml() {
  const cfg = sync.loadSyncConfig();
  if (!cfg) return '';
  const when = syncState.lastAt || (cfg.lastSyncedAt ? new Date(cfg.lastSyncedAt) : null);
  return `${syncState.busy ? 'Syncing…' : syncState.error ? `<span style="color:var(--bad)">${esc(syncState.error)}</span>` : (syncState.lastResult || 'Connected')}${when ? ` · last sync ${esc(fmtDateTime(when))}` : ''}`;
}

/** Update a few settings keys (shallow) and persist. */
function updateSettings(patch) {
  const settings = store.normaliseSettings(Object.assign({}, app.progress.settings, patch));
  setProgress(Object.assign({}, app.progress, { settings, updatedAt: now().toISOString() }));
  applyTheme(settings.theme);
}

/** Take today's IndexedDB snapshot at most once per day (plus on demand). */
function backupIfNeeded(force = false) {
  const key = engine.dayKey(now());
  if (!force && app.lastBackupDay === key) return;
  if (!Object.keys(app.progress.items || {}).length) return;
  app.lastBackupDay = key;
  store.backupDaily(app.progress, key);
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

function lastExportAt() {
  try { return localStorage.getItem(LAST_EXPORT_KEY); } catch (_) { return null; }
}

function markExported() {
  try { localStorage.setItem(LAST_EXPORT_KEY, now().toISOString()); } catch (_) { /* ignore */ }
}

// ===========================================================================
// 3. Small UI pieces
// ===========================================================================

function toast(message, kind = '') {
  const host = $('#toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind ? `is-${kind}` : ''}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 200ms'; }, 2600);
  setTimeout(() => el.remove(), 2900);
}

/**
 * Confirmation dialog. Resolves true/false. Enter confirms, Esc cancels.
 * Focus goes to the safe action by default.
 */
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title">${esc(title)}</h2>
        <p>${body}</p>
        <div class="btn-row">
          <button class="btn" data-act="cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const previous = document.activeElement;
    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (previous && previous.focus) previous.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      e.stopPropagation();
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
      const act = e.target.closest('[data-act]');
      if (act) close(act.dataset.act === 'ok');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    $('[data-act="cancel"]', backdrop).focus();
  });
}

function stageBadge(stage) {
  const g = srs.groupOf(stage);
  return `<span class="badge stage-${g}">${esc(srs.stageName(stage))}</span>`;
}

function typeBadge(item) {
  return `<span class="badge type-${esc(item.type)}">${typeLabel(item)}</span>`;
}

/** A clickable chip linking to an item page. */
function chip(id, { locked = false, extra = '' } = {}) {
  const item = itemOf(id);
  if (!item) return `<span class="chip"><span class="chip-glyph">?</span>${esc(id)}</span>`;
  return `<a class="chip type-${esc(item.type)} ${locked ? 'is-locked' : ''}" href="${itemHref(id)}" title="${esc(typeLabel(item))}">
    <span class="chip-glyph">${esc(item.char)}</span>${esc(item.name)}${extra}</a>`;
}

function chipList(ids, opts) {
  if (!ids || !ids.length) return '<span class="muted small">none</span>';
  return `<div class="chips">${ids.map((id) => chip(id, opts)).join('')}</div>`;
}

function mnemonicBlock(item, note) {
  const own = note ? `<div class="mnemonic mnemonic-note"><strong>Your note:</strong> ${esc(note)}</div>` : '';
  if (item.mnemonic) return `<div class="mnemonic">${esc(item.mnemonic)}</div>${own}`;
  const hint = item.type === 'radical' && item.note ? esc(item.note) : 'No mnemonic written yet — add your own note on the item page.';
  return `<div class="mnemonic is-empty">${hint}</div>${own}`;
}

function examplesList(item) {
  if (!Array.isArray(item.examples) || !item.examples.length) return '';
  return `<ul class="examples">${item.examples.map((ex) => `
    <li><span class="ex-word">${esc(ex.word)}</span><span class="ex-gloss">${esc(ex.gloss)}</span></li>`).join('')}</ul>`;
}

/** SVG progress ring. */
function ring(ratio, label, sub) {
  const r = 44, c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(1, ratio)));
  return `
    <div class="ring-wrap" role="img" aria-label="${esc(label)}, ${esc(sub)}">
      <svg class="ring" viewBox="0 0 100 100">
        <circle class="ring-track" cx="50" cy="50" r="${r}"></circle>
        <circle class="ring-value" cx="50" cy="50" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${offset}"></circle>
      </svg>
      <div class="ring-label"><span class="ring-level">${esc(label)}</span><span class="ring-sub">${esc(sub)}</span></div>
    </div>`;
}

/** Animate rings after insertion (respects reduced motion through CSS). */
function animateRings(root) {
  requestAnimationFrame(() => {
    $$('.ring-value', root).forEach((el) => { el.style.strokeDashoffset = el.dataset.target; });
  });
}

/** Vertical bar chart. `labels` may be sparse (empty strings are skipped). */
function bars(values, labels, { tall = false, cls = '', counts = true } = {}) {
  const max = Math.max(1, ...values);
  const items = values.map((v, i) => `
    <div class="bar ${v ? '' : 'is-empty'}" title="${esc(labels[i] || '')}: ${v}">
      ${counts && v ? `<span class="bar-count">${v}</span>` : ''}
      <div class="bar-fill ${cls}" style="height:${v ? Math.max(4, Math.round((v / max) * 100)) : 2}%; animation-delay:${i * 12}ms"></div>
    </div>`).join('');
  const labelRow = labels.map((l) => `<span>${esc(l)}</span>`).join('');
  return `<div class="bars ${tall ? 'bars-tall' : ''}">${items}</div><div class="bar-labels">${labelRow}</div>`;
}

function emptyState(glyph, title, body, actions = '') {
  return `<div class="empty card"><div class="empty-glyph">${esc(glyph)}</div><h2>${esc(title)}</h2><p>${body}</p>${actions}</div>`;
}

// ===========================================================================
// 4. Quiz view (shared by Reviews and the lesson quiz)
// ===========================================================================

/**
 * Mount a typed-answer quiz into `root`.
 *
 * @param {HTMLElement} root
 * @param {object} opts
 *   session        engine session (queue/done/wrong); the view never mutates it
 *   onSession(s)   called with the new session after every answer
 *   onCorrect(id, wrong)  called when an item is completed (first correct answer)
 *   onFinish(s)    called when the queue empties
 *   onWrapUp(s)    optional; enables the wrap-up button and Esc
 *   lightning      auto-advance on an exact correct answer
 *   affectsSrs     shows "no SRS effect" note when false
 * @returns {{destroy: Function}}
 */
const GLYPH_FONTS = ['', 'font-mincho', 'font-pen', 'font-hand'];

/** A typeface for this item in this session: fixed per item so a retry looks the same. */
function glyphFont(item, session) {
  if (!app.progress.settings.fontVariety || !item || item.type !== 'kanji') return '';
  let h = 0;
  const key = item.id + (session && session.startedAt || '');
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return GLYPH_FONTS[h % GLYPH_FONTS.length];
}

function mountQuiz(root, opts) {
  let session = opts.session;
  // `answeredId` and `counter` freeze what the feedback phase shows: the
  // session has already moved on to the next item by then.
  const view = { phase: 'ask', result: null, retried: false, info: false, collision: null, timer: null, answeredId: null, counter: 1, streak: 0, best: 0 };
  const typo = app.progress.settings.typoTolerance !== false;

  function current() { return engine.currentId(session); }

  function render() {
    const stats = engine.sessionStats(session);
    let id;
    if (view.phase === 'feedback') {
      id = view.answeredId;
    } else {
      id = current();
      if (id == null) { opts.onFinish(session); return; }
      if (!itemOf(id)) {
        // Stale id (data changed): skip it silently.
        session = engine.answerCurrent(session, true);
        opts.onSession(session);
        render();
        return;
      }
      view.counter = Math.min(stats.total, stats.done + 1);
    }
    const item = itemOf(id);
    const wrongSoFar = view.phase === 'ask' ? (session.wrong[id] || 0) : 0;
    const stateCls = view.phase === 'feedback' ? `is-${view.result === 'wrong' ? 'wrong' : view.result === 'typo' ? 'typo' : 'correct'}` : '';
    const shinyNow = item.type === 'kanji' && game.isShinyEncounter(id, session.startedAt);
    const progressPct = stats.total ? (stats.done / stats.total) * 100 : 0;
    const note = app.progress.notes[id];

    root.innerHTML = `
      <div class="review">
        <div class="review-top">
          <span class="counter" aria-live="polite">${view.counter} / ${stats.total}</span>
          <span class="accuracy" title="Accuracy so far">${stats.done ? pct(stats.accuracy) : '—'}</span>
          ${view.streak >= 2 ? `<span class="streak ${view.streak >= 5 ? 'is-hot' : ''}" title="Caught in a row: combo">×${view.streak}</span>` : ''}
          <span class="spacer"></span>
          <button class="btn btn-ghost btn-sm btn-icon" data-act="mute" title="${app.progress.settings.sounds === false ? 'Sounds off — click to turn on' : 'Sounds on — click to mute'}" aria-label="Toggle sounds">${app.progress.settings.sounds === false ? '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3 3 3-1.4 1.4-3-3-3 3L10.7 15l3-3-3-3 1.4-1.4 3 3 3-3L19.5 9z"/></svg>' : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>'}</button>
          ${opts.onWrapUp ? `<button class="btn btn-ghost btn-sm" data-act="wrap" title="Finish the items in progress and stop (Esc)">
            <span class="label">${session.wrappingUp ? 'Wrapping up' : 'Wrap up'}</span> <kbd>Esc</kbd></button>` : ''}
        </div>
        <div class="review-progress"><div style="width:${progressPct}%"></div></div>

        <div class="card glyph-card type-${esc(item.type)} ${stateCls} ${shinyNow ? 'is-shiny' : ''} ${view.phase === 'feedback' && view.result === 'wrong' ? 'shake' : ''}" data-role="card">
          <div class="glyph-type">${typeBadge(item)}</div>
          ${shinyNow ? `<span class="shiny-badge shiny-tag">✦ Shiny</span><span class="sparkle" style="left:12%;top:30%">✦</span><span class="sparkle" style="right:14%;top:58%;animation-delay:.5s">✦</span><span class="sparkle" style="left:22%;bottom:18%;animation-delay:1s">✦</span>` : ''}
          <div class="glyph ${esc(glyphFont(item, session))}">${esc(item.char)}</div>
          <div class="glyph-prompt">${typeLabel(item)} <strong>meaning</strong>${wrongSoFar ? ` · <span class="muted">missed ${wrongSoFar}×</span>` : ''}${view.phase === 'feedback' ? ' · <span class="muted">tap to continue</span>' : ''}</div>
        </div>

        <form class="answer-form" data-role="form" autocomplete="off">
          <label class="sr-only" for="answer">Your answer</label>
          <input class="answer ${stateCls}" id="answer" name="answer" type="text"
            placeholder="${view.phase === 'ask' ? 'Type the meaning…' : ''}"
            autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go"
            ${view.phase === 'feedback' ? 'readonly' : ''} value="${esc(view.lastInput || '')}">
          <div class="answer-hint ${hintClass()}" data-role="hint">${hintText(item)}</div>
        </form>

        ${view.phase === 'feedback' ? feedbackHtml(item, note) : ''}
        ${view.phase === 'feedback' ? `<div class="continue-bar"><span class="muted small">${view.result === 'wrong' ? 'Slipped away' : 'Caught!'} · tap the kanji or</span><button class="btn btn-primary btn-sm" data-act="next">Continue</button></div>` : ''}
      </div>`;

    const input = $('#answer', root);
    const form = $('[data-role="form"]', root);
    form.addEventListener('submit', (e) => { e.preventDefault(); if (view.phase === 'ask') submit(input.value); else next(); });
    // Tapping the kanji card acts like Enter: continue after feedback, or
    // submit the typed answer. Saves reaching for a button on a phone.
    const cardEl = $('[data-role="card"]', root);
    cardEl.addEventListener('click', () => {
      if (view.phase === 'feedback') next();
      else if (normalise(input.value)) submit(input.value);
      else input.focus();
    });
    $$('[data-act="wrap"]', root).forEach((b) => b.addEventListener('click', wrap));
    $$('[data-act="mute"]', root).forEach((b) => b.addEventListener('click', () => { updateSettings({ sounds: app.progress.settings.sounds === false }); render(); }));
    $$('[data-act="next"]', root).forEach((b) => b.addEventListener('click', next));
    $$('[data-act="info"]', root).forEach((b) => b.addEventListener('click', toggleInfo));
    $$('[data-act="accept-syn"]', root).forEach((b) => b.addEventListener('click', acceptAsSynonym));
    input.focus({ preventScroll: true });
    if (view.phase === 'ask') input.select();

    if (view.phase === 'feedback' && view.result === 'exact' && opts.lightning) {
      view.timer = setTimeout(next, LIGHTNING_DELAY_MS);
    }
  }

  function hintClass() {
    if (view.phase === 'ask') return view.collision ? 'is-warn' : '';
    if (view.result === 'typo') return 'is-warn';
    if (view.result === 'wrong') return 'is-bad';
    return 'is-ok';
  }

  function hintText(item) {
    if (view.phase === 'ask') {
      if (view.collision) {
        return `That's another ${item.type} (${esc(view.collision.char)} <strong>${esc(view.collision.name)}</strong>). Try once more.`;
      }
      return `<kbd>Enter</kbd> to check${opts.onWrapUp ? ' · <kbd>Esc</kbd> to wrap up' : ''}`;
    }
    if (view.result === 'typo') return 'Close enough — check the spelling. <kbd>Enter</kbd> to continue';
    if (view.result === 'wrong') return `It slipped away. <kbd>Enter</kbd> to continue${opts.affectsSrs === false ? ' (you will meet it again)' : ''}`;
    return `Caught! <kbd>Enter</kbd> to continue · <kbd>?</kbd> for details`;
  }

  function feedbackHtml(item, note) {
    const alt = Array.isArray(item.alt) ? item.alt : [];
    const syn = app.progress.synonyms[item.id] || [];
    const showDetail = view.result === 'wrong' || view.info;
    return `
      <div class="feedback fade-in" data-role="feedback">
        <div class="feedback-answer">${esc(item.name)}</div>
        ${alt.length || syn.length ? `<div class="feedback-alt">${esc([...alt, ...syn].join(' · '))}</div>` : ''}
        <div class="feedback-meta">${stageBadge(engine.stageOf(app.progress, item.id))}
          ${item.strokes ? `<span class="pill">${plural(item.strokes, 'stroke')}</span>` : ''}
          <a class="pill" href="${itemHref(item.id)}">Item page ↗</a></div>
        ${showDetail ? `
          ${mnemonicBlock(item, note)}
          ${item.parts && item.parts.length ? `<div class="section-label">Parts</div>${chipList(item.parts)}` : ''}
          ${item.type === 'radical' && item.used_in && item.used_in.length ? `<div class="section-label">Used in</div>${chipList(item.used_in.slice(0, 8))}` : ''}
          ${view.info && item.examples && item.examples.length ? `<div class="section-label">Examples</div>${examplesList(item)}` : ''}
        ` : ''}
        <div class="feedback-actions">
          ${view.result !== 'wrong' ? `<button class="btn btn-sm" data-act="info">${view.info ? 'Hide' : 'Show'} details <kbd>?</kbd></button>` : ''}
          ${view.result === 'wrong' && normalise(view.lastInput) ? `<button class="btn btn-sm" data-act="accept-syn" title="Overrides this answer as correct and accepts “${esc(normalise(view.lastInput))}” for this item from now on">No, I got this right <kbd>R</kbd></button>` : ''}
          <button class="btn btn-primary btn-sm" data-act="next">Continue <kbd>Enter</kbd></button>
        </div>
      </div>`;
  }

  function submit(raw) {
    const id = current();
    const item = itemOf(id);
    if (!normalise(raw)) { shakeCard(); return; }
    const accepted = acceptedFor(item, app.progress.synonyms[id]);
    let verdict = isCorrect(raw, accepted, { typoTolerance: typo });

    if (verdict === 'wrong' && !view.retried) {
      const collision = findCollision(raw, item, app.data.items);
      if (collision) {
        view.retried = true;
        view.collision = collision;
        view.lastInput = '';
        render();
        shakeCard();
        return;
      }
    }

    const shiny = item.type === 'kanji' && game.isShinyEncounter(id, session.startedAt);
    const wrongBefore = session.wrong[id] || 0;
    view.lastInput = raw;
    view.collision = null;
    view.phase = 'feedback';
    view.result = verdict;
    view.info = false;
    view.answeredId = id;
    if (verdict === 'wrong') {
      view.streak = 0;
      session = engine.answerCurrent(session, false);
      sfx.wrong();
    } else {
      view.streak += 1;
      view.best = Math.max(view.best, view.streak);
      const wrong = session.wrong[id] || 0;
      session = engine.answerCurrent(session, true);
      opts.onCorrect(id, wrong);
      if (verdict === 'typo') sfx.typo(); else sfx.correct(view.streak);
    }
    opts.onSession(session);
    render();
    const card = $('[data-role="card"]', root);
    if (verdict !== 'wrong') {
      burst(card, { count: view.streak >= 5 ? 22 : 14, colour: view.streak >= 5 ? 'var(--accent)' : 'var(--ok)' });
      floatText(card, view.streak >= 5 && view.streak % 5 === 0 ? `×${view.streak} combo!` : view.streak >= 2 ? `×${view.streak}` : 'Caught!', view.streak >= 5 ? 'is-hot' : '');
      stampHit(card, shiny ? 'Shiny!' : 'Caught', shiny);
      if (shiny && opts.affectsSrs !== false && !wrongBefore) {
        const entry = Object.assign({}, app.progress.items[id], { shiny: true });
        setProgress(Object.assign({}, app.progress, { items: Object.assign({}, app.progress.items, { [id]: entry }) }), { immediate: true });
        setTimeout(() => { sfx.burned(); toast(`✦ Shiny ${itemOf(id).char} caught!`, 'ok'); }, 350);
      }
    }
  }

  /** The learner's "wrong" answer was a synonym: accept it and undo the miss. */
  function acceptAsSynonym() {
    if (view.phase !== 'feedback' || view.result !== 'wrong') return;
    const id = view.answeredId;
    const word = normalise(view.lastInput);
    if (!id || !word) return;
    const list = (app.progress.synonyms[id] || []).slice();
    if (!list.some((x) => normalise(x) === word)) list.push(word);
    setProgress(Object.assign({}, app.progress, { synonyms: Object.assign({}, app.progress.synonyms, { [id]: list }) }));
    const r = engine.retractWrong(session, id);
    session = r.session;
    opts.onSession(session);
    if (opts.affectsSrs !== false) opts.onCorrect(id, r.wrong);
    view.result = 'exact';
    view.streak += 1;
    sfx.correct(view.streak);
    toast(`Marked correct — “${word}” is now accepted for ${itemOf(id).char}`, 'ok');
    render();
    burst($('[data-role="card"]', root));
  }

  function next() {
    if (view.timer) { clearTimeout(view.timer); view.timer = null; }
    view.phase = 'ask';
    view.result = null;
    view.retried = false;
    view.collision = null;
    view.info = false;
    view.lastInput = '';
    render();
  }

  function toggleInfo() {
    if (view.phase !== 'feedback') return;
    if (view.timer) { clearTimeout(view.timer); view.timer = null; }
    view.info = !view.info;
    render();
  }

  function wrap() {
    if (!opts.onWrapUp) return;
    if (session.wrappingUp) return;
    session = engine.wrapUp(session);
    opts.onSession(session);
    opts.onWrapUp(session);
    const left = session.queue.length;
    toast(left ? `Wrapping up — ${plural(left, 'item')} left` : 'Session wrapped up');
    if (view.phase === 'ask') render(); else $$('[data-act="wrap"] .label', root).forEach((l) => { l.textContent = 'Wrapping up'; });
  }

  function shakeCard() {
    const card = $('[data-role="card"]', root);
    if (!card) return;
    card.classList.remove('shake');
    void card.offsetWidth; // restart the animation
    card.classList.add('shake');
  }

  function onKey(e) {
    if (e.key === 'Escape' && opts.onWrapUp) { e.preventDefault(); wrap(); return; }
    if (e.key === '?' ) {
      if (view.phase === 'feedback') { e.preventDefault(); toggleInfo(); }
      else e.preventDefault(); // never part of an answer
      return;
    }
    if (e.key === 'Enter' && view.phase === 'feedback') { e.preventDefault(); next(); }
    if ((e.key === 'r' || e.key === 'R') && view.phase === 'feedback' && view.result === 'wrong' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); acceptAsSynonym(); }
  }

  app.keyHandler = onKey;
  render();
  return {
    destroy() { if (view.timer) clearTimeout(view.timer); app.keyHandler = null; },
  };
}

// ===========================================================================
// 5. Screens
// ===========================================================================

// --- Home ------------------------------------------------------------------

function renderHome() {
  const t = now();
  const p = app.progress;
  const data = app.data;
  const level = engine.currentLevel(data, p);
  const lp = engine.levelProgress(data, p, level);
  const lessons = engine.lessonQueue(data, p, t);
  const dueNow = engine.dueCount(p, t);
  const nextAt = engine.nextReviewAt(p, t);
  const fc = engine.forecast(p, t);
  const today = p.days[engine.dayKey(t)] || { lessons: 0, reviews: 0, correct: 0 };
  const streak = engine.streak(p.days, t);
  const groups = engine.groupCounts(p, data);
  const mistakes = engine.recentMistakes(p, 12);
  const leechList = engine.leeches(p);
  const kanjiTotal = Object.values(data.items).filter((i) => i.type === 'kanji').length;
  const blockReason = lessons.length ? null : engine.lessonBlockReason(data, p, t);
  const hasSession = !!(app.session && app.session.queue.length);

  const hourLabels = fc.hours.map((_, i) => {
    const h = new Date(Math.ceil((t.getTime() + i * 3600000) / 3600000) * 3600000).getHours();
    return i % 4 === 0 ? `${pad2(h)}` : '';
  });
  const upcoming = fc.hours.reduce((a, b) => a + b, 0);

  const lessonSub = lessons.length
    ? `${plural(lessons.length, 'kanji', 'kanji')} to sight`
    : blockReason === 'apprentice-cap' ? 'Apprentice cap reached'
      : blockReason === 'daily-cap' ? 'Done for today'
        : blockReason === 'nothing-unlocked' ? 'Nothing unlocked yet' : 'None right now';
  const reviewSub = dueNow
    ? (hasSession ? 'Encounter in progress' : `${plural(dueNow, 'wild kanji', 'wild kanji')} waiting`)
    : (nextAt ? `Next ${whenPhrase(nextAt, t)}` : 'Nothing scheduled');

  main.innerHTML = `
    <section class="screen stack home">
      <div class="card home-hero">
        ${ring(lp.ratio, `Lv ${level}`, pct(lp.ratio))}
        <div class="hero-text">
          <h1>${greeting()}, trainer</h1>
          <p class="muted"><strong>${caughtCount()}</strong> of ${kanjiTotal} kanji caught${shinyCount() ? ` · <span class="shiny-badge">✦ ${shinyCount()} shiny</span>` : ''} · Level ${level}: ${lp.guru} of ${lp.total} at Guru</p>
          <div class="btn-row">
            <span class="streak" title="Days in a row with lessons or reviews"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2s.7 3.2-1.2 5.3C10.6 9.2 8 10.4 8 14a4.5 4.5 0 0 0 9 0c0-1.6-.7-2.8-1.4-3.7-.2 1.2-.9 1.9-1.6 2.2.5-2.6-.3-5.5-.5-10.5zM12 22a7 7 0 0 1-7-7c0-3.3 1.8-5.1 3.4-6.6-.2 1.5.1 2.7.9 3.4A5.5 5.5 0 0 0 11 4.2c3 1.2 8 4.5 8 10.8a7 7 0 0 1-7 7z"/></svg> ${plural(streak, 'day')} streak</span>
            <a class="btn btn-sm btn-ghost" href="#/levels/${level}">See level ${level} →</a>
          </div>
        </div>
      </div>

      <div class="big-buttons">
        <a class="big-btn big-btn-reviews ${dueNow ? '' : 'is-empty'}" href="#/reviews">
          <span class="big-btn-label">Encounters</span>
          <span class="big-btn-count">${dueNow}</span>
          <span class="big-btn-sub">${esc(reviewSub)}</span>
          <span class="big-btn-glyph" aria-hidden="true">遭</span>
        </a>
        <a class="big-btn big-btn-lessons ${lessons.length ? '' : 'is-empty'}" href="#/lessons">
          <span class="big-btn-label">New sightings</span>
          <span class="big-btn-count">${lessons.length}</span>
          <span class="big-btn-sub">${esc(lessonSub)}</span>
          <span class="big-btn-glyph" aria-hidden="true">発</span>
        </a>
      </div>

      <div class="grid-2">
        <div class="card">
          <h2>Today <span class="muted">${esc(fmtDate(t))}</span></h2>
          <div class="stat-row">
            <div class="stat"><div class="stat-value">${today.reviews}</div><div class="stat-label">Encounters</div></div>
            <div class="stat"><div class="stat-value">${today.reviews ? pct(today.correct / today.reviews) : '—'}</div><div class="stat-label">Accuracy</div></div>
            <div class="stat"><div class="stat-value">${today.lessons}<span class="muted" style="font-size:.9rem">/${p.settings.dailyLessons}</span></div><div class="stat-label">Sightings</div></div>
          </div>
          <p class="small muted" style="margin:12px 0 0">${nextAt ? `Next encounter ${esc(whenPhrase(nextAt, t))} (${relPhrase(nextAt, t)}).` : (dueNow ? 'Wild kanji are waiting for you.' : 'Nothing due — go sight some new kanji.')}</p>
          <p class="small muted" style="margin:6px 0 0">Pace: <strong>${esc(p.settings.dailyLessons)}</strong> new sightings a day · <a href="#/settings">change</a> · <a href="#/scan">catch from a photo</a></p>
        </div>
        <div class="card">
          <h2>Next 24 hours <span class="muted">${plural(upcoming, 'encounter')}</span></h2>
          ${bars(fc.hours, hourLabels)}
        </div>
      </div>

      <div class="card">
        <h2>Stages <span class="muted">${Object.keys(p.items).length} started · ${groups.locked} locked</span></h2>
        <div class="group-counts">
          ${srs.GROUPS.map((g) => `<a class="group-count stage-${g}" href="#/stats" title="${esc(g)}"><div class="n">${groups[g]}</div><div class="l">${esc(g)}</div></a>`).join('')}
        </div>
      </div>

      ${leechList.length ? `<div class="card"><h2>Leeches <span class="muted">${plural(leechList.length, 'item')} you keep missing</span></h2>
        <div style="margin-bottom:12px">${chipList(leechList.map((l) => l.id))}</div>
        <div class="btn-row"><a class="btn btn-sm btn-primary" href="#/drill/leeches">Drill leeches</a><a class="btn btn-sm btn-ghost" href="#/stats">Details</a></div></div>` : ''}
      ${mistakes.length ? `<div class="card"><h2>Got away recently</h2>${chipList(mistakes)}</div>` : ''}

      ${!Object.keys(p.items).length ? `
        <div class="card about">
          <h2>Welcome, trainer</h2>
          <p>There are <strong>2,136 kanji</strong> out there and your dex is empty. Sight new ones in lessons, meet them again in encounters at growing intervals (4 h, 8 h, a day, two days, a week…) until each one is burned into memory, and catch the ones you spot in the wild with the camera.</p>
          <p>Answers are typed in English. Small typos are forgiven; a completely different kanji's meaning is not. Keep an eye out: one encounter in sixty-four is <span class="shiny-badge">✦ shiny</span>.</p>
          <div class="btn-row"><a class="btn btn-primary" href="#/lessons">First sightings</a><a class="btn" href="#/settings">Adjust the pace</a></div>
        </div>` : ''}
    </section>`;
  animateRings(main);
}

// --- Lessons ---------------------------------------------------------------

function renderLessons() {
  const t = now();
  const p = app.progress;
  const data = app.data;

  // Start a new batch when none is in flight.
  if (!app.lesson || app.lesson.phase === 'done') {
    const queue = engine.lessonQueue(data, p, t);
    if (!queue.length) {
      const reason = engine.lessonBlockReason(data, p, t);
      const nextAt = engine.nextReviewAt(p, t);
      const body = reason === 'apprentice-cap'
        ? `You have ${engine.apprenticeCount(p)} items in Apprentice, which is your cap of ${p.settings.apprenticeCap}. Clear some reviews first — new lessons unlock as items reach Guru.`
        : reason === 'daily-cap'
          ? `You've done ${engine.lessonsDoneToday(p, t)} lessons today. More tomorrow${nextAt ? `, and reviews are ${esc(whenPhrase(nextAt, t))}` : ''}.`
          : reason === 'nothing-unlocked'
            ? 'Every unlocked item has been started. New items unlock as their parts reach the unlock stage.'
            : 'No lessons right now.';
      main.innerHTML = `<section class="screen lesson">${emptyState('学', 'No lessons right now', body,
        `<div class="btn-row" style="justify-content:center"><a class="btn btn-primary" href="#/reviews">Go to reviews</a><a class="btn" href="#/settings">Change the pace</a></div>`)}</section>`;
      return;
    }
    const batch = queue.slice(0, Math.max(1, p.settings.lessonBatch));
    app.lesson = { ids: batch, index: 0, phase: 'cards', peek: null, quiz: null, remainingAfter: queue.length - batch.length };
  }

  const L = app.lesson;
  if (L.phase === 'cards') renderLessonCard(L);
  else if (L.phase === 'quiz') renderLessonQuiz(L);
}

function lessonDots(L, quizActive) {
  return `<div class="lesson-dots">
    ${L.ids.map((_, i) => `<span ${quizActive ? '' : `data-dot="${i}" role="button" tabindex="0" title="Card ${i + 1}"`} class="${i < L.index || quizActive ? 'is-done' : ''} ${i === L.index && !quizActive ? 'is-current' : ''}"></span>`).join('')}
    <span class="is-quiz ${quizActive ? 'is-current' : ''}"></span>
  </div>`;
}

/** Horizontal swipe detection on touch screens. cb('left'|'right'). */
function attachSwipe(el, cb) {
  let x0 = null, y0 = null, t0 = 0;
  el.addEventListener('touchstart', (e) => { const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    if (Date.now() - t0 > 800) return;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    cb(dx < 0 ? 'left' : 'right');
  }, { passive: true });
}

function renderLessonCard(L) {
  const id = L.ids[L.index];
  const item = itemOf(id);
  const isLast = L.index === L.ids.length - 1;
  const alt = Array.isArray(item.alt) ? item.alt : [];
  const peek = L.peek ? itemOf(L.peek) : null;

  main.innerHTML = `
    <section class="screen lesson">
      <div class="screen-head"><h1>Lesson ${L.index + 1} of ${L.ids.length}</h1><span class="muted small"><kbd>←</kbd> <kbd>→</kbd> to move · <kbd>Enter</kbd> for next · swipe on a phone</span></div>
      ${lessonDots(L, false)}
      <div class="card glyph-card lesson-card type-${esc(item.type)} fade-in" data-role="card">
        <div class="glyph-type">${typeBadge(item)} <span class="badge stage-locked">New</span></div>
        <div class="glyph">${esc(item.char)}</div>
        <div class="lesson-name">${esc(item.name)}</div>
        ${alt.length ? `<div class="lesson-alt">also: ${esc(alt.join(', '))}</div>` : ''}
        <div class="lesson-facts">
          ${item.strokes ? `<span class="pill">${plural(item.strokes, 'stroke')}</span>` : ''}
          ${item.grade ? `<span class="pill">Grade ${esc(item.grade)}</span>` : ''}
          ${item.jlpt ? `<span class="pill">JLPT N${esc(item.jlpt)}</span>` : ''}
          ${item.freq ? `${rarityBadge(item)} <span class="pill">Frequency #${esc(item.freq)}</span>` : ''}
          <span class="pill">Level ${esc(item.level)}</span>
        </div>

        <div class="lesson-body">
          ${item.type === 'radical' && item.note ? `<div class="section-label">About</div><p class="muted">${esc(item.note)}</p>` : ''}
          ${item.parts && item.parts.length ? `
            <div class="section-label">Parts <span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">(tap to peek)</span></div>
            <div class="chips">${item.parts.map((pid) => {
              const part = itemOf(pid);
              return part ? `<button class="chip type-${esc(part.type)}" data-peek="${esc(pid)}" type="button"><span class="chip-glyph">${esc(part.char)}</span>${esc(part.name)}</button>` : '';
            }).join('')}</div>
            ${peek ? `<div class="peek fade-in"><span class="peek-glyph">${esc(peek.char)}</span><div><div class="peek-name">${esc(peek.name)} <span class="muted small">· ${typeLabel(peek)}</span></div><div class="small muted">${esc(peek.mnemonic || peek.note || '')}</div></div><a class="btn btn-sm btn-ghost" href="${itemHref(peek.id)}">Open</a></div>` : ''}` : ''}
          <div class="section-label">Mnemonic</div>
          ${mnemonicBlock(item, app.progress.notes[id])}
          ${item.type === 'kanji' && item.examples && item.examples.length ? `<div class="section-label">Examples</div>${examplesList(item)}` : ''}
          ${item.type === 'radical' && item.used_in && item.used_in.length ? `<div class="section-label">Used in</div>${chipList(item.used_in.slice(0, 10))}` : ''}
        </div>
      </div>
      <div class="lesson-nav">
        <button class="btn" data-act="prev" ${L.index === 0 ? 'disabled' : ''}>← Previous</button>
        <a class="btn btn-ghost btn-sm" href="${itemHref(id)}">Item page</a>
        <button class="btn btn-primary" data-act="next">${isLast ? 'Start quiz' : 'Next →'}</button>
      </div>
    </section>`;

  const go = (delta) => {
    const i = L.index + delta;
    if (i < 0) return;
    if (i >= L.ids.length) { startLessonQuiz(L); return; }
    L.index = i; L.peek = null; renderLessonCard(L);
  };
  $('[data-act="prev"]', main).addEventListener('click', () => go(-1));
  $('[data-act="next"]', main).addEventListener('click', () => go(1));
  // Swipe left for the next card, right for the previous one; tap a dot to jump.
  attachSwipe($('.lesson', main) || main, (dir) => { if (dir === 'left' && L.index < L.ids.length - 1) go(1); else if (dir === 'right') go(-1); });
  $$('[data-dot]', main).forEach((d) => d.addEventListener('click', () => { L.index = Number(d.dataset.dot); L.peek = null; renderLessonCard(L); }));
  $$('[data-peek]', main).forEach((b) => b.addEventListener('click', () => {
    L.peek = L.peek === b.dataset.peek ? null : b.dataset.peek;
    renderLessonCard(L);
  }));
  app.keyHandler = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    // Enter on a focused button or link activates it natively.
    if (e.key === 'Enter' && e.target && /^(BUTTON|A)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };
  $('[data-act="next"]', main).focus({ preventScroll: true });
}

function startLessonQuiz(L) {
  L.phase = 'quiz';
  L.quiz = engine.createSession(engine.shuffle(L.ids), now());
  renderLessonQuiz(L);
}

function renderLessonQuiz(L) {
  main.innerHTML = `
    <section class="screen lesson">
      <div class="screen-head"><h1>Quiz</h1><span class="muted small">Answer every item once to finish the batch</span></div>
      ${lessonDots(L, true)}
      <div data-role="quiz"></div>
    </section>`;
  const host = $('[data-role="quiz"]', main);
  const view = mountQuiz(host, {
    session: L.quiz,
    lightning: app.progress.settings.lightning,
    affectsSrs: false,
    onSession(s) { L.quiz = s; },
    onCorrect() { /* quiz answers never touch the SRS */ },
    onFinish() {
      view.destroy();
      finishLessonBatch(L);
    },
  });
  app.cleanup = () => view.destroy();
}

function finishLessonBatch(L) {
  let p = app.progress;
  const t = now();
  for (const id of L.ids) p = engine.applyLesson(p, id, t);
  setProgress(p, { immediate: true });
  backupIfNeeded(true);
  L.phase = 'done';
  sfx.lessonDone();
  music.play('celebration');
  confetti(1200);
  const more = engine.lessonQueue(app.data, p, t).length;
  const due = engine.dueCount(p, t);
  const firstDue = engine.nextReviewAt(p, t);
  main.innerHTML = `
    <section class="screen lesson">
      <div class="card session-summary fade-in">
        <div class="big-number">${L.ids.length}</div>
        <h2>${L.ids.length === 1 ? 'new kanji sighted' : 'new kanji sighted'}</h2>
        <p class="muted">They are in your dex at Apprentice 1; the first encounter is ${esc(whenPhrase(firstDue, t) || 'in about 4 hours')}.${L.ids.some((id) => ['epic', 'legendary'].includes(game.rarityOf(itemOf(id)).key)) ? ' A rare one among them!' : ''}</p>
        <div style="margin:16px 0">${chipList(L.ids)}</div>
        <div class="btn-row" style="justify-content:center">
          ${more ? `<button class="btn btn-primary" data-act="more">Next batch (${Math.min(more, app.progress.settings.lessonBatch)})</button>` : ''}
          ${due ? `<a class="btn ${more ? '' : 'btn-primary'}" href="#/reviews">Reviews (${due})</a>` : ''}
          <a class="btn btn-ghost" href="#/">Home</a>
        </div>
      </div>
    </section>`;
  const moreBtn = $('[data-act="more"]', main);
  if (moreBtn) { moreBtn.addEventListener('click', () => { app.lesson = null; music.play('sighting'); renderLessons(); }); moreBtn.focus(); }
  app.keyHandler = (e) => { if (e.key === 'Enter' && moreBtn) { e.preventDefault(); moreBtn.click(); } };
}

// --- Reviews ---------------------------------------------------------------

function renderReviews() {
  const t = now();
  const p = app.progress;

  // Resume an unfinished session or build a new one.
  if (!app.session || !app.session.queue.length) {
    app.session = null;
    const queue = engine.reviewQueue(app.data, p, t);
    if (!queue.length) {
      const nextAt = engine.nextReviewAt(p, t);
      const lessons = engine.lessonQueue(app.data, p, t).length;
      const body = nextAt
        ? `Next batch ${esc(whenPhrase(nextAt, t))} (${relPhrase(nextAt, t)}).`
        : (Object.keys(p.items).length ? 'Nothing is scheduled. Everything you know is burned or resting.' : 'Do a few lessons first; reviews will appear four hours later.');
      main.innerHTML = `<section class="screen review">${emptyState('休', 'No reviews right now', body,
        `<div class="btn-row" style="justify-content:center">${lessons ? `<a class="btn btn-primary" href="#/lessons">Lessons (${lessons})</a>` : ''}<a class="btn" href="#/">Home</a></div>`)}</section>`;
      return;
    }
    app.session = engine.createSession(queue, t);
    store.saveSession(app.session);
  }

  main.innerHTML = '<section class="screen" data-role="quiz"></section>';
  const host = $('[data-role="quiz"]', main);
  const view = mountQuiz(host, {
    session: app.session,
    lightning: p.settings.lightning,
    affectsSrs: true,
    onSession(s) { app.session = s; store.saveSession(s); },
    onCorrect(id, wrong) {
      const before = engine.stageOf(app.progress, id);
      setProgress(engine.applyReview(app.progress, id, wrong, now()));
      const after = engine.stageOf(app.progress, id);
      if (after >= 9 && before < 9) { setTimeout(() => sfx.burned(), 260); setTimeout(() => toast(`${itemOf(id).char} burned — a gold stamp in your dex`, 'ok'), 300); }
      else if (srs.groupOf(after) !== srs.groupOf(before) && after > before) { setTimeout(() => showEvolution(id, before, after), 420); }
    },
    onWrapUp() { /* session already saved via onSession */ },
    onFinish(s) {
      view.destroy();
      finishReviewSession(s);
    },
  });
  app.cleanup = () => view.destroy();
}

function finishReviewSession(s) {
  app.session = null;
  store.clearSession();
  store.flush();
  backupIfNeeded(true);
  const stats = engine.sessionStats(s);
  if (stats.done) { sfx.complete(); music.play('celebration'); if (stats.accuracy >= 0.8) confetti(); }
  const missed = s.done.filter((d) => d.wrong > 0).map((d) => d.id);
  const t = now();
  const nextAt = engine.nextReviewAt(app.progress, t);
  const lessons = engine.lessonQueue(app.data, app.progress, t).length;
  main.innerHTML = `
    <section class="screen review">
      <div class="card session-summary fade-in">
        <div class="big-number">${stats.done ? pct(stats.accuracy) : '—'}</div>
        <h2>${stats.done ? `${stats.firstTry} of ${plural(stats.done, 'encounter')} caught first time` : 'Session ended'}</h2>
        <p class="muted">${nextAt ? `Next review ${esc(whenPhrase(nextAt, t))}.` : 'Nothing else is scheduled right now.'}</p>
        ${missed.length ? `<div class="section-label" style="text-align:left">Got away this session</div><div style="text-align:left">${chipList(missed)}</div>` : ''}
        <div class="btn-row" style="justify-content:center;margin-top:16px">
          ${lessons ? `<a class="btn btn-primary" href="#/lessons">Lessons (${lessons})</a>` : ''}
          <a class="btn ${lessons ? '' : 'btn-primary'}" href="#/">Home</a>
        </div>
      </div>
    </section>`;
  const primary = $('.btn-primary', main);
  if (primary) primary.focus();
}

// --- Item page -------------------------------------------------------------

function renderItem(id) {
  const item = itemOf(id);
  if (!item) { renderNotFound(`No item called "${esc(id)}".`); return; }
  const p = app.progress;
  const entry = p.items[id] || null;
  const stage = entry ? entry.stage : 0;
  const t = now();
  const syn = p.synonyms[id] || [];
  const note = p.notes[id] || '';
  const unlocked = engine.isUnlocked(item, p, p.settings.unlockStage);
  const isLeech = engine.leeches(p).some((l) => l.id === id);
  const alt = Array.isArray(item.alt) ? item.alt : [];
  const total = entry ? entry.correct + entry.incorrect : 0;

  const dueText = !entry ? 'Not started'
    : stage === 9 ? 'Never — burned'
      : entry.due ? (srs.toMillis(entry.due) <= t.getTime() ? `Due now (${fmtDateTime(entry.due)})` : `${fmtDateTime(entry.due)} (${relPhrase(entry.due, t)})`) : '—';

  main.innerHTML = `
    <section class="screen stack item-page">
      <div class="card">
        <div class="item-head">
          <div class="glyph${entry && entry.shiny ? ' is-shiny' : ''}">${esc(item.char)}</div>
          <div class="item-title">
            <div class="btn-row" style="margin-bottom:6px"><span class="dexno">${esc(game.dexNo(dexNumberOf(id)))}</span> ${typeBadge(item)} ${rarityBadge(item)} ${stageBadge(stage)} ${entry && entry.shiny ? '<span class="shiny-badge">✦ Shiny</span>' : ''}${!entry && !unlocked ? '<span class="badge stage-locked">Unseen</span>' : ''}${isLeech ? '<span class="badge leech" title="Missed repeatedly — try rewriting the mnemonic in your own words">Leech</span>' : ''}</div>
            <h1>${esc(item.name)}</h1>
            ${alt.length ? `<p class="muted">also: ${esc(alt.join(', '))}</p>` : ''}
            <div class="item-facts">
              <a class="pill" href="#/levels/${esc(item.level)}">Level ${esc(item.level)}</a>
              ${item.strokes ? `<span class="pill" title="Stroke count">Power ${esc(item.strokes)}</span>` : ''}
              ${item.grade ? `<span class="pill">Grade ${esc(item.grade)}</span>` : ''}
              ${item.jlpt ? `<span class="pill">JLPT N${esc(item.jlpt)}</span>` : ''}
              ${item.freq ? `${rarityBadge(item)} <span class="pill">Frequency #${esc(item.freq)}</span>` : ''}
            </div>
            ${!entry ? `<div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" type="button" data-act="start-now">Already know it — mark caught</button></div>` : ''}
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h2>Progress</h2>
          <dl class="kv">
            <dt>Stage</dt><dd>${esc(srs.stageName(stage))}</dd>
            <dt>Next review</dt><dd>${esc(dueText)}</dd>
            <dt>Started</dt><dd>${entry && entry.startedAt ? esc(fmtDate(entry.startedAt)) : '—'}</dd>
            <dt>Guru</dt><dd>${entry && entry.guruAt ? esc(fmtDate(entry.guruAt)) : '—'}</dd>
            <dt>Burned</dt><dd>${entry && entry.burnedAt ? esc(fmtDate(entry.burnedAt)) : '—'}</dd>
            <dt>Reviews</dt><dd>${entry ? `${total} · ${entry.correct} correct, ${entry.incorrect} wrong${total ? ` (${pct(entry.correct / total)})` : ''}` : '—'}</dd>
          </dl>
        </div>
        <div class="card">
          <h2>Your synonyms <span class="muted">accepted as answers</span></h2>
          <div class="chips" data-role="synonyms">
            ${syn.length ? syn.map((s) => `<span class="chip">${esc(s)}<button class="chip-remove" data-remove-syn="${esc(s)}" aria-label="Remove synonym ${esc(s)}" title="Remove">×</button></span>`).join('') : '<span class="muted small">None yet</span>'}
          </div>
          <form class="synonym-form" data-role="syn-form">
            <label class="sr-only" for="syn-input">New synonym</label>
            <input type="text" id="syn-input" placeholder="Add a meaning you prefer…" autocomplete="off">
            <button class="btn btn-sm" type="submit">Add</button>
          </form>
        </div>
      </div>

      <div class="card">
        <h2>Mnemonic</h2>
        ${mnemonicBlock(item, '')}
        ${item.type === 'radical' && item.note ? `<p class="muted small" style="margin-top:8px">${esc(item.note)}</p>` : ''}
        <div class="section-label">Your note</div>
        ${isLeech ? '<p class="small muted" style="margin:0 0 8px">This one keeps slipping. Rewrite the mnemonic here in your own words, with a picture that is vivid to you; then run a <a href="#/drill/leeches">leech drill</a>.</p>' : ''}
        <textarea data-role="note" placeholder="Write your own mnemonic or reminder…" aria-label="Your note">${esc(note)}</textarea>
        <div class="small muted" data-role="note-status" style="margin-top:4px">Saved automatically.</div>
      </div>

      <div class="grid-2">
        <div class="card"><h2>Parts</h2>${chipList(item.parts || [])}</div>
        <div class="card"><h2>Used in <span class="muted">${(item.used_in || []).length}</span></h2>${chipList((item.used_in || []).slice(0, 40))}</div>
      </div>

      ${item.examples && item.examples.length ? `<div class="card"><h2>Examples</h2>${examplesList(item)}</div>` : ''}
    </section>`;

  // Synonyms
  $('[data-role="syn-form"]', main).addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#syn-input', main);
    const value = input.value.trim();
    if (!value) return;
    const list = (app.progress.synonyms[id] || []).slice();
    if (list.some((s) => normalise(s) === normalise(value))) { toast('Already a synonym'); input.value = ''; return; }
    list.push(value);
    setProgress(Object.assign({}, app.progress, { synonyms: Object.assign({}, app.progress.synonyms, { [id]: list }) }));
    renderItem(id);
    $('#syn-input', main).focus();
  });
  $$('[data-remove-syn]', main).forEach((b) => b.addEventListener('click', () => {
    const list = (app.progress.synonyms[id] || []).filter((s) => s !== b.dataset.removeSyn);
    const synonyms = Object.assign({}, app.progress.synonyms);
    if (list.length) synonyms[id] = list; else delete synonyms[id];
    setProgress(Object.assign({}, app.progress, { synonyms }));
    renderItem(id);
  }));

  // Note (debounced through store.save)
  const noteEl = $('[data-role="note"]', main);
  const statusEl = $('[data-role="note-status"]', main);
  noteEl.addEventListener('input', () => {
    const notes = Object.assign({}, app.progress.notes);
    const value = noteEl.value;
    if (value.trim()) notes[id] = value; else delete notes[id];
    setProgress(Object.assign({}, app.progress, { notes }));
    statusEl.textContent = 'Saving…';
    setTimeout(() => { statusEl.textContent = 'Saved.'; }, 600);
  });
  wireStartNow(id);
}

// --- Levels ----------------------------------------------------------------

function wireStartNow(id) {
  const btn = $('[data-act="start-now"]', main);
  if (!btn) return;
  btn.addEventListener('click', () => {
    setProgress(engine.startManually(app.progress, [id], now()), { immediate: true });
    toast('Caught — it is in your encounters now', 'ok');
    renderItem(id);
  });
}

function renderLevels() {
  const p = app.progress;
  const data = app.data;
  const current = engine.currentLevel(data, p);
  const cards = data.levels.map((lv) => {
    const lp = engine.levelProgress(data, p, lv.level);
    const locked = lv.level > current && lp.started === 0;
    return `<a class="level-card ${lv.level === current ? 'is-current' : ''} ${locked ? 'is-locked' : ''}" href="#/levels/${lv.level}">
      <span class="level-num">Level ${lv.level}</span>
      <span class="level-meta">${lp.guru}/${lp.total} guru${lp.started ? ` · ${lp.started} started` : ''}</span>
      <span class="level-bar"><div style="width:${lp.ratio * 100}%"></div></span>
    </a>`;
  }).join('');

  main.innerHTML = `
    <section class="screen stack">
      <div class="screen-head"><h1>Levels</h1><span class="muted small">${data.levels.length} levels · ${Object.keys(data.items).length} items</span></div>
      <div class="card search">
        <label class="sr-only" for="search">Search items</label>
        <input type="text" id="search" placeholder="Search by kanji or meaning…" autocomplete="off">
        <ul class="search-results" data-role="results"></ul>
      </div>
      <div class="levels-grid">${cards}</div>
    </section>`;

  const input = $('#search', main);
  const results = $('[data-role="results"]', main);
  input.addEventListener('input', () => {
    const q = normalise(input.value);
    if (!q) { results.innerHTML = ''; return; }
    const hits = [];
    for (const id in data.items) {
      const it = data.items[id];
      const hay = [it.char, it.name].concat(it.alt || []).concat(p.synonyms[id] || []).map(normalise);
      const score = hay[0] === q || hay[1] === q ? 0 : hay.some((h) => h === q) ? 1 : hay.some((h) => h.startsWith(q)) ? 2 : hay.some((h) => h.includes(q)) ? 3 : -1;
      if (score >= 0) hits.push({ it, score });
      if (hits.length > 200) break;
    }
    hits.sort((a, b) => a.score - b.score || a.it.level - b.it.level || a.it.pos - b.it.pos);
    results.innerHTML = hits.slice(0, 12).map(({ it }) => `
      <li><a href="${itemHref(it.id)}"><span class="r-glyph">${esc(it.char)}</span><span class="r-name">${esc(it.name)}</span>
      <span class="r-meta">${typeLabel(it)} · Lv ${esc(it.level)} · ${esc(srs.stageName(engine.stageOf(p, it.id)))}</span></a></li>`).join('')
      || '<li class="muted small" style="padding:8px 10px">No matches</li>';
  });
}

function renderLevel(n) {
  const data = app.data;
  const p = app.progress;
  const lv = data.levels.find((l) => l.level === n);
  if (!lv) { renderNotFound(`There is no level ${esc(n)}.`); return; }
  const lp = engine.levelProgress(data, p, n);
  const prev = data.levels.find((l) => l.level === n - 1);
  const next = data.levels.find((l) => l.level === n + 1);
  const t = now();

  const tiles = lv.items.map((id) => {
    const it = itemOf(id);
    if (!it) return '';
    const stage = engine.stageOf(p, id);
    const entry = p.items[id];
    const dueSoon = entry && entry.due && stage < 9 && srs.toMillis(entry.due) <= t.getTime();
    return `<a class="tile stage-${srs.groupOf(stage)} st-${stage} type-${esc(it.type)}${entry && entry.shiny ? ' is-shiny' : ''}" href="${itemHref(id)}" ${entry && entry.shiny ? `style="--d:${(game.hash32(id) % 24) / 8}s"` : ''}
      title="${esc(it.name)} · ${esc(srs.stageName(stage))}${dueSoon ? ' · due now' : ''}">
      <span class="tile-mark" aria-hidden="true"></span>${esc(it.char)}<span class="tile-name">${esc(it.name)}</span></a>`;
  }).join('');

  main.innerHTML = `
    <section class="screen stack">
      <div class="screen-head">
        <h1>Level ${n}</h1>
        <div class="btn-row">
          ${prev ? `<a class="btn btn-sm" href="#/levels/${prev.level}">← ${prev.level}</a>` : ''}
          <a class="btn btn-sm btn-ghost" href="#/levels">All levels</a>
          ${next ? `<a class="btn btn-sm" href="#/levels/${next.level}">${next.level} →</a>` : ''}
        </div>
      </div>
      <div class="card">
        <h2>Progress <span class="muted">${lp.guru} of ${lp.total} at Guru · ${pct(lp.ratio)}</span></h2>
        <div class="level-bar"><div style="width:${lp.ratio * 100}%"></div></div>
        <div class="legend" style="margin-top:12px">
          <span><i class="dot stage-locked"></i> Locked</span><span><i class="dot stage-apprentice"></i> Apprentice</span>
          <span><i class="dot stage-guru"></i> Guru</span><span><i class="dot stage-master"></i> Master</span>
          <span><i class="dot stage-enlightened"></i> Enlightened</span><span><i class="dot stage-burned"></i> Burned</span>
          <span><i class="dot" style="background:var(--radical)"></i> radical</span><span><i class="dot" style="background:var(--kanji)"></i> kanji</span>
        </div>
      </div>
      <div class="tiles">${tiles}</div>
    </section>`;
  app.keyHandler = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft' && prev) location.hash = `#/levels/${prev.level}`;
    if (e.key === 'ArrowRight' && next) location.hash = `#/levels/${next.level}`;
  };
}

// --- Stats -----------------------------------------------------------------

/* ---------- Grid: every item as one small box, coloured by SRS stage ---------- */

const GRID_PREFS_KEY = 'kanjr.gridPrefs';

function gridPrefs() {
  try { return Object.assign({ kanjiOnly: true, byLevel: false, reveal: false }, JSON.parse(localStorage.getItem(GRID_PREFS_KEY) || '{}')); }
  catch (_) { return { kanjiOnly: true, byLevel: false, reveal: false }; }
}

function saveGridPrefs(prefs) {
  try { localStorage.setItem(GRID_PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* fine */ }
}

/** Selection state for "add kanji you already know" on the Grid. */
const gridSelect = { active: false, ids: new Set() };

function renderGrid() {
  const data = app.data;
  const p = app.progress;
  const prefs = gridPrefs();
  const t = now().getTime();
  const selecting = gridSelect.active;

  const counts = { locked: 0, apprentice: 0, guru: 0, master: 0, enlightened: 0, burned: 0 };
  let total = 0;
  const cells = [];
  for (const lv of data.levels) {
    const ids = lv.items.filter((id) => !prefs.kanjiOnly || data.items[id].type === 'kanji');
    if (!ids.length) continue;
    if (prefs.byLevel) cells.push(`<a class="kgrid-level" href="#/levels/${lv.level}" title="Level ${lv.level}">${lv.level}</a>`);
    for (const id of ids) {
      const it = data.items[id];
      const stage = engine.stageOf(p, id);
      const group = srs.groupOf(stage);
      counts[group] += 1;
      total += 1;
      const entry = p.items[id];
      const due = entry && entry.due && stage > 0 && stage < 9 && srs.toMillis(entry.due) <= t;
      const selectable = selecting && stage === 0;
      const selected = selectable && gridSelect.ids.has(id);
      const hidden = stage === 0 && !prefs.reveal && !selecting;
      const entry2 = p.items[id];
      cells.push(`<a class="kcell stage-${group} st-${stage}${due ? ' is-due' : ''}${it.type === 'radical' ? ' type-radical' : ''}${selectable ? ' is-selectable' : ''}${selected ? ' is-selected' : ''}${selecting && !selectable ? ' is-dim' : ''}${hidden ? ' is-unseen' : ''}${entry2 && entry2.shiny ? ' is-shiny' : ''}"
        href="${itemHref(id)}" data-id="${esc(id)}" ${entry2 && entry2.shiny ? `style="--d:${(game.hash32(id) % 24) / 8}s"` : ''} ${selectable ? 'role="checkbox" aria-checked="' + selected + '"' : ''}
        title="${hidden ? `Unseen · ${game.dexNo(dexNumberOf(id))} · Lv ${lv.level}` : `${esc(it.char)} · ${esc(it.name)} · ${esc(srs.stageName(stage))}${entry2 && entry2.shiny ? ' · shiny' : ''}${due ? ' · due now' : ''} · Lv ${lv.level}`}">${hidden ? '' : esc(it.char)}</a>`);
    }
  }
  const learned = total - counts.locked;
  const SUBSTAGES = { apprentice: [1, 2, 3, 4], guru: [5, 6], master: [7], enlightened: [8], burned: [9], locked: [0] };
  const legend = ['locked', 'apprentice', 'guru', 'master', 'enlightened', 'burned'].map((g) =>
    `<span class="kgrid-key" title="${SUBSTAGES[g].map((n) => srs.stageName(n)).join(' → ')}">${SUBSTAGES[g].map((n) => `<i class="dot stage-${g} st-${n}"></i>`).join('')}${g === 'locked' ? 'Unseen' : g[0].toUpperCase() + g.slice(1)} <b>${counts[g]}</b></span>`).join('');

  main.innerHTML = `
    <section class="screen stack">
      <div class="screen-head">
        <h1>Kanjidex</h1>
        <span class="muted small">${learned} of ${total} ${prefs.kanjiOnly ? 'kanji' : 'items'} caught · ${pct(total ? learned / total : 0)}${shinyCount() ? ` · ✦ ${shinyCount()} shiny` : ''} · <a href="#/levels">levels</a></span>
      </div>
      <div class="card kgrid-controls">
        <div class="legend">${legend}</div>
        <div class="kgrid-toggles">
          <label class="kgrid-toggle"><span class="switch"><input type="checkbox" data-pref="kanjiOnly" ${prefs.kanjiOnly ? 'checked' : ''}><span class="track"></span></span>Kanji only</label>
          <label class="kgrid-toggle"><span class="switch"><input type="checkbox" data-pref="byLevel" ${prefs.byLevel ? 'checked' : ''}><span class="track"></span></span>Level numbers</label>
          <label class="kgrid-toggle"><span class="switch"><input type="checkbox" data-pref="reveal" ${prefs.reveal ? 'checked' : ''}><span class="track"></span></span>Reveal unseen</label>
        </div>
      </div>
      <div class="kgrid-bar" aria-hidden="true">
        ${['burned', 'enlightened', 'master', 'guru', 'apprentice'].map((g) => `<i class="stage-${g}" style="width:${total ? (counts[g] / total) * 100 : 0}%"></i>`).join('')}
      </div>
      ${selecting ? `
      <div class="card kgrid-select fade-in">
        <div class="kgrid-select-head">
          <div>
            <h2>Mark kanji you already know as caught</h2>
            <p class="muted small">Click boxes, drag across them, shift-click a range, click a level number to take the whole level, or type the kanji below. Right-click any box for a quick menu. Marked kanji go straight into your reviews at Apprentice 1, do not use today's lesson allowance, and do not count against the apprentice cap. Lessons carry on from the remaining kanji in order.</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-act="cancel-select">Cancel</button>
        </div>
        <div class="kgrid-select-row">
          <label class="sr-only" for="kgrid-paste">Type or paste kanji</label>
          <input type="text" id="kgrid-paste" class="jp" placeholder="Type or paste kanji, e.g. 日本人" autocomplete="off" spellcheck="false">
          <span class="muted small" data-role="paste-note"></span>
        </div>
      </div>` : `
      <div class="btn-row">
        <button class="btn btn-sm" type="button" data-act="start-select">Already know some? Mark them caught</button>
        <a class="btn btn-sm btn-primary" href="#/scan">Catch from a photo</a>
      </div>`}
      <div class="kgrid${prefs.byLevel ? ' is-by-level' : ''}${selecting ? ' is-selecting' : ''}">${cells.join('')}</div>
      ${selecting ? `
      <div class="kgrid-actionbar" role="region" aria-label="Selection">
        <span data-role="sel-count">${gridSelect.ids.size} selected</span>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" type="button" data-act="clear-select" ${gridSelect.ids.size ? '' : 'disabled'}>Clear</button>
          <button class="btn btn-primary" type="button" data-act="confirm-select" ${gridSelect.ids.size ? '' : 'disabled'}>Add to circulation</button>
        </div>
      </div>` : ''}
    </section>`;

  $$('input[data-pref]', main).forEach((box) => box.addEventListener('change', () => {
    const next = gridPrefs();
    next[box.dataset.pref] = box.checked;
    saveGridPrefs(next);
    renderGrid();
  }));

  const startBtn = $('[data-act="start-select"]', main);
  if (startBtn) startBtn.addEventListener('click', () => { gridSelect.active = true; gridSelect.ids.clear(); renderGrid(); $('#kgrid-paste', main).focus(); });
  if (!selecting) return;

  const grid = $('.kgrid', main);
  const countEl = $('[data-role="sel-count"]', main);
  const confirmBtn = $('[data-act="confirm-select"]', main);
  const clearBtn = $('[data-act="clear-select"]', main);
  const paste = $('#kgrid-paste', main);
  const pasteNote = $('[data-role="paste-note"]', main);

  const syncBar = () => {
    const n = gridSelect.ids.size;
    countEl.textContent = `${n} selected`;
    confirmBtn.disabled = !n;
    clearBtn.disabled = !n;
  };
  const setSelected = (id, on) => {
    const cell = grid.querySelector(`.kcell[data-id="${CSS.escape(id)}"]`);
    if (!cell || !cell.classList.contains('is-selectable')) return false;
    if (on) gridSelect.ids.add(id); else gridSelect.ids.delete(id);
    cell.classList.toggle('is-selected', on);
    cell.setAttribute('aria-checked', String(on));
    return true;
  };

  // Click toggles; shift+click selects the range since the last click;
  // press and drag paints a selection; clicking a level number takes the
  // whole level.
  let lastClicked = null;
  const cellsInOrder = () => $$('.kcell.is-selectable', grid);
  const paint = { on: false, value: true, moved: false };
  grid.addEventListener('click', (e) => {
    const lvl = e.target.closest('.kgrid-level');
    if (lvl) {
      e.preventDefault();
      const n = Number(lvl.textContent);
      const ids = Object.keys(data.items).filter((id) => data.items[id].level === n && (!prefs.kanjiOnly || data.items[id].type === 'kanji'));
      const allOn = ids.every((id) => gridSelect.ids.has(id) || engine.stageOf(p, id) > 0);
      for (const id of ids) setSelected(id, !allOn);
      syncBar();
      return;
    }
    const cell = e.target.closest('.kcell');
    if (!cell) return;
    e.preventDefault();
    if (paint.moved) { paint.moved = false; return; }   // a drag already handled it
    if (!cell.classList.contains('is-selectable')) { toast('That kanji is already in circulation.'); return; }
    const id = cell.dataset.id;
    if (e.shiftKey && lastClicked) {
      const all = cellsInOrder();
      const a = all.findIndex((c) => c.dataset.id === lastClicked);
      const b = all.findIndex((c) => c.dataset.id === id);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) setSelected(all[i].dataset.id, true);
        syncBar();
        lastClicked = id;
        return;
      }
    }
    setSelected(id, !gridSelect.ids.has(id));
    lastClicked = id;
    syncBar();
  });
  grid.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.kcell.is-selectable');
    if (!cell || e.button !== 0 || e.pointerType === 'touch') return;
    e.preventDefault();   // no native link drag or text selection while painting
    paint.on = true; paint.moved = false; paint.value = !gridSelect.ids.has(cell.dataset.id);
  });
  grid.addEventListener('dragstart', (e) => e.preventDefault());
  grid.addEventListener('pointerover', (e) => {
    if (!paint.on) return;
    const cell = e.target.closest('.kcell.is-selectable');
    if (!cell) return;
    paint.moved = true;
    setSelected(cell.dataset.id, paint.value);
    syncBar();
  });
  const stopPaint = () => { paint.on = false; };
  window.addEventListener('pointerup', stopPaint);
  window.addEventListener('pointercancel', stopPaint);

  paste.addEventListener('input', () => {
    const chars = Array.from(paste.value).filter((c) => /[\u3400-\u9fff]/.test(c));
    let added = 0, known = 0, missing = 0;
    for (const c of chars) {
      const id = `k:${c}`;
      if (!data.items[id]) { missing += 1; continue; }
      if (engine.stageOf(p, id) > 0) { known += 1; continue; }
      if (!gridSelect.ids.has(id) && setSelected(id, true)) added += 1;
    }
    const bits = [];
    if (added) bits.push(`${added} selected`);
    if (known) bits.push(`${known} already in circulation`);
    if (missing) bits.push(`${missing} not in the jōyō set`);
    pasteNote.textContent = bits.join(' · ');
    if (added) {
      const first = grid.querySelector('.kcell.is-selected');
      if (first) first.scrollIntoView({ block: 'nearest' });
    }
    syncBar();
  });

  $('[data-act="cancel-select"]', main).addEventListener('click', () => { gridSelect.active = false; gridSelect.ids.clear(); renderGrid(); });
  clearBtn.addEventListener('click', () => { for (const id of Array.from(gridSelect.ids)) setSelected(id, false); syncBar(); });
  confirmBtn.addEventListener('click', async () => {
    const ids = Array.from(gridSelect.ids);
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Add ${plural(ids.length, 'kanji', 'kanji')} to circulation?`,
      body: `<div style="margin-bottom:10px">${chipList(ids.slice(0, 40))}${ids.length > 40 ? `<span class="muted small"> and ${ids.length - 40} more</span>` : ''}</div>
             <p class="muted small">They start at Apprentice 1 and are due for review straight away, so you can confirm them now. This does not use today's lesson allowance.</p>`,
      confirmLabel: 'Add to circulation',
    });
    if (!ok) return;
    setProgress(engine.startManually(app.progress, ids, now()), { immediate: true });
    backupIfNeeded(true);
    gridSelect.active = false; gridSelect.ids.clear();
    toast(`${plural(ids.length, 'kanji', 'kanji')} caught — they are in your encounters now`, 'ok');
    renderGrid();
  });
  app.keyHandler = (e) => { if (e.key === 'Escape') { gridSelect.active = false; gridSelect.ids.clear(); renderGrid(); } };
  app.cleanup = () => { gridSelect.active = false; gridSelect.ids.clear(); window.removeEventListener('pointerup', stopPaint); window.removeEventListener('pointercancel', stopPaint); };
}

/** Right-click (or long-press) menu on a grid box. */
function gridContextMenu(cell, x, y) {
  closeContextMenu();
  const id = cell.dataset.id;
  const item = itemOf(id);
  if (!item) return;
  const stage = engine.stageOf(app.progress, id);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu fade-in';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <div class="ctx-title"><span class="jp">${esc(item.char)}</span> ${esc(item.name)} <span class="muted">· ${esc(srs.stageName(stage))}</span></div>
    ${stage === 0 ? `<button type="button" role="menuitem" data-act="add">Already know it — mark caught</button>
    <button type="button" role="menuitem" data-act="select">Select this and more…</button>` : ''}
    <button type="button" role="menuitem" data-act="open">Open item page</button>`;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  menu.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    closeContextMenu();
    if (act.dataset.act === 'add') {
      setProgress(engine.startManually(app.progress, [id], now()), { immediate: true });
      sfx.tap();
      toast(`${item.char} caught — it is in your encounters now`, 'ok');
      renderGrid();
    } else if (act.dataset.act === 'select') {
      gridSelect.active = true; gridSelect.ids.clear(); gridSelect.ids.add(id); renderGrid();
    } else {
      location.hash = itemHref(id);
    }
  });
  app.contextMenu = menu;
  const first = menu.querySelector('button');
  if (first) first.focus();
}

function closeContextMenu() {
  if (app.contextMenu) { app.contextMenu.remove(); app.contextMenu = null; }
}
document.addEventListener('click', (e) => { if (app.contextMenu && !e.target.closest('.ctx-menu')) closeContextMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });
document.addEventListener('contextmenu', (e) => {
  const cell = e.target.closest('.kgrid .kcell');
  if (!cell) return;
  e.preventDefault();
  gridContextMenu(cell, e.clientX, e.clientY);
});
// Long-press on touch devices opens the same menu.
let pressTimer = null;
document.addEventListener('pointerdown', (e) => {
  const cell = e.target.closest('.kgrid .kcell');
  if (!cell || e.pointerType !== 'touch') return;
  pressTimer = setTimeout(() => { pressTimer = null; gridContextMenu(cell, e.clientX, e.clientY); }, 500);
});
['pointerup', 'pointercancel', 'pointermove'].forEach((ev) => document.addEventListener(ev, () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } }));

/* ---------- Intro: the Kanjiland title screen ---------- */

function introScene() {
  const kan = (x, y, ch, size = 26, delay = 0) => `<g class="kan" style="animation-delay:${delay}s"><rect x="${x - size * 0.7}" y="${y - size * 0.7}" width="${size * 1.4}" height="${size * 1.4}" rx="${size * 0.32}" fill="#f7f2e8" stroke="#17130f" stroke-width="2.5"/><text x="${x}" y="${y + size * 0.36}" text-anchor="middle" font-family="'Noto Sans JP','Zen Kaku Gothic New',sans-serif" font-weight="700" font-size="${size}" fill="#d7262a">${ch}</text></g>`;
  return `<svg viewBox="0 0 400 720" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5fb4ea"/><stop offset="1" stop-color="#cdeaf9"/></linearGradient>
      <linearGradient id="hill1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7fce5c"/><stop offset="1" stop-color="#4f9e3c"/></linearGradient>
      <linearGradient id="hill2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9ddc74"/><stop offset="1" stop-color="#5fb04a"/></linearGradient>
      <linearGradient id="hill3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b6e58f"/><stop offset="1" stop-color="#78c25a"/></linearGradient>
    </defs>
    <rect width="400" height="720" fill="url(#sky)"/>
    <circle cx="52" cy="66" r="30" fill="#fff4b3" stroke="#17130f" stroke-width="3"/>
    <g fill="#fff" stroke="#17130f" stroke-width="3" stroke-linejoin="round">
      <path d="M40 214a22 22 0 0 1 30-22 26 26 0 0 1 48-4 20 20 0 0 1 24 26z"/>
      <path d="M262 186a18 18 0 0 1 26-16 22 22 0 0 1 40-2 16 16 0 0 1 18 18z"/>
    </g>
    <path d="M0 356 L150 246 L190 268 L226 236 L400 356z" fill="#6e7f9a" stroke="#17130f" stroke-width="3" stroke-linejoin="round"/>
    <path d="M124 264 L150 246 L190 268 L226 236 L252 256 L236 262 L212 250 L192 280 L150 256 L130 270z" fill="#fff" stroke="#17130f" stroke-width="3" stroke-linejoin="round"/>
    <path d="M0 380 C 80 330, 170 340, 240 372 S 360 400, 400 372 V720 H0z" fill="url(#hill3)" stroke="#17130f" stroke-width="3"/>
    <path d="M0 450 C 90 400, 190 420, 260 452 S 350 480, 400 440 V720 H0z" fill="url(#hill2)" stroke="#17130f" stroke-width="3"/>
    <path d="M0 540 C 70 490, 160 500, 230 540 S 340 580, 400 530 V720 H0z" fill="url(#hill1)" stroke="#17130f" stroke-width="3"/>
    <path d="M150 720 C 170 640, 200 600, 230 560 C 260 520, 300 500, 340 480" fill="none" stroke="#e9d8a6" stroke-width="26" stroke-linecap="round"/>
    <path d="M150 720 C 170 640, 200 600, 230 560 C 260 520, 300 500, 340 480" fill="none" stroke="#17130f" stroke-width="3" stroke-dasharray="8 10" stroke-linecap="round"/>
    <g stroke="#17130f" stroke-width="3" stroke-linejoin="round">
      <rect x="300" y="430" width="10" height="52" fill="#d7262a"/><rect x="346" y="430" width="10" height="52" fill="#d7262a"/>
      <rect x="290" y="426" width="76" height="9" rx="2" fill="#17130f"/><rect x="298" y="444" width="60" height="7" fill="#d7262a"/>
    </g>
    ${kan(70, 470, '木', 24, 0)}${kan(330, 390, '山', 22, 0.8)}${kan(110, 585, '日', 26, 1.4)}${kan(300, 640, '花', 24, 0.4)}${kan(48, 660, '川', 22, 1.9)}${kan(356, 560, '月', 22, 1.1)}
    <g transform="translate(214 500)" >
      <ellipse cx="0" cy="58" rx="30" ry="7" fill="#00000022"/>
      <path d="M-16 8 h32 l8 44 h-48z" fill="#d7262a" stroke="#17130f" stroke-width="3" stroke-linejoin="round"/>
      <rect x="-12" y="14" width="24" height="28" rx="6" fill="#f7f2e8" stroke="#17130f" stroke-width="3"/>
      <path d="M-20 52 h14 l-2 12 h-14z M6 52 h14 l2 12 h-14z" fill="#17130f"/>
      <path d="M-24 14 l-10 24 M24 14 l10 24" stroke="#f0c9a6" stroke-width="8" stroke-linecap="round"/>
      <circle cx="0" cy="-8" r="17" fill="#f0c9a6" stroke="#17130f" stroke-width="3"/>
      <path d="M-18 -10 a18 18 0 0 1 36 0 v6 h-36z" fill="#d7262a" stroke="#17130f" stroke-width="3"/>
      <rect x="-20" y="-6" width="40" height="7" rx="3" fill="#f7f2e8" stroke="#17130f" stroke-width="3"/>
    </g>
  </svg>`;
}

function maybeIntro() {
  let seen = false;
  try { seen = sessionStorage.getItem('kanjr.introSeen') === '1'; } catch (_) { /* fine */ }
  if (seen || app.progress.settings.intro === false) return;
  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Kanjr title screen');
  el.innerHTML = `${introScene()}
    <div class="intro-text">
      <h1><span class="stamp-logo jp">字</span>Kanjr</h1>
      <p>2,136 kanji are out there.<br>Go catch them all.</p>
    </div>
    <div class="intro-cta"><button class="btn btn-primary" type="button">Tap to set off</button></div>`;
  document.body.appendChild(el);
  const leave = () => {
    if (el.classList.contains('is-leaving')) return;
    try { sessionStorage.setItem('kanjr.introSeen', '1'); } catch (_) { /* fine */ }
    unlockAudio();
    music.unlock();
    music.play('overworld');
    sfx.lessonDone();
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 500);
  };
  el.addEventListener('click', leave);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') leave(); });
  el.querySelector('button').focus();
}

/* ---------- Scan: photograph a kanji and add it ---------- */

const scanState = { file: null, result: null, selected: new Set(), busy: false, error: '', progress: null, crop: null, usedCrop: false, box: null, candidates: null, boxSize: 0.28 };

function renderScan() {
  const data = app.data;
  const p = app.progress;
  const known = scanKnownSet();
  const r = scanState.result;
  const tile = ({ char, count, conf }) => {
    const id = `k:${char}`;
    const it = data.items[id];
    const stage = engine.stageOf(p, id);
    const inCirc = stage > 0;
    const sel = scanState.selected.has(id);
    return `<button type="button" class="scan-tile ${inCirc ? 'is-known' : ''} ${sel ? 'is-selected' : ''} ${conf < scan.SURE_CONF ? 'is-unsure' : ''}" data-id="${esc(id)}" ${inCirc ? 'disabled' : ''} aria-pressed="${sel}" title="Confidence ${esc(conf)}%">
      <span class="scan-char jp">${esc(char)}</span>
      <span class="scan-name">${esc(it.name)}</span>
      <span class="scan-meta">${inCirc ? `caught · ${esc(srs.stageName(stage))}` : `${esc(game.rarityOf(it).label)} · Lv ${esc(it.level)}`}${count > 1 ? ` · ${count}×` : ''}</span>
    </button>`;
  };
  const sure = r ? r.kanji.filter((k) => k.conf >= scan.SURE_CONF) : [];
  const unsure = r ? r.kanji.filter((k) => k.conf < scan.SURE_CONF) : [];
  const tiles = sure.map(tile).join('') + (unsure.length ? `<div class="scan-unsure-label">Less sure — check these against the photo</div>${unsure.map(tile).join('')}` : '');
  const selectable = r ? r.kanji.filter(({ char }) => engine.stageOf(p, `k:${char}`) === 0).length : 0;

  main.innerHTML = `
    <section class="screen stack scan">
      <div class="screen-head"><h1>Catch a kanji</h1><a class="btn btn-sm btn-ghost" href="#/grid">Dex</a></div>
      <div class="card">
        <p class="small muted">Snap a sign, a menu or a package, then drag the red square onto one kanji and capture it. You get a handful of best guesses with their meanings; tap the right one to catch it. Everything is recognised on your phone; nothing is uploaded. "Read the whole photo" is there for clean, straight-on shots with several kanji.</p>
        <div class="btn-row" style="margin-top:8px">
          <label class="btn btn-primary" for="scan-file">${scanState.file ? 'Snap another' : 'Snap a photo'}</label>
          <input type="file" id="scan-file" accept="image/*" capture="environment" class="sr-only" tabindex="-1">
          <label class="btn" for="scan-pick">Choose from library</label>
          <input type="file" id="scan-pick" accept="image/*" class="sr-only" tabindex="-1">
        </div>
        ${scanState.busy ? `<div class="scan-progress"><div class="muted small" data-role="scan-label">${esc(scanState.progress ? scanState.progress.label : 'Preparing…')}</div><div class="level-bar"><div data-role="scan-bar" style="width:${scanState.progress ? Math.round(scanState.progress.ratio * 100) : 0}%"></div></div></div>` : ''}
        ${scanState.error ? `<p class="small" style="color:var(--bad);margin-top:10px">${esc(scanState.error)}</p>` : ''}
        <div data-role="scan-preview" class="scan-preview" ${scanState.file ? '' : 'hidden'}></div>
        ${scanState.file && !scanState.busy ? `
        <div class="btn-row" style="margin-top:10px">
          <button class="btn btn-primary" type="button" data-act="capture-one">Capture the kanji in the square</button>
          <button class="btn btn-sm" type="button" data-act="scan-whole">Read the whole photo</button>
        </div>
        ${r && (r.angle || r.vertical) ? `<p class="small muted" style="margin-top:8px">${r.angle ? `Straightened by ${esc(Math.abs(r.angle))}°. ` : ''}${r.vertical ? 'Read as vertical text.' : ''}</p>` : ''}` : ''}
      </div>
      ${scanState.candidates ? `
      <div class="card">
        <h2>Which one is it? <span class="muted">best guesses for the square</span></h2>
        ${scanState.candidates.length ? `<div class="scan-tiles">${scanState.candidates.map((c) => { const id = `k:${c.char}`; const it = data.items[id]; const st = engine.stageOf(p, id); return `
          <button type="button" class="scan-tile ${st > 0 ? 'is-known' : ''}" data-act="pick-candidate" data-id="${esc(id)}" title="Match ${c.score}%${c.source === 'shape' ? ' (by shape)' : ''}">
            <span class="scan-char jp">${esc(c.char)}</span><span class="scan-name">${esc(it.name)}</span>
            <span class="scan-meta">${st > 0 ? `caught · ${esc(srs.stageName(st))}` : `${esc(game.rarityOf(it).label)} · Lv ${esc(it.level)}`}</span></button>`; }).join('')}</div>
        <p class="small muted" style="margin-top:10px">Tap the right one to catch it. Not there? Tighten the square around a single kanji, or type it below.</p>` : '<p class="muted">Nothing readable in the square. Make it a little larger than the kanji, keep it to one character, and try again.</p>'}
      </div>` : ''}
      ${r ? `
      <div class="card">
        <h2>${r.kanji.length ? `${plural(r.kanji.length, 'wild kanji', 'wild kanji')} spotted` : 'Nothing spotted'} <span class="muted">${r.unknown ? `· ${r.unknown} not in the jōyō set` : ''}</span></h2>
        ${r.kanji.length ? `<div class="scan-tiles">${tiles}</div>` : '<p class="muted" data-role="scan-empty">No kanji recognised. Try a closer, straighter, better-lit photo, or type what you see below.</p>'}
        ${selectable ? `<div class="btn-row" style="margin-top:12px">
          <button class="btn btn-sm btn-ghost" type="button" data-act="scan-all">Select all new</button>
          <button class="btn btn-primary" type="button" data-act="scan-add" ${scanState.selected.size ? '' : 'disabled'}>Catch ${scanState.selected.size || ''}</button>
        </div>` : (r.kanji.length ? '<p class="small muted" style="margin-top:8px">Everything spotted is already in your dex.</p>' : '')}
      </div>` : ''}
      <div class="card">
        <h2>Or type what you see</h2>
        <p class="small muted">On an iPhone the Camera app can also read Japanese: tap the Live Text icon in the corner of the viewfinder, select the kanji, copy, and paste here.</p>
        <div class="kgrid-select-row"><input type="text" class="jp" id="scan-typed" placeholder="Paste or type kanji" autocomplete="off" spellcheck="false"><button class="btn btn-sm" type="button" data-act="scan-typed">Show</button></div>
      </div>
    </section>`;

  const preview = $('[data-role="scan-preview"]', main);
  if (scanState.file) {
    const url = URL.createObjectURL(scanState.file);
    preview.innerHTML = `<div class="scan-stage"><img src="${url}" alt="Your photo" draggable="false"><div class="capture-box" data-role="capture-box" hidden><i></i><i></i><i></i><i></i></div></div>
      <div class="capture-controls">
        <label class="small muted">Square size <input type="range" min="10" max="70" value="${Math.round(scanState.boxSize * 100)}" data-role="box-size"></label>
        <span class="small muted">Drag the square onto one kanji, then capture.</span>
      </div>`;
    const img = preview.querySelector('img');
    const stage = preview.querySelector('.scan-stage');
    const box = preview.querySelector('[data-role="capture-box"]');
    const sizeInput = preview.querySelector('[data-role="box-size"]');
    // Box is kept in image pixels: { cx, cy, side } around its centre.
    const ensureBox = () => {
      if (!img.naturalWidth) return;
      if (!scanState.box) {
        const side = Math.round(Math.min(img.naturalWidth, img.naturalHeight) * scanState.boxSize);
        scanState.box = { cx: Math.round(img.naturalWidth / 2), cy: Math.round(img.naturalHeight / 2), side };
      }
    };
    const drawBox = () => {
      ensureBox();
      const b = scanState.box;
      if (!b || !img.clientWidth) { box.hidden = true; return; }
      const k = img.clientWidth / img.naturalWidth;
      box.hidden = false;
      box.style.width = `${b.side * k}px`; box.style.height = `${b.side * k}px`;
      box.style.left = `${(b.cx - b.side / 2) * k}px`; box.style.top = `${(b.cy - b.side / 2) * k}px`;
    };
    img.addEventListener('load', () => { URL.revokeObjectURL(url); drawBox(); });
    if (img.complete) drawBox();
    let drag = null;
    const toImg = (e) => { const r = img.getBoundingClientRect(); const k = img.naturalWidth / r.width; return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }; };
    stage.addEventListener('pointerdown', (e) => {
      if (scanState.busy) return;
      e.preventDefault(); ensureBox();
      const pt = toImg(e);
      drag = { dx: scanState.box.cx - pt.x, dy: scanState.box.cy - pt.y };
      // Tapping away from the box jumps it there.
      if (Math.abs(pt.x - scanState.box.cx) > scanState.box.side || Math.abs(pt.y - scanState.box.cy) > scanState.box.side) {
        const half = scanState.box.side / 2;
        scanState.box.cx = Math.max(half, Math.min(img.naturalWidth - half, pt.x));
        scanState.box.cy = Math.max(half, Math.min(img.naturalHeight - half, pt.y));
        drag = { dx: 0, dy: 0 };
      }
      drawBox();
      try { stage.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pt = toImg(e);
      const half = scanState.box.side / 2;
      scanState.box.cx = Math.max(half, Math.min(img.naturalWidth - half, pt.x + drag.dx));
      scanState.box.cy = Math.max(half, Math.min(img.naturalHeight - half, pt.y + drag.dy));
      drawBox();
    });
    const endDrag = () => { drag = null; };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    sizeInput.addEventListener('input', () => {
      ensureBox();
      scanState.boxSize = Number(sizeInput.value) / 100;
      scanState.box.side = Math.round(Math.min(img.naturalWidth, img.naturalHeight) * scanState.boxSize);
      const half = scanState.box.side / 2;
      scanState.box.cx = Math.max(half, Math.min(img.naturalWidth - half, scanState.box.cx));
      scanState.box.cy = Math.max(half, Math.min(img.naturalHeight - half, scanState.box.cy));
      drawBox();
    });
  }
  const captureOne = async () => {
    const b = scanState.box;
    if (!b || !scanState.file) return;
    const crop = { x: Math.round(b.cx - b.side / 2), y: Math.round(b.cy - b.side / 2), w: b.side, h: b.side };
    scanState.candidates = null; scanState.error = ''; scanState.busy = true; scanState.progress = null; scanState.result = null;
    renderScan();
    try {
      const r = await scan.recognizeSingle(scanState.file, crop, known, (label, ratio) => {
        scanState.progress = { label, ratio };
        const lbl = $('[data-role="scan-label"]', main), bar = $('[data-role="scan-bar"]', main);
        if (lbl) lbl.textContent = label;
        if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
      });
      // Combine three opinions: the reader's confidence, the shape matcher's
      // similarity, and whether the stroke complexity is in the right league.
      let templates = null, q = null;
      try {
        templates = await visual.getTemplates(Array.from(known));
        q = visual.normaliseBitmap(visual.canvasGray(r.canvas), r.canvas.width, r.canvas.height);
      } catch (_) { /* visual matcher unavailable */ }
      const visualTop = q && templates ? visual.rank(q, templates, 6) : [];
      const qComplexity = q ? visual.complexity(q) : 0;
      const pool = new Map();
      for (const c of r.candidates) pool.set(c.char, { char: c.char, ocr: c.conf / 100, vis: 0 });
      for (const v of visualTop) { const e = pool.get(v.char) || { char: v.char, ocr: 0, vis: 0 }; e.vis = v.score; pool.set(v.char, e); }
      const merged = [];
      for (const e of pool.values()) {
        if (q && templates && templates.has(e.char) && !e.vis) e.vis = visual.bestSimilarity(q, templates.get(e.char));
        const visN = Math.max(0, Math.min(1, (e.vis - 0.15) / 0.4));
        const tmpl = templates && templates.get(e.char);
        const cx = tmpl ? visual.complexityMatch(qComplexity, visual.complexity(Array.isArray(tmpl) ? tmpl[0] : tmpl)) : 0.5;
        // A confident reading counts most, unless its stroke complexity is
        // nowhere near what is in the square (a 16-stroke guess for a
        // 3-stroke blob), in which case it is probably noise.
        const ocrW = cx < 0.2 ? 0.35 : 0.7;
        e.score = ocrW * e.ocr + 0.45 * visN + 0.25 * cx;
        e.source = e.ocr * ocrW >= visN * 0.45 ? 'ocr' : 'shape';
        merged.push(e);
      }
      merged.sort((a, b) => b.score - a.score);
      for (const e of merged) e.score = Math.round(e.score * 100);
      scanState.candidates = merged.slice(0, 6);
      window.kanjrScanDebug = { ocr: r.candidates, passes: r.debug && r.debug.passes, visualTop, merged: merged.slice(0, 6) };   // handy in the console when tuning
      sfx.tap();
    } catch (err) {
      scanState.error = err && err.message ? err.message : String(err);
    } finally {
      scanState.busy = false;
      renderScan();
    }
  };
  const capBtn = $('[data-act="capture-one"]', main);
  if (capBtn) capBtn.addEventListener('click', captureOne);
  $$('[data-act="pick-candidate"]', main).forEach((t) => t.addEventListener('click', () => {
    const id = t.dataset.id;
    if (engine.stageOf(app.progress, id) > 0) { toast(`${itemOf(id).char} is already in your dex`); return; }
    setProgress(engine.startManually(app.progress, [id], now()), { immediate: true });
    stampHit(t, 'Caught');
    sfx.lessonDone();
    toast(`${itemOf(id).char} caught — in your encounters now`, 'ok');
    setTimeout(() => renderScan(), 500);
  }));
  const recognise = async (f, crop) => {
    scanState.result = null; scanState.selected.clear(); scanState.error = ''; scanState.busy = true; scanState.progress = null; scanState.usedCrop = !!crop;
    renderScan();
    try {
      const res = await scan.recognizeKanji(f, known, (label, ratio) => {
        scanState.progress = { label, ratio };
        const lbl = $('[data-role="scan-label"]', main), bar = $('[data-role="scan-bar"]', main);
        if (lbl) lbl.textContent = label;
        if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
      }, { crop });
      scanState.result = res;
      for (const { char, conf } of res.kanji) if (conf >= scan.SURE_CONF && engine.stageOf(app.progress, `k:${char}`) === 0) scanState.selected.add(`k:${char}`);
      sfx.tap();
    } catch (err) {
      scanState.error = err && err.message ? err.message : String(err);
    } finally {
      scanState.busy = false;
      renderScan();
    }
  };
  const onFile = (input) => {
    const f = input.files && input.files[0];
    if (!f) return;
    scanState.file = f; scanState.crop = null; scanState.box = null; scanState.candidates = null; scanState.result = null; scanState.error = '';
    renderScan();
  };
  $('#scan-file', main).addEventListener('change', (e) => onFile(e.target));
  $('#scan-pick', main).addEventListener('change', (e) => onFile(e.target));
  const wholeBtn = $('[data-act="scan-whole"]', main);
  if (wholeBtn) wholeBtn.addEventListener('click', () => { scanState.candidates = null; recognise(scanState.file, null); });
  $$('.scan-tile', main).forEach((t) => t.addEventListener('click', () => {
    const id = t.dataset.id;
    if (scanState.selected.has(id)) scanState.selected.delete(id); else scanState.selected.add(id);
    renderScan();
  }));
  const addBtn = $('[data-act="scan-add"]', main);
  if (addBtn) addBtn.addEventListener('click', () => {
    const ids = Array.from(scanState.selected);
    if (!ids.length) return;
    setProgress(engine.startManually(app.progress, ids, now()), { immediate: true });
    sfx.lessonDone();
    toast(`${plural(ids.length, 'kanji', 'kanji')} caught — in your encounters now`, 'ok');
    scanState.selected.clear();
    renderScan();
  });
  const allBtn = $('[data-act="scan-all"]', main);
  if (allBtn) allBtn.addEventListener('click', () => {
    for (const { char } of scanState.result.kanji) if (engine.stageOf(app.progress, `k:${char}`) === 0) scanState.selected.add(`k:${char}`);
    renderScan();
  });
  const typed = $('#scan-typed', main);
  const showTyped = () => {
    const res = scan.extractKanji(typed.value, known);
    scanState.result = Object.assign(res, { text: typed.value });
    scanState.selected.clear();
    for (const { char } of res.kanji) if (engine.stageOf(app.progress, `k:${char}`) === 0) scanState.selected.add(`k:${char}`);
    renderScan();
  };
  $('[data-act="scan-typed"]', main).addEventListener('click', showTyped);
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); showTyped(); } });
  app.cleanup = () => { scanState.file = null; scanState.result = null; scanState.selected.clear(); scanState.error = ''; scanState.crop = null; scanState.box = null; scanState.candidates = null; };
}

function scanKnownSet() {
  if (!app.knownSet) {
    app.knownSet = new Set();
    for (const id in app.data.items) if (app.data.items[id].type === 'kanji') app.knownSet.add(app.data.items[id].char);
  }
  return app.knownSet;
}

/* ---------- Evolution: a kanji reaches a new stage group ---------- */

function showEvolution(id, fromStage, toStage) {
  const item = itemOf(id);
  if (!item || app.progress.settings.celebrations === false) { sfx.stageUp(); toast(`${item ? item.char : id} reached ${srs.stageName(toStage)}`, 'ok'); return; }
  const fromGroup = srs.groupOf(fromStage), toGroup = srs.groupOf(toStage);
  const form = { guru: 'Guru form', master: 'Master form', enlightened: 'Enlightened form', burned: 'Burned form' }[toGroup] || srs.stageName(toStage);
  const el = document.createElement('div');
  el.className = 'evo';
  el.setAttribute('role', 'dialog');
  el.innerHTML = `
    <div class="evo-card">
      <div class="evo-title">What? ${esc(item.char)} is evolving!</div>
      <div class="evo-stage"><div class="evo-glyph jp stage-${esc(fromGroup)}">${esc(item.char)}</div></div>
      <div class="evo-result" hidden>
        <div class="evo-name">${esc(item.char)} evolved into its <strong>${esc(form)}</strong></div>
        <div class="btn-row" style="justify-content:center;margin-top:6px">${stageBadge(fromStage)}<span class="evo-arrow">→</span>${stageBadge(toStage)}</div>
        <p class="small muted" style="margin:10px 0 0">Meaning: ${esc(item.name)} · next encounter in ${esc(srs.intervalHours(toStage) >= 24 ? `${Math.round(srs.intervalHours(toStage) / 24)} days` : `${srs.intervalHours(toStage)} hours`)}</p>
      </div>
      <p class="small muted evo-hint">tap to continue</p>
    </div>`;
  document.body.appendChild(el);
  const glyph = el.querySelector('.evo-glyph');
  const result = el.querySelector('.evo-result');
  sfx.stageUp();
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 350);
  };
  const reveal = () => {
    if (done) return;
    glyph.classList.remove(`stage-${fromGroup}`);
    glyph.classList.add(`stage-${toGroup}`, 'is-evolved');
    result.hidden = false;
    if (toGroup === 'burned') sfx.burned(); else sfx.lessonDone();
    burst(glyph.parentElement, { count: 26, colour: toGroup === 'burned' ? 'var(--gold)' : 'var(--accent)' });
    setTimeout(finish, 3200);
  };
  setTimeout(reveal, reducedMotion() ? 200 : 1700);
  el.addEventListener('click', () => { if (result.hidden) reveal(); else finish(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') { e.preventDefault(); if (result.hidden) reveal(); else finish(); } });
  el.tabIndex = -1; el.focus();
}

/* ---------- Leech drill: extra practice that never touches the SRS ---------- */

function renderLeechDrill() {
  const ids = engine.leeches(app.progress).map((l) => l.id);
  if (!ids.length) {
    main.innerHTML = `<section class="screen">${emptyState('無', 'No leeches right now', 'Items you miss three times in a recent stretch show up here for extra practice.', '<a class="btn btn-primary" href="#/">Home</a>')}</section>`;
    return;
  }
  let session = engine.createSession(engine.shuffle(ids), now());
  main.innerHTML = `
    <section class="screen lesson">
      <div class="screen-head"><h1>Leech drill</h1><span class="muted small">${plural(ids.length, 'item')} · practice only, the SRS is not changed</span></div>
      <div data-role="quiz"></div>
    </section>`;
  const host = $('[data-role="quiz"]', main);
  const view = mountQuiz(host, {
    session,
    lightning: app.progress.settings.lightning,
    affectsSrs: false,
    onSession(s2) { session = s2; },
    onCorrect() { /* practice only */ },
    onWrapUp() { /* nothing to persist */ },
    onFinish(s2) {
      view.destroy();
      const stats = engine.sessionStats(s2);
      const missed = s2.done.filter((d) => d.wrong > 0).map((d) => d.id);
      main.innerHTML = `
        <section class="screen lesson">
          <div class="card session-summary fade-in">
            <div class="big-number">${stats.done ? pct(stats.accuracy) : '—'}</div>
            <h2>${stats.firstTry} of ${plural(stats.done, 'leech', 'leeches')} right first time</h2>
            <p class="muted">Still slipping? Open the item and rewrite its mnemonic in your own words; a story you made yourself sticks better.</p>
            ${missed.length ? `<div class="section-label" style="text-align:left">Missed again</div><div style="text-align:left">${chipList(missed)}</div>` : ''}
            <div class="btn-row" style="justify-content:center;margin-top:16px">
              <a class="btn btn-primary" href="#/drill/leeches">Drill again</a>
              <a class="btn" href="#/">Home</a>
            </div>
          </div>
        </section>`;
    },
  });
  app.cleanup = () => view.destroy();
}

/* ---------- Stats helpers ---------- */

function heatmapHtml(h) {
  const level = (c) => (!h.max || !c.count ? 0 : Math.min(4, Math.ceil((c.count / h.max) * 4)));
  const months = h.cols.map((col, i) => {
    const first = col.find(Boolean);
    const prev = i ? h.cols[i - 1].find(Boolean) : null;
    return first && (!prev || prev.month !== first.month) ? `<span>${new Date(first.date + 'T00:00:00').toLocaleDateString(undefined, { month: 'short' })}</span>` : '<span></span>';
  }).join('');
  const cells = h.cols.map((col) => col.map((c) => c
    ? `<i class="h${level(c)}" title="${esc(c.date)} · ${plural(c.count, 'item')}"></i>`
    : '<i class="future"></i>').join('')).join('');
  return `<div class="heatmap-wrap"><div class="heatmap-months">${months}</div><div class="heatmap" role="img" aria-label="Daily activity for the last year">${cells}</div></div>
    <div class="heatmap-legend">Less <i></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i> More</div>`;
}

function areaChart(series, { width = 640, height = 170, label = '' } = {}) {
  const n = series.length;
  if (!n) return '';
  const max = Math.max(1, ...series.map((d) => d.total));
  const padL = 36, padR = 16, padT = 14, padB = 24;
  const w = width - padL - padR, hgt = height - padT - padB;
  const x = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * w);
  const y = (v) => padT + hgt - (v / max) * hgt;
  const pts = series.map((d, i) => `${x(i).toFixed(1)},${y(d.total).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${x(n - 1).toFixed(1)},${(padT + hgt).toFixed(1)} L${x(0).toFixed(1)},${(padT + hgt).toFixed(1)} Z`;
  const ticks = [0, Math.round(max / 2), max];
  const fmt = (k) => new Date(k + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `<svg class="area-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">
    ${ticks.map((v) => `<line class="axis" x1="${padL}" x2="${width - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke-dasharray="2 4"/><text x="${padL - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('')}
    <path class="fill" d="${area}"/><path class="line" d="${line}"/>
    <circle cx="${x(n - 1).toFixed(1)}" cy="${y(series[n - 1].total).toFixed(1)}" r="3.5" fill="var(--accent)"/>
    <text class="end" x="${(x(n - 1) - 8).toFixed(1)}" y="${(y(series[n - 1].total) + (series[n - 1].total > max * 0.85 ? 16 : -8)).toFixed(1)}" text-anchor="end">${series[n - 1].total}</text>
    <text x="${padL}" y="${height - 6}">${esc(fmt(series[0].date))}</text>
    <text x="${width - padR}" y="${height - 6}" text-anchor="end">${esc(fmt(series[n - 1].date))}</text>
  </svg>`;
}

function renderStats() {
  const p = app.progress;
  const data = app.data;
  const t = now();
  const groups = engine.groupCounts(p, data);
  const totalItems = Object.keys(data.items).length;
  const history = engine.dailyHistory(p, t, 30);
  const fc = engine.forecast(p, t);
  const accuracy = engine.overallAccuracy(p);
  const last7 = history.slice(-7);
  const r7 = last7.reduce((a, d) => a + d.reviews, 0);
  const c7 = last7.reduce((a, d) => a + d.correct, 0);
  const totalReviews = history.reduce((a, d) => a + d.reviews, 0);

  // Per-stage totals (1..9)
  const perStage = new Array(10).fill(0);
  for (const id in p.items) perStage[srs.clampStage(p.items[id].stage)]++;
  const maxStage = Math.max(1, ...perStage.slice(1));

  const dayLabels = history.map((d, i) => (i % 5 === 4 || i === 0 ? d.date.slice(5).replace('-', '/') : ''));
  const dayNames = fc.days.map((_, i) => {
    const d = new Date(t); d.setDate(d.getDate() + i);
    return i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
  });
  const accuracySeries = history.map((d) => (d.reviews ? Math.round((d.correct / d.reviews) * 100) : 0));

  // Level timeline: levels with any progress, with first start and guru dates.
  const timeline = data.levels.map((lv) => {
    let started = null, allGuru = true, anyStarted = false, lastGuru = null;
    for (const id of lv.items) {
      const e = p.items[id];
      if (!e) { allGuru = false; continue; }
      anyStarted = true;
      if (e.startedAt && (!started || e.startedAt < started)) started = e.startedAt;
      if (e.stage >= 5) { if (e.guruAt && (!lastGuru || e.guruAt > lastGuru)) lastGuru = e.guruAt; } else allGuru = false;
    }
    if (!anyStarted) return null;
    const lp = engine.levelProgress(data, p, lv.level);
    return { level: lv.level, started, passed: allGuru ? lastGuru : null, lp };
  }).filter(Boolean);

  const leechList = engine.leeches(p);
  const acc = engine.accuracyByStage(p);
  const learned = engine.learnedSeries(p, t, 90);
  const proj = engine.projection(data, p, t);
  const heat = engine.heatmap(p, t, 53);
  const kanjiStarted = Object.keys(p.items).filter((id) => p.items[id].stage > 0 && data.items[id] && data.items[id].type === 'kanji').length;
  const kanjiTotal = Object.values(data.items).filter((i) => i.type === 'kanji').length;

  main.innerHTML = `
    <section class="screen stack">
      <div class="screen-head"><h1>Stats</h1><span class="muted small">${Object.keys(p.items).length} of ${totalItems} items started</span></div>

      <div class="stat-row">
        <div class="stat card"><div class="stat-value">${accuracy == null ? '—' : pct(accuracy)}</div><div class="stat-label">Accuracy (all time)</div></div>
        <div class="stat card"><div class="stat-value">${r7 ? pct(c7 / r7) : '—'}</div><div class="stat-label">Accuracy (7 days)</div></div>
        <div class="stat card"><div class="stat-value">${totalReviews}</div><div class="stat-label">Reviews (30 days)</div></div>
        <div class="stat card"><div class="stat-value">${engine.streak(p.days, t)}</div><div class="stat-label">Day streak</div></div>
        <div class="stat card"><div class="stat-value">${groups.burned}</div><div class="stat-label">Burned</div></div>
        <div class="stat card"><div class="stat-value">✦ ${shinyCount()}</div><div class="stat-label">Shiny</div></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h2>Items by stage</h2>
          <div class="stage-bars">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => `
              <div class="stage-bar"><span>${esc(srs.stageName(s))}</span>
                <div class="track"><div style="width:${(perStage[s] / maxStage) * 100}%;background:var(--${srs.groupOf(s)})"></div></div>
                <span class="n">${perStage[s]}</span></div>`).join('')}
          </div>
        </div>
        <div class="card">
          <h2>Groups</h2>
          <div class="group-counts" style="grid-template-columns:repeat(2,1fr)">
            ${srs.GROUPS.map((g) => `<div class="group-count stage-${g}"><div class="n">${groups[g]}</div><div class="l">${esc(g)}</div></div>`).join('')}
            <div class="group-count" style="background:var(--surface-3);color:var(--text)"><div class="n">${groups.locked}</div><div class="l">locked</div></div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <h2>Projected finish</h2>
          <dl class="kv">
            <dt>Kanji started</dt><dd>${kanjiStarted} of ${kanjiTotal} (${pct(kanjiTotal ? kanjiStarted / kanjiTotal : 0)})</dd>
            <dt>Your pace</dt><dd>${proj.rate ? `${proj.rate.toFixed(1)} new items a day <span class="muted">(last ${plural(proj.daysObserved, 'day')})</span>` : '—'}</dd>
            <dt>All items at your pace</dt><dd>${proj.eta ? `${esc(fmtDate(proj.eta))} <span class="muted">(${Math.round((proj.eta - t) / 86400000)} days)</span>` : 'Start a few lessons to see a projection'}</dd>
            <dt>At ${proj.settingRate} a day</dt><dd>${proj.etaAtSetting ? `${esc(fmtDate(proj.etaAtSetting))} <span class="muted">(${Math.round((proj.etaAtSetting - t) / 86400000)} days)</span>` : '—'}</dd>
          </dl>
        </div>
        <div class="card">
          <h2>Accuracy by stage <span class="muted">${acc.counted ? `${acc.counted} answers` : 'collected from now on'}</span></h2>
          <div class="stage-acc">
            ${srs.GROUPS.filter((g) => g !== 'burned').map((g) => { const r = acc.groups[g]; const v = r.total ? r.ok / r.total : 0; return `
              <div class="row"><span>${g[0].toUpperCase() + g.slice(1)}</span>
                <div class="track"><div style="width:${v * 100}%;background:var(--${g})"></div></div>
                <span class="n">${r.total ? pct(v) : '—'}</span></div>`; }).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Items learned <span class="muted">cumulative, last 90 days</span></h2>
        ${areaChart(learned, { label: 'Items started over the last 90 days' })}
      </div>

      <div class="card">
        <h2>Activity <span class="muted">last 12 months · reviews and lessons per day</span></h2>
        ${heatmapHtml(heat)}
      </div>

      <div class="card">
        <h2>Leeches <span class="muted">${leechList.length ? `${plural(leechList.length, 'item')} missed ${engine.LEECH_MIN_WRONG}+ times in their last ${engine.LEECH_WINDOW} answers` : 'none right now'}</span></h2>
        ${leechList.length ? `<ul class="leech-list">${leechList.map((l) => { const it = itemOf(l.id); return `
          <li><a class="jp" href="${itemHref(l.id)}">${esc(it ? it.char : l.id)}</a><span>${esc(it ? it.name : '')} <span class="muted">· ${esc(srs.stageName(engine.stageOf(p, l.id)))}</span></span><span class="n">${l.recentWrong}/${l.recentTotal} wrong</span></li>`; }).join('')}</ul>
          <div class="btn-row" style="margin-top:12px"><a class="btn btn-primary btn-sm" href="#/drill/leeches">Drill leeches</a></div>`
        : '<p class="muted">Items you keep missing will be listed here with an extra drill. A run of three correct answers clears one.</p>'}
      </div>

      <div class="card">
        <h2>Reviews per day <span class="muted">last 30 days</span></h2>
        ${bars(history.map((d) => d.reviews), dayLabels, { tall: true, cls: 'is-accent' })}
      </div>

      <div class="card">
        <h2>Accuracy over time <span class="muted">% correct per day</span></h2>
        ${bars(accuracySeries, dayLabels, { cls: 'is-ok', counts: false })}
      </div>

      <div class="card">
        <h2>7-day forecast <span class="muted">${fc.days.reduce((a, b) => a + b, 0)} reviews${fc.dueNow ? ` · ${fc.dueNow} due now` : ''}</span></h2>
        ${bars(fc.days, dayNames)}
      </div>

      <div class="card">
        <h2>Level timeline</h2>
        ${timeline.length ? `<ul class="timeline">${timeline.map((l) => `
          <li><span class="tl-level"><a href="#/levels/${l.level}">Lv ${l.level}</a></span>
            <span>${l.started ? `started ${esc(fmtDate(l.started))}` : ''}${l.passed ? ` · all Guru ${esc(fmtDate(l.passed))}` : ` · ${l.lp.guru}/${l.lp.total} guru`}</span>
            <span class="tl-date">${pct(l.lp.ratio)}</span></li>`).join('')}</ul>`
        : '<p class="muted">Start some lessons and your level history will appear here.</p>'}
      </div>
    </section>`;
}

// --- Settings --------------------------------------------------------------

function renderSettings() {
  const syncCfg = sync.loadSyncConfig();
  const s = app.progress.settings;
  const st = store.status();
  const itemCount = Object.keys(app.progress.items).length;
  const lastExport = lastExportAt();

  const num = (key, label, help, min, max) => `
    <div class="setting">
      <label class="setting-label" for="set-${key}">${label}</label>
      <div class="setting-help">${help}</div>
      <div class="setting-control"><input type="number" id="set-${key}" data-setting="${key}" min="${min}" max="${max}" value="${esc(s[key])}"></div>
    </div>`;
  const toggle = (key, label, help) => `
    <div class="setting">
      <span class="setting-label" id="lbl-${key}">${label}</span>
      <div class="setting-help">${help}</div>
      <div class="setting-control"><label class="switch"><input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''} aria-labelledby="lbl-${key}"><span class="track"></span></label></div>
    </div>`;

  main.innerHTML = `
    <section class="screen stack">
      <div class="screen-head"><h1>Settings</h1></div>

      <div class="card">
        <h2>Pace</h2>
        ${num('dailyLessons', 'Lessons per day', 'Gentle 4 · Standard 10 · Fast 15. New items per day; each kanji is a single meaning card.', 0, 100)}
        ${num('apprenticeCap', 'Apprentice cap', 'No new lessons while this many items sit in Apprentice. Keeps review debt in check.', 1, 1000)}
        ${num('unlockStage', 'Unlock stage', 'A kanji becomes available once all its parts reach this stage (3 = Apprentice 3, 5 = Guru 1).', 1, 9)}
        ${num('lessonBatch', 'Lesson batch size', 'Items per lesson batch before the quiz.', 1, 20)}
      </div>

      <div class="card">
        <h2>Reviews</h2>
        ${toggle('lightning', 'Lightning mode', 'Move on automatically after a correct answer.')}
        ${toggle('fontVariety', 'Typeface variety in reviews', 'Show kanji in a rotating set of typefaces (Gothic, Mincho, pen, handwriting) so recognition is not tied to one design.')}
        ${toggle('typoTolerance', 'Typo tolerance', 'Accept answers within a small edit distance (0 for ≤3 letters, up to 3 for long ones).')}
      </div>

      <div class="card">
        <h2>Appearance</h2>
        <div class="setting">
          <label class="setting-label" for="set-theme">Theme</label>
          <div class="setting-help">"Auto" follows your system preference.</div>
          <div class="setting-control"><select id="set-theme" data-setting="theme">
            <option value="auto" ${s.theme === 'auto' ? 'selected' : ''}>Auto</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>Light</option>
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>Dark</option>
          </select></div>
        </div>
      </div>

      <div class="card">
        <h2>Sounds and feedback</h2>
        ${toggle('sounds', 'Sounds', 'A ding for a correct answer that climbs with your streak, a soft double-note for a miss, clicks on buttons, and a chime when an item reaches a new stage.')}
        ${num('volume', 'Volume', '0 to 100.', 0, 100)}
        ${toggle('haptics', 'Vibration', 'A tiny buzz on answers and taps, on phones that support it (Android; iPhones do not vibrate for websites).')}
        ${toggle('celebrations', 'Celebrations', 'Stamps and bursts on catches, combo counters and confetti at the end of a session.')}
        ${toggle('intro', 'Intro screen', 'Show the Kanjiland title screen when the app opens.')}
        ${toggle('music', 'Music', 'Original 8-bit tunes: a whimsical overworld theme on the home screen, an encounter theme in reviews, a gentle one for new sightings, a dreamy one in the dex, and a victory fanfare.')}
        ${num('musicVolume', 'Music volume', '0 to 100. Sound effects have their own volume above.', 0, 100)}
        <div class="btn-row" style="margin-top:12px"><button class="btn btn-sm" type="button" data-act="sound-test">Play the ding</button><button class="btn btn-sm" type="button" data-act="music-test">Start the music</button></div>
        <p class="small muted" data-role="audio-state" style="margin-top:8px"></p>
        <p class="small muted">No sound on an iPhone? Flip the ringer switch on the side of the phone away from silent, turn the volume up, and tap "Start the music". Sound can only begin after a tap, never on its own.</p>
      </div>

      <div class="card" data-role="sync-card">
        <h2>Sync between devices <span class="muted">via a private GitHub Gist</span></h2>
        ${syncCfg ? `
        <p class="small muted">Connected. Progress is merged with the shared file when the app opens, returns to the foreground, and a few seconds after you finish answering. Gist <a href="https://gist.github.com/${esc(syncCfg.gistId)}" target="_blank" rel="noopener">${esc(syncCfg.gistId.slice(0, 8))}…</a></p>
        <p class="small" data-role="sync-status">${syncStatusHtml()}</p>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" data-act="sync-now">Sync now</button>
          <button class="btn btn-ghost btn-sm" data-act="sync-disconnect">Disconnect</button>
        </div>` : `
        <p class="small muted">Keep the phone and the desktop on one progress file. You need a GitHub personal access token with only the <strong>gist</strong> permission; paste it below and the app finds or creates a private gist on your account. The token is stored in this browser only.</p>
        <div class="kgrid-select-row" style="margin-top:8px">
          <label class="sr-only" for="sync-token">GitHub token</label>
          <input type="password" id="sync-token" placeholder="github_pat_… or ghp_…" autocomplete="off" spellcheck="false">
          <button class="btn btn-primary" data-act="sync-connect">Connect</button>
        </div>
        <p class="small" data-role="sync-status"></p>`}
      </div>

      <div class="card">
        <h2>Your data</h2>
        <p class="small muted">Progress lives in this browser (${itemCount} items, ${app.progress.reviews.length} logged reviews). Sync above keeps devices together; export a copy now and then as a backup.
        ${lastExport ? `Last export: ${esc(fmtDate(lastExport))}.` : 'Never exported yet.'}</p>
        <div class="btn-row">
          <button class="btn btn-primary" data-act="export">Export JSON</button>
          <button class="btn" data-act="import">Import JSON…</button>
          <input type="file" accept="application/json,.json" data-role="file" class="sr-only" tabindex="-1" aria-hidden="true">
          <button class="btn" data-act="copy-text">Copy as text</button>
          <button class="btn" data-act="paste-text">Paste text…</button>
        </div>
        <div data-role="text-transfer" hidden style="margin-top:12px">
          <p class="small muted" data-role="text-help"></p>
          <textarea data-role="text-area" rows="6" style="width:100%;font-family:var(--font-mono);font-size:0.75rem" spellcheck="false"></textarea>
          <div class="btn-row" style="margin-top:8px">
            <button class="btn btn-primary btn-sm" data-act="text-import" hidden>Import pasted text</button>
            <button class="btn btn-ghost btn-sm" data-act="text-close">Close</button>
          </div>
        </div>
        <div class="section-label">Daily backups <span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">(kept in this browser for 14 days)</span></div>
        <ul class="backup-list" data-role="backups"><li class="muted">Loading…</li></ul>
        ${!st.localStorage || !st.indexedDB ? `<p class="small" style="color:var(--warn);margin-top:10px">Storage warning: ${!st.localStorage ? 'localStorage is unavailable — progress is kept in memory only this session. ' : ''}${!st.indexedDB ? 'IndexedDB backups are unavailable.' : ''}${st.lastError ? ` (${esc(st.lastError)})` : ''}</p>` : ''}
      </div>

      <div class="card">
        <h2>Danger zone</h2>
        <p class="small muted">Reset wipes all progress, synonyms and notes from this browser. Export first.</p>
        <button class="btn btn-danger" data-act="reset">Reset all progress…</button>
      </div>

      <div class="card about">
        <h2>About</h2>
        <p><strong>Kanjr</strong> — meanings of the jōyō kanji, WaniKani-style spaced repetition, no readings.
        ${app.sample ? '<strong>Currently running on sample data</strong> because <code>data/kanji.json</code> could not be loaded.' : app.data.meta ? `Data built ${esc(app.data.meta.built || '')}, ${esc((app.data.meta.counts || {}).kanji || '?')} kanji, ${esc((app.data.meta.counts || {}).radicals || '?')} radicals.` : ''}</p>
        <p>Kanji data comes from KANJIDIC2, KRADFILE and JMdict (EDRDG, CC BY-SA 4.0) and scriptin/kanji-frequency (CC BY 4.0). See the full <a href="../data/LICENSES.md" target="_blank" rel="noopener">licences</a>.</p>
        <p class="small muted">Keyboard: <kbd>Enter</kbd> submit / continue · <kbd>Esc</kbd> wrap up · <kbd>?</kbd> item details · <kbd>←</kbd> <kbd>→</kbd> between lesson cards.</p>
      </div>
    </section>`;

  // Settings inputs
  $$('[data-setting]', main).forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.setting;
      const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      updateSettings({ [key]: value });
      if (el.type === 'number') el.value = app.progress.settings[key];
      toast('Saved');
    });
  });

  const audioStateEl = $('[data-role="audio-state"]', main);
  const showAudioState = () => { const a = audioState(); audioStateEl.textContent = `Sound engine: ${a.context} · music: ${music.state()} · playing: ${music.playing() || 'nothing'} · silent-mode workaround: ${a.unlocked ? 'active' : 'not yet (tap a button)'}`; };
  showAudioState();
  $('[data-act="sound-test"]', main).addEventListener('click', (e) => { unlockAudio(); sfx.correct(3); burst(e.currentTarget.closest('.card')); setTimeout(showAudioState, 300); });
  $('[data-act="music-test"]', main).addEventListener('click', () => { unlockAudio(); music.unlock(); updateSettings({ music: true }); music.play('overworld'); setTimeout(showAudioState, 300); });

  // Export / import
  $('[data-act="export"]', main).addEventListener('click', () => {
    store.flush();
    store.downloadExport(app.progress, now());
    markExported();
    toast('Progress exported', 'ok');
    hideExportReminder();
  });
  // Text transfer: for copies that cannot download or read files (a sandboxed page).
  const transfer = $('[data-role="text-transfer"]', main);
  const textArea = $('[data-role="text-area"]', main);
  const textHelp = $('[data-role="text-help"]', main);
  const textImportBtn = $('[data-act="text-import"]', main);
  $('[data-act="copy-text"]', main).addEventListener('click', async () => {
    store.flush();
    const text = store.exportJSON(app.progress);
    transfer.hidden = false; textImportBtn.hidden = true;
    textArea.value = text; textArea.readOnly = true;
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (_) { copied = false; }
    textHelp.textContent = copied
      ? 'Copied to the clipboard. On the other device open Settings, press “Paste text…”, paste, and import.'
      : 'Select everything in the box (click inside, then Ctrl+A or Cmd+A) and copy it. On the other device open Settings, press “Paste text…”, paste, and import.';
    if (!copied) { textArea.focus(); textArea.select(); }
    else toast('Progress copied to the clipboard', 'ok');
    markExported();
  });
  $('[data-act="paste-text"]', main).addEventListener('click', () => {
    transfer.hidden = false; textImportBtn.hidden = false;
    textArea.value = ''; textArea.readOnly = false;
    textHelp.textContent = 'Paste the progress text here, then press “Import pasted text”.';
    textArea.focus();
  });
  $('[data-act="text-close"]', main).addEventListener('click', () => { transfer.hidden = true; textArea.value = ''; });
  textImportBtn.addEventListener('click', async () => {
    const result = store.parseImport(textArea.value);
    if (!result.ok) { toast(`Import failed: ${result.error}`, 'error'); return; }
    const incoming = result.progress;
    const merged = sync.mergeProgress(app.progress, incoming);
    const ok = await confirmDialog({
      title: 'Import this progress?',
      body: `The text contains <strong>${Object.keys(incoming.items).length} items</strong> (last updated ${esc(fmtDate(incoming.updatedAt))}). It will be merged with what is here (${itemCount} items); where both know an item, the one with more answers wins.`,
      confirmLabel: 'Import and merge',
    });
    if (!ok) return;
    replaceProgress(merged);
    toast('Progress imported and merged', 'ok');
  });

  // Sync
  const connectBtn = $('[data-act="sync-connect"]', main);
  if (connectBtn) connectBtn.addEventListener('click', async () => {
    const token = ($('#sync-token', main).value || '').trim();
    const status = $('[data-role="sync-status"]', main);
    if (!token) { status.textContent = 'Paste a token first.'; return; }
    connectBtn.disabled = true; status.textContent = 'Connecting to GitHub…';
    try {
      store.flush();
      const { gistId, created } = await sync.connect(token, app.progress);
      sync.saveSyncConfig({ token, gistId, connectedAt: new Date().toISOString() });
      toast(created ? 'Connected — created a private gist for your progress' : 'Connected — found your existing progress gist', 'ok');
      await runSync({ quiet: false });
      renderSettings();
    } catch (err) {
      status.innerHTML = `<span style="color:var(--bad)">${esc(err && err.message ? err.message : String(err))}</span>`;
      connectBtn.disabled = false;
    }
  });
  const syncNowBtn = $('[data-act="sync-now"]', main);
  if (syncNowBtn) syncNowBtn.addEventListener('click', () => runSync({ quiet: false }));
  const disconnectBtn = $('[data-act="sync-disconnect"]', main);
  if (disconnectBtn) disconnectBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Disconnect sync?', body: 'This device stops syncing. Your progress stays here and in the gist; nothing is deleted.', confirmLabel: 'Disconnect' });
    if (!ok) return;
    sync.clearSyncConfig();
    toast('Sync disconnected');
    renderSettings();
  });

  const file = $('[data-role="file"]', main);
  $('[data-act="import"]', main).addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    if (!f) return;
    let text;
    try { text = await f.text(); } catch (err) { toast('Could not read the file', 'error'); return; }
    const result = store.parseImport(text);
    if (!result.ok) { toast(`Import failed: ${result.error}`, 'error'); file.value = ''; return; }
    const incoming = result.progress;
    const ok = await confirmDialog({
      title: 'Replace your progress?',
      body: `The file contains <strong>${Object.keys(incoming.items).length} items</strong> (last updated ${esc(fmtDate(incoming.updatedAt))}). Your current progress (${itemCount} items) will be replaced.`,
      confirmLabel: 'Replace',
      danger: true,
    });
    file.value = '';
    if (!ok) return;
    replaceProgress(incoming);
    toast('Progress imported', 'ok');
  });

  // Reset
  $('[data-act="reset"]', main).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset all progress?',
      body: 'This deletes every item, review, synonym and note stored in this browser. Backups in IndexedDB are kept for 14 days.',
      confirmLabel: 'Reset everything',
      danger: true,
    });
    if (!ok) return;
    store.clearAll();
    app.session = null;
    app.lesson = null;
    const fresh = store.defaultProgress(now());
    fresh.settings = Object.assign({}, app.progress.settings); // keep preferences
    setProgress(fresh, { immediate: true });
    toast('Progress reset');
    renderSettings();
  });

  // Backups
  const list = $('[data-role="backups"]', main);
  store.listBackups().then((backups) => {
    if (!backups.length) { list.innerHTML = '<li class="muted">No backups yet — one is taken each day you use the app.</li>'; return; }
    list.innerHTML = backups.map((b) => `
      <li><span class="grow"><strong>${esc(b.date)}</strong> <span class="muted">· ${plural(b.itemCount, 'item')} · saved ${esc(fmtTime(b.savedAt))}</span></span>
      <button class="btn btn-sm" data-restore="${esc(b.date)}">Restore</button></li>`).join('');
    $$('[data-restore]', list).forEach((btn) => btn.addEventListener('click', async () => {
      const date = btn.dataset.restore;
      const snapshot = await store.loadBackup(date);
      if (!snapshot) { toast('That backup could not be read', 'error'); return; }
      const ok = await confirmDialog({
        title: `Restore backup from ${date}?`,
        body: `Your current progress (${Object.keys(app.progress.items).length} items) will be replaced by the snapshot (${Object.keys(snapshot.items).length} items).`,
        confirmLabel: 'Restore',
        danger: true,
      });
      if (!ok) return;
      replaceProgress(snapshot);
      toast(`Restored backup from ${date}`, 'ok');
    }));
  });
}

/** Swap in a validated progress object from import/restore. */
function replaceProgress(incoming) {
  app.session = null;
  app.lesson = null;
  store.clearSession();
  setProgress(incoming, { immediate: true });
  applyTheme(incoming.settings.theme);
  renderSettings();
}

// --- Misc screens ----------------------------------------------------------

function renderNotFound(message) {
  main.innerHTML = `<section class="screen">${emptyState('迷', 'Page not found', message || 'That page does not exist.', '<a class="btn btn-primary" href="#/">Home</a>')}</section>`;
}

function renderLoadError(err) {
  main.innerHTML = `<section class="screen">${emptyState('誤', 'Could not load the kanji data',
    `Neither <code>data/kanji.json</code> nor the sample fixture could be fetched. Serve the repository root (for example <code>python3 -m http.server 8000</code>) and open <code>/app/</code>.<br><span class="small muted">${esc(err && err.message ? err.message : err)}</span>`,
    '<button class="btn btn-primary" onclick="location.reload()">Retry</button>')}</section>`;
}

// ===========================================================================
// 6. Router and boot
// ===========================================================================

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  return raw.split('/').filter(Boolean).map((seg) => { try { return decodeURIComponent(seg); } catch (_) { return seg; } });
}

function route() {
  if (app.cleanup) { try { app.cleanup(); } catch (_) { /* ignore */ } app.cleanup = null; }
  app.keyHandler = null;
  const parts = parseRoute();
  const head = parts[0] || 'home';
  music.play(sceneFor(head));
  const routeName = { home: 'home', lessons: 'home', reviews: 'home', item: 'levels', levels: 'grid', item: 'grid', grid: 'grid', scan: 'scan', drill: 'stats', stats: 'stats', settings: 'settings' }[head] || '';
  $$('#nav a').forEach((a) => {
    if (a.dataset.route === routeName) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  // Leaving the lesson cards discards an unfinished batch (nothing was recorded).
  if (head !== 'lessons' && app.lesson && app.lesson.phase !== 'done') app.lesson = null;

  try {
    switch (head) {
      case 'home': renderHome(); break;
      case 'lessons': renderLessons(); break;
      case 'reviews': renderReviews(); break;
      case 'item': renderItem(parts[1] || ''); break;
      case 'levels':
        if (parts[1] !== undefined) {
          const n = Number(parts[1]);
          if (Number.isInteger(n)) renderLevel(n); else renderNotFound();
        } else renderLevels();
        break;
      case 'grid': renderGrid(); break;
      case 'drill': renderLeechDrill(); break;
      case 'scan': renderScan(); break;
      case 'stats': renderStats(); break;
      case 'settings': renderSettings(); break;
      default: renderNotFound();
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<section class="screen">${emptyState('誤', 'Something went wrong', `<span class="small muted">${esc(err && err.message)}</span>`, '<a class="btn btn-primary" href="#/">Home</a>')}</section>`;
  }
  window.scrollTo({ top: 0 });
  document.title = { home: 'Kanjr', lessons: 'Lessons · Kanjr', reviews: 'Reviews · Kanjr', item: 'Item · Kanjr', levels: 'Levels · Kanjr', grid: 'Kanjidex · Kanjr', drill: 'Leech drill · Kanjr', scan: 'Catch · Kanjr', stats: 'Stats · Kanjr', settings: 'Settings · Kanjr' }[head] || 'Kanjr';
}

function showBanner(html, { kind = '', dismiss = null } = {}) {
  const banner = $('#banner');
  banner.className = `banner ${kind}`;
  banner.innerHTML = html + (dismiss ? `<button class="btn btn-sm btn-ghost" data-act="dismiss">${esc(dismiss)}</button>` : '');
  banner.hidden = false;
  const d = $('[data-act="dismiss"]', banner);
  if (d) d.addEventListener('click', () => { banner.hidden = true; });
}

function hideExportReminder() {
  const banner = $('#banner');
  if (banner && banner.dataset.kind === 'export') { banner.hidden = true; delete banner.dataset.kind; }
}

function maybeExportReminder() {
  if (app.sample || Object.keys(app.progress.items).length < 20) return;
  const last = lastExportAt();
  const days = last ? engine.calendarDaysBetween(last, now()) : Infinity;
  if (days < EXPORT_REMINDER_DAYS) return;
  showBanner(`It has been ${last ? plural(days, 'day') : 'a while'} since you exported your progress. <a href="#/settings" style="text-decoration:underline">Export a backup</a>.`, { dismiss: 'Later' });
  $('#banner').dataset.kind = 'export';
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function validData(d) {
  return d && typeof d === 'object' && d.items && typeof d.items === 'object' && Array.isArray(d.levels);
}

async function loadData() {
  // A single-file bundle (pipeline/bundle.py) embeds the data on window.
  if (window.KANJR_DATA && validData(window.KANJR_DATA)) {
    return { data: window.KANJR_DATA, sample: false };
  }
  try {
    const d = await fetchJSON(DATA_URL);
    if (!validData(d)) throw new Error('kanji.json has an unexpected shape');
    return { data: d, sample: false };
  } catch (primaryErr) {
    console.warn('Falling back to sample data:', primaryErr);
    const d = await fetchJSON(SAMPLE_URL);
    if (!validData(d)) throw new Error('fixture.json has an unexpected shape');
    return { data: d, sample: true, reason: primaryErr };
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!/^https?:$/.test(location.protocol)) return;
  if (window.KANJR_DATA) return;   // single-file bundle: no sw.js next to it
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err));
}

async function boot() {
  app.progress = store.load();
  applyTheme(app.progress.settings.theme);
  app.session = store.loadSession();

  try {
    const loaded = await loadData();
    app.data = loaded.data;
    app.sample = loaded.sample;
    if (app.sample) {
      showBanner('<strong>Using sample data.</strong> <code>data/kanji.json</code> was not found, so a 14-item fixture is loaded. Run the pipeline to build the real data file.', { dismiss: 'OK' });
    }
  } catch (err) {
    renderLoadError(err);
    return;
  }

  // A saved session that no longer matches the data set is dropped.
  if (app.session && !app.session.queue.every((id) => app.data.items[id])) {
    app.session = null;
    store.clearSession();
  }

  updateLevelBadge();
  maybeExportReminder();
  backupIfNeeded();

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (app.keyHandler) app.keyHandler(e);
  });
  window.addEventListener('pagehide', () => { store.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.flush(); });
  // Refresh counts when returning to the tab (reviews may have become due).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (parseRoute()[0] || 'home') === 'home') route();
  });

  if (!location.hash) location.hash = '#/';
  route();
  registerServiceWorker();
  applySfxSettings();
  window.kanjrMusic = music;   // handy in the console
  maybeIntro();
  // iOS only unlocks audio from click, touchend or a key press (not
  // touchstart/pointerdown), so listen to those.
  const unlockOnce = () => { unlockAudio(); music.unlock(); };
  document.addEventListener('click', unlockOnce, true);
  document.addEventListener('touchend', unlockOnce, { passive: true, capture: true });
  document.addEventListener('keydown', unlockOnce, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') music.pause(); else music.resume(); });
  // Every button and nav tap gives a tiny click, so the interface feels physical.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.btn, .nav a, .kgrid-toggle, .switch, .ctx-menu button');
    if (t && !t.disabled) sfx.click();
  });
  if (sync.loadSyncConfig()) {
    runSync({ quiet: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync({ quiet: true }); });
    window.addEventListener('online', () => runSync({ quiet: true }));
  }
}

boot();
