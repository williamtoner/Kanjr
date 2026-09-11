import assert from 'assert';
import { extractKanji, fitSize, mergeSymbols, passScore, MIN_CONF } from '../app/scan.js';

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
  'mergeSymbols keeps the best confidence per kanji, drops low confidence and non-CJK': () => {
    const known = new Set(['東', '京', '駅']);
    const r = mergeSymbols([
      [{ t: '東', c: 55 }, { t: '京', c: 20 }, { t: 'x', c: 99 }, { t: '駅', c: 70 }],
      [{ t: '東', c: 91 }, { t: '京', c: 65 }, { t: '齟', c: 88 }],
    ], known);
    assert.deepStrictEqual(r.kanji, [{ char: '東', count: 2, conf: 91 }, { char: '駅', count: 1, conf: 70 }, { char: '京', count: 1, conf: 65 }]);
    assert.strictEqual(r.unknown, 1);
    assert.ok(MIN_CONF > 20, 'the 20-confidence 京 reading was ignored');
  },
  'passScore rewards confident CJK symbols only': () => {
    assert.strictEqual(passScore([{ t: 'a', c: 99 }, { t: '東', c: 10 }]), 0);
    assert.strictEqual(passScore([{ t: '東', c: 80 }, { t: '京', c: 60 }]), 140);
    assert.strictEqual(passScore([]), 0);
  },
};
