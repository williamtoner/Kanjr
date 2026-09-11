import assert from 'assert';
import { rarity, rarityOf, dexNumbers, dexNo, isShinyEncounter, hash32, SHINY_ODDS } from '../app/game.js';

export const tests = {
  'rarity tiers follow frequency rank': () => {
    assert.strictEqual(rarity(1).key, 'common');
    assert.strictEqual(rarity(300).key, 'common');
    assert.strictEqual(rarity(301).key, 'uncommon');
    assert.strictEqual(rarity(1400).key, 'rare');
    assert.strictEqual(rarity(1500).key, 'epic');
    assert.strictEqual(rarity(2136).key, 'legendary');
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
};
