/**
 * scan.js — recognise kanji in a photo, on the device, with Tesseract.
 *
 * The library (about 60 KB) and the fast Japanese model (about 1.5 MB) are
 * fetched from CDNs the first time and cached by the browser / IndexedDB,
 * so later scans work offline. Photos never leave the phone.
 *
 * Pure helpers (`extractKanji`, `prepareCanvas` maths) are separated from
 * the loading and recognition side effects so they can be unit tested.
 */

export const TESSERACT_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/7.0.0/tesseract.min.js';
export const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0_fast';
export const MAX_SIDE = 1600;
export const ANGLES = [0, -3, 3, -6, 6, -9, 9];   // deskew search, degrees
export const MIN_CONF = 30;                        // symbols below this are dropped
export const SURE_CONF = 60;                       // below this a tile is shown as 'less sure'

/**
 * Pull every CJK character out of recognised text, in order of first
 * appearance, with how often it appeared. `known` filters to the kanji the
 * app teaches (a Set of characters); others are reported separately so the
 * UI can say "3 characters not in the jōyō set".
 */
export function isCJK(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df);
}

export function extractKanji(text, known) {
  const seen = new Map();
  let unknown = 0;
  const unknownChars = new Set();
  for (const ch of String(text || '')) {
    if (!isCJK(ch)) continue;
    if (known && !known.has(ch)) { if (!unknownChars.has(ch)) { unknownChars.add(ch); unknown++; } continue; }
    seen.set(ch, (seen.get(ch) || 0) + 1);
  }
  return { kanji: Array.from(seen, ([char, count]) => ({ char, count, conf: 100 })), unknown };
}

/**
 * Merge recognised symbols ({ t, c }: character and confidence 0–100) from
 * one or more passes into ranked kanji. A character keeps its best
 * confidence; symbols below `minConf` are ignored; the result is sorted by
 * confidence then count. `known` filters to the taught set.
 */
export function mergeSymbols(passes, known, minConf = MIN_CONF) {
  const best = new Map();
  let unknown = 0;
  const unknownChars = new Set();
  for (const syms of passes) {
    for (const s of syms || []) {
      const ch = s.t;
      if (!ch || ch.length !== 1 && [...ch].length !== 1) continue;
      if (!isCJK(ch)) continue;
      if (s.c < minConf) continue;
      if (known && !known.has(ch)) { if (!unknownChars.has(ch)) { unknownChars.add(ch); unknown++; } continue; }
      const cur = best.get(ch);
      if (!cur) best.set(ch, { char: ch, count: 1, conf: Math.round(s.c) });
      else { cur.count += 1; cur.conf = Math.max(cur.conf, Math.round(s.c)); }
    }
  }
  const kanji = Array.from(best.values()).sort((a, b) => b.conf - a.conf || b.count - a.count);
  return { kanji, unknown };
}

/** How good a pass looks: confidence-weighted count of CJK symbols. */
export function passScore(syms) {
  let score = 0;
  for (const s of syms || []) if (s.t && isCJK(s.t) && s.c >= MIN_CONF) score += s.c;
  return score;
}

/** Target size for the working canvas: longest side capped at MAX_SIDE. */
export function fitSize(w, h, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/* ------------------------------------------------------------------ */
/* Side effects                                                        */
/* ------------------------------------------------------------------ */

let libPromise = null;
let workerPromise = null;
let workerLang = 'jpn';

function loadLibrary() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (libPromise) return libPromise;
  libPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_SRC;
    s.async = true;
    s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Recognition library did not load.')));
    s.onerror = () => { libPromise = null; reject(new Error('Could not download the recognition library. Check the connection and try again.')); };
    document.head.appendChild(s);
  });
  return libPromise;
}

const LABELS = { 'loading tesseract core': 'Loading recognition engine', 'initializing tesseract': 'Starting engine', 'loading language traineddata': 'Downloading Japanese model (once)', 'initializing api': 'Preparing', 'recognizing text': 'Reading the photo' };

/** Create (once) a worker with the Japanese model. onProgress(label, ratio). */
export async function getWorker(onProgress) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const T = await loadLibrary();
    const worker = await T.createWorker('jpn', 1, {
      langPath: LANG_PATH,
      logger: (m) => {
        if (!onProgress || !m) return;
        onProgress(LABELS[m.status] || m.status, typeof m.progress === 'number' ? m.progress : 0);
      },
    });
    workerLang = 'jpn';
    return worker;
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

async function useLang(worker, lang) {
  if (workerLang === lang) return;
  await worker.reinitialize(lang, 1);
  workerLang = lang;
}

/** Load the photo as a bitmap, honouring EXIF orientation. */
function loadBitmap(file) {
  if (window.createImageBitmap) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => loadViaImage(file));
  }
  return loadViaImage(file);
}

function loadViaImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image the browser can read.')); };
    img.src = url;
  });
}

/**
 * Draw a region of the photo onto a canvas: cropped, downscaled so the
 * longest side is `maxSide`, rotated by `deg`, grayscale, contrast-stretched.
 */
export function renderCanvas(bitmap, { crop = null, maxSide = MAX_SIDE, deg = 0 } = {}) {
  const sx = crop ? crop.x : 0, sy = crop ? crop.y : 0;
  const sw = crop ? crop.w : bitmap.width, sh = crop ? crop.h : bitmap.height;
  const { w, h } = fitSize(sw, sh, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2); ctx.rotate((deg * Math.PI) / 180); ctx.translate(-w / 2, -h / 2);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g | 0]++;
  }
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.02) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.max(0, Math.min(255, ((d[i] - lo) / range) * 255));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function recognizeCanvas(worker, canvas, lang, psm) {
  await useLang(worker, lang);
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const syms = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) for (const s of w.symbols || []) syms.push({ t: s.text, c: s.confidence });
  return { syms, text: data.text || '' };
}

/**
 * Recognise kanji in a photo (or a cropped region of it).
 *
 * 1. Deskew: a quick horizontal pass at low resolution for each angle in
 *    ANGLES; the angle whose pass reads the most, most confidently, wins.
 * 2. A full-resolution horizontal pass (block mode) at that angle.
 * 3. If that pass is weak, a vertical-text pass with the vertical model.
 * 4. Symbols are merged by best confidence and filtered to the taught set.
 *
 * Returns { kanji: [{char, count, conf}], unknown, text, angle, vertical }.
 */
export async function recognizeKanji(file, known, onProgress, { crop = null } = {}) {
  const bitmap = await loadBitmap(file);
  const worker = await getWorker(onProgress);
  const say = (label, ratio) => { if (onProgress) onProgress(label, ratio); };

  say('Finding the angle', 0);
  let bestAngle = 0, bestScore = -1;
  for (let i = 0; i < ANGLES.length; i++) {
    const deg = ANGLES[i];
    const small = renderCanvas(bitmap, { crop, maxSide: 800, deg });
    const r = await recognizeCanvas(worker, small, 'jpn', 6);
    const score = passScore(r.syms);
    if (score > bestScore) { bestScore = score; bestAngle = deg; }
    say('Finding the angle', (i + 1) / ANGLES.length);
    if (deg === 0 && score > 0 && r.syms.filter((s) => isCJK(s.t) && s.c >= 80).length >= 6) break;   // already crisp
  }

  say('Reading the photo', 0.2);
  const full = renderCanvas(bitmap, { crop, deg: bestAngle });
  const horiz = await recognizeCanvas(worker, full, 'jpn', 6);
  const passes = [horiz.syms];
  let vertical = false;
  const strong = horiz.syms.filter((s) => isCJK(s.t) && s.c >= SURE_CONF).length;
  if (strong < 4) {
    say('Trying vertical text', 0.6);
    try {
      const vert = await recognizeCanvas(worker, full, 'jpn_vert', 5);
      if (passScore(vert.syms) > passScore(horiz.syms)) { passes.unshift(vert.syms); vertical = true; }
      else passes.push(vert.syms.filter((s) => s.c >= 85));   // only very sure extras from the losing pass
    } catch (_) { /* vertical model unavailable: carry on */ }
  }
  say('Reading the photo', 1);
  if (bitmap.close) bitmap.close();
  const merged = mergeSymbols(passes, known);
  return Object.assign(merged, { text: horiz.text, angle: bestAngle, vertical });
}

/**
 * Capture one kanji from a square region. Runs several Tesseract passes on
 * the crop (single character, single line, block; normal and inverted) and
 * returns candidate characters ranked by confidence, filtered to `known`.
 * The caller merges these with the visual matcher's candidates.
 */
export async function recognizeSingle(file, crop, known, onProgress) {
  const bitmap = await loadBitmap(file);
  const worker = await getWorker(onProgress);
  const say = (label, ratio) => { if (onProgress) onProgress(label, ratio); };
  // Tesseract's models were trained on text about 30-60 px tall, so a big
  // crop of one character must be shrunk, not enlarged. Try a few sizes.
  const base = renderCanvas(bitmap, { crop, maxSide: 320, deg: 0 });
  const variants = [];
  for (const px of [48, 72, 104]) {
    const pad = Math.round(px * 0.3);
    const c = document.createElement('canvas');
    c.width = px + pad * 2; c.height = px + pad * 2;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(base, pad, pad, px, px);
    variants.push(c);
  }
  const inverted = document.createElement('canvas');
  inverted.width = variants[1].width; inverted.height = variants[1].height;
  const ictx = inverted.getContext('2d');
  ictx.drawImage(variants[1], 0, 0);
  const id = ictx.getImageData(0, 0, inverted.width, inverted.height);
  for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 255 - id.data[i]; id.data[i + 1] = 255 - id.data[i + 1]; id.data[i + 2] = 255 - id.data[i + 2]; }
  ictx.putImageData(id, 0, 0);
  const plan = [[variants[0], 10], [variants[1], 10], [variants[2], 10], [variants[1], 7], [variants[2], 7], [inverted, 10], [variants[1], 6]];
  const passes = [];
  for (let i = 0; i < plan.length; i++) {
    say('Reading the capture', i / plan.length);
    try {
      const r = await recognizeCanvas(worker, plan[i][0], 'jpn', plan[i][1]);
      passes.push(r.syms);
    } catch (_) { /* skip this pass */ }
  }
  say('Reading the capture', 1);
  if (bitmap.close) bitmap.close();
  const merged = mergeSymbols(passes, known, 10);
  return { candidates: merged.kanji, canvas: base, debug: { passes: passes.map((syms) => syms.map((x) => `${x.t}(${Math.round(x.c)})`).join(' ')) } };
}
