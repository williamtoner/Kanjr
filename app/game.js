/**
 * game.js — the "catch them all" layer: rarity tiers, dex numbers, shiny
 * encounters. Pure functions; the UI decides how to show them.
 */

export const RARITIES = [
  { key: 'common', label: 'Common', stars: 1, maxFreq: 300 },
  { key: 'uncommon', label: 'Uncommon', stars: 2, maxFreq: 800 },
  { key: 'rare', label: 'Rare', stars: 3, maxFreq: 1400 },
  { key: 'epic', label: 'Epic', stars: 4, maxFreq: 1900 },
  { key: 'ancient', label: 'Ancient', stars: 5, maxFreq: Infinity },
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

export const LEGENDARY_ODDS = 512;   // one encounter in 512 is legendary (colourful shiny)

/**
 * What kind of encounter this is: 'legendary', 'shiny' or null. Legendary
 * is rolled first with its own salt so the two never depend on each other.
 */
export function encounterKind(id, sessionKey) {
  if (hash32(`L|${id}|${sessionKey}`) % LEGENDARY_ODDS === 0) return 'legendary';
  if (isShinyEncounter(id, sessionKey)) return 'shiny';
  return null;
}

/* ---------- KanjiQuest: a kanji of the day to find in the wild ---------- */

export const QUEST_MAX_FREQ = 600;       // quest kanji are common enough to meet on a sign or a menu
export const QUEST_SHINY_ODDS = 4;       // a quest kanji caught in the wild is shiny one time in 4
export const QUEST_LEGENDARY_ODDS = 16;  // and legendary one time in 16

/** The candidates for a quest: common kanji, in dex order. */
export function questPool(data) {
  const out = [];
  for (const lv of data.levels) for (const id of lv.items) {
    const it = data.items[id];
    if (it.type === 'kanji' && it.freq && it.freq <= QUEST_MAX_FREQ) out.push(id);
  }
  return out;
}

/** The kanji of the day for a local date key (YYYY-MM-DD); the same for everyone. */
export function questFor(dateKey, pool) {
  if (!pool.length) return null;
  return pool[hash32(`quest|${dateKey}`) % pool.length];
}

/** Rolls for a wild catch of the quest kanji on its day. */
export function wildRoll(dateKey, id) {
  const h = hash32(`wild|${dateKey}|${id}`);
  if (h % QUEST_LEGENDARY_ODDS === 0) return 'legendary';
  if ((h >>> 8) % QUEST_SHINY_ODDS === 0) return 'shiny';
  return null;
}

/** Current and best streak of consecutive quest days, ending today or yesterday. */
export function questStreak(quests, todayKey) {
  const days = Object.keys(quests || {}).filter((k) => quests[k]).sort();
  if (!days.length) return { current: 0, best: 0 };
  const dayMs = 86400000;
  const toMs = (k) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    run = toMs(days[i]) - toMs(days[i - 1]) === dayMs ? run + 1 : 1;
    if (run > best) best = run;
  }
  const last = toMs(days[days.length - 1]);
  const today = toMs(todayKey);
  const current = today - last <= dayMs ? run : 0;
  return { current, best };
}
