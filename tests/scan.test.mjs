import assert from 'assert';
import { extractKanji, fitSize } from '../app/scan.js';

export const tests = {
  'extractKanji keeps CJK characters in order of first appearance with counts': () => {
    const r = extractKanji('東京駅 → 新宿。東口 abc 123', null);
    assert.deepStrictEqual(r.kanji.map((k) => k.char), ['東', '京', '駅', '新', '宿', '口']);
    assert.strictEqual(r.kanji[0].count, 2);
    assert.strictEqual(r.unknown, 0);
  },
  'extractKanji filters to the taught set and counts unknown characters once each': () => {
    const known = new Set(['東', '京', '口']);
    const r = extractKanji('東京駅駅 口 齟齬', known);
    assert.deepStrictEqual(r.kanji.map((k) => k.char), ['東', '京', '口']);
    assert.strictEqual(r.unknown, 3, '駅, 齟, 齬');
  },
  'extractKanji ignores kana, punctuation and empty input': () => {
    assert.deepStrictEqual(extractKanji('ひらがな カタカナ 、。', null), { kanji: [], unknown: 0 });
    assert.deepStrictEqual(extractKanji(null, null), { kanji: [], unknown: 0 });
  },
  'fitSize caps the longest side and keeps the aspect ratio': () => {
    assert.deepStrictEqual(fitSize(4000, 3000, 1600), { w: 1600, h: 1200, scale: 0.4 });
    assert.deepStrictEqual(fitSize(800, 600, 1600), { w: 800, h: 600, scale: 1 });
    assert.deepStrictEqual(fitSize(1000, 4000, 1600), { w: 400, h: 1600, scale: 0.4 });
  },
};
