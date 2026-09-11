import assert from 'assert';
import { normaliseBitmap, similarity, rank, complexity, complexityMatch, SIZE } from '../app/visual.js';

function glyph(w, h, paint) {
  const g = new Uint8ClampedArray(w * h).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (paint(x, y)) g[y * w + x] = 0;
  return g;
}

export const tests = {
  'normaliseBitmap returns a unit vector cropped to the ink, or null for blank': () => {
    const v = normaliseBitmap(glyph(40, 40, (x, y) => x > 10 && x < 30 && y > 18 && y < 22), 40, 40);
    assert.strictEqual(v.length, SIZE * SIZE);
    let n = 0; for (const x of v) n += x * x;
    assert.ok(Math.abs(n - 1) < 1e-4);
    assert.strictEqual(normaliseBitmap(glyph(10, 10, () => false), 10, 10), null);
  },
  'the same shape at a different scale and position still matches best': () => {
    const bar = (s, ox, oy) => glyph(60, 60, (x, y) => x > ox && x < ox + s && y > oy + s * 0.4 && y < oy + s * 0.6);
    const cross = (s, ox, oy) => glyph(60, 60, (x, y) => (x > ox && x < ox + s && Math.abs(y - (oy + s / 2)) < s * 0.08) || (y > oy && y < oy + s && Math.abs(x - (ox + s / 2)) < s * 0.08));
    const templates = new Map([['一', normaliseBitmap(bar(40, 5, 5), 60, 60)], ['十', normaliseBitmap(cross(40, 5, 5), 60, 60)]]);
    const q1 = normaliseBitmap(bar(20, 30, 30), 60, 60);
    const q2 = normaliseBitmap(cross(24, 20, 10), 60, 60);
    assert.strictEqual(rank(q1, templates, 1)[0].char, '一');
    assert.strictEqual(rank(q2, templates, 1)[0].char, '十');
    assert.ok(similarity(q1, templates.get('一')) > similarity(q1, templates.get('十')));
  },
  'light text on a dark background is inverted automatically': () => {
    const dark = new Uint8ClampedArray(40 * 40).fill(0);
    for (let y = 18; y < 22; y++) for (let x = 8; x < 32; x++) dark[y * 40 + x] = 255;
    const light = glyph(40, 40, (x, y) => x >= 8 && x < 32 && y >= 18 && y < 22);
    const a = normaliseBitmap(dark, 40, 40), b = normaliseBitmap(light, 40, 40);
    assert.ok(similarity(a, b) > 0.95);
  },
  'complexity grows with the number of strokes and complexityMatch compares it': () => {
    const bar = glyph(60, 60, (x, y) => x > 5 && x < 55 && y > 27 && y < 33);
    const grid = glyph(60, 60, (x, y) => (x > 5 && x < 55 && (Math.abs(y - 15) < 3 || Math.abs(y - 30) < 3 || Math.abs(y - 45) < 3)) || (y > 5 && y < 55 && (Math.abs(x - 15) < 3 || Math.abs(x - 30) < 3 || Math.abs(x - 45) < 3)));
    const cb = complexity(normaliseBitmap(bar, 60, 60)), cg = complexity(normaliseBitmap(grid, 60, 60));
    assert.ok(cg > cb * 2, `${cg} vs ${cb}`);
    assert.strictEqual(complexityMatch(10, 10), 1);
    assert.ok(complexityMatch(10, 30) < 0.1);
    assert.ok(complexityMatch(10, 12) > 0.8);
  },
};
