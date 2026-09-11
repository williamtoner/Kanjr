/**
 * store.js — progress persistence.
 *
 *   localStorage   the live progress object, key `kanjr.progress.v1`,
 *                  written with a debounce
 *   sessionStorage the unfinished review session (reload safe)
 *   IndexedDB      one snapshot per day, last 14 days, as a safety net
 *   JSON file      export / import
 *
 * Every storage access is wrapped in try/catch. If storage is unavailable
 * (private mode, quota, disabled) the app keeps working in memory and
 * `status()` reports what failed so the UI can warn the user.
 */

export const STORAGE_KEY = 'kanjr.progress.v1';
export const SESSION_KEY = 'kanjr.session.v1';
export const BACKUP_DB = 'kanjr-backups';
export const BACKUP_STORE = 'snapshots';
export const BACKUP_KEEP_DAYS = 14;
export const PROGRESS_VERSION = 1;
const SAVE_DEBOUNCE_MS = 400;

export const DEFAULT_SETTINGS = Object.freeze({
  dailyLessons: 10,
  apprenticeCap: 120,
  unlockStage: 3,
  lessonBatch: 5,
  lightning: false,
  fontVariety: true,
  theme: 'auto',
  typoTolerance: true,
  sounds: true,
  volume: 70,
  haptics: true,
  celebrations: true,
  intro: true,
  music: true,
  musicVolume: 40,
});

/** Allowed ranges for numeric settings (used by import validation and the UI). */
export const SETTING_RANGES = Object.freeze({
  dailyLessons: [0, 100],
  apprenticeCap: [1, 1000],
  unlockStage: [1, 9],
  lessonBatch: [1, 20],
  volume: [0, 100],
  musicVolume: [0, 100],
});

const state = {
  localStorageOk: true,
  sessionStorageOk: true,
  indexedDBOk: typeof indexedDB !== 'undefined',
  lastError: null,
  timer: null,
  pending: null,
};

// ---------------------------------------------------------------------------
// Progress object
// ---------------------------------------------------------------------------

/** A fresh, empty progress object. */
export function defaultProgress(now = new Date()) {
  const iso = new Date(now).toISOString();
  return {
    version: PROGRESS_VERSION,
    createdAt: iso,
    updatedAt: iso,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    items: {},
    synonyms: {},
    notes: {},
    reviews: [],
    days: {},
  };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate an untrusted object (import, backup, storage) as progress.
 * Returns `{ ok: true, progress }` with a normalised copy or `{ ok: false, error }`.
 */
export function validateProgress(raw) {
  if (!isObject(raw)) return { ok: false, error: 'Not a progress object.' };
  if (raw.version !== undefined && Number(raw.version) > PROGRESS_VERSION) {
    return { ok: false, error: `Progress version ${raw.version} is newer than this app understands.` };
  }
  if (raw.items !== undefined && !isObject(raw.items)) return { ok: false, error: '"items" must be an object.' };
  if (raw.settings !== undefined && !isObject(raw.settings)) return { ok: false, error: '"settings" must be an object.' };
  if (raw.reviews !== undefined && !Array.isArray(raw.reviews)) return { ok: false, error: '"reviews" must be an array.' };
  if (raw.days !== undefined && !isObject(raw.days)) return { ok: false, error: '"days" must be an object.' };

  const base = defaultProgress();
  const out = {
    version: PROGRESS_VERSION,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    settings: normaliseSettings(raw.settings),
    items: {},
    synonyms: {},
    notes: {},
    reviews: [],
    days: {},
  };

  const items = raw.items || {};
  for (const id in items) {
    const e = items[id];
    if (!isObject(e)) return { ok: false, error: `Item "${id}" is malformed.` };
    const stage = Number(e.stage);
    if (!Number.isInteger(stage) || stage < 0 || stage > 9) return { ok: false, error: `Item "${id}" has an invalid stage.` };
    out.items[id] = {
      stage,
      due: typeof e.due === 'string' && !Number.isNaN(Date.parse(e.due)) ? e.due : null,
      startedAt: typeof e.startedAt === 'string' ? e.startedAt : null,
      guruAt: typeof e.guruAt === 'string' ? e.guruAt : null,
      burnedAt: typeof e.burnedAt === 'string' ? e.burnedAt : null,
      correct: Math.max(0, Math.trunc(Number(e.correct) || 0)),
      incorrect: Math.max(0, Math.trunc(Number(e.incorrect) || 0)),
    };
    if (e.manual) out.items[id].manual = true;   // marked "seen before": exempt from the apprentice cap
    if (e.shiny) out.items[id].shiny = true;     // caught during a shiny encounter
  }
  const synonyms = isObject(raw.synonyms) ? raw.synonyms : {};
  for (const id in synonyms) {
    if (Array.isArray(synonyms[id])) {
      const list = synonyms[id].filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());
      if (list.length) out.synonyms[id] = list;
    }
  }
  const notes = isObject(raw.notes) ? raw.notes : {};
  for (const id in notes) {
    if (typeof notes[id] === 'string' && notes[id].trim()) out.notes[id] = notes[id];
  }
  for (const r of raw.reviews || []) {
    if (isObject(r) && typeof r.id === 'string' && typeof r.t === 'string') {
      const entry = { t: r.t, id: r.id, ok: !!r.ok };
      if (typeof r.s === 'number') entry.s = r.s;   // stage at answer time, for accuracy by stage
      out.reviews.push(entry);
    }
  }
  const days = raw.days || {};
  for (const key in days) {
    const d = days[key];
    if (!isObject(d) || !/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    out.days[key] = {
      lessons: Math.max(0, Math.trunc(Number(d.lessons) || 0)),
      reviews: Math.max(0, Math.trunc(Number(d.reviews) || 0)),
      correct: Math.max(0, Math.trunc(Number(d.correct) || 0)),
    };
    if (d.manual) out.days[key].manual = Math.max(0, Math.trunc(Number(d.manual) || 0));
  }
  return { ok: true, progress: out };
}

/** Merge settings over the defaults, clamping numbers into range. */
export function normaliseSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, isObject(raw) ? raw : {});
  for (const key in SETTING_RANGES) {
    const [lo, hi] = SETTING_RANGES[key];
    const n = Math.trunc(Number(s[key]));
    s[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULT_SETTINGS[key];
  }
  s.lightning = !!s.lightning;
  s.fontVariety = s.fontVariety !== false;
  s.typoTolerance = s.typoTolerance !== false;
  s.sounds = s.sounds !== false;
  s.haptics = s.haptics !== false;
  s.celebrations = s.celebrations !== false;
  s.intro = s.intro !== false;
  s.music = s.music !== false;
  const mv = Number(s.musicVolume);
  s.musicVolume = Number.isFinite(mv) ? Math.max(0, Math.min(100, Math.round(mv))) : 40;
  const vol = Number(s.volume);
  s.volume = Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 70;
  s.theme = ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto';
  return s;
}

// ---------------------------------------------------------------------------
// localStorage
// ---------------------------------------------------------------------------

/** Load progress from localStorage, or a fresh object when absent/broken. */
export function load() {
  let text = null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    state.localStorageOk = false;
    state.lastError = err;
    return defaultProgress();
  }
  if (!text) return defaultProgress();
  try {
    const result = validateProgress(JSON.parse(text));
    if (result.ok) return result.progress;
    state.lastError = new Error(result.error);
  } catch (err) {
    state.lastError = err;
  }
  // Keep the unreadable blob around for manual recovery rather than overwrite it.
  try { localStorage.setItem(STORAGE_KEY + '.corrupt', text); } catch (_) { /* ignore */ }
  return defaultProgress();
}

/** Write progress now (synchronously). Returns true on success. */
export function writeNow(progress) {
  // An immediate write supersedes any debounced one still waiting.
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.pending = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    state.localStorageOk = true;
    return true;
  } catch (err) {
    state.localStorageOk = false;
    state.lastError = err;
    return false;
  }
}

/** Debounced save: the last object passed within the window is written. */
export function save(progress) {
  state.pending = progress;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

/** Write any pending save immediately (call on pagehide). */
export function flush() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (state.pending) {
    const p = state.pending;
    state.pending = null;
    writeNow(p);
  }
}

/** Remove all progress from localStorage. */
export function clearAll() {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  state.pending = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
  clearSession();
}

/** Health report for the Settings screen. */
export function status() {
  return {
    localStorage: state.localStorageOk,
    sessionStorage: state.sessionStorageOk,
    indexedDB: state.indexedDBOk,
    lastError: state.lastError ? String(state.lastError.message || state.lastError) : null,
  };
}

// ---------------------------------------------------------------------------
// sessionStorage (review session)
// ---------------------------------------------------------------------------

export function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
    state.sessionStorageOk = true;
  } catch (err) {
    state.sessionStorageOk = false;
    state.lastError = err;
  }
}

export function loadSession() {
  try {
    const text = sessionStorage.getItem(SESSION_KEY);
    if (!text) return null;
    const s = JSON.parse(text);
    if (!isObject(s) || !Array.isArray(s.queue) || !Array.isArray(s.done)) return null;
    return s;
  } catch (err) {
    state.sessionStorageOk = false;
    state.lastError = err;
    return null;
  }
}

export function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/** Pretty JSON for download. */
export function exportJSON(progress) {
  return JSON.stringify(progress, null, 2);
}

/** Suggested file name for an export. */
export function exportFileName(now = new Date()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `kanjr-progress-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** Trigger a browser download of the progress file. */
export function downloadExport(progress, now = new Date()) {
  const blob = new Blob([exportJSON(progress)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(now);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse the text of an imported file. */
export function parseImport(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  return validateProgress(raw);
}

// ---------------------------------------------------------------------------
// IndexedDB daily backups
// ---------------------------------------------------------------------------

function openBackupDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let req;
    try {
      req = indexedDB.open(BACKUP_DB, 1);
    } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BACKUP_STORE)) {
        db.createObjectStore(BACKUP_STORE, { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/**
 * Store today's snapshot (overwriting today's earlier one) and prune to the
 * last BACKUP_KEEP_DAYS. Safe to call often; failures are swallowed.
 * `dateKey` is the local YYYY-MM-DD for today.
 */
export async function backupDaily(progress, dateKey) {
  try {
    const db = await openBackupDB();
    const tx = db.transaction(BACKUP_STORE, 'readwrite');
    const store = tx.objectStore(BACKUP_STORE);
    store.put({
      date: dateKey,
      savedAt: new Date().toISOString(),
      itemCount: Object.keys(progress.items || {}).length,
      progress,
    });
    const keys = await reqPromise(store.getAllKeys());
    keys.sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - BACKUP_KEEP_DAYS))) {
      if (key !== dateKey) store.delete(key);
    }
    await txPromise(tx);
    db.close();
    state.indexedDBOk = true;
    return true;
  } catch (err) {
    state.indexedDBOk = false;
    state.lastError = err;
    return false;
  }
}

/** List available snapshots, newest first (without the payload). */
export async function listBackups() {
  try {
    const db = await openBackupDB();
    const tx = db.transaction(BACKUP_STORE, 'readonly');
    const all = await reqPromise(tx.objectStore(BACKUP_STORE).getAll());
    db.close();
    return all
      .map((b) => ({ date: b.date, savedAt: b.savedAt, itemCount: b.itemCount }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  } catch (err) {
    state.indexedDBOk = false;
    state.lastError = err;
    return [];
  }
}

/** Load one snapshot's progress (validated), or null. */
export async function loadBackup(dateKey) {
  try {
    const db = await openBackupDB();
    const tx = db.transaction(BACKUP_STORE, 'readonly');
    const rec = await reqPromise(tx.objectStore(BACKUP_STORE).get(dateKey));
    db.close();
    if (!rec) return null;
    const result = validateProgress(rec.progress);
    return result.ok ? result.progress : null;
  } catch (err) {
    state.indexedDBOk = false;
    state.lastError = err;
    return null;
  }
}
