# Kanjr web app specification

Kanjr is a WaniKani-style spaced-repetition app for learning the **meanings**
of Japanese kanji. No readings, no pronunciation, ever. This document is the
contract between the data pipeline (`pipeline/`, Python) and the web app
(`app/`, static HTML/CSS/JS). The app must feel like a finished product:
fast, keyboard-first on desktop, thumb-friendly on a phone, and pleasant to
look at.

## Files

```
app/
  index.html            single page; loads style.css and app.js (type="module")
  style.css             all styling; CSS custom properties; light + dark theme
  app.js                screens, routing (hash-based), rendering
  engine.js             lesson/review queue logic (pure functions over state)
  srs.js                SRS stage transitions (pure functions)
  match.js              answer normalisation and typo-tolerant matching (pure)
  store.js              persistence: localStorage + JSON export/import
  sw.js                 service worker: cache app shell + data for offline use
  manifest.webmanifest  PWA manifest (name "Kanjr", standalone, theme colour)
  icons/                icon-192.png, icon-512.png (generate simple ones: a
                        rounded square with 字 in white on the kanji colour)
tests/
  run.mjs               tiny test runner (see Testing)
  srs.test.mjs, match.test.mjs, engine.test.mjs
```

Serve from the repository root: `python3 -m http.server 8000` then open
`http://localhost:8000/app/`. The data file is fetched from `../data/kanji.json`.
No build step, no bundler, no framework, no external JS. Google Fonts may be
used for `Noto Sans JP` (kanji glyphs) and one UI font, with system fallbacks
(`"Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`), and the app must
still work with the fonts blocked.

Node on this machine is v12, so: ES modules with `.mjs` extension for tests,
no `node --test`, no optional chaining in test files is fine but avoid
top-level await. Browser code may use modern syntax (ES2020).

## Data contract: `data/kanji.json`

```jsonc
{
  "meta": { "built": "2026-09-08T18:00:00Z", "version": 1,
            "counts": { "kanji": 2136, "radicals": 170, "levels": 72 } },
  "items": {
    "k:日": {
      "id": "k:日", "type": "kanji", "char": "日",
      "name": "day",                     // primary keyword, unique across kanji
      "alt": ["sun", "Japan"],           // accepted alternates
      "level": 1, "pos": 3,              // position within level (0-based)
      "strokes": 4, "grade": 1, "jlpt": 4,
      "freq": 1,                          // corpus frequency rank among joyo (1 = most common)
      "parts": ["r:汁", "k:毎"],          // component item ids (may be empty for atoms)
      "used_in": ["k:明", "k:時"],        // kanji this item appears in
      "mnemonic": "…",                    // may be "" if not written yet
      "examples": [ { "word": "毎日", "gloss": "every day; daily" } ]
    },
    "r:汁": {
      "id": "r:汁", "type": "radical", "char": "氵",   // display glyph
      "name": "water drops", "alt": ["tsunami"],
      "level": 1, "pos": 0, "strokes": 3,
      "note": "left-side form of water",  // short descriptive note
      "used_in": ["k:海", "k:法"],
      "mnemonic": ""
    }
  },
  "levels": [ { "level": 1, "items": ["r:…", "k:…", "…"] } ]   // in learning order
}
```

Radicals are components that are not themselves kanji in the set. When a
kanji is a component of another kanji it is referenced directly (`k:寺`
inside `k:時`), so there is never a duplicate radical/kanji pair.

## SRS (srs.js)

WaniKani's scheme. Stages:

| stage | name | interval to next review |
|---|---|---|
| 0 | locked / not started | – |
| 1 | Apprentice 1 | 4 h |
| 2 | Apprentice 2 | 8 h |
| 3 | Apprentice 3 | 1 day |
| 4 | Apprentice 4 | 2 days |
| 5 | Guru 1 | 1 week |
| 6 | Guru 2 | 2 weeks |
| 7 | Master | 1 month (30 days) |
| 8 | Enlightened | 4 months (120 days) |
| 9 | Burned | never |

Groups: apprentice 1–4, guru 5–6, master 7, enlightened 8, burned 9.

- A lesson completes → stage 1, due = now + 4 h.
- A review item is *complete* when answered correctly. If it was answered
  wrongly `w` times before that in this session, the new stage is
  `max(1, stage - ceil(w / 2) * penalty)` where penalty is 1 for stages 1–4
  and 2 for stages 5–8. Otherwise the new stage is `stage + 1`.
- Due time = now + interval(newStage). Round due times *down* to the hour so
  reviews arrive in batches (WaniKani behaviour). Stage 9 has no due time.
- Export a pure `nextState({stage, wrong}, now) -> {stage, due}` and
  `intervalHours(stage)`, `groupOf(stage)`, `stageName(stage)`.

## Progress state (store.js)

```jsonc
{
  "version": 1,
  "createdAt": "…", "updatedAt": "…",
  "settings": { "dailyLessons": 6, "apprenticeCap": 120, "unlockStage": 3,
                "lessonBatch": 5, "lightning": false, "theme": "auto",
                "typoTolerance": true },
  "items": { "k:日": { "stage": 3, "due": "2026-09-09T10:00:00Z",
                       "startedAt": "…", "guruAt": null, "burnedAt": null,
                       "correct": 5, "incorrect": 1 } },
  "synonyms": { "k:日": ["daytime"] },
  "notes": { "k:日": "my own mnemonic" },
  "reviews": [ { "t": "2026-09-08T18:00:00Z", "id": "k:日", "ok": true } ],  // log, capped at 20 000
  "days": { "2026-09-08": { "lessons": 6, "reviews": 40, "correct": 36 } }
}
```

Persist to localStorage under key `kanjr.progress.v1`; debounce writes.
Export = pretty JSON download; import = file picker, validated, replaces
state after confirmation. Also keep a daily snapshot in IndexedDB
(`kanjr-backups`, last 14 days) as a safety net, with a "restore backup"
list in Settings. Wrap every storage access in try/catch and work in memory
if storage is unavailable.

## Lesson and review logic (engine.js)

- **Lesson queue**: items with no progress (stage 0), taken in global order
  (`levels[].items` flattened), where every part in `parts` has
  `stage >= settings.unlockStage`. Items that are not yet unlocked are
  skipped, not blocked on. Limits: `dailyLessons - lessons done today`, and
  none at all while apprentice count (stages 1–4) ≥ `apprenticeCap`.
- **Lessons UI**: batches of `lessonBatch`. For each item show a full lesson
  card (see Screens). After the batch, quiz all batch items (typed answer,
  retry until correct; quiz wrong answers do not affect SRS). On finishing
  the quiz all batch items become stage 1.
- **Review queue**: items with 1 ≤ stage ≤ 8 and due ≤ now, shuffled.
  Wrong answers put the item back into the queue (a few positions later).
  An item leaves the queue on its first correct answer; SRS updates then.
  Track per-item wrong count for the session. "Wrap up" finishes the items
  already in progress and ends the session. Reload safe: unfinished session
  state lives in sessionStorage.
- **Current level** = level of the next lesson item (or highest level with
  any progress). Level progress = share of that level's items ≥ Guru.
- **Forecast**: reviews due per hour for the next 24 h and per day for the
  next 7 days, from progress.due values.
- **Streak**: consecutive days (local time) with at least one review or
  lesson recorded in `days`.

## Answer matching (match.js)

`normalise(s)`: lowercase, trim, collapse whitespace, strip punctuation
except hyphens inside words, NFKC. `isCorrect(input, accepted[])` returns
`"exact" | "typo" | "wrong"`. Typo tolerance (Damerau–Levenshtein distance)
by accepted-answer length: ≤3 → 0, 4–5 → 1, 6–8 → 2, ≥9 → 3. A "typo"
result counts as correct but the UI flashes "close enough, check the
spelling". If the input matches the name of a *different* item of the same
type exactly, the UI shakes and lets the user retry once ("that's another
kanji") before marking it wrong — WaniKani does this for readings; we do it
for cross-item collisions. Any user synonym is accepted.

## Screens (app.js) — hash routes

- `#/` **Home**: level badge and progress ring; big buttons "Lessons (n)"
  and "Reviews (n)"; next review time; today's numbers; streak; forecast
  bars for the next 24 h; stage-group counts (apprentice/guru/master/
  enlightened/burned); "recent mistakes" chips.
- `#/lessons` **Lessons**: card with the glyph very large, name, alternates,
  parts as chips (click to peek), mnemonic, examples (kanji), "used in"
  chips (radicals). Then the batch quiz. Progress dots for the batch.
- `#/reviews` **Reviews**: focus mode. Glyph huge, type-badge (radical/kanji)
  colour bar, input box auto-focused, Enter to submit, Enter again to
  continue. On wrong: show correct answer, mnemonic, parts; item shakes.
  Counter "12 / 40", accuracy so far, wrap-up button. Lightning mode setting
  auto-advances on correct.
- `#/item/<id>` **Item page**: everything about the item, SRS stage, due,
  history (correct/incorrect counts), user synonyms (add/remove), user note
  (editable), parts and used-in links, examples.
- `#/levels` and `#/levels/<n>` **Levels**: grid of levels; a level shows its
  items as tiles coloured by stage.
- `#/grid` **Grid**: every item as one small box in learning order, coloured
  by SRS stage (locked, apprentice, guru, master, enlightened, burned), with a
  legend that shows the counts, a stacked progress bar, a "kanji only" toggle
  and optional level dividers. Radicals are round, kanji square; a white dot
  marks an item due now. Click a box for its item page. "Add kanji you already
  know" switches the grid into selection mode: click locked boxes or type/paste
  kanji into a box to select them, then "Add to circulation" puts them straight
  in at Apprentice 1 (`engine.startManually`) without using the day's lesson
  allowance; the lesson queue continues from the remaining kanji in order. The
  item page has the same action for a single locked item.
- `#/stats` **Stats**: totals by stage, accuracy over time, reviews per day
  (last 30 days bars), 7-day forecast, level timeline.
- `#/settings` **Settings**: pace (dailyLessons), apprentice cap, unlock
  stage, batch size, lightning, theme, typo tolerance; export/import; backups;
  reset with confirmation; about + licences (link to `../data/LICENSES.md`).

Keyboard: Enter submits/continues; in reviews `Esc` = wrap up; `?` toggles
the info panel; in lessons ←/→ move between cards. Everything reachable by
tab; focus rings visible.

## Visual design

- Type colours: radical `#0ea5e9` (blue), kanji `#ec4899` (pink). Stage
  colours: apprentice `#f472b6`, guru `#a855f7`, master `#3b82f6`,
  enlightened `#06b6d4`, burned `#374151`.
- Neutral UI: near-white background, slate text; dark theme swaps to a slate
  background. Respect `prefers-color-scheme` and the theme setting.
- Glyph sizes: reviews 8–10 rem on desktop, `min(28vw, 8rem)` on phones.
- Subtle motion only: shake on wrong, fade between cards, progress ring
  animates. Respect `prefers-reduced-motion`.
- A thin top bar with the logo ("Kanjr"), nav (Home, Levels, Stats,
  Settings) and level badge; collapses to a bottom tab bar under 640 px.
- Empty states are friendly ("No reviews right now — next batch at 14:00").

## Testing

`tests/run.mjs` imports each `*.test.mjs` file, runs exported test functions
(`export const tests = { "name": () => {…} }`) with `assert` from Node, and
prints pass/fail counts, exit code 1 on failure. Cover every SRS transition
and penalty case, due-time rounding, typo thresholds, cross-item collision
detection, lesson unlock rules, apprentice cap, daily cap, review ordering
and requeue, forecast bucketing, and streak calculation across midnight.

Run: `node tests/run.mjs`.
