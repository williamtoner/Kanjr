/**
 * visual.js — a second opinion for single-kanji capture: nearest-neighbour
 * matching of the captured square against every jōyō kanji rendered in a
 * clean typeface. Font-dependent and crude, but on a tight crop of printed
 * text it often ranks the right character in the top few, which is exactly
 * what the candidate picker needs.
 *
 * Pure helpers (`normaliseBitmap`, `similarity`, `rank`) are tested; the
 * rendering side needs a canvas.
 */

export const SIZE = 28;          // template resolution (SIZE × SIZE)

/**
 * Turn a grayscale array (0 = ink, 255 = paper) of w×h into a SIZE×SIZE
 * ink-density vector in [0, 1], cropped to the ink's bounding box, then
 * mean-centred and length-normalised so brightness and stroke weight matter
 * less than shape.
 */
export function normaliseBitmap(gray, w, h, size = SIZE) {
  // Otsu threshold to find ink.
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const total = gray.length;
  let sum = 0; for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  // Ink is the darker class; if ink covers most of the crop, the text is
  // probably light on dark: invert.
  let inkCount = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] <= thr) inkCount++;
  const invert = inkCount > total * 0.5;
  const isInk = (i) => (invert ? gray[i] > thr : gray[i] <= thr);
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isInk(y * w + x)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  // Square bounding box so aspect is preserved.
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sx0 = cx - side / 2, sy0 = cy - side / 2;
  const out = new Float32Array(size * size);
  const cell = side / size;
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      let ink = 0, n = 0;
      const ya = Math.floor(sy0 + ty * cell), yb = Math.ceil(sy0 + (ty + 1) * cell);
      const xa = Math.floor(sx0 + tx * cell), xb = Math.ceil(sx0 + (tx + 1) * cell);
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) {
        n++;
        if (x >= 0 && y >= 0 && x < w && y < h && isInk(y * w + x)) ink++;
      }
      out[ty * size + tx] = n ? ink / n : 0;
    }
  }
  // Blur slightly so small misalignments are forgiven.
  const blurred = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= size || xx >= size) continue;
      const wgt = dx === 0 && dy === 0 ? 2 : 1;
      acc += out[yy * size + xx] * wgt; n += wgt;
    }
    blurred[y * size + x] = acc / n;
  }
  let mean = 0; for (let i = 0; i < blurred.length; i++) mean += blurred[i]; mean /= blurred.length;
  let norm = 0; for (let i = 0; i < blurred.length; i++) { blurred[i] -= mean; norm += blurred[i] * blurred[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < blurred.length; i++) blurred[i] /= norm;
  return blurred;
}

/**
 * Rough stroke complexity of a normalised bitmap: how often the ink turns
 * on and off scanning rows and columns. A 3-stroke 口 scores far lower
 * than a 16-stroke 還, which lets the picker discount wild guesses.
 */
export function complexity(vec, size = SIZE) {
  let t = 0;
  for (let y = 0; y < size; y++) {
    let on = false;
    for (let x = 0; x < size; x++) { const v = vec[y * size + x] > 0; if (v !== on) { t++; on = v; } }
  }
  for (let x = 0; x < size; x++) {
    let on = false;
    for (let y = 0; y < size; y++) { const v = vec[y * size + x] > 0; if (v !== on) { t++; on = v; } }
  }
  return t;
}

/** 1 when two complexities match, falling to 0 as they differ by a factor of e. */
export function complexityMatch(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(a / b)));
}

/** Similarity of a query against one template entry (vector or list). */
export function bestSimilarity(query, entry) {
  const list = Array.isArray(entry) ? entry : [entry];
  let best = -1;
  for (const v of list) { const sc = similarity(query, v); if (sc > best) best = sc; }
  return best;
}

/** Cosine similarity of two normalised vectors, in [-1, 1]. */
export function similarity(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Rank templates (Map char -> vector or [vectors]) against a query; top k [{char, score}]. */
export function rank(query, templates, k = 5) {
  const out = [];
  for (const [char, vecs] of templates) {
    const list = Array.isArray(vecs) ? vecs : [vecs];
    let best = -1;
    for (const v of list) { const sc = similarity(query, v); if (sc > best) best = sc; }
    out.push({ char, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

/* ------------------------------------------------------------------ */
/* Rendering (browser only)                                            */
/* ------------------------------------------------------------------ */

let templates = null;
let templatePromise = null;

/** Render every character once in a sans and a serif face, at 64 px. */
export const TEMPLATE_FONTS = ["'Noto Sans JP', sans-serif", "'Noto Serif JP', serif"];

export async function getTemplates(chars) {
  if (templates) return templates;
  if (templatePromise) return templatePromise;
  templatePromise = (async () => {
    for (const f of TEMPLATE_FONTS) { try { if (document.fonts && document.fonts.load) await document.fonts.load(`500 48px ${f}`); } catch (_) { /* fallback font */ } }
    const px = 64;
    const canvas = document.createElement('canvas');
    canvas.width = px; canvas.height = px;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const map = new Map();
    for (const ch of chars) {
      const vecs = [];
      for (const f of TEMPLATE_FONTS) {
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, px, px);
        ctx.fillStyle = '#000'; ctx.font = `500 ${px * 0.8}px ${f}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ch, px / 2, px / 2 + 2);
        const d = ctx.getImageData(0, 0, px, px).data;
        const gray = new Uint8ClampedArray(px * px);
        for (let i = 0; i < gray.length; i++) gray[i] = d[i * 4];
        const vec = normaliseBitmap(gray, px, px);
        if (vec) vecs.push(vec);
      }
      if (vecs.length) map.set(ch, vecs);
    }
    templates = map;
    return map;
  })();
  return templatePromise;
}

export function templateCount() { return templates ? templates.size : 0; }

/** Gray array from a canvas. */
export function canvasGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000;
  return gray;
}
