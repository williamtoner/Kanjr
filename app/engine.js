/**
 * engine.js — lesson and review queue logic.
 *
 * Every function here is pure: it takes the dataset, the progress object,
 * the current time and (where randomness is needed) an `rng` function, and
 * returns new values without mutating its inputs. The UI layer (app.js)
 * owns side effects.
 *
 * Terminology
 *   data      the parsed kanji.json ({ meta, items, levels })
 *   progress  the persisted progress object (see store.js)
 *   session   an in-flight review session (JSON-serialisable)
 */

import { nextState, groupOf, toMillis, GROUPS } from './srs.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const REVIEW_LOG_CAP = 20000;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Local calendar key, YYYY-MM-DD, for a Date/ms/ISO value. */
export function dayKey(when) {
  const d = new Date(toMillis(when));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Alias that reads better at call sites. */
export const todayKey = dayKey;

/** Number of whole local calendar days from `a` to `b` (b − a). */
export function calendarDaysBetween(a, b) {
  const da = new Date(toMillis(a));
  const db = new Date(toMillis(b));
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / DAY);
}

// ---------------------------------------------------------------------------
// Basic accessors
// ---------------------------------------------------------------------------

/** All item ids in global learning order (levels[].items flattened). */
export function orderedIds(data) {
  const out = [];
  for (const level of (data && data.levels) || []) {
    for (const id of level.items || []) out.push(id);
  }
  return out;
}

/** SRS stage of an item (0 when it has no progress). */
export function stageOf(progress, id) {
  const entry = progress && progress.items && progress.items[id];
  return entry ? Number(entry.stage) || 0 : 0;
}

/** Does every component of `item` sit at or above `unlockStage`? */
export function isUnlocked(item, progress, unlockStage) {
  if (!item) return false;
  const parts = Array.isArray(item.parts) ? item.parts : [];
  return parts.every((pid) => stageOf(progress, pid) >= unlockStage);
}

/** Number of items currently in Apprentice (stages 1–4). */
export function apprenticeCount(progress) {
  let n = 0;
  const items = (progress && progress.items) || {};
  for (const id in items) {
    const s = Number(items[id].stage) || 0;
    if (s >= 1 && s <= 4) n++;
  }
  return n;
}

/**
 * Counts per stage group. When `data` is given, `locked` counts items in the
 * dataset without progress; otherwise it is 0.
 */
export function groupCounts(progress, data) {
  const counts = { locked: 0 };
  for (const g of GROUPS) counts[g] = 0;
  const items = (progress && progress.items) || {};
  let started = 0;
  for (const id in items) {
    const s = Number(items[id].stage) || 0;
    if (s === 0) continue;
    started++;
    counts[groupOf(s)]++;
  }
  if (data && data.items) counts.locked = Math.max(0, Object.keys(data.items).length - started);
  return counts;
}

/** Lessons already completed today (local time). */
export function lessonsDoneToday(progress, now) {
  const rec = progress && progress.days && progress.days[dayKey(now)];
  return rec ? Number(rec.lessons) || 0 : 0;
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/**
 * Items eligible for a lesson right now, in global order.
 *
 * An item is eligible when it has no progress and every part is at or above
 * `settings.unlockStage`. Locked items are skipped, not blocked on.
 *
 * Limits (unless `opts.ignoreLimits`): at most `dailyLessons − done today`,
 * and none while the Apprentice count is at or above `apprenticeCap`.
 */
export function lessonQueue(data, progress, now, opts = {}) {
  const settings = (progress && progress.settings) || {};
  const unlockStage = Number(settings.unlockStage) || 0;
  const unlocked = [];
  for (const id of orderedIds(data)) {
    const item = data.items[id];
    if (!item || stageOf(progress, id) > 0) continue;
    if (isUnlocked(item, progress, unlockStage)) unlocked.push(id);
  }
  if (opts.ignoreLimits) return unlocked;

  const cap = Number(settings.apprenticeCap);
  if (Number.isFinite(cap) && apprenticeCount(progress) >= cap) return [];
  const daily = Number(settings.dailyLessons);
  const remaining = Number.isFinite(daily)
    ? Math.max(0, daily - lessonsDoneToday(progress, now))
    : unlocked.length;
  return unlocked.slice(0, remaining);
}

/** Why no lessons are available (for friendly empty states), or null. */
export function lessonBlockReason(data, progress, now) {
  const settings = (progress && progress.settings) || {};
  const unlocked = lessonQueue(data, progress, now, { ignoreLimits: true });
  if (unlocked.length === 0) return 'nothing-unlocked';
  if (apprenticeCount(progress) >= Number(settings.apprenticeCap)) return 'apprentice-cap';
  if (lessonsDoneToday(progress, now) >= Number(settings.dailyLessons)) return 'daily-cap';
  return null;
}

/**
 * Record a completed lesson: the item enters the SRS at Apprentice 1 and
 * today's lesson count goes up. Returns a new progress object.
 */
export function applyLesson(progress, id, now) {
  const nowMs = toMillis(now);
  const iso = new Date(nowMs).toISOString();
  const { stage, due } = nextState({ stage: 0, wrong: 0 }, nowMs);
  const prev = (progress.items && progress.items[id]) || {};
  const entry = {
    stage,
    due,
    startedAt: prev.startedAt || iso,
    guruAt: prev.guruAt || null,
    burnedAt: prev.burnedAt || null,
    correct: Number(prev.correct) || 0,
    incorrect: Number(prev.incorrect) || 0,
  };
  const key = dayKey(nowMs);
  const day = Object.assign({ lessons: 0, reviews: 0, correct: 0 }, progress.days && progress.days[key]);
  day.lessons += 1;
  return Object.assign({}, progress, {
    updatedAt: iso,
    items: Object.assign({}, progress.items, { [id]: entry }),
    days: Object.assign({}, progress.days, { [key]: day }),
  });
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

/** Ids of items that are due (1 ≤ stage ≤ 8 and due ≤ now), unordered. */
/**
 * Put items straight into circulation without a lesson, for kanji the
 * learner already knows. They enter at Apprentice 1 exactly like a lesson
 * would, but they do not use up today's lesson allowance: the day record
 * counts them under `manual` instead of `lessons`. Items that already have
 * progress are left untouched.
 */
export function startManually(progress, ids, now) {
  const nowMs = toMillis(now);
  const iso = new Date(nowMs).toISOString();
  const items = Object.assign({}, progress.items);
  let added = 0;
  for (const id of ids) {
    if (items[id] && items[id].stage > 0) continue;
    const { stage, due } = nextState({ stage: 0, wrong: 0 }, nowMs);
    items[id] = { stage, due, startedAt: iso, guruAt: null, burnedAt: null, correct: 0, incorrect: 0 };
    added += 1;
  }
  if (!added) return progress;
  const key = dayKey(nowMs);
  const day = Object.assign({ lessons: 0, reviews: 0, correct: 0, manual: 0 }, progress.days && progress.days[key]);
  day.manual = (Number(day.manual) || 0) + added;
  return Object.assign({}, progress, {
    updatedAt: iso,
    items,
    days: Object.assign({}, progress.days, { [key]: day }),
  });
}

export function dueIds(progress, now) {
  const nowMs = toMillis(now);
  const out = [];
  const items = (progress && progress.items) || {};
  for (const id in items) {
    const e = items[id];
    const s = Number(e.stage) || 0;
    if (s < 1 || s > 8 || !e.due) continue;
    if (toMillis(e.due) <= nowMs) out.push(id);
  }
  return out;
}

/** Number of reviews due now. */
export function dueCount(progress, now) {
  return dueIds(progress, now).length;
}

/** Fisher–Yates shuffle into a new array; `rng` returns [0, 1). */
export function shuffle(array, rng = Math.random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * The review queue: due items, shuffled. Only ids that exist in `data` are
 * included so a stale progress file cannot crash the UI.
 */
export function reviewQueue(data, progress, now, rng = Math.random) {
  const ids = dueIds(progress, now).filter((id) => !data || !data.items || data.items[id]);
  // Sort first so the shuffle is deterministic for a given rng regardless of
  // object key order.
  ids.sort();
  return shuffle(ids, rng);
}

/** Wrong answers are re-asked this many positions later (inclusive range). */
export const REQUEUE_MIN = 2;
export const REQUEUE_MAX = 4;

/** Start a review session over the given ids (already shuffled). */
export function createSession(ids, now) {
  return {
    queue: ids.slice(),
    done: [],            // [{ id, wrong }] in completion order
    wrong: {},           // id → wrong answers so far this session
    total: ids.length,
    startedAt: new Date(toMillis(now)).toISOString(),
    wrappingUp: false,
  };
}

/** The id currently being asked, or null when the session is finished. */
export function currentId(session) {
  return session && session.queue.length ? session.queue[0] : null;
}

/**
 * Record an answer for the current item.
 *
 * Correct → the item leaves the queue and is appended to `done` with its
 * wrong count. Wrong → the wrong count goes up and the item is re-inserted
 * a few positions later (REQUEUE_MIN..REQUEUE_MAX, clamped to the queue).
 * Returns a new session object.
 */
export function answerCurrent(session, ok, rng = Math.random) {
  const id = currentId(session);
  if (id == null) return session;
  const rest = session.queue.slice(1);
  const wrongCount = session.wrong[id] || 0;
  if (ok) {
    return Object.assign({}, session, {
      queue: rest,
      done: session.done.concat([{ id, wrong: wrongCount }]),
    });
  }
  const span = REQUEUE_MAX - REQUEUE_MIN + 1;
  const offset = REQUEUE_MIN + Math.floor(rng() * span);
  const at = Math.min(rest.length, offset);
  rest.splice(at, 0, id);
  return Object.assign({}, session, {
    queue: rest,
    wrong: Object.assign({}, session.wrong, { [id]: wrongCount + 1 }),
  });
}

/**
 * Wrap up: keep only items already in progress (answered wrongly at least
 * once and not yet completed); everything untouched is dropped so the
 * session ends quickly. Returns a new session.
 */
export function wrapUp(session) {
  const inProgress = session.queue.filter((id) => (session.wrong[id] || 0) > 0);
  return Object.assign({}, session, {
    queue: inProgress,
    total: session.done.length + inProgress.length,
    wrappingUp: true,
  });
}

/** Summary numbers for the counter and the end-of-session screen. */
export function sessionStats(session) {
  const done = session.done.length;
  const firstTry = session.done.filter((d) => d.wrong === 0).length;
  const remaining = session.queue.length;
  const total = session.total;
  const answered = done + Object.keys(session.wrong).filter(
    (id) => !session.done.some((d) => d.id === id)).length;
  return {
    done,
    remaining,
    total,
    firstTry,
    accuracy: done ? firstTry / done : null,
    answered,
    finished: remaining === 0,
  };
}

/**
 * Record a completed review: SRS transition, counters, the review log and
 * today's numbers. Returns a new progress object.
 */
export function applyReview(progress, id, wrong, now) {
  const nowMs = toMillis(now);
  const iso = new Date(nowMs).toISOString();
  const prev = (progress.items && progress.items[id]) || { stage: 0 };
  const { stage, due } = nextState({ stage: prev.stage, wrong }, nowMs);
  const ok = !(wrong > 0);
  const entry = Object.assign({}, prev, {
    stage,
    due,
    startedAt: prev.startedAt || iso,
    guruAt: prev.guruAt || (stage >= 5 ? iso : null),
    burnedAt: prev.burnedAt || (stage >= 9 ? iso : null),
    correct: (Number(prev.correct) || 0) + 1,
    incorrect: (Number(prev.incorrect) || 0) + (Number(wrong) || 0),
  });
  const key = dayKey(nowMs);
  const day = Object.assign({ lessons: 0, reviews: 0, correct: 0 }, progress.days && progress.days[key]);
  day.reviews += 1;
  if (ok) day.correct += 1;
  let reviews = (progress.reviews || []).concat([{ t: iso, id, ok }]);
  if (reviews.length > REVIEW_LOG_CAP) reviews = reviews.slice(reviews.length - REVIEW_LOG_CAP);
  return Object.assign({}, progress, {
    updatedAt: iso,
    items: Object.assign({}, progress.items, { [id]: entry }),
    days: Object.assign({}, progress.days, { [key]: day }),
    reviews,
  });
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/**
 * The user's current level: the level of the next lesson item in global
 * order (the first item without progress), or, when everything has been
 * started, the highest level with any progress. Falls back to 1.
 */
export function currentLevel(data, progress) {
  if (!data || !data.items) return 1;
  for (const id of orderedIds(data)) {
    if (stageOf(progress, id) === 0) return data.items[id] ? data.items[id].level : 1;
  }
  let best = 0;
  const items = (progress && progress.items) || {};
  for (const id in items) {
    const item = data.items[id];
    if (item && (Number(items[id].stage) || 0) > 0 && item.level > best) best = item.level;
  }
  return best || 1;
}

/** Share of a level's items at Guru or above. */
export function levelProgress(data, progress, level) {
  const entry = ((data && data.levels) || []).find((l) => l.level === level);
  const ids = entry ? entry.items : [];
  let guru = 0, started = 0;
  for (const id of ids) {
    const s = stageOf(progress, id);
    if (s > 0) started++;
    if (s >= 5) guru++;
  }
  return { total: ids.length, guru, started, ratio: ids.length ? guru / ids.length : 0 };
}

// ---------------------------------------------------------------------------
// Forecast, streak, history
// ---------------------------------------------------------------------------

/**
 * Upcoming reviews.
 *   hours[i]  reviews due in [now + i h, now + (i+1) h) for i = 0..23
 *   days[i]   reviews due on the local calendar day today + i, i = 0..6
 *             (today only counts reviews still in the future)
 *   dueNow    reviews already due
 */
export function forecast(progress, now) {
  const nowMs = toMillis(now);
  const hours = new Array(24).fill(0);
  const days = new Array(7).fill(0);
  let dueNow = 0;
  const items = (progress && progress.items) || {};
  for (const id in items) {
    const e = items[id];
    const s = Number(e.stage) || 0;
    if (s < 1 || s > 8 || !e.due) continue;
    const due = toMillis(e.due);
    if (due <= nowMs) { dueNow++; continue; }
    const h = Math.floor((due - nowMs) / HOUR);
    if (h < 24) hours[h]++;
    const d = calendarDaysBetween(nowMs, due);
    if (d >= 0 && d < 7) days[d]++;
  }
  return { dueNow, hours, days };
}

/** ISO time of the next review after `now`, or null when nothing is scheduled. */
export function nextReviewAt(progress, now) {
  const nowMs = toMillis(now);
  let best = null;
  const items = (progress && progress.items) || {};
  for (const id in items) {
    const e = items[id];
    const s = Number(e.stage) || 0;
    if (s < 1 || s > 8 || !e.due) continue;
    const due = toMillis(e.due);
    if (due > nowMs && (best === null || due < best)) best = due;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Consecutive local days with at least one lesson or review, counted back
 * from today. If today has no activity yet the streak continues from
 * yesterday (so it is not broken before the day's session).
 */
export function streak(days, now) {
  const active = (key) => {
    const d = days && days[key];
    return !!d && ((Number(d.lessons) || 0) > 0 || (Number(d.reviews) || 0) > 0);
  };
  const cursor = new Date(toMillis(now));
  if (!active(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (active(dayKey(cursor))) {
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

/** Most recently missed item ids (unique, newest first). */
export function recentMistakes(progress, limit = 10) {
  const seen = new Set();
  const out = [];
  const log = (progress && progress.reviews) || [];
  for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
    const r = log[i];
    if (r.ok || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r.id);
  }
  return out;
}

/** Daily numbers for the last `n` days, oldest first. */
export function dailyHistory(progress, now, n = 30) {
  const out = [];
  const cursor = new Date(toMillis(now));
  cursor.setDate(cursor.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    const key = dayKey(cursor);
    const rec = (progress && progress.days && progress.days[key]) || {};
    out.push({
      date: key,
      lessons: Number(rec.lessons) || 0,
      reviews: Number(rec.reviews) || 0,
      correct: Number(rec.correct) || 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/** Overall review accuracy from the day records: correct / reviews. */
export function overallAccuracy(progress) {
  let reviews = 0, correct = 0;
  const days = (progress && progress.days) || {};
  for (const key in days) {
    reviews += Number(days[key].reviews) || 0;
    correct += Number(days[key].correct) || 0;
  }
  return reviews ? correct / reviews : null;
}
