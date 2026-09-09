import assert from 'assert';
import { mergeProgress, fingerprint, toSyncPayload, SYNC_LOG_CAP } from '../app/sync.js';

const base = (over = {}) => Object.assign({
  version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z',
  settings: { dailyLessons: 10, theme: 'auto' }, items: {}, synonyms: {}, notes: {}, reviews: [], days: {},
}, over);
const entry = (stage, correct, incorrect, extra = {}) => Object.assign({ stage, due: '2026-09-10T00:00:00.000Z', startedAt: '2026-09-05T00:00:00.000Z', guruAt: null, burnedAt: null, correct, incorrect }, extra);

export const tests = {
  'merge keeps the entry with more answers, ties to the higher stage': () => {
    const a = base({ items: { 'k:日': entry(3, 5, 1), 'k:月': entry(2, 2, 0), 'k:人': entry(4, 3, 0) } });
    const b = base({ items: { 'k:日': entry(2, 4, 0), 'k:月': entry(5, 2, 0), 'k:大': entry(1, 0, 0) } });
    const m = mergeProgress(a, b);
    assert.strictEqual(m.items['k:日'].stage, 3);
    assert.strictEqual(m.items['k:月'].stage, 5);
    assert.strictEqual(m.items['k:人'].stage, 4);
    assert.strictEqual(m.items['k:大'].stage, 1);
    assert.deepStrictEqual(a.items['k:月'], entry(2, 2, 0), 'inputs are not mutated');
  },
  'merge keeps the manual flag and earliest start': () => {
    const a = base({ items: { 'k:日': entry(2, 1, 0, { manual: true, startedAt: '2026-09-08T00:00:00.000Z' }) } });
    const b = base({ items: { 'k:日': entry(3, 4, 0, { startedAt: '2026-09-02T00:00:00.000Z' }) } });
    const m = mergeProgress(a, b);
    assert.strictEqual(m.items['k:日'].manual, true);
    assert.strictEqual(m.items['k:日'].startedAt, '2026-09-02T00:00:00.000Z');
    assert.strictEqual(m.items['k:日'].stage, 3);
  },
  'merge unions the review log, days take the max, synonyms and notes union': () => {
    const a = base({ reviews: [{ t: '2026-09-09T01:00:00Z', id: 'k:日', ok: true }], days: { '2026-09-09': { lessons: 2, reviews: 10, correct: 8 } },
      synonyms: { 'k:大': ['huge'] }, notes: { 'k:日': 'short' } });
    const b = base({ reviews: [{ t: '2026-09-09T00:00:00Z', id: 'k:月', ok: false }, { t: '2026-09-09T01:00:00Z', id: 'k:日', ok: true }],
      days: { '2026-09-09': { lessons: 0, reviews: 12, correct: 7, manual: 3 } }, synonyms: { 'k:大': ['Huge', 'enormous'] }, notes: { 'k:日': 'a longer note' } });
    const m = mergeProgress(a, b);
    assert.strictEqual(m.reviews.length, 2);
    assert.strictEqual(m.reviews[0].id, 'k:月', 'sorted by time');
    assert.deepStrictEqual(m.days['2026-09-09'], { lessons: 2, reviews: 12, correct: 8, manual: 3 });
    assert.deepStrictEqual(m.synonyms['k:大'], ['huge', 'enormous']);
    assert.strictEqual(m.notes['k:日'], 'a longer note');
  },
  'merge takes settings from the newer side and the earliest createdAt': () => {
    const a = base({ updatedAt: '2026-09-09T12:00:00Z', settings: { dailyLessons: 12, theme: 'dark' }, createdAt: '2026-09-03T00:00:00Z' });
    const b = base({ updatedAt: '2026-09-08T12:00:00Z', settings: { dailyLessons: 6, theme: 'light', lightning: true }, createdAt: '2026-09-01T00:00:00Z' });
    const m = mergeProgress(a, b);
    assert.strictEqual(m.settings.dailyLessons, 12);
    assert.strictEqual(m.settings.lightning, true, 'keys only the older side has are kept');
    assert.strictEqual(m.createdAt, '2026-09-01T00:00:00Z');
    assert.strictEqual(m.updatedAt, '2026-09-09T12:00:00Z');
  },
  'merge with a missing side returns the other unchanged': () => {
    const a = base();
    assert.strictEqual(mergeProgress(a, null), a);
    assert.strictEqual(mergeProgress(null, a), a);
  },
  'fingerprint changes when progress changes': () => {
    const a = base({ items: { 'k:日': entry(3, 5, 1) } });
    const b = base({ items: { 'k:日': entry(4, 6, 1) } });
    assert.notStrictEqual(fingerprint(a), fingerprint(b));
    assert.strictEqual(fingerprint(a), fingerprint(Object.assign({}, a)));
  },
  'sync payload caps the review log': () => {
    const reviews = []; for (let i = 0; i < SYNC_LOG_CAP + 50; i++) reviews.push({ t: `t${i}`, id: 'k:日', ok: true });
    const p = toSyncPayload(base({ reviews }));
    assert.strictEqual(p.reviews.length, SYNC_LOG_CAP);
    assert.strictEqual(p.reviews[0].t, 't50');
  },
};
