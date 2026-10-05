import assert from 'assert';
import { pairKey, recordConfusion, recordDuel, confusedPairs, partnersOf, duelGroups, focusGroup, pickDuels, buildQuestions, createDuelSession, duelSummary, diffMask, isSettled, SETTLED_WINS } from '../app/duel.js';

const NOW = new Date('2026-10-05T09:00:00Z');
const K = (char, lookalikes = []) => ({ id: `k:${char}`, type: 'kanji', char, name: char, lookalikes: lookalikes.map((c) => `k:${c}`) });
const data = { items: Object.fromEntries([
  K('未', ['末', '朱']), K('末', ['未', '朱']), K('朱', ['未', '末']),
  K('土', ['士']), K('士', ['土']),
  K('待', ['持', '特', '侍']), K('持', ['待', '特']), K('特', ['待', '持']), K('侍', ['待']),
  K('山'),
].map((k) => [k.id, k]).concat([['r:丨', { id: 'r:丨', type: 'radical', char: '丨', name: 'stick' }]])) };
const learned = (...chars) => ({ items: Object.fromEntries(chars.map((c) => [`k:${c}`, { stage: 2, correct: 1, incorrect: 0 }])), confusions: {} });
const seq = (values) => { let i = 0; return () => values[i++ % values.length]; };

export const tests = {
  'pairKey is order-independent': () => {
    assert.strictEqual(pairKey('k:未', 'k:末'), pairKey('k:末', 'k:未'));
  },
  'recordConfusion counts mix-ups and resets the win streak': () => {
    let p = learned('未', '末');
    p = recordConfusion(p, 'k:未', 'k:末', NOW);
    p = recordDuel(p, ['k:未', 'k:末'], true, NOW);
    assert.strictEqual(p.confusions[pairKey('k:未', 'k:末')].wins, 1);
    const p2 = recordConfusion(p, 'k:末', 'k:未', NOW);
    assert.deepStrictEqual(p2.confusions[pairKey('k:未', 'k:末')], { n: 2, wins: 0, last: NOW.toISOString() });
    assert.strictEqual(p.confusions[pairKey('k:未', 'k:末')].n, 1, 'input not mutated');
    assert.strictEqual(recordConfusion(p, 'k:未', 'k:未', NOW), p, 'a kanji is not confused with itself');
  },
  'recordDuel tracks totals, and a pair settles after SETTLED_WINS straight wins': () => {
    let p = recordConfusion(learned('未', '末'), 'k:未', 'k:末', NOW);
    for (let i = 0; i < SETTLED_WINS; i++) p = recordDuel(p, ['k:未', 'k:末'], true, NOW);
    assert.ok(isSettled(p.confusions[pairKey('k:未', 'k:末')]));
    assert.deepStrictEqual({ played: p.duels.played, won: p.duels.won }, { played: SETTLED_WINS, won: SETTLED_WINS });
    assert.strictEqual(duelGroups(data, p).filter((g) => g.source === 'confused').length, 0, 'settled pairs stop being priority duels');
    p = recordDuel(p, ['k:未', 'k:末'], false, NOW);
    assert.strictEqual(p.confusions[pairKey('k:未', 'k:末')].wins, 0, 'a loss resets the streak');
    // A duel between kanji never confused adds no confusion entries.
    const q = recordDuel(learned('土', '士'), ['k:土', 'k:士'], true, NOW);
    assert.deepStrictEqual(q.confusions, {});
  },
  'confusedPairs lists the worst unsettled mix-ups first': () => {
    let p = learned('未', '末', '土', '士');
    p = recordConfusion(p, 'k:土', 'k:士', NOW);
    p = recordConfusion(p, 'k:未', 'k:末', NOW);
    p = recordConfusion(p, 'k:未', 'k:末', NOW);
    assert.deepStrictEqual(confusedPairs(p).map((c) => c.n), [2, 1]);
    for (let i = 0; i < SETTLED_WINS; i++) p = recordDuel(p, ['k:未', 'k:末'], true, NOW);
    assert.strictEqual(confusedPairs(p)[0].a + confusedPairs(p)[0].b, 'k:土k:士');
  },
  'partnersOf puts own mix-ups before shape lookalikes, without repeats': () => {
    const p = recordConfusion(learned('待', '侍'), 'k:待', 'k:侍', NOW);
    assert.deepStrictEqual(partnersOf(data, p, 'k:待').map((x) => x.id), ['k:侍', 'k:持', 'k:特']);
    assert.strictEqual(partnersOf(data, p, 'k:待')[0].n, 1);
    assert.deepStrictEqual(partnersOf(data, p, 'k:山'), []);
  },
  'duelGroups only uses learned kanji and needs at least two': () => {
    assert.deepStrictEqual(duelGroups(data, learned('未')), []);
    assert.deepStrictEqual(duelGroups(data, learned('未', '山')), []);
    const g = duelGroups(data, learned('未', '末'));
    assert.strictEqual(g.length, 1);
    assert.deepStrictEqual(g[0].ids.slice().sort(), ['k:未', 'k:末'].sort());
    // Three learned members of a family duel together, never more than three.
    const fam = duelGroups(data, learned('待', '持', '特', '侍'));
    assert.ok(fam.every((x) => x.ids.length <= 3));
    assert.ok(fam.some((x) => x.ids.length === 3));
  },
  'own mix-ups outrank lookalikes and bring a third kanji when one is learned': () => {
    let p = learned('未', '末', '朱', '土', '士');
    p.items['k:土'].incorrect = 5;
    p = recordConfusion(p, 'k:未', 'k:末', NOW);
    const g = duelGroups(data, p);
    assert.strictEqual(g[0].source, 'confused');
    assert.deepStrictEqual(g[0].ids, ['k:未', 'k:末', 'k:朱']);
    // An unlearned partner is never pulled in.
    const q = recordConfusion(learned('未', '末'), 'k:未', 'k:末', NOW);
    assert.deepStrictEqual(duelGroups(data, q)[0].ids, ['k:未', 'k:末']);
    // A mix-up with a kanji not yet learned waits until it is.
    const r = recordConfusion(learned('未'), 'k:未', 'k:末', NOW);
    assert.deepStrictEqual(duelGroups(data, r), []);
  },
  'pickDuels never uses a kanji twice in one session': () => {
    const p = learned('未', '末', '朱', '土', '士', '待', '持', '特', '侍');
    const picked = pickDuels(duelGroups(data, p), seq([0.3, 0.9, 0.1, 0.5]), 8);
    const all = picked.flatMap((g) => g.ids);
    assert.strictEqual(new Set(all).size, all.length);
    assert.ok(picked.length >= 3);
    assert.strictEqual(pickDuels(duelGroups(data, p), seq([0.5]), 1).length, 1);
  },
  'focusGroup duels one kanji against its learned partners': () => {
    const p = learned('待', '持', '特', '侍');
    assert.deepStrictEqual(focusGroup(data, p, 'k:待').ids, ['k:待', 'k:持', 'k:特', 'k:侍']);
    assert.strictEqual(focusGroup(data, learned('待'), 'k:待'), null);
    assert.strictEqual(focusGroup(data, learned('持'), 'k:待'), null, 'the kanji itself must be learned');
  },
  'buildQuestions asks about every kanji once, in both directions': () => {
    const qs = buildQuestions(['k:未', 'k:末'], seq([0.1, 0.7, 0.4, 0.2, 0.9]));
    assert.deepStrictEqual(qs.map((q) => q.target).sort(), ['k:未', 'k:末'].sort());
    assert.deepStrictEqual(qs.map((q) => q.pick).sort(), ['kanji', 'meaning']);
    for (const q of qs) assert.deepStrictEqual(q.options.slice().sort(), ['k:未', 'k:末'].sort());
    const three = buildQuestions(['k:待', 'k:持', 'k:特'], seq([0.8, 0.2, 0.6]));
    assert.strictEqual(three.length, 3);
    assert.strictEqual(new Set(three.map((q) => q.target)).size, 3);
  },
  'createDuelSession and duelSummary': () => {
    let p = learned('未', '末', '土', '士');
    p = recordConfusion(p, 'k:土', 'k:士', NOW);
    const s = duelSummary(data, p);
    assert.strictEqual(s.confused, 1);
    assert.strictEqual(s.available, 2);
    const session = createDuelSession(pickDuels(s.groups, seq([0.5])), seq([0.5, 0.1]));
    assert.strictEqual(session.duels.length, 2);
    assert.strictEqual(session.duels[0].source, 'confused');
    assert.ok(session.duels.every((d) => d.questions.length === d.ids.length));
    assert.strictEqual(duelSummary(data, learned('山')).available, 0);
    const all = s.picked.flatMap((g) => g.ids);
    assert.strictEqual(new Set(all).size, all.length, 'the preview never repeats a kanji');
  },
  'diffMask flags ink with no counterpart nearby and forgives small shifts': () => {
    const w = 8, h = 4;
    const grid = (rows) => Uint8Array.from(rows.join('').split('').map((c) => (c === '#' ? 1 : 0)));
    const a = grid(['#.....#.', '#.....#.', '#.......', '#.......']);   // a bar at x=0 and a tick at x=6
    const b = grid(['.#......', '.#......', '.#......', '.#......']);   // the same bar shifted by one
    const d = diffMask(a, b, w, h, 1);
    assert.strictEqual(d[0], 0, 'the bar has ink one pixel away: not different');
    assert.strictEqual(d[6], 1, 'the tick has nothing near it: different');
    assert.strictEqual(d[w + 6], 1);
    assert.strictEqual(d.reduce((n, v) => n + v, 0), 2);
    assert.strictEqual(diffMask(a, a, w, h, 0).reduce((n, v) => n + v, 0), 0, 'identical glyphs have no difference');
    assert.strictEqual(diffMask(a, b, w, h, 0).reduce((n, v) => n + v, 0), 6, 'radius 0 is an exact comparison');
  },
};
