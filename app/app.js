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
  const badge = $('#level-badge');
  if (!badge || !app.data) return;
  const level = engine.currentLevel(app.data, app.progress);
  badge.textContent = `Lv ${level}`;
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
function mountQuiz(root, opts) {
  let session = opts.session;
  // `answeredId` and `counter` freeze what the feedback phase shows: the
  // session has already moved on to the next item by then.
  const view = { phase: 'ask', result: null, retried: false, info: false, collision: null, timer: null, answeredId: null, counter: 1 };
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
    const progressPct = stats.total ? (stats.done / stats.total) * 100 : 0;
    const note = app.progress.notes[id];

    root.innerHTML = `
      <div class="review">
        <div class="review-top">
          <span class="counter" aria-live="polite">${view.counter} / ${stats.total}</span>
          <span class="accuracy" title="Accuracy so far">${stats.done ? pct(stats.accuracy) : '—'}</span>
          <span class="spacer"></span>
          ${opts.onWrapUp ? `<button class="btn btn-ghost btn-sm" data-act="wrap" title="Finish the items in progress and stop (Esc)">
            <span class="label">${session.wrappingUp ? 'Wrapping up' : 'Wrap up'}</span> <kbd>Esc</kbd></button>` : ''}
        </div>
        <div class="review-progress"><div style="width:${progressPct}%"></div></div>

        <div class="card glyph-card type-${esc(item.type)} ${stateCls} ${view.phase === 'feedback' && view.result === 'wrong' ? 'shake' : ''}" data-role="card">
          <div class="glyph-type">${typeBadge(item)}</div>
          <div class="glyph">${esc(item.char)}</div>
          <div class="glyph-prompt">${typeLabel(item)} <strong>meaning</strong>${wrongSoFar ? ` · <span class="muted">missed ${wrongSoFar}×</span>` : ''}</div>
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
      </div>`;

    const input = $('#answer', root);
    const form = $('[data-role="form"]', root);
    form.addEventListener('submit', (e) => { e.preventDefault(); if (view.phase === 'ask') submit(input.value); else next(); });
    $$('[data-act="wrap"]', root).forEach((b) => b.addEventListener('click', wrap));
    $$('[data-act="next"]', root).forEach((b) => b.addEventListener('click', next));
    $$('[data-act="info"]', root).forEach((b) => b.addEventListener('click', toggleInfo));
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
    if (view.result === 'wrong') return `Not quite. <kbd>Enter</kbd> to continue${opts.affectsSrs === false ? ' (you will see it again)' : ''}`;
    return `Correct! <kbd>Enter</kbd> to continue · <kbd>?</kbd> for details`;
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

    view.lastInput = raw;
    view.collision = null;
    view.phase = 'feedback';
    view.result = verdict;
    view.info = false;
    view.answeredId = id;
    if (verdict === 'wrong') {
      session = engine.answerCurrent(session, false);
    } else {
      const wrong = session.wrong[id] || 0;
      session = engine.answerCurrent(session, true);
      opts.onCorrect(id, wrong);
    }
    opts.onSession(session);
    render();
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
  const blockReason = lessons.length ? null : engine.lessonBlockReason(data, p, t);
  const hasSession = !!(app.session && app.session.queue.length);

  const hourLabels = fc.hours.map((_, i) => {
    const h = new Date(Math.ceil((t.getTime() + i * 3600000) / 3600000) * 3600000).getHours();
    return i % 4 === 0 ? `${pad2(h)}` : '';
  });
  const upcoming = fc.hours.reduce((a, b) => a + b, 0);

  const lessonSub = lessons.length
    ? `${plural(lessons.length, 'item')} ready`
    : blockReason === 'apprentice-cap' ? 'Apprentice cap reached'
      : blockReason === 'daily-cap' ? 'Done for today'
        : blockReason === 'nothing-unlocked' ? 'Nothing unlocked yet' : 'None right now';
  const reviewSub = dueNow
    ? (hasSession ? 'Session in progress' : `${plural(dueNow, 'item')} due`)
    : (nextAt ? `Next ${whenPhrase(nextAt, t)}` : 'Nothing scheduled');

  main.innerHTML = `
    <section class="screen stack home">
      <div class="card home-hero">
        ${ring(lp.ratio, `Lv ${level}`, pct(lp.ratio))}
        <div class="hero-text">
          <h1>${greeting()}</h1>
          <p class="muted">Level ${level} · ${lp.guru} of ${lp.total} at Guru or above · ${lp.started - lp.guru} in progress</p>
          <div class="btn-row">
            <span class="streak" title="Days in a row with lessons or reviews"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 2s.7 3.2-1.2 5.3C10.6 9.2 8 10.4 8 14a4.5 4.5 0 0 0 9 0c0-1.6-.7-2.8-1.4-3.7-.2 1.2-.9 1.9-1.6 2.2.5-2.6-.3-5.5-.5-10.5zM12 22a7 7 0 0 1-7-7c0-3.3 1.8-5.1 3.4-6.6-.2 1.5.1 2.7.9 3.4A5.5 5.5 0 0 0 11 4.2c3 1.2 8 4.5 8 10.8a7 7 0 0 1-7 7z"/></svg> ${plural(streak, 'day')} streak</span>
            <a class="btn btn-sm btn-ghost" href="#/levels/${level}">See level ${level} →</a>
          </div>
        </div>
      </div>

      <div class="big-buttons">
        <a class="big-btn big-btn-lessons ${lessons.length ? '' : 'is-empty'}" href="#/lessons">
          <span class="big-btn-label">Lessons</span>
          <span class="big-btn-count">${lessons.length}</span>
          <span class="big-btn-sub">${esc(lessonSub)}</span>
          <span class="big-btn-glyph" aria-hidden="true">学</span>
        </a>
        <a class="big-btn big-btn-reviews ${dueNow ? '' : 'is-empty'}" href="#/reviews">
          <span class="big-btn-label">Reviews</span>
          <span class="big-btn-count">${dueNow}</span>
          <span class="big-btn-sub">${esc(reviewSub)}</span>
          <span class="big-btn-glyph" aria-hidden="true">復</span>
        </a>
      </div>

      <div class="grid-2">
        <div class="card">
          <h2>Today <span class="muted">${esc(fmtDate(t))}</span></h2>
          <div class="stat-row">
            <div class="stat"><div class="stat-value">${today.reviews}</div><div class="stat-label">Reviews</div></div>
            <div class="stat"><div class="stat-value">${today.reviews ? pct(today.correct / today.reviews) : '—'}</div><div class="stat-label">Accuracy</div></div>
            <div class="stat"><div class="stat-value">${today.lessons}<span class="muted" style="font-size:.9rem">/${p.settings.dailyLessons}</span></div><div class="stat-label">Lessons</div></div>
          </div>
          <p class="small muted" style="margin:12px 0 0">${nextAt ? `Next review ${esc(whenPhrase(nextAt, t))} (${relPhrase(nextAt, t)}).` : (dueNow ? 'Reviews are waiting for you.' : 'No reviews scheduled — do some lessons to get started.')}</p>
        </div>
        <div class="card">
          <h2>Next 24 hours <span class="muted">${plural(upcoming, 'review')}</span></h2>
          ${bars(fc.hours, hourLabels)}
        </div>
      </div>

      <div class="card">
        <h2>Stages <span class="muted">${Object.keys(p.items).length} started · ${groups.locked} locked</span></h2>
        <div class="group-counts">
          ${srs.GROUPS.map((g) => `<a class="group-count stage-${g}" href="#/stats" title="${esc(g)}"><div class="n">${groups[g]}</div><div class="l">${esc(g)}</div></a>`).join('')}
        </div>
      </div>

      ${mistakes.length ? `<div class="card"><h2>Recent mistakes</h2>${chipList(mistakes)}</div>` : ''}

      ${!Object.keys(p.items).length ? `
        <div class="card about">
          <h2>Welcome to Kanjr</h2>
          <p>Kanjr teaches you the <strong>meaning</strong> of every jōyō kanji using spaced repetition. Start with a few lessons; reviews come back at growing intervals (4 h, 8 h, a day, two days, a week…) until each kanji is burned into memory.</p>
          <p>Answers are typed in English. Small typos are forgiven; a completely different kanji's meaning is not.</p>
          <div class="btn-row"><a class="btn btn-primary" href="#/lessons">Start your first lessons</a><a class="btn" href="#/settings">Adjust the pace</a></div>
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
  return `<div class="lesson-dots" aria-hidden="true">
    ${L.ids.map((_, i) => `<span class="${i < L.index || quizActive ? 'is-done' : ''} ${i === L.index && !quizActive ? 'is-current' : ''}"></span>`).join('')}
    <span class="is-quiz ${quizActive ? 'is-current' : ''}"></span>
  </div>`;
}

function renderLessonCard(L) {
  const id = L.ids[L.index];
  const item = itemOf(id);
  const isLast = L.index === L.ids.length - 1;
  const alt = Array.isArray(item.alt) ? item.alt : [];
  const peek = L.peek ? itemOf(L.peek) : null;

  main.innerHTML = `
    <section class="screen lesson">
      <div class="screen-head"><h1>Lesson ${L.index + 1} of ${L.ids.length}</h1><span class="muted small"><kbd>←</kbd> <kbd>→</kbd> to move · <kbd>Enter</kbd> for next</span></div>
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
          ${item.freq ? `<span class="pill">Frequency #${esc(item.freq)}</span>` : ''}
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
  const more = engine.lessonQueue(app.data, p, t).length;
  const due = engine.dueCount(p, t);
  const firstDue = engine.nextReviewAt(p, t);
  main.innerHTML = `
    <section class="screen lesson">
      <div class="card session-summary fade-in">
        <div class="big-number">${L.ids.length}</div>
        <h2>${L.ids.length === 1 ? 'item learned' : 'items learned'}</h2>
        <p class="muted">They enter the SRS at Apprentice 1 and come back for review ${esc(whenPhrase(firstDue, t) || 'in about 4 hours')}.</p>
        <div style="margin:16px 0">${chipList(L.ids)}</div>
        <div class="btn-row" style="justify-content:center">
          ${more ? `<button class="btn btn-primary" data-act="more">Next batch (${Math.min(more, app.progress.settings.lessonBatch)})</button>` : ''}
          ${due ? `<a class="btn ${more ? '' : 'btn-primary'}" href="#/reviews">Reviews (${due})</a>` : ''}
          <a class="btn btn-ghost" href="#/">Home</a>
        </div>
      </div>
    </section>`;
  const moreBtn = $('[data-act="more"]', main);
  if (moreBtn) { moreBtn.addEventListener('click', () => { app.lesson = null; renderLessons(); }); moreBtn.focus(); }
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
      setProgress(engine.applyReview(app.progress, id, wrong, now()));
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
  const missed = s.done.filter((d) => d.wrong > 0).map((d) => d.id);
  const t = now();
  const nextAt = engine.nextReviewAt(app.progress, t);
  const lessons = engine.lessonQueue(app.data, app.progress, t).length;
  main.innerHTML = `
    <section class="screen review">
      <div class="card session-summary fade-in">
        <div class="big-number">${stats.done ? pct(stats.accuracy) : '—'}</div>
        <h2>${stats.done ? `${stats.firstTry} of ${plural(stats.done, 'review')} right first time` : 'Session ended'}</h2>
        <p class="muted">${nextAt ? `Next review ${esc(whenPhrase(nextAt, t))}.` : 'Nothing else is scheduled right now.'}</p>
        ${missed.length ? `<div class="section-label" style="text-align:left">Missed this session</div><div style="text-align:left">${chipList(missed)}</div>` : ''}
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
  const alt = Array.isArray(item.alt) ? item.alt : [];
  const total = entry ? entry.correct + entry.incorrect : 0;

  const dueText = !entry ? 'Not started'
    : stage === 9 ? 'Never — burned'
      : entry.due ? (srs.toMillis(entry.due) <= t.getTime() ? `Due now (${fmtDateTime(entry.due)})` : `${fmtDateTime(entry.due)} (${relPhrase(entry.due, t)})`) : '—';

  main.innerHTML = `
    <section class="screen stack item-page">
      <div class="card">
        <div class="item-head">
          <div class="glyph">${esc(item.char)}</div>
          <div class="item-title">
            <div class="btn-row" style="margin-bottom:6px">${typeBadge(item)} ${stageBadge(stage)} ${!entry && !unlocked ? '<span class="badge stage-locked">Locked</span>' : ''}</div>
            <h1>${esc(item.name)}</h1>
            ${alt.length ? `<p class="muted">also: ${esc(alt.join(', '))}</p>` : ''}
            <div class="item-facts">
              <a class="pill" href="#/levels/${esc(item.level)}">Level ${esc(item.level)}</a>
              ${item.strokes ? `<span class="pill">${plural(item.strokes, 'stroke')}</span>` : ''}
              ${item.grade ? `<span class="pill">Grade ${esc(item.grade)}</span>` : ''}
              ${item.jlpt ? `<span class="pill">JLPT N${esc(item.jlpt)}</span>` : ''}
              ${item.freq ? `<span class="pill">Frequency #${esc(item.freq)}</span>` : ''}
            </div>
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
}

// --- Levels ----------------------------------------------------------------

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
    return `<a class="tile stage-${srs.groupOf(stage)} type-${esc(it.type)}" href="${itemHref(id)}"
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

  main.innerHTML = `
    <section class="screen stack">
      <div class="screen-head"><h1>Stats</h1><span class="muted small">${Object.keys(p.items).length} of ${totalItems} items started</span></div>

      <div class="stat-row">
        <div class="stat card"><div class="stat-value">${accuracy == null ? '—' : pct(accuracy)}</div><div class="stat-label">Accuracy (all time)</div></div>
        <div class="stat card"><div class="stat-value">${r7 ? pct(c7 / r7) : '—'}</div><div class="stat-label">Accuracy (7 days)</div></div>
        <div class="stat card"><div class="stat-value">${totalReviews}</div><div class="stat-label">Reviews (30 days)</div></div>
        <div class="stat card"><div class="stat-value">${engine.streak(p.days, t)}</div><div class="stat-label">Day streak</div></div>
        <div class="stat card"><div class="stat-value">${groups.burned}</div><div class="stat-label">Burned</div></div>
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
        ${num('dailyLessons', 'Lessons per day', 'Gentle 4 · Standard 6 · Fast 10. New items per day.', 0, 100)}
        ${num('apprenticeCap', 'Apprentice cap', 'No new lessons while this many items sit in Apprentice. Keeps review debt in check.', 1, 1000)}
        ${num('unlockStage', 'Unlock stage', 'A kanji becomes available once all its parts reach this stage (3 = Apprentice 3, 5 = Guru 1).', 1, 9)}
        ${num('lessonBatch', 'Lesson batch size', 'Items per lesson batch before the quiz.', 1, 20)}
      </div>

      <div class="card">
        <h2>Reviews</h2>
        ${toggle('lightning', 'Lightning mode', 'Move on automatically after a correct answer.')}
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
        <h2>Your data</h2>
        <p class="small muted">Progress lives in this browser (${itemCount} items, ${app.progress.reviews.length} logged reviews). Export a copy regularly — it is the only way to move to another device.
        ${lastExport ? `Last export: ${esc(fmtDate(lastExport))}.` : 'Never exported yet.'}</p>
        <div class="btn-row">
          <button class="btn btn-primary" data-act="export">Export JSON</button>
          <button class="btn" data-act="import">Import JSON…</button>
          <input type="file" accept="application/json,.json" data-role="file" class="sr-only" tabindex="-1" aria-hidden="true">
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

  // Export / import
  $('[data-act="export"]', main).addEventListener('click', () => {
    store.flush();
    store.downloadExport(app.progress, now());
    markExported();
    toast('Progress exported', 'ok');
    hideExportReminder();
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
  const routeName = { home: 'home', lessons: 'home', reviews: 'home', item: 'levels', levels: 'levels', stats: 'stats', settings: 'settings' }[head] || '';
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
      case 'stats': renderStats(); break;
      case 'settings': renderSettings(); break;
      default: renderNotFound();
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<section class="screen">${emptyState('誤', 'Something went wrong', `<span class="small muted">${esc(err && err.message)}</span>`, '<a class="btn btn-primary" href="#/">Home</a>')}</section>`;
  }
  window.scrollTo({ top: 0 });
  document.title = { home: 'Kanjr', lessons: 'Lessons · Kanjr', reviews: 'Reviews · Kanjr', item: 'Item · Kanjr', levels: 'Levels · Kanjr', stats: 'Stats · Kanjr', settings: 'Settings · Kanjr' }[head] || 'Kanjr';
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
}

boot();
