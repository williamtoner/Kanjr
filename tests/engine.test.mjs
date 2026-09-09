import assert from 'assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  orderedIds, stageOf, isUnlocked, apprenticeCount, groupCounts, lessonsDoneToday,
  lessonQueue, lessonBlockReason, applyLesson, startManually, retractWrong,
  dueIds, dueCount, shuffle, reviewQueue, createSession, currentId, answerCurrent,
  wrapUp, sessionStats, applyReview, REQUEUE_MIN, REQUEUE_MAX, REVIEW_LOG_CAP,
  currentLevel, levelProgress, forecast, nextReviewAt, streak, recentMistakes,
  dailyHistory, overallAccuracy, dayKey, calendarDaysBetween,
} from '../app/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'fixture.json'), 'utf8'));

const HOUR = 3600000;
// Local-time "now" so that day-bucketing tests are timezone independent.
const NOW = new Date(2026, 8, 8, 14, 30, 0); // 8 Sep 2026, 14:30 local
const iso = (d) => new Date(d).toISOString();
const plus = (ms) => iso(NOW.getTime() + ms);

/** Build a progress object with the given item stages and optional overrides. */
function progressWith(stages = {}, extra = {}) {
  const items = {};
  for (const id in stages) {
    const v = stages[id];
    items[id] = typeof v === 'number'
      ? { stage: v, due: plus(-HOUR), startedAt: plus(-3 * HOUR), guruAt: null, burnedAt: null, correct: 0, incorrect: 0 }
      : Object.assign({ stage: 1, due: plus(-HOUR), correct: 0, incorrect: 0 }, v);
  }
  return Object.assign({
    version: 1,
    settings: { dailyLessons: 6, apprenticeCap: 120, unlockStage: 3, lessonBatch: 5 },
    items,
    synonyms: {},
    notes: {},
    reviews: [],
    days: {},
  }, extra);
}

/** Deterministic rng: cycles through the given values. */
function seq(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

export const tests = {
  // --- accessors ----------------------------------------------------------

  'orderedIds flattens levels in learning order': () => {
    const ids = orderedIds(data);
    assert.strictEqual(ids.length, 14);
    assert.strictEqual(ids[0], 'r:丨');
    assert.strictEqual(ids[8], 'k:木');
    assert.strictEqual(ids[9], 'r:也');
    assert.strictEqual(ids[13], 'k:池');
    assert.deepStrictEqual(orderedIds(null), []);
  },

  'stageOf defaults to 0': () => {
    const p = progressWith({ 'k:一': 4 });
    assert.strictEqual(stageOf(p, 'k:一'), 4);
    assert.strictEqual(stageOf(p, 'k:二'), 0);
    assert.strictEqual(stageOf(null, 'k:二'), 0);
  },

  'apprenticeCount counts stages 1–4 only': () => {
    const p = progressWith({ 'k:一': 1, 'k:二': 4, 'k:口': 5, 'k:日': 9, 'k:月': 0 });
    assert.strictEqual(apprenticeCount(p), 2);
  },

  'groupCounts buckets by group and counts locked from the dataset': () => {
    const p = progressWith({ 'k:一': 1, 'k:二': 4, 'k:口': 5, 'k:日': 7, 'k:月': 8, 'k:人': 9 });
    const c = groupCounts(p, data);
    assert.deepStrictEqual(c, { locked: 8, apprentice: 2, guru: 1, master: 1, enlightened: 1, burned: 1 });
  },

  // --- lesson unlock rules ------------------------------------------------

  'items without parts are always unlocked': () => {
    const p = progressWith({});
    assert.ok(isUnlocked(data.items['k:一'], p, 3));
    assert.ok(isUnlocked(data.items['r:丨'], p, 3));   // radicals have no parts field
  },

  'an item is unlocked only when every part reaches unlockStage': () => {
    const p1 = progressWith({ 'k:日': 3 });
    assert.strictEqual(isUnlocked(data.items['k:明'], p1, 3), false, 'moon still locked');
    const p2 = progressWith({ 'k:日': 3, 'k:月': 2 });
    assert.strictEqual(isUnlocked(data.items['k:明'], p2, 3), false, 'moon below unlock stage');
    const p3 = progressWith({ 'k:日': 3, 'k:月': 3 });
    assert.strictEqual(isUnlocked(data.items['k:明'], p3, 3), true);
    // A lower unlockStage setting makes it available sooner.
    assert.strictEqual(isUnlocked(data.items['k:明'], p2, 2), true);
  },

  'lessonQueue takes unlocked items in global order and skips locked ones': () => {
    // 二 depends on 一 (not started), so it is skipped while later atoms are taken.
    const p = progressWith({}, { settings: { dailyLessons: 100, apprenticeCap: 120, unlockStage: 3 } });
    const q = lessonQueue(data, p, NOW);
    assert.deepStrictEqual(q, ['r:丨', 'r:汁', 'k:一', 'k:口', 'k:日', 'k:月', 'k:人', 'k:木', 'r:也']);
  },

  'lessonQueue excludes items that already have progress': () => {
    const p = progressWith({ 'r:丨': 1, 'r:汁': 5, 'k:一': 9 },
      { settings: { dailyLessons: 100, apprenticeCap: 120, unlockStage: 3 } });
    const q = lessonQueue(data, p, NOW);
    assert.ok(!q.includes('r:丨') && !q.includes('r:汁') && !q.includes('k:一'));
    // 一 is burned (≥ unlockStage) so 二 is now unlocked and comes first.
    assert.strictEqual(q[0], 'k:二');
    assert.strictEqual(q[1], 'k:口');
  },

  'lessonQueue unlocks dependants once parts reach the unlock stage': () => {
    const p = progressWith({ 'k:口': 3, 'r:丨': 3, 'k:日': 3, 'k:月': 2 },
      { settings: { dailyLessons: 100, apprenticeCap: 120, unlockStage: 3 } });
    const q = lessonQueue(data, p, NOW);
    assert.ok(q.includes('k:中'), '中 unlocked (mouth + stick at 3)');
    assert.ok(!q.includes('k:明'), '明 locked (moon at 2)');
    assert.ok(!q.includes('k:池'), '池 locked (no radicals learnt)');
  },

  'daily cap: dailyLessons minus lessons done today': () => {
    const today = dayKey(NOW);
    const p = progressWith({}, {
      settings: { dailyLessons: 6, apprenticeCap: 120, unlockStage: 3 },
      days: { [today]: { lessons: 4, reviews: 0, correct: 0 } },
    });
    assert.strictEqual(lessonsDoneToday(p, NOW), 4);
    assert.strictEqual(lessonQueue(data, p, NOW).length, 2);
    // Yesterday's lessons do not count against today.
    const p2 = progressWith({}, {
      settings: { dailyLessons: 6, apprenticeCap: 120, unlockStage: 3 },
      days: { '2026-09-07': { lessons: 6, reviews: 0, correct: 0 } },
    });
    assert.strictEqual(lessonQueue(data, p2, NOW).length, 6);
  },

  'daily cap reached: no lessons, reason daily-cap': () => {
    const today = dayKey(NOW);
    const p = progressWith({}, {
      settings: { dailyLessons: 6, apprenticeCap: 120, unlockStage: 3 },
      days: { [today]: { lessons: 6, reviews: 0, correct: 0 } },
    });
    assert.deepStrictEqual(lessonQueue(data, p, NOW), []);
    assert.strictEqual(lessonBlockReason(data, p, NOW), 'daily-cap');
    // Over the cap (setting lowered later) still yields none, never negative.
    p.days[today].lessons = 10;
    assert.deepStrictEqual(lessonQueue(data, p, NOW), []);
  },

  'apprentice cap blocks all lessons while at or above the cap': () => {
    const p = progressWith({ 'k:一': 1, 'k:口': 2, 'k:日': 4 },
      { settings: { dailyLessons: 6, apprenticeCap: 3, unlockStage: 3 } });
    assert.deepStrictEqual(lessonQueue(data, p, NOW), []);
    assert.strictEqual(lessonBlockReason(data, p, NOW), 'apprentice-cap');
    // One of them reaching Guru frees the queue.
    p.items['k:日'].stage = 5;
    assert.ok(lessonQueue(data, p, NOW).length > 0);
    assert.strictEqual(lessonBlockReason(data, p, NOW), null);
  },

  'ignoreLimits returns everything unlocked': () => {
    const today = dayKey(NOW);
    const p = progressWith({ 'k:一': 1 }, {
      settings: { dailyLessons: 1, apprenticeCap: 1, unlockStage: 3 },
      days: { [today]: { lessons: 1, reviews: 0, correct: 0 } },
    });
    assert.deepStrictEqual(lessonQueue(data, p, NOW), []);
    assert.ok(lessonQueue(data, p, NOW, { ignoreLimits: true }).length >= 7);
  },

  'lessonBlockReason reports nothing-unlocked when the set is exhausted': () => {
    const stages = {};
    for (const id of orderedIds(data)) stages[id] = 5;
    const p = progressWith(stages);
    assert.strictEqual(lessonBlockReason(data, p, NOW), 'nothing-unlocked');
  },

  'applyLesson enters stage 1 with a 4 h due time and bumps today': () => {
    const p = progressWith({});
    const next = applyLesson(p, 'k:一', NOW);
    assert.strictEqual(next.items['k:一'].stage, 1);
    assert.strictEqual(next.items['k:一'].due, iso(Math.floor(NOW.getTime() / HOUR) * HOUR + 4 * HOUR));
    assert.strictEqual(next.items['k:一'].startedAt, iso(NOW));
    assert.strictEqual(next.days[dayKey(NOW)].lessons, 1);
    // Immutable: the original is untouched.
    assert.strictEqual(Object.keys(p.items).length, 0);
    assert.deepStrictEqual(p.days, {});
    const again = applyLesson(next, 'k:口', NOW);
    assert.strictEqual(again.days[dayKey(NOW)].lessons, 2);
  },

  // --- review queue -------------------------------------------------------

  'dueIds includes stages 1–8 with due ≤ now and nothing else': () => {
    const p = progressWith({
      'k:一': { stage: 1, due: plus(-HOUR) },
      'k:二': { stage: 8, due: plus(0) },            // exactly now counts
      'k:口': { stage: 4, due: plus(HOUR) },         // future
      'k:日': { stage: 9, due: null },               // burned
      'k:月': { stage: 0, due: null },               // not started
      'k:人': { stage: 3, due: plus(-10 * HOUR) },
    });
    assert.deepStrictEqual(dueIds(p, NOW).sort(), ['k:一', 'k:二', 'k:人']);
    assert.strictEqual(dueCount(p, NOW), 3);
  },

  'shuffle is a permutation and deterministic for a given rng': () => {
    const input = ['a', 'b', 'c', 'd', 'e'];
    const out = shuffle(input, seq([0.1, 0.9, 0.5, 0.3]));
    assert.deepStrictEqual(out.slice().sort(), input);
    assert.deepStrictEqual(shuffle(input, seq([0.1, 0.9, 0.5, 0.3])), out);
    assert.deepStrictEqual(input, ['a', 'b', 'c', 'd', 'e'], 'input untouched');
    // A different rng gives a different order for this input.
    assert.notDeepStrictEqual(shuffle(input, seq([0.99])), out);
  },

  'reviewQueue is the shuffled due set and ignores unknown ids': () => {
    const p = progressWith({ 'k:一': 1, 'k:二': 2, 'k:口': 3, 'k:日': 4, 'k:ghost': 2 });
    const q = reviewQueue(data, p, NOW, seq([0.42, 0.17, 0.83]));
    assert.deepStrictEqual(q.slice().sort(), ['k:一', 'k:二', 'k:口', 'k:日']);
    assert.strictEqual(q.length, 4);
  },

  'a session walks the queue; correct answers complete items': () => {
    let s = createSession(['a', 'b', 'c'], NOW);
    assert.strictEqual(currentId(s), 'a');
    assert.strictEqual(s.total, 3);
    s = answerCurrent(s, true);
    assert.strictEqual(currentId(s), 'b');
    assert.deepStrictEqual(s.done, [{ id: 'a', wrong: 0 }]);
    s = answerCurrent(s, true);
    s = answerCurrent(s, true);
    assert.strictEqual(currentId(s), null);
    assert.strictEqual(sessionStats(s).finished, true);
    assert.strictEqual(sessionStats(s).accuracy, 1);
  },

  'a wrong answer requeues the item a few positions later': () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    // rng 0 → offset REQUEUE_MIN; rng ~1 → REQUEUE_MAX
    let s = answerCurrent(createSession(ids, NOW), false, () => 0);
    assert.deepStrictEqual(s.queue, ['b', 'c', 'a', 'd', 'e', 'f']);
    assert.strictEqual(s.queue.indexOf('a'), REQUEUE_MIN);
    assert.strictEqual(s.wrong.a, 1);
    s = answerCurrent(createSession(ids, NOW), false, () => 0.999);
    assert.strictEqual(s.queue.indexOf('a'), REQUEUE_MAX);
    assert.strictEqual(s.done.length, 0);
  },

  'requeue clamps to the end of a short queue and keeps counting wrongs': () => {
    let s = createSession(['a', 'b'], NOW);
    s = answerCurrent(s, false, () => 0.999);
    assert.deepStrictEqual(s.queue, ['b', 'a']);
    s = answerCurrent(s, true);               // b done
    s = answerCurrent(s, false, () => 0.5);   // a wrong again, alone in the queue
    assert.deepStrictEqual(s.queue, ['a']);
    assert.strictEqual(s.wrong.a, 2);
    s = answerCurrent(s, true);
    assert.deepStrictEqual(s.done, [{ id: 'b', wrong: 0 }, { id: 'a', wrong: 2 }]);
    const st = sessionStats(s);
    assert.strictEqual(st.done, 2);
    assert.strictEqual(st.firstTry, 1);
    assert.strictEqual(st.accuracy, 0.5);
  },

  'answering a finished session is a no-op': () => {
    const s = createSession([], NOW);
    assert.strictEqual(answerCurrent(s, true), s);
  },

  'wrapUp keeps only items already answered wrongly': () => {
    let s = createSession(['a', 'b', 'c', 'd', 'e'], NOW);
    s = answerCurrent(s, false, () => 0);   // a wrong → [b, c, a, d, e]
    s = answerCurrent(s, true);             // b done → [c, a, d, e]
    s = wrapUp(s);
    assert.deepStrictEqual(s.queue, ['a']);
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.wrappingUp, true);
    const st = sessionStats(s);
    assert.strictEqual(st.remaining, 1);
    assert.strictEqual(st.done, 1);
  },

  'wrapUp with nothing in progress ends the session immediately': () => {
    const s = wrapUp(createSession(['a', 'b'], NOW));
    assert.deepStrictEqual(s.queue, []);
    assert.strictEqual(s.total, 0);
    assert.ok(sessionStats(s).finished);
  },

  'sessions survive a JSON round trip (sessionStorage safe)': () => {
    let s = createSession(['a', 'b', 'c'], NOW);
    s = answerCurrent(s, false, () => 0);
    const back = JSON.parse(JSON.stringify(s));
    assert.deepStrictEqual(back, s);
    assert.strictEqual(currentId(back), 'b');
  },

  'applyReview: correct first time advances and logs': () => {
    const p = progressWith({ 'k:一': { stage: 2, due: plus(-HOUR), correct: 3, incorrect: 1 } });
    const next = applyReview(p, 'k:一', 0, NOW);
    const e = next.items['k:一'];
    assert.strictEqual(e.stage, 3);
    assert.strictEqual(e.due, iso(Math.floor(NOW.getTime() / HOUR) * HOUR + 24 * HOUR));
    assert.strictEqual(e.correct, 4);
    assert.strictEqual(e.incorrect, 1);
    assert.deepStrictEqual(next.reviews, [{ t: iso(NOW), id: 'k:一', ok: true }]);
    assert.deepStrictEqual(next.days[dayKey(NOW)], { lessons: 0, reviews: 1, correct: 1 });
    assert.strictEqual(p.items['k:一'].stage, 2, 'input not mutated');
  },

  'applyReview: wrong answers drop the stage and count as incorrect': () => {
    const p = progressWith({ 'k:一': { stage: 6, due: plus(-HOUR), correct: 0, incorrect: 0 } });
    const next = applyReview(p, 'k:一', 2, NOW);
    assert.strictEqual(next.items['k:一'].stage, 4);
    assert.strictEqual(next.items['k:一'].correct, 1);
    assert.strictEqual(next.items['k:一'].incorrect, 2);
    assert.strictEqual(next.reviews[0].ok, false);
    assert.deepStrictEqual(next.days[dayKey(NOW)], { lessons: 0, reviews: 1, correct: 0 });
  },

  'applyReview stamps guruAt and burnedAt once': () => {
    const p = progressWith({ 'k:一': { stage: 4, due: plus(-HOUR) } });
    const guru = applyReview(p, 'k:一', 0, NOW);
    assert.strictEqual(guru.items['k:一'].guruAt, iso(NOW));
    const later = new Date(NOW.getTime() + 24 * HOUR);
    const guru2 = applyReview(guru, 'k:一', 0, later);
    assert.strictEqual(guru2.items['k:一'].guruAt, iso(NOW), 'not overwritten');
    const p8 = progressWith({ 'k:一': { stage: 8, due: plus(-HOUR) } });
    const burned = applyReview(p8, 'k:一', 0, NOW);
    assert.strictEqual(burned.items['k:一'].stage, 9);
    assert.strictEqual(burned.items['k:一'].due, null);
    assert.strictEqual(burned.items['k:一'].burnedAt, iso(NOW));
  },

  'the review log is capped at 20 000 entries': () => {
    const log = [];
    for (let i = 0; i < REVIEW_LOG_CAP; i++) log.push({ t: 'x', id: 'k:一', ok: true });
    const p = progressWith({ 'k:一': 1 }, { reviews: log });
    const next = applyReview(p, 'k:一', 0, NOW);
    assert.strictEqual(next.reviews.length, REVIEW_LOG_CAP);
    assert.strictEqual(next.reviews[REVIEW_LOG_CAP - 1].t, iso(NOW));
  },

  // --- levels -------------------------------------------------------------

  'currentLevel is the level of the next unstarted item': () => {
    assert.strictEqual(currentLevel(data, progressWith({})), 1);
    const stages = {};
    for (const id of data.levels[0].items) stages[id] = 3;
    assert.strictEqual(currentLevel(data, progressWith(stages)), 2);
    for (const id of data.levels[1].items) stages[id] = 1;
    assert.strictEqual(currentLevel(data, progressWith(stages)), 2, 'everything started → highest level');
    assert.strictEqual(currentLevel(null, progressWith({})), 1);
  },

  'levelProgress is the share of items at Guru or above': () => {
    const p = progressWith({ 'r:丨': 5, 'r:汁': 9, 'k:一': 4, 'k:二': 1 });
    const lp = levelProgress(data, p, 1);
    assert.strictEqual(lp.total, 9);
    assert.strictEqual(lp.guru, 2);
    assert.strictEqual(lp.started, 4);
    assert.ok(Math.abs(lp.ratio - 2 / 9) < 1e-9);
    assert.deepStrictEqual(levelProgress(data, p, 99), { total: 0, guru: 0, started: 0, ratio: 0 });
  },

  // --- forecast -----------------------------------------------------------

  'forecast buckets by hour offset and counts due-now separately': () => {
    const p = progressWith({
      'k:一': { stage: 1, due: plus(-HOUR) },              // already due
      'k:二': { stage: 1, due: plus(10 * 60000) },         // in 10 min → hour 0
      'k:口': { stage: 2, due: plus(HOUR + 1) },           // just past 1 h → hour 1
      'k:日': { stage: 3, due: plus(23 * HOUR + 59 * 60000) }, // hour 23
      'k:月': { stage: 4, due: plus(24 * HOUR) },          // outside the 24 h window
      'k:人': { stage: 9, due: plus(HOUR) },               // burned: never
    });
    const f = forecast(p, NOW);
    assert.strictEqual(f.dueNow, 1);
    assert.strictEqual(f.hours.length, 24);
    assert.strictEqual(f.hours[0], 1);
    assert.strictEqual(f.hours[1], 1);
    assert.strictEqual(f.hours[23], 1);
    assert.strictEqual(f.hours.reduce((a, b) => a + b, 0), 3);
  },

  'forecast buckets days by local calendar date': () => {
    const midnight = new Date(2026, 8, 9, 0, 0, 0); // tomorrow 00:00 local
    const p = progressWith({
      'k:一': { stage: 1, due: plus(HOUR) },                                  // today
      'k:二': { stage: 1, due: iso(midnight) },                               // tomorrow, first minute
      'k:口': { stage: 2, due: iso(new Date(2026, 8, 9, 23, 0)) },            // tomorrow, late
      'k:日': { stage: 3, due: iso(new Date(2026, 8, 14, 12, 0)) },           // day 6
      'k:月': { stage: 4, due: iso(new Date(2026, 8, 15, 0, 0)) },            // day 7: outside
      'k:人': { stage: 1, due: plus(-HOUR) },                                 // overdue: not forecast
    });
    const f = forecast(p, NOW);
    assert.deepStrictEqual(f.days, [1, 2, 0, 0, 0, 0, 1]);
  },

  'calendarDaysBetween counts whole local days': () => {
    assert.strictEqual(calendarDaysBetween(NOW, NOW), 0);
    assert.strictEqual(calendarDaysBetween(NOW, new Date(2026, 8, 9, 0, 0)), 1);
    assert.strictEqual(calendarDaysBetween(NOW, new Date(2026, 8, 7, 23, 59)), -1);
  },

  'nextReviewAt is the earliest future due time': () => {
    const p = progressWith({
      'k:一': { stage: 1, due: plus(-HOUR) },
      'k:二': { stage: 1, due: plus(5 * HOUR) },
      'k:口': { stage: 2, due: plus(2 * HOUR) },
      'k:日': { stage: 9, due: null },
    });
    assert.strictEqual(nextReviewAt(p, NOW), plus(2 * HOUR));
    assert.strictEqual(nextReviewAt(progressWith({}), NOW), null);
  },

  // --- streak -------------------------------------------------------------

  'streak counts consecutive active days ending today': () => {
    const days = {
      '2026-09-06': { lessons: 0, reviews: 5, correct: 5 },
      '2026-09-07': { lessons: 6, reviews: 0, correct: 0 },
      '2026-09-08': { lessons: 0, reviews: 1, correct: 1 },
    };
    assert.strictEqual(streak(days, NOW), 3);
  },

  'streak survives midnight: yesterday counts when today is still empty': () => {
    const days = {
      '2026-09-06': { lessons: 0, reviews: 5, correct: 5 },
      '2026-09-07': { lessons: 6, reviews: 0, correct: 0 },
    };
    const justAfterMidnight = new Date(2026, 8, 8, 0, 0, 30);
    assert.strictEqual(streak(days, justAfterMidnight), 2);
    const justBeforeMidnight = new Date(2026, 8, 7, 23, 59, 30);
    assert.strictEqual(streak(days, justBeforeMidnight), 2);
  },

  'streak breaks on a gap and treats empty records as inactive': () => {
    const days = {
      '2026-09-04': { lessons: 1, reviews: 0, correct: 0 },
      '2026-09-05': { lessons: 0, reviews: 0, correct: 0 },   // recorded but idle
      '2026-09-06': { lessons: 0, reviews: 5, correct: 5 },
      '2026-09-08': { lessons: 0, reviews: 1, correct: 1 },
    };
    assert.strictEqual(streak(days, NOW), 1);
    assert.strictEqual(streak({}, NOW), 0);
    assert.strictEqual(streak(undefined, NOW), 0);
    // Two idle days → streak is gone.
    assert.strictEqual(streak({ '2026-09-05': { lessons: 1 } }, NOW), 0);
  },

  // --- history ------------------------------------------------------------

  'recentMistakes lists unique misses, newest first': () => {
    const p = progressWith({}, {
      reviews: [
        { t: '1', id: 'k:一', ok: false },
        { t: '2', id: 'k:二', ok: true },
        { t: '3', id: 'k:口', ok: false },
        { t: '4', id: 'k:一', ok: false },
        { t: '5', id: 'k:日', ok: false },
      ],
    });
    assert.deepStrictEqual(recentMistakes(p, 10), ['k:日', 'k:一', 'k:口']);
    assert.deepStrictEqual(recentMistakes(p, 2), ['k:日', 'k:一']);
    assert.deepStrictEqual(recentMistakes(progressWith({})), []);
  },

  'dailyHistory returns n days oldest-first ending today': () => {
    const p = progressWith({}, {
      days: {
        '2026-09-08': { lessons: 2, reviews: 10, correct: 9 },
        '2026-09-06': { lessons: 0, reviews: 4, correct: 2 },
      },
    });
    const h = dailyHistory(p, NOW, 3);
    assert.deepStrictEqual(h.map((d) => d.date), ['2026-09-06', '2026-09-07', '2026-09-08']);
    assert.deepStrictEqual(h[0], { date: '2026-09-06', lessons: 0, reviews: 4, correct: 2 });
    assert.deepStrictEqual(h[1], { date: '2026-09-07', lessons: 0, reviews: 0, correct: 0 });
    assert.strictEqual(h[2].reviews, 10);
    assert.ok(Math.abs(overallAccuracy(p) - 11 / 14) < 1e-9);
    assert.strictEqual(overallAccuracy(progressWith({})), null);
  },
  'startManually puts locked items at Apprentice 1 without spending lessons': () => {
    const p0 = progressWith({});
    const ids = orderedIds(data).slice(0, 3);
    const p1 = startManually(p0, ids, NOW);
    for (const id of ids) {
      assert.strictEqual(stageOf(p1, id), 1);
      assert.strictEqual(p1.items[id].due, iso(NOW), 'due immediately');
      assert.strictEqual(p1.items[id].manual, true);
    }
    assert.strictEqual(dueCount(p1, NOW), 3, 'they are in the review queue at once');
    assert.strictEqual(apprenticeCount(p1), 0, 'manual items do not count against the apprentice cap');
    assert.strictEqual(lessonsDoneToday(p1, NOW), 0);
    assert.strictEqual(p1.days[dayKey(NOW)].manual, 3);
    assert.strictEqual(p0.items[ids[0]], undefined, 'input progress is not mutated');
    // The normal lesson queue no longer offers them.
    const queue = lessonQueue(data, p1, NOW);
    for (const id of ids) assert.ok(!queue.includes(id));
  },
  'startManually leaves items that already have progress alone': () => {
    const [a, b] = orderedIds(data);
    const p0 = progressWith({ [a]: 5 });
    const p1 = startManually(p0, [a, b], NOW);
    assert.strictEqual(stageOf(p1, a), 5);
    assert.strictEqual(stageOf(p1, b), 1);
    assert.strictEqual(p1.days[dayKey(NOW)].manual, 1);
    assert.strictEqual(startManually(p1, [a], NOW), p1, 'nothing to add returns the same object');
  },
  'retractWrong undoes a wrong answer and completes the item': () => {
    const [a, b, c] = orderedIds(data);
    let s = createSession([a, b, c], NOW);
    s = answerCurrent(s, false, () => 0);           // a wrong, requeued
    assert.strictEqual(s.wrong[a], 1);
    assert.ok(s.queue.includes(a));
    const r = retractWrong(s, a);
    assert.strictEqual(r.wrong, 0);
    assert.ok(!r.session.queue.includes(a));
    assert.strictEqual(r.session.wrong[a], undefined);
    assert.deepStrictEqual(r.session.done, [{ id: a, wrong: 0 }]);
    assert.strictEqual(retractWrong(r.session, b).session, r.session, 'nothing to retract');
  },
};
