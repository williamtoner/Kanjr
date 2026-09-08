import assert from 'assert';
import {
  intervalHours, stageName, groupOf, nextStage, nextState, floorToHour, clampStage,
} from '../app/srs.js';

// A fixed instant: 2026-09-08T14:37:21.500Z (mid-hour, so rounding is visible).
const NOW = new Date('2026-09-08T14:37:21.500Z');
const HOUR = 3600000;
const isoPlusHours = (h) => new Date(Date.UTC(2026, 8, 8, 14) + h * HOUR).toISOString();

export const tests = {
  'intervalHours matches the WaniKani table': () => {
    assert.strictEqual(intervalHours(0), null);
    assert.strictEqual(intervalHours(1), 4);
    assert.strictEqual(intervalHours(2), 8);
    assert.strictEqual(intervalHours(3), 24);
    assert.strictEqual(intervalHours(4), 48);
    assert.strictEqual(intervalHours(5), 24 * 7);
    assert.strictEqual(intervalHours(6), 24 * 14);
    assert.strictEqual(intervalHours(7), 24 * 30);
    assert.strictEqual(intervalHours(8), 24 * 120);
    assert.strictEqual(intervalHours(9), null);
  },

  'stageName and groupOf cover every stage': () => {
    const expected = [
      ['Not started', 'locked'],
      ['Apprentice 1', 'apprentice'], ['Apprentice 2', 'apprentice'],
      ['Apprentice 3', 'apprentice'], ['Apprentice 4', 'apprentice'],
      ['Guru 1', 'guru'], ['Guru 2', 'guru'],
      ['Master', 'master'], ['Enlightened', 'enlightened'], ['Burned', 'burned'],
    ];
    expected.forEach(([name, group], stage) => {
      assert.strictEqual(stageName(stage), name, `name of ${stage}`);
      assert.strictEqual(groupOf(stage), group, `group of ${stage}`);
    });
  },

  'clampStage coerces garbage into [0, 9]': () => {
    assert.strictEqual(clampStage(-3), 0);
    assert.strictEqual(clampStage(42), 9);
    assert.strictEqual(clampStage('4'), 4);
    assert.strictEqual(clampStage(undefined), 0);
    assert.strictEqual(clampStage(NaN), 0);
    assert.strictEqual(clampStage(3.9), 3);
  },

  'a correct answer moves every stage up by one, 9 stays 9': () => {
    for (let s = 0; s < 9; s++) assert.strictEqual(nextStage(s, 0), s + 1, `from ${s}`);
    assert.strictEqual(nextStage(9, 0), 9);
  },

  'a lesson completes to stage 1 due in 4 h, floored to the hour': () => {
    const r = nextState({ stage: 0, wrong: 0 }, NOW);
    assert.strictEqual(r.stage, 1);
    assert.strictEqual(r.due, isoPlusHours(4));
  },

  'every correct transition schedules the right interval from the floored hour': () => {
    const hours = [4, 8, 24, 48, 168, 336, 720, 2880];
    for (let s = 0; s < 8; s++) {
      const r = nextState({ stage: s, wrong: 0 }, NOW);
      assert.strictEqual(r.stage, s + 1);
      assert.strictEqual(r.due, isoPlusHours(hours[s]), `stage ${s} -> ${s + 1}`);
    }
  },

  'reaching Burned has no due time': () => {
    const r = nextState({ stage: 8, wrong: 0 }, NOW);
    assert.strictEqual(r.stage, 9);
    assert.strictEqual(r.due, null);
    const again = nextState({ stage: 9, wrong: 0 }, NOW);
    assert.strictEqual(again.stage, 9);
    assert.strictEqual(again.due, null);
  },

  'apprentice penalty is 1 per ceil(w/2)': () => {
    // stage 4, one wrong -> 3; two wrongs -> 3; three -> 2; four -> 2; five -> 1
    assert.strictEqual(nextStage(4, 1), 3);
    assert.strictEqual(nextStage(4, 2), 3);
    assert.strictEqual(nextStage(4, 3), 2);
    assert.strictEqual(nextStage(4, 4), 2);
    assert.strictEqual(nextStage(4, 5), 1);
    assert.strictEqual(nextStage(3, 1), 2);
    assert.strictEqual(nextStage(2, 1), 1);
  },

  'guru and above penalty is 2 per ceil(w/2)': () => {
    assert.strictEqual(nextStage(5, 1), 3);
    assert.strictEqual(nextStage(5, 2), 3);
    assert.strictEqual(nextStage(5, 3), 1);
    assert.strictEqual(nextStage(6, 1), 4);
    assert.strictEqual(nextStage(6, 3), 2);
    assert.strictEqual(nextStage(7, 1), 5);
    assert.strictEqual(nextStage(7, 4), 3);
    assert.strictEqual(nextStage(8, 1), 6);
    assert.strictEqual(nextStage(8, 2), 6);
    assert.strictEqual(nextStage(8, 3), 4);
    assert.strictEqual(nextStage(8, 5), 2);
    assert.strictEqual(nextStage(8, 7), 1);
  },

  'the floor is stage 1, never 0': () => {
    assert.strictEqual(nextStage(1, 1), 1);
    assert.strictEqual(nextStage(1, 9), 1);
    assert.strictEqual(nextStage(2, 3), 1);
    assert.strictEqual(nextStage(5, 99), 1);
    assert.strictEqual(nextStage(8, 99), 1);
  },

  'every stage x wrong-count combination is consistent with the formula': () => {
    for (let s = 1; s <= 8; s++) {
      for (let w = 1; w <= 10; w++) {
        const penalty = s >= 5 ? 2 : 1;
        const expected = Math.max(1, s - Math.ceil(w / 2) * penalty);
        assert.strictEqual(nextStage(s, w), expected, `stage ${s} wrong ${w}`);
      }
    }
  },

  'wrong answers reschedule from the new stage interval': () => {
    // Guru 1 with one wrong -> Apprentice 3 -> due in 24 h.
    const r = nextState({ stage: 5, wrong: 1 }, NOW);
    assert.strictEqual(r.stage, 3);
    assert.strictEqual(r.due, isoPlusHours(24));
  },

  'missing wrong count is treated as zero': () => {
    assert.strictEqual(nextState({ stage: 2 }, NOW).stage, 3);
    assert.strictEqual(nextState({ stage: 2, wrong: undefined }, NOW).stage, 3);
    assert.strictEqual(nextState({ stage: 2, wrong: -1 }, NOW).stage, 3);
  },

  'floorToHour rounds down, never up': () => {
    assert.strictEqual(floorToHour(NOW).toISOString(), '2026-09-08T14:00:00.000Z');
    assert.strictEqual(floorToHour('2026-09-08T14:59:59.999Z').toISOString(), '2026-09-08T14:00:00.000Z');
    assert.strictEqual(floorToHour('2026-09-08T14:00:00.000Z').toISOString(), '2026-09-08T14:00:00.000Z');
    assert.strictEqual(floorToHour('2026-09-08T00:00:00.001Z').toISOString(), '2026-09-08T00:00:00.000Z');
  },

  'nextState accepts Date, epoch ms and ISO strings for now': () => {
    const a = nextState({ stage: 1 }, NOW);
    const b = nextState({ stage: 1 }, NOW.getTime());
    const c = nextState({ stage: 1 }, NOW.toISOString());
    assert.strictEqual(a.due, b.due);
    assert.strictEqual(b.due, c.due);
    assert.strictEqual(a.due, isoPlusHours(8));
  },

  'nextState does not mutate its input': () => {
    const state = { stage: 3, wrong: 2 };
    const copy = JSON.parse(JSON.stringify(state));
    nextState(state, NOW);
    assert.deepStrictEqual(state, copy);
  },
};
