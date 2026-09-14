import assert from 'assert';
import { rarity, rarityOf, dexNumbers, dexNo, isShinyEncounter, hash32, SHINY_ODDS, encounterKind, LEGENDARY_ODDS, questPool, questFor, wildRoll, questStreak } from '../app/game.js';

export const tests = {
  'rarity tiers follow frequency rank': () => {
    assert.strictEqual(rarity(1).key, 'common');
    assert.strictEqual(rarity(300).key, 'common');
    assert.strictEqual(rarity(301).key, 'uncommon');
    assert.strictEqual(rarity(1400).key, 'rare');
    assert.strictEqual(rarity(1500).key, 'epic');
    assert.strictEqual(rarity(2136).key, 'ancient');
    assert.strictEqual(rarity(undefined).key, 'common');
    assert.strictEqual(rarityOf({ type: 'radical' }).key, 'part');
  },
  'dex numbers follow learning order': () => {
    const d = dexNumbers({ levels: [{ items: ['a', 'b'] }, { items: ['c'] }] });
    assert.deepStrictEqual(d, { a: 1, b: 2, c: 3 });
    assert.strictEqual(dexNo(7), 'No. 0007');
  },
  'shiny encounters are deterministic and roughly 1 in SHINY_ODDS': () => {
    assert.strictEqual(isShinyEncounter('k:日', 's1'), isShinyEncounter('k:日', 's1'));
    let n = 0;
    for (let i = 0; i < 6400; i++) if (isShinyEncounter(`k:${i}`, 'session')) n++;
    assert.ok(n > 60 && n < 140, `about 100 expected, got ${n}`);
    assert.notStrictEqual(hash32('a'), hash32('b'));
  },
  'encounterKind: legendary is rarer than shiny and deterministic': () => {
    let leg = 0, shi = 0;
    for (let i = 0; i < 20000; i++) { const k = encounterKind(`k:${i}`, 's'); if (k === 'legendary') leg++; else if (k === 'shiny') shi++; }
    assert.ok(leg > 15 && leg < 70, `legendary about 39 expected, got ${leg}`);
    assert.ok(shi > 220 && shi < 400, `shiny about 310 expected, got ${shi}`);
    assert.strictEqual(encounterKind('k:日', 'x'), encounterKind('k:日', 'x'));
  },
  'questFor picks a common kanji deterministically per day': () => {
    const data = { levels: [{ items: ['k:a', 'k:b', 'r:x', 'k:c'] }], items: { 'k:a': { type: 'kanji', freq: 10 }, 'k:b': { type: 'kanji', freq: 5000 }, 'r:x': { type: 'radical' }, 'k:c': { type: 'kanji', freq: 300 } } };
    const pool = questPool(data);
    assert.deepStrictEqual(pool, ['k:a', 'k:c']);
    assert.strictEqual(questFor('2026-09-14', pool), questFor('2026-09-14', pool));
    assert.ok(pool.includes(questFor('2026-09-15', pool)));
    assert.strictEqual(questFor('2026-09-14', []), null);
  },
  'wildRoll returns legendary, shiny or null with the right rough odds': () => {
    let leg = 0, shi = 0;
    for (let i = 0; i < 8000; i++) { const r = wildRoll(`2026-01-${i}`, 'k:日'); if (r === 'legendary') leg++; else if (r === 'shiny') shi++; }
    assert.ok(leg > 350 && leg < 650, `~500 legendary, got ${leg}`);
    assert.ok(shi > 1500 && shi < 2300, `~1875 shiny, got ${shi}`);
  },
  'questStreak counts consecutive days and keeps the best': () => {
    const q = { '2026-09-10': '日', '2026-09-11': '月', '2026-09-13': '山', '2026-09-14': '川' };
    assert.deepStrictEqual(questStreak(q, '2026-09-14'), { current: 2, best: 2 });
    assert.deepStrictEqual(questStreak(q, '2026-09-15'), { current: 2, best: 2 }, 'yesterday still counts');
    assert.deepStrictEqual(questStreak(q, '2026-09-17'), { current: 0, best: 2 });
    assert.deepStrictEqual(questStreak({}, '2026-09-14'), { current: 0, best: 0 });
  },
};
