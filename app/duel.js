/**
 * duel.js — Lookalike duels: telling apart kanji that are easy to mix up.
 * Pure functions; the UI decides how to show them.
 *
 * Pairs come from two places: the dataset's `lookalikes` (similar shapes)
 * and the learner's own mix-ups, recorded in `progress.confusions` as
 *   { "k:末|k:未": { n: 3, wins: 1, last: "2026-10-05T…" } }
 * where `n` counts how often the two were confused and `wins` counts duels
 * won in a row since. A pair is "settled" after SETTLED_WINS straight wins.
 */

export const SETTLED_WINS = 3;
export const DUEL_SIZE = 8;        // groups per session
export const MAX_GROUP = 3;        // kanji per ordinary duel
export const MAX_FOCUS_GROUP = 4;  // kanji when duelling one kanji's lookalikes

export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function iso(now) { return new Date(now instanceof Date ? now.getTime() : now).toISOString(); }

function isLearned(data, progress, id) {
  const item = data.items[id];
  const entry = progress.items && progress.items[id];
  return !!(item && item.type === 'kanji' && entry && Number(entry.stage) > 0);
}

/** The learner mistook `a` for `b` (or the reverse). Returns a new progress object. */
export function recordConfusion(progress, a, b, now) {
  if (!a || !b || a === b) return progress;
  const key = pairKey(a, b);
  const prev = (progress.confusions && progress.confusions[key]) || { n: 0, wins: 0 };
  const confusions = Object.assign({}, progress.confusions, { [key]: { n: (Number(prev.n) || 0) + 1, wins: 0, last: iso(now) } });
  return Object.assign({}, progress, { confusions });
}

/**
 * Record a finished duel over `ids`. Winning adds a win to every recorded
 * mix-up inside the group; losing resets their streaks (the specific wrong
 * pick is recorded separately with recordConfusion).
 */
export function recordDuel(progress, ids, won, now) {
  const confusions = Object.assign({}, progress.confusions);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const key = pairKey(ids[i], ids[j]);
    const c = confusions[key];
    if (c) confusions[key] = Object.assign({}, c, { wins: won ? (Number(c.wins) || 0) + 1 : 0 });
  }
  const prev = progress.duels || {};
  const duels = { played: (Number(prev.played) || 0) + 1, won: (Number(prev.won) || 0) + (won ? 1 : 0), last: iso(now) };
  return Object.assign({}, progress, { confusions, duels });
}

export function isSettled(c) { return !!c && (Number(c.wins) || 0) >= SETTLED_WINS; }

/** Recorded mix-ups, worst first: [{ a, b, n, wins, last, settled }]. */
export function confusedPairs(progress) {
  const out = [];
  const src = (progress && progress.confusions) || {};
  for (const key in src) {
    const [a, b] = key.split('|');
    const c = src[key];
    out.push({ a, b, n: Number(c.n) || 0, wins: Number(c.wins) || 0, last: c.last || '', settled: isSettled(c) });
  }
  out.sort((x, y) => (x.settled - y.settled) || (y.n - x.n) || (x.last < y.last ? 1 : x.last > y.last ? -1 : 0));
  return out;
}

/**
 * Everything `id` should not be confused with: the learner's own mix-ups
 * first (with counts), then the dataset's lookalikes.
 */
export function partnersOf(data, progress, id) {
  const out = [];
  const seen = new Set([id]);
  for (const p of confusedPairs(progress)) {
    const other = p.a === id ? p.b : p.b === id ? p.a : null;
    if (!other || seen.has(other) || !data.items[other]) continue;
    seen.add(other);
    out.push({ id: other, n: p.n, settled: p.settled });
  }
  const item = data.items[id];
  for (const other of (item && item.lookalikes) || []) {
    if (seen.has(other) || !data.items[other]) continue;
    seen.add(other);
    out.push({ id: other, n: 0, settled: false });
  }
  return out;
}

/**
 * Every duel available now: groups of 2–3 learned kanji. Own mix-ups that
 * are not settled come first and weigh most; shape lookalikes weigh by how
 * often their members have been missed.
 */
export function duelGroups(data, progress) {
  const learned = (id) => isLearned(data, progress, id);
  const groups = [];
  const seen = new Set();
  const add = (ids, source, weight) => {
    const key = ids.slice().sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    groups.push({ ids, source, weight });
  };
  const missed = (id) => Math.min(5, Number(progress.items[id] && progress.items[id].incorrect) || 0);

  for (const p of confusedPairs(progress)) {
    if (p.settled || !learned(p.a) || !learned(p.b)) continue;
    const ids = [p.a, p.b];
    // A third kanji from the same family makes the duel harder to guess.
    const extra = [...((data.items[p.a].lookalikes) || []), ...((data.items[p.b].lookalikes) || [])].find((o) => !ids.includes(o) && learned(o));
    if (extra && ids.length < MAX_GROUP) ids.push(extra);
    add(ids, 'confused', 100 + p.n * 10 - p.wins * 5);
  }
  for (const id in progress.items || {}) {
    if (!learned(id)) continue;
    const others = ((data.items[id].lookalikes) || []).filter(learned).slice(0, MAX_GROUP - 1);
    if (!others.length) continue;
    const ids = [id, ...others];
    add(ids, 'lookalike', 1 + ids.reduce((s, x) => s + missed(x), 0));
  }
  groups.sort((x, y) => y.weight - x.weight || (x.ids.join('') < y.ids.join('') ? -1 : 1));
  return groups;
}

/** One duel built around a single kanji: it and its learned partners. */
export function focusGroup(data, progress, id) {
  if (!isLearned(data, progress, id)) return null;
  const others = partnersOf(data, progress, id).map((p) => p.id).filter((o) => isLearned(data, progress, o)).slice(0, MAX_FOCUS_GROUP - 1);
  return others.length ? { ids: [id, ...others], source: 'focus', weight: 0 } : null;
}

/**
 * Choose the groups for one session: heaviest first with a little shuffle
 * among the shape lookalikes, and no kanji appearing in two duels.
 */
export function pickDuels(groups, rng = Math.random, n = DUEL_SIZE) {
  const scored = groups.map((g) => ({ g, s: g.weight + (g.source === 'confused' ? 0 : rng() * 6) }));
  scored.sort((x, y) => y.s - x.s);
  const used = new Set();
  const out = [];
  for (const { g } of scored) {
    if (out.length >= n) break;
    if (g.ids.some((id) => used.has(id))) continue;
    g.ids.forEach((id) => used.add(id));
    out.push(g);
  }
  return out;
}

function shuffled(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The questions of one duel: every kanji in the group is the target once,
 * alternating between "which kanji means X?" (`pick: 'kanji'`) and "what
 * does this kanji mean?" (`pick: 'meaning'`). Options are the whole group,
 * reshuffled each time.
 */
export function buildQuestions(ids, rng = Math.random) {
  const order = shuffled(ids, rng);
  const first = rng() < 0.5 ? 'kanji' : 'meaning';
  return order.map((target, i) => ({
    target,
    pick: (i % 2 === 0) === (first === 'kanji') ? 'kanji' : 'meaning',
    options: shuffled(ids, rng),
  }));
}

/** A fresh session: { duels: [{ ids, source, questions }] }. */
export function createDuelSession(groups, rng = Math.random) {
  return { duels: groups.map((g) => ({ ids: g.ids, source: g.source, questions: buildQuestions(g.ids, rng) })) };
}

/** Numbers for the Home card; `picked` is a stable, non-overlapping preview. */
export function duelSummary(data, progress) {
  const groups = duelGroups(data, progress);
  const picked = pickDuels(groups, () => 0, 999);
  return {
    groups,
    picked,
    confused: groups.filter((g) => g.source === 'confused').length,
    available: picked.length,
  };
}

/**
 * Which ink of glyph `a` has no counterpart in glyph `b`? Both are w×h masks
 * (non-zero = ink). A pixel of `a` is "different" when no ink of `b` lies
 * within `r` pixels of it (Chebyshev distance), so strokes that merely sit a
 * little to one side in the two glyphs are not flagged. Returns a mask the
 * UI paints in red: the extra stroke of 未 against 末, the radical of 待
 * against 持.
 */
export function diffMask(a, b, w, h, r) {
  // Dilate b by r with two separable max passes.
  const tmp = new Uint8Array(w * h), near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !on; k++) on = b[y * w + k] ? 1 : 0;
    tmp[y * w + x] = on;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let on = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !on; k++) on = tmp[k * w + x];
    near[y * w + x] = on;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = a[i] && !near[i] ? 1 : 0;
  return out;
}
