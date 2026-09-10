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

/**
 * Pull every CJK character out of recognised text, in order of first
 * appearance, with how often it appeared. `known` filters to the kanji the
 * app teaches (a Set of characters); others are reported separately so the
 * UI can say "3 characters not in the jōyō set".
 */
export function extractKanji(text, known) {
  const seen = new Map();
  let unknown = 0;
  const unknownChars = new Set();
  for (const ch of String(text || '')) {
    const cp = ch.codePointAt(0);
    const isCJK = (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df);
    if (!isCJK) continue;
    if (known && !known.has(ch)) { if (!unknownChars.has(ch)) { unknownChars.add(ch); unknown++; } continue; }
    seen.set(ch, (seen.get(ch) || 0) + 1);
  }
  return { kanji: Array.from(seen, ([char, count]) => ({ char, count })), unknown };
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

/** Create (once) a worker with the Japanese model. onProgress(label, ratio). */
export async function getWorker(onProgress) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const T = await loadLibrary();
    const worker = await T.createWorker('jpn', 1, {
      langPath: LANG_PATH,
      logger: (m) => {
        if (!onProgress || !m) return;
        const labels = { 'loading tesseract core': 'Loading recognition engine', 'initializing tesseract': 'Starting engine', 'loading language traineddata': 'Downloading Japanese model (1.5 MB, once)', 'initializing api': 'Preparing', 'recognizing text': 'Reading the photo' };
        onProgress(labels[m.status] || m.status, typeof m.progress === 'number' ? m.progress : 0);
      },
    });
    await worker.setParameters({ tessedit_pageseg_mode: '11' });   // sparse text: signs, menus, packaging
    return worker;
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

/** Draw the photo onto a canvas, downscaled and contrast-stretched. */
export async function prepareCanvas(file) {
  const bitmap = await loadBitmap(file);
  const { w, h } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  // Grayscale, then stretch the contrast between the 2nd and 98th percentile.
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
  if (bitmap.close) bitmap.close();
  return canvas;
}

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
 * Recognise kanji in a photo. Returns { kanji: [{char, count}], unknown, text }.
 * `known` is the Set of characters the app teaches.
 */
export async function recognizeKanji(file, known, onProgress) {
  const canvas = await prepareCanvas(file);
  const worker = await getWorker(onProgress);
  if (onProgress) onProgress('Reading the photo', 0);
  const { data } = await worker.recognize(canvas);
  const text = (data && data.text) || '';
  return Object.assign(extractKanji(text, known), { text, canvas });
}
