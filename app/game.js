/**
 * game.js — the "catch them all" layer: rarity tiers, dex numbers, shiny
 * encounters. Pure functions; the UI decides how to show them.
 */

export const RARITIES = [
  { key: 'common', label: 'Common', stars: 1, maxFreq: 300 },
  { key: 'uncommon', label: 'Uncommon', stars: 2, maxFreq: 800 },
  { key: 'rare', label: 'Rare', stars: 3, maxFreq: 1400 },
  { key: 'epic', label: 'Epic', stars: 4, maxFreq: 1900 },
  { key: 'legendary', label: 'Legendary', stars: 5, maxFreq: Infinity },
];

/** Rarity from how often a kanji appears in real text (1 = most common). */
export function rarity(freqRank) {
  const f = Number(freqRank);
  if (!Number.isFinite(f) || f <= 0) return RARITIES[0];
  for (const r of RARITIES) if (f <= r.maxFreq) return r;
  return RARITIES[RARITIES.length - 1];
}

/** Radicals are the building blocks: always "Common" but labelled as parts. */
export function rarityOf(item) {
  if (!item) return RARITIES[0];
  if (item.type === 'radical') return { key: 'part', label: 'Part', stars: 0, maxFreq: 0 };
  return rarity(item.freq);
}

/** "Power" is just the stroke count, worn like a stat. */
export function power(item) { return (item && item.strokes) || 0; }

/** Dex numbers follow the learning order, 1-based, zero-padded to 4. */
export function dexNumbers(data) {
  const out = {};
  let n = 0;
  for (const lv of data.levels) for (const id of lv.items) out[id] = ++n;
  return out;
}

export function dexNo(n) { return `No. ${String(n).padStart(4, '0')}`; }

export const SHINY_ODDS = 64;   // one encounter in 64 is shiny

/** Small deterministic hash so a shiny encounter stays shiny on re-render. */
export function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/**
 * Is this encounter shiny? Decided from the item and the session start
 * time, so it does not change while the card is on screen, but a new
 * session rolls again.
 */
export function isShinyEncounter(id, sessionKey, odds = SHINY_ODDS) {
  return hash32(`${id}|${sessionKey}`) % odds === 0;
}
