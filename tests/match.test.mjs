import assert from 'assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  normalise, tolerance, damerau, isCorrect, acceptedFor, findCollision, canonical } from '../app/match.js';

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(here, 'fixture.json'), 'utf8'));

export const tests = {
  'normalise lowercases, trims and collapses whitespace': () => {
    assert.strictEqual(normalise('  Water   Drops '), 'water drops');
    assert.strictEqual(normalise('DAY'), 'day');
    assert.strictEqual(normalise('\tone\n'), 'one');
  },

  'normalise strips punctuation but keeps hyphens inside words': () => {
    assert.strictEqual(normalise('self-esteem'), 'self-esteem');
    assert.strictEqual(normalise('-day'), 'day');
    assert.strictEqual(normalise('day-'), 'day');
    assert.strictEqual(normalise('day - night'), 'day night');
    assert.strictEqual(normalise("o'clock!"), 'oclock');
    assert.strictEqual(normalise('(sun), Japan.'), 'sun japan');
    assert.strictEqual(normalise('---'), '');
  },

  'normalise applies NFKC (full-width, ligatures, compatibility forms)': () => {
    assert.strictEqual(normalise('ｄａｙ'), 'day');
    assert.strictEqual(normalise('ﬁre'), 'fire');
    assert.strictEqual(normalise('①'), '1');
    assert.strictEqual(normalise('Ｗater　Drops'), 'water drops');
  },

  'normalise handles null and non-strings': () => {
    assert.strictEqual(normalise(null), '');
    assert.strictEqual(normalise(undefined), '');
    assert.strictEqual(normalise(42), '42');
  },

  'tolerance thresholds at every length boundary': () => {
    assert.strictEqual(tolerance(0), 0);
    assert.strictEqual(tolerance(1), 0);
    assert.strictEqual(tolerance(3), 0);
    assert.strictEqual(tolerance(4), 1);
    assert.strictEqual(tolerance(5), 1);
    assert.strictEqual(tolerance(6), 2);
    assert.strictEqual(tolerance(8), 2);
    assert.strictEqual(tolerance(9), 3);
    assert.strictEqual(tolerance(40), 3);
  },

  'damerau distance: basic edits': () => {
    assert.strictEqual(damerau('', ''), 0);
    assert.strictEqual(damerau('abc', ''), 3);
    assert.strictEqual(damerau('', 'abc'), 3);
    assert.strictEqual(damerau('kitten', 'kitten'), 0);
    assert.strictEqual(damerau('kitten', 'sitting'), 3);
    assert.strictEqual(damerau('flaw', 'lawn'), 2);
  },

  'damerau counts an adjacent transposition as one edit': () => {
    assert.strictEqual(damerau('ab', 'ba'), 1);
    assert.strictEqual(damerau('brihgt', 'bright'), 1);
    assert.strictEqual(damerau('mdidle', 'middle'), 1);
    // Unrestricted variant: transposition plus an insertion in between.
    assert.strictEqual(damerau('ca', 'abc'), 2);
  },

  'exact matches on name, alternates and normalised forms': () => {
    assert.strictEqual(isCorrect('day', ['day', 'sun']), 'exact');
    assert.strictEqual(isCorrect('Sun', ['day', 'sun']), 'exact');
    assert.strictEqual(isCorrect('  Water   drops ', ['water drops']), 'exact');
    // An inner hyphen is kept, so this is one edit away: a typo, not exact.
    assert.strictEqual(isCorrect('Water-Drops', ['water drops']), 'typo');
  },

  'short answers (≤3) allow no typos': () => {
    assert.strictEqual(isCorrect('dya', ['day']), 'wrong');
    assert.strictEqual(isCorrect('da', ['day']), 'wrong');
    assert.strictEqual(isCorrect('days', ['day']), 'wrong');
    assert.strictEqual(isCorrect('one', ['one']), 'exact');
  },

  'length 4–5 allows one typo, not two': () => {
    assert.strictEqual(isCorrect('tre', ['tree']), 'typo');
    assert.strictEqual(isCorrect('trea', ['tree']), 'typo');
    assert.strictEqual(isCorrect('tere', ['tree']), 'typo');   // adjacent transposition
    assert.strictEqual(isCorrect('teer', ['tree']), 'wrong');  // r moved two places: 2 edits
    assert.strictEqual(isCorrect('trxx', ['tree']), 'wrong');
    assert.strictEqual(isCorrect('mouht', ['mouth']), 'typo');
    assert.strictEqual(isCorrect('moutx', ['mouth']), 'typo');
    assert.strictEqual(isCorrect('mxxth', ['mouth']), 'wrong');
  },

  'length 6–8 allows two typos, not three': () => {
    assert.strictEqual(isCorrect('brigt', ['bright']), 'typo');
    assert.strictEqual(isCorrect('brihgt', ['bright']), 'typo');
    assert.strictEqual(isCorrect('bxxght', ['bright']), 'typo');
    assert.strictEqual(isCorrect('bxxxht', ['bright']), 'wrong');
    assert.strictEqual(isCorrect('scorpian', ['scorpion']), 'typo');
    assert.strictEqual(isCorrect('scorpianz', ['scorpion']), 'typo');
    assert.strictEqual(isCorrect('scxxxion', ['scorpion']), 'wrong');
  },

  'length ≥9 allows three typos, not four': () => {
    assert.strictEqual(isCorrect('water drps', ['water drops']), 'typo');
    assert.strictEqual(isCorrect('watr drps', ['water drops']), 'typo');
    assert.strictEqual(isCorrect('watr drp', ['water drops']), 'typo');
    assert.strictEqual(isCorrect('wat drp', ['water drops']), 'wrong');
  },

  'typo tolerance can be switched off': () => {
    assert.strictEqual(isCorrect('tre', ['tree'], { typoTolerance: false }), 'wrong');
    assert.strictEqual(isCorrect('tree', ['tree'], { typoTolerance: false }), 'exact');
  },

  'exact beats typo when several answers are accepted': () => {
    assert.strictEqual(isCorrect('light', ['bright', 'light']), 'exact');
    assert.strictEqual(isCorrect('lihgt', ['bright', 'light']), 'typo');
  },

  'empty input is wrong': () => {
    assert.strictEqual(isCorrect('', ['day']), 'wrong');
    assert.strictEqual(isCorrect('   ', ['day']), 'wrong');
    assert.strictEqual(isCorrect('!!!', ['day']), 'wrong');
  },

  'user synonyms are accepted through acceptedFor': () => {
    const item = data.items['k:日'];
    const accepted = acceptedFor(item, ['daytime']);
    assert.deepStrictEqual(accepted, ['day', 'sun', 'Japan', 'daytime']);
    assert.strictEqual(isCorrect('daytime', accepted), 'exact');
    assert.strictEqual(isCorrect('daytime', acceptedFor(item)), 'wrong');
  },

  'acceptedFor tolerates missing fields': () => {
    assert.deepStrictEqual(acceptedFor({ name: 'x' }), ['x']);
    assert.deepStrictEqual(acceptedFor(null, ['y']), ['y']);
  },

  'cross-item collision: another kanji\'s name is detected': () => {
    const moon = data.items['k:月'];
    const hit = findCollision('day', moon, data.items);
    assert.ok(hit, 'expected a collision');
    assert.strictEqual(hit.id, 'k:日');
  },

  'cross-item collision: alternates of other items count too': () => {
    const hit = findCollision('Japan', data.items['k:月'], data.items);
    assert.strictEqual(hit.id, 'k:日');
  },

  'cross-item collision ignores the item itself and other types': () => {
    assert.strictEqual(findCollision('moon', data.items['k:月'], data.items), null);
    // "stick" is a radical name; typing it for a kanji is just wrong, not a collision.
    assert.strictEqual(findCollision('stick', data.items['k:中'], data.items), null);
    // ...but for another radical it is a collision.
    assert.strictEqual(findCollision('stick', data.items['r:汁'], data.items).id, 'r:丨');
  },

  'cross-item collision requires an exact (normalised) match': () => {
    assert.strictEqual(findCollision('dya', data.items['k:月'], data.items), null);
    assert.strictEqual(findCollision('  DAY ', data.items['k:月'], data.items).id, 'k:日');
    assert.strictEqual(findCollision('', data.items['k:月'], data.items), null);
  },
  'canonical drops articles, "to" and simple plurals': () => {
    assert.strictEqual(canonical('the tree'), 'tree');
    assert.strictEqual(canonical('to see'), 'see');
    assert.strictEqual(canonical('flowers'), 'flower');
    assert.strictEqual(canonical('boxes'), 'box');
    assert.strictEqual(canonical('cities'), 'city');
    assert.strictEqual(canonical('glass'), 'glass');
    assert.strictEqual(canonical('bus'), 'bus');
  },
  'isCorrect accepts plural, article and infinitive forms as exact': () => {
    assert.strictEqual(isCorrect('flowers', ['flower']), 'exact');
    assert.strictEqual(isCorrect('to see', ['see']), 'exact');
    assert.strictEqual(isCorrect('the sea', ['sea']), 'exact');
    assert.strictEqual(isCorrect('dirt', ['soil', 'dirt', 'ground']), 'exact');
    assert.strictEqual(isCorrect('dirts', ['soil', 'dirt']), 'exact');
    assert.strictEqual(isCorrect('drit', ['soil', 'dirt']), 'typo', 'one transposition within a 4-letter answer');
  },
  'digits are accepted for number kanji': () => {
    assert.strictEqual(isCorrect('7', ['seven']), 'exact');
    assert.strictEqual(isCorrect('10', ['ten']), 'exact');
    assert.strictEqual(isCorrect('10,000', ['ten thousand']), 'exact');
    assert.strictEqual(isCorrect('10000', ['ten thousand']), 'exact');
    assert.strictEqual(isCorrect('100', ['hundred']), 'exact');
    assert.strictEqual(isCorrect('one hundred', ['hundred']), 'exact');
    assert.strictEqual(isCorrect('0', ['zero']), 'exact');
    assert.strictEqual(isCorrect('8', ['seven']), 'wrong');
    assert.strictEqual(isCorrect('11', ['ten']), 'wrong');
  },
};
