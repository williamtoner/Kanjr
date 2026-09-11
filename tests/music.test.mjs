import assert from 'assert';
import { noteFreq, parsePattern, patternLength, tuneLength, TUNES } from '../app/music.js';

export const tests = {
  'noteFreq maps names to frequencies': () => {
    assert.ok(Math.abs(noteFreq('a4') - 440) < 1e-9);
    assert.ok(Math.abs(noteFreq('c5') - 523.25) < 0.01);
    assert.ok(Math.abs(noteFreq('f#4') - 369.99) < 0.01);
    assert.ok(Math.abs(noteFreq('bb3') - 233.08) < 0.01);
    assert.throws(() => noteFreq('h2'));
  },
  'parsePattern tracks positions in sixteenths and rests': () => {
    const p = parsePattern('c5:4 -:2 e5:2');
    assert.deepStrictEqual(p.map((e) => [e.note, e.len, e.at]), [['c5', 4, 0], [null, 2, 4], ['e5', 2, 6]]);
    assert.strictEqual(patternLength(p), 8);
  },
  'every tune has channels of equal length and playable notes': () => {
    for (const [name, tune] of Object.entries(TUNES)) {
      const len = tuneLength(tune);
      assert.ok(len > 0 && len % 4 === 0, `${name}: length ${len} is a whole number of beats`);
      for (const k of ['lead', 'harmony', 'bass']) for (const ev of parsePattern(tune[k].pattern)) if (ev.note) noteFreq(ev.note);
      for (const ev of parsePattern(tune.drums.pattern)) if (ev.note) assert.ok('khs'.includes(ev.note), `${name}: drum ${ev.note}`);
    }
  },
};
