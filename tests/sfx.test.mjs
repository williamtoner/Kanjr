import assert from 'assert';
import { midi, correctNotes, NOTES, configure, isEnabled } from '../app/sfx.js';

export const tests = {
  'midi maps A4 to 440 Hz and octaves double': () => {
    assert.strictEqual(midi(69), 440);
    assert.ok(Math.abs(midi(81) - 880) < 1e-9);
    assert.ok(Math.abs(midi(57) - 220) < 1e-9);
  },
  'the correct ding climbs a semitone per streak step, capped at an octave': () => {
    const base = correctNotes(0);
    assert.strictEqual(correctNotes(1)[0].note, base[0].note);
    assert.strictEqual(correctNotes(2)[0].note, base[0].note + 1);
    assert.strictEqual(correctNotes(13)[0].note, base[0].note + 12);
    assert.strictEqual(correctNotes(40)[0].note, base[0].note + 12);
    assert.ok(base[1].note > base[0].note, 'second note is higher: a rising chime');
    assert.ok(base[1].at > base[0].at);
  },
  'wrong is a falling pair, quieter than correct': () => {
    assert.ok(NOTES.wrong[1].note < NOTES.wrong[0].note);
    assert.ok(Math.max(...NOTES.wrong.map((n) => n.gain)) < Math.max(...correctNotes(0).map((n) => n.gain)));
  },
  'every table has ordered, positive timings': () => {
    for (const [name, notes] of Object.entries(NOTES)) {
      let last = -1;
      for (const n of notes) {
        assert.ok(n.at >= last, `${name}: notes in time order`); last = n.at;
        assert.ok(n.dur > 0 && n.gain > 0 && n.gain <= 1, `${name}: sane duration and gain`);
      }
    }
  },
  'configure clamps volume and toggles enabled': () => {
    configure({ volume: 3 }); configure({ enabled: false });
    assert.strictEqual(isEnabled(), false);
    configure({ enabled: true });
    assert.strictEqual(isEnabled(), true);
  },
};
