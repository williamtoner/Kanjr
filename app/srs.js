/**
 * srs.js — WaniKani-style SRS stage transitions.
 *
 * Pure functions only: no DOM, no storage, no clocks. Every function takes
 * the time it needs as an argument so it can be unit tested deterministically.
 *
 * Stages:
 *   0 locked / not started
 *   1–4 Apprentice 1–4      (4 h, 8 h, 1 d, 2 d)
 *   5–6 Guru 1–2            (1 w, 2 w)
 *   7   Master              (30 d)
 *   8   Enlightened         (120 d)
 *   9   Burned              (never reviewed again)
 */

export const MIN_STAGE = 0;
export const MAX_STAGE = 9;
export const BURNED = 9;

/** Hours until the next review, indexed by stage. `null` = no review. */
const INTERVALS = Object.freeze([
  null,       // 0 locked
  4,          // 1 Apprentice 1
  8,          // 2 Apprentice 2
  24,         // 3 Apprentice 3
  48,         // 4 Apprentice 4
  24 * 7,     // 5 Guru 1
  24 * 14,    // 6 Guru 2
  24 * 30,    // 7 Master
  24 * 120,   // 8 Enlightened
  null,       // 9 Burned
]);

const NAMES = Object.freeze([
  'Not started',
  'Apprentice 1', 'Apprentice 2', 'Apprentice 3', 'Apprentice 4',
  'Guru 1', 'Guru 2',
  'Master',
  'Enlightened',
  'Burned',
]);

/** Stage groups in display order (excluding "locked"). */
export const GROUPS = Object.freeze(['apprentice', 'guru', 'master', 'enlightened', 'burned']);

/** Hours until the next review for a stage, or `null` for stages 0 and 9. */
export function intervalHours(stage) {
  const s = clampStage(stage);
  return INTERVALS[s];
}

/** Human-readable stage name. */
export function stageName(stage) {
  return NAMES[clampStage(stage)];
}

/** Group name for a stage: locked | apprentice | guru | master | enlightened | burned. */
export function groupOf(stage) {
  const s = clampStage(stage);
  if (s === 0) return 'locked';
  if (s <= 4) return 'apprentice';
  if (s <= 6) return 'guru';
  if (s === 7) return 'master';
  if (s === 8) return 'enlightened';
  return 'burned';
}

/** Coerce anything to an integer stage within [0, 9]. */
export function clampStage(stage) {
  const n = Number(stage);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_STAGE, Math.max(MIN_STAGE, Math.trunc(n)));
}

/**
 * Round a time *down* to the start of its hour (UTC hour boundaries are the
 * same instants as local hour boundaries, so this is timezone-agnostic).
 * Accepts a Date, epoch ms or ISO string; returns a Date.
 */
export function floorToHour(when) {
  const t = toMillis(when);
  return new Date(Math.floor(t / 3600000) * 3600000);
}

/**
 * Compute the stage an item lands on after a review is completed.
 *
 * `wrong` is how many times the item was answered incorrectly in the session
 * before the correct answer. Zero wrongs → one stage up. Otherwise the drop is
 * ceil(wrong / 2) × penalty, where penalty is 1 for Apprentice and 2 for
 * Guru and above, floored at stage 1.
 */
export function nextStage(stage, wrong = 0) {
  const s = clampStage(stage);
  const w = Math.max(0, Math.trunc(Number(wrong) || 0));
  if (w === 0) return Math.min(MAX_STAGE, s + 1);
  const penalty = s >= 5 ? 2 : 1;
  return Math.max(1, s - Math.ceil(w / 2) * penalty);
}

/**
 * Pure SRS transition.
 *
 * @param {{stage:number, wrong?:number}} state  current stage and session wrong count
 * @param {Date|number|string} now               the time of the (correct) answer
 * @returns {{stage:number, due:string|null}}   new stage and ISO due time,
 *          floored to the hour; `due` is null once the item is burned.
 */
export function nextState(state, now) {
  const stage = nextStage(state ? state.stage : 0, state ? state.wrong : 0);
  const hours = intervalHours(stage);
  if (hours == null) return { stage, due: null };
  const dueMs = floorToHour(now).getTime() + hours * 3600000;
  return { stage, due: new Date(dueMs).toISOString() };
}

/** Convert Date | number | ISO string to epoch milliseconds. */
export function toMillis(when) {
  if (when instanceof Date) return when.getTime();
  if (typeof when === 'number') return when;
  if (typeof when === 'string') return new Date(when).getTime();
  return Date.now();
}
