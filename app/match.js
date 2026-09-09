/**
 * match.js — answer normalisation and typo-tolerant matching.
 *
 * Pure functions only. The UI decides what to do with the verdicts.
 */

/**
 * Normalise a user answer or accepted meaning so that trivial differences
 * (case, whitespace, punctuation, full-width characters) never matter.
 *
 * Steps: NFKC → lowercase → strip punctuation except hyphens *inside* words
 * → collapse whitespace → trim.
 */
export function normalise(s) {
  if (s == null) return '';
  let out = String(s).normalize('NFKC').toLowerCase();
  // Keep letters, digits, whitespace and hyphens; drop everything else.
  out = out.replace(/[^\p{L}\p{N}\s-]/gu, '');
  // A hyphen only survives when it sits between two word characters.
  out = out.replace(/(^|[^\p{L}\p{N}])-+|-+(?=$|[^\p{L}\p{N}])/gu, '$1');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/**
 * A looser form for comparing meanings: drops a leading article or "to",
 * and a simple English plural, so "the tree", "to see" and "flowers" match
 * "tree", "see" and "flower". Applied to both sides of a comparison.
 */
const NUMBER_WORDS = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven',
  '8': 'eight', '9': 'nine', '10': 'ten', '100': 'hundred', '1000': 'thousand', '10000': 'ten thousand',
  '1000000': 'million', '100000000': 'hundred million', '1000000000000': 'trillion',
};

export function canonical(s) {
  let out = normalise(s);
  out = out.replace(/^(to|a|an|the) /, '');
  // Digits stand for the number word: "7" is "seven", "10,000" is "ten thousand".
  const digits = out.replace(/[\s,]/g, '');
  if (/^\d+$/.test(digits) && NUMBER_WORDS[digits]) return NUMBER_WORDS[digits];
  // "one hundred" and "a thousand" are just "hundred" and "thousand".
  out = out.replace(/^(one|a) (hundred|thousand|million|trillion)\b/, '$2');
  if (out.length > 4 && /[^s]s$/.test(out) && !/ss$/.test(out)) {
    out = out.replace(/ies$/, 'y').replace(/(ch|sh|x|z|s)es$/, '$1').replace(/s$/, '');
  }
  return out;
}

/**
 * Number of typos tolerated for an accepted answer of the given length
 * (WaniKani's thresholds): ≤3 → 0, 4–5 → 1, 6–8 → 2, ≥9 → 3.
 */
export function tolerance(length) {
  const n = Number(length) || 0;
  if (n <= 3) return 0;
  if (n <= 5) return 1;
  if (n <= 8) return 2;
  return 3;
}

/**
 * Damerau–Levenshtein distance (unrestricted: adjacent transpositions count
 * as a single edit and may be combined with other edits).
 */
export function damerau(a, b) {
  a = String(a); b = String(b);
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const INF = la + lb;
  // d has an extra row/column of INF sentinels for the transposition lookup.
  const d = [];
  for (let i = 0; i <= la + 1; i++) d.push(new Array(lb + 2).fill(0));
  d[0][0] = INF;
  for (let i = 0; i <= la; i++) { d[i + 1][0] = INF; d[i + 1][1] = i; }
  for (let j = 0; j <= lb; j++) { d[0][j + 1] = INF; d[1][j + 1] = j; }
  const lastRow = new Map();
  for (let i = 1; i <= la; i++) {
    const ca = a[i - 1];
    let lastCol = 0;
    for (let j = 1; j <= lb; j++) {
      const cb = b[j - 1];
      const i1 = lastRow.get(cb) || 0;
      const j1 = lastCol;
      const cost = ca === cb ? 0 : 1;
      if (cost === 0) lastCol = j;
      d[i + 1][j + 1] = Math.min(
        d[i][j] + cost,                                   // substitution / match
        d[i + 1][j] + 1,                                  // insertion
        d[i][j + 1] + 1,                                  // deletion
        d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1),      // transposition
      );
    }
    lastRow.set(ca, i);
  }
  return d[la + 1][lb + 1];
}

/**
 * Judge an answer against a list of accepted meanings.
 *
 * @returns {"exact"|"typo"|"wrong"}
 *   "exact" – normalised input equals a normalised accepted answer
 *   "typo"  – within the typo tolerance of one accepted answer (counts as
 *             correct; the UI nudges the user to check the spelling)
 *   "wrong" – neither
 * Pass `{ typoTolerance: false }` to disable the typo branch.
 */
export function isCorrect(input, accepted, options = {}) {
  const guess = normalise(input);
  if (!guess) return 'wrong';
  const list = (accepted || []).map(normalise).filter(Boolean);
  if (list.includes(guess)) return 'exact';
  const loose = canonical(input);
  const looseList = list.map(canonical);
  if (loose && looseList.includes(loose)) return 'exact';
  if (options.typoTolerance === false) return 'wrong';
  // Typo tolerance is judged against the accepted answers as written, so the
  // looser forms above never widen the thresholds.
  for (const answer of list) {
    const allowed = tolerance(answer.length);
    if (allowed === 0) continue;
    // Cheap length pre-check before the O(n·m) distance.
    if (Math.abs(answer.length - guess.length) > allowed) continue;
    if (damerau(guess, answer) <= allowed) return 'typo';
  }
  return 'wrong';
}

/**
 * All accepted answers for an item: primary name, alternates, user synonyms.
 */
export function acceptedFor(item, synonyms) {
  const out = [];
  if (item) {
    if (item.name) out.push(item.name);
    if (Array.isArray(item.alt)) out.push(...item.alt);
  }
  if (Array.isArray(synonyms)) out.push(...synonyms);
  return out;
}

/**
 * Detect a cross-item collision: the input exactly matches the name (or an
 * alternate) of a *different* item of the same type. The UI uses this to
 * offer a retry ("that's another kanji") instead of marking the answer wrong.
 *
 * @param {string} input
 * @param {object} item        the item being reviewed
 * @param {object} items       map of id → item (the whole dataset)
 * @returns {object|null}      the colliding item, or null
 */
export function findCollision(input, item, items) {
  const guess = normalise(input);
  if (!guess || !item || !items) return null;
  for (const id in items) {
    const other = items[id];
    if (!other || other.id === item.id || other.type !== item.type) continue;
    if (normalise(other.name) === guess) return other;
    if (Array.isArray(other.alt) && other.alt.some((a) => normalise(a) === guess)) return other;
  }
  return null;
}
