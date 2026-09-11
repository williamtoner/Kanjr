/**
 * sync.js — keep progress in a private GitHub Gist so several devices share
 * one file.
 *
 * The learner pastes a personal access token (gist scope only). The first
 * connect finds an existing Kanjr gist on the account or creates one. Every
 * later sync pulls the remote file, merges it with local progress (pure,
 * see mergeProgress), and pushes the result when anything changed.
 *
 * Only `mergeProgress` and the config helpers are pure; the network calls
 * live at the bottom and are never run at import time, so this module can
 * be unit tested in Node.
 */

export const SYNC_KEY = 'kanjr.sync.v1';
export const GIST_FILE = 'kanjr-progress.json';
export const GIST_DESCRIPTION = 'Kanjr progress — kanji meanings SRS (do not edit by hand)';
export const SYNC_LOG_CAP = 6000;   // review-log entries kept in the shared file (gist files over 1 MB get truncated)
const API = 'https://api.github.com';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    const cfg = raw ? JSON.parse(raw) : null;
    return cfg && typeof cfg.token === 'string' && typeof cfg.gistId === 'string' ? cfg : null;
  } catch (_) { return null; }
}

export function saveSyncConfig(cfg) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); } catch (_) { /* memory only */ }
}

export function clearSyncConfig() {
  try { localStorage.removeItem(SYNC_KEY); } catch (_) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Merge                                                               */
/* ------------------------------------------------------------------ */

function num(x) { return Number(x) || 0; }

/**
 * Merge two progress files into one. Neither input is mutated.
 *
 * - items: per item, the entry with more answers wins (correct + incorrect);
 *   ties go to the higher stage, then the later due time. The "seen before"
 *   flag survives if either side has it.
 * - days: per day, the larger count of each field.
 * - reviews: the union, ordered by time, capped.
 * - synonyms: the union per item. notes: the longer text.
 * - settings: from the side updated more recently.
 */
export function mergeProgress(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = (a.updatedAt || '') >= (b.updatedAt || '') ? a : b;
  const older = newer === a ? b : a;

  const items = {};
  const ids = new Set([...Object.keys(a.items || {}), ...Object.keys(b.items || {})]);
  for (const id of ids) {
    const x = a.items && a.items[id], y = b.items && b.items[id];
    let pick;
    if (!x) pick = y; else if (!y) pick = x;
    else {
      const ax = num(x.correct) + num(x.incorrect), ay = num(y.correct) + num(y.incorrect);
      if (ax !== ay) pick = ax > ay ? x : y;
      else if (num(x.stage) !== num(y.stage)) pick = num(x.stage) > num(y.stage) ? x : y;
      else pick = (x.due || '') >= (y.due || '') ? x : y;
    }
    const entry = Object.assign({}, pick);
    if ((x && x.manual) || (y && y.manual)) entry.manual = true;
    if ((x && x.shiny) || (y && y.shiny)) entry.shiny = true;
    if (x && y) {
      if (x.startedAt && y.startedAt) entry.startedAt = x.startedAt < y.startedAt ? x.startedAt : y.startedAt;
      entry.guruAt = entry.guruAt || x.guruAt || y.guruAt || null;
      entry.burnedAt = entry.burnedAt || x.burnedAt || y.burnedAt || null;
    }
    items[id] = entry;
  }

  const days = {};
  const keys = new Set([...Object.keys(a.days || {}), ...Object.keys(b.days || {})]);
  for (const k of keys) {
    const x = (a.days && a.days[k]) || {}, y = (b.days && b.days[k]) || {};
    const d = { lessons: Math.max(num(x.lessons), num(y.lessons)), reviews: Math.max(num(x.reviews), num(y.reviews)), correct: Math.max(num(x.correct), num(y.correct)) };
    const manual = Math.max(num(x.manual), num(y.manual));
    if (manual) d.manual = manual;
    days[k] = d;
  }

  const seen = new Set();
  const reviews = [];
  for (const r of [...(a.reviews || []), ...(b.reviews || [])]) {
    const key = `${r.t}|${r.id}|${r.ok ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reviews.push(r);
  }
  reviews.sort((p, q) => (p.t < q.t ? -1 : p.t > q.t ? 1 : 0));
  const cappedReviews = reviews.length > SYNC_LOG_CAP ? reviews.slice(reviews.length - SYNC_LOG_CAP) : reviews;

  const synonyms = {};
  for (const src of [a.synonyms || {}, b.synonyms || {}]) {
    for (const id in src) {
      const list = synonyms[id] || (synonyms[id] = []);
      for (const s of src[id]) if (!list.some((t) => t.toLowerCase() === String(s).toLowerCase())) list.push(s);
    }
  }
  const notes = Object.assign({}, a.notes || {});
  for (const id in b.notes || {}) {
    if (!notes[id] || String(b.notes[id]).length > String(notes[id]).length) notes[id] = b.notes[id];
  }

  return {
    version: 1,
    createdAt: [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || newer.createdAt,
    updatedAt: (a.updatedAt || '') >= (b.updatedAt || '') ? a.updatedAt : b.updatedAt,
    settings: Object.assign({}, older.settings || {}, newer.settings || {}),
    items, synonyms, notes, reviews: cappedReviews, days,
  };
}

/** A cheap fingerprint so we only push when something changed. */
export function fingerprint(progress) {
  const items = progress.items || {};
  let n = 0, sum = 0;
  for (const id in items) { n++; sum += num(items[id].stage) * 7 + num(items[id].correct) * 3 + num(items[id].incorrect); }
  return `${n}:${sum}:${(progress.reviews || []).length}:${Object.keys(progress.synonyms || {}).length}:${Object.keys(progress.notes || {}).length}:${progress.updatedAt || ''}`;
}

/** What goes into the gist: the progress with a capped review log. */
export function toSyncPayload(progress) {
  const reviews = progress.reviews || [];
  return Object.assign({}, progress, { reviews: reviews.length > SYNC_LOG_CAP ? reviews.slice(reviews.length - SYNC_LOG_CAP) : reviews });
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

async function api(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new SyncError('GitHub rejected the token. Check it was copied completely and has the gist permission.', 'auth');
  if (res.status === 403) throw new SyncError('GitHub refused the request (rate limit or missing gist permission).', 'auth');
  if (res.status === 404) throw new SyncError('The sync file was not found on GitHub. Disconnect and connect again.', 'notfound');
  if (!res.ok) throw new SyncError(`GitHub returned ${res.status}.`, 'http');
  return res.status === 204 ? null : res.json();
}

export class SyncError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/** Find the Kanjr gist on this account, or null. */
export async function findGist(token) {
  for (let page = 1; page <= 5; page++) {
    const list = await api(token, `/gists?per_page=100&page=${page}`);
    for (const g of list) if (g.files && g.files[GIST_FILE]) return g.id;
    if (list.length < 100) break;
  }
  return null;
}

/** Connect: reuse the account's Kanjr gist or create a private one. */
export async function connect(token, progress) {
  let gistId = await findGist(token);
  let created = false;
  if (!gistId) {
    const g = await api(token, '/gists', {
      method: 'POST',
      body: { description: GIST_DESCRIPTION, public: false, files: { [GIST_FILE]: { content: JSON.stringify(toSyncPayload(progress)) } } },
    });
    gistId = g.id;
    created = true;
  }
  return { gistId, created };
}

/** Download the remote progress. Returns { progress: object|null, updatedAt }. */
export async function pull(cfg) {
  const g = await api(cfg.token, `/gists/${cfg.gistId}`);
  const f = g.files && g.files[GIST_FILE];
  if (!f) return { progress: null, updatedAt: g.updated_at };
  let text = f.content;
  if (f.truncated) {
    const res = await fetch(f.raw_url);
    if (!res.ok) throw new SyncError('Could not download the sync file.', 'http');
    text = await res.text();
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { throw new SyncError('The sync file on GitHub is not valid JSON.', 'data'); }
  return { progress: parsed, updatedAt: g.updated_at };
}

/** Upload progress. */
export async function push(cfg, progress) {
  const g = await api(cfg.token, `/gists/${cfg.gistId}`, {
    method: 'PATCH',
    body: { files: { [GIST_FILE]: { content: JSON.stringify(toSyncPayload(progress)) } } },
  });
  return g.updated_at;
}

/**
 * One full sync. `validate` turns the raw remote JSON into a progress
 * object (the store's validator). Returns { progress, pushed, pulledChanges }.
 */
export async function syncOnce(cfg, local, validate) {
  const remote = await pull(cfg);
  let merged = local;
  let pulledChanges = false;
  if (remote.progress) {
    const v = validate(remote.progress);
    if (v.ok) {
      merged = mergeProgress(local, v.progress);
      pulledChanges = fingerprint(merged) !== fingerprint(local);
    }
  }
  const remoteFp = remote.progress ? fingerprint(merged) === (remote.progress && fingerprint(remote.progress)) : false;
  let pushed = false;
  if (!remoteFp) {
    await push(cfg, merged);
    pushed = true;
  }
  return { progress: merged, pushed, pulledChanges };
}
