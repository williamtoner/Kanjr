# Kanjr — Project Plan

A daily flash-card system for learning the **meanings** of Japanese kanji.
No readings, no pronunciation. WaniKani-style spaced repetition, ordered so
that simple, common, high-value kanji come first and every kanji is learned
after the pieces it is built from.

Written 2026-09-08. Target: in daily use within one week; full scope reached
within one year.

---

## 1. Goals and non-goals

**Goals**
- Learn the meaning of every kanji in a defined set (default: the 2,136 jōyō
  kanji, which cover essentially all everyday Japanese writing).
- Usable every day in under 20 minutes: reviews first, then a capped number of
  new lessons.
- Ordering that respects three things at once: *simplicity* (stroke count and
  structural complexity), *importance* (school grade, JLPT level), and
  *frequency* (how often the kanji appears in real text).
- Feels like WaniKani: levels, typed answers, Apprentice → Guru → Master →
  Enlightened → Burned, a mnemonic per item, and components ("radicals")
  taught before the kanji that contain them.
- Progress never lost. Works offline.

**Non-goals**
- Readings (on'yomi / kun'yomi), vocabulary pronunciation, pitch accent.
- Handwriting or stroke-order practice (may show stroke count only).
- Accounts, multi-user, monetisation.

---

## 2. What the user experiences each day

1. Open the app. The home screen shows: reviews due now, lessons available,
   current level, streak, and a forecast of reviews for the next 24 hours.
2. **Reviews.** Each card shows a large kanji. You type its meaning in
   English. Correct → it advances one SRS stage. Wrong → it drops back and you
   see the meaning, the components, and the mnemonic before continuing.
3. **Lessons.** After reviews, up to N new items (default 6). Each lesson
   shows the kanji, its primary keyword, alternate meanings, its components
   with their names, a mnemonic, stroke count, frequency rank, and two or
   three example words with English glosses (readings hidden). A short quiz
   follows; items then enter the SRS at Apprentice 1.
4. Done. The app tells you when the next batch of reviews is due.

Optional extras in the same session: a "recent mistakes" drill, and a search
box to look any kanji up.

---

## 3. Data

All data is built offline by a Python pipeline into a single `kanji.json`
that the app loads. Sources (all free for this use; licences recorded in
`data/LICENSES.md`):

| Need | Source | Notes |
|---|---|---|
| Kanji list, meanings, grade, JLPT, stroke count, newspaper frequency | **KANJIDIC2** (EDRDG, CC BY-SA 4.0) | Canonical. Gives the jōyō set and English glosses. |
| Component decomposition | **KRADFILE / KRADFILE2** (EDRDG) | Which visual parts make up each kanji. Drives ordering and mnemonics. |
| Modern corpus frequency | **scriptin/kanji-frequency** (CC BY 4.0) | Aggregated counts from Wikipedia, news, novels, Aozora. Better than newspaper-only. |
| Example words with glosses | **JMdict** (EDRDG, CC BY-SA 4.0) | Pick 2–3 common words per kanji; show word + English only. |
| Component names | Hand-curated list (~250 entries) | KRADFILE parts have no names; we assign memorable ones, WaniKani-style. |
| Mnemonics | Generated in batches by Claude during the build, then stored in the data file and editable in the app | Built from the component names so every mnemonic references parts already learned. |

**Unique keywords.** KANJIDIC glosses collide (several kanji gloss as "see",
"think", etc). The pipeline assigns each kanji one **unique primary keyword**
so that a meaning maps to exactly one kanji, and keeps the remaining glosses
as accepted alternates. Collisions are resolved by a script plus a small
hand-edited override file.

---

## 4. Ordering algorithm

Goal: a single global order, cut into **levels of 30 items**, such that
every kanji appears after the components it is made of, and within that
constraint, higher-value and simpler kanji come first.

1. **Priority score** per kanji (lower = earlier):
   - frequency rank from the aggregated corpus (weight 0.5)
   - school grade / secondary-school status (weight 0.3)
   - JLPT level (weight 0.1)
   - stroke count (weight 0.1)
   Weights live in a config file so they can be tuned.
2. **Dependency graph** from KRADFILE: kanji → its components. Components
   that are themselves kanji are ordinary nodes; pure components become
   "radical" items.
3. **Greedy topological fill.** Repeatedly pick the lowest-score item whose
   dependencies are already placed, until the level has 30 items. Radicals
   are cheap and get pulled in just ahead of the first kanji that needs them.
4. **Sanity checks** in the build: no level exceeds a stroke-count median
   jump of more than 3 over the previous level; the 100 most frequent kanji
   all land in the first 6 levels; every jōyō kanji is present exactly once.
5. Emit `order.csv` alongside `kanji.json` so the ordering can be inspected
   and hand-tweaked (an override file lets us pin an item to a level).

Expected result: ~72 levels for jōyō + ~250 radicals. Level 1 looks like
一 二 三 人 口 日 月 山 川 大 小 …

---

## 5. Spaced repetition

WaniKani's fixed-stage scheme, because it is predictable and the user
already knows it. Intervals:

| Stage | Interval to next review |
|---|---|
| Apprentice 1 | 4 h |
| Apprentice 2 | 8 h |
| Apprentice 3 | 1 day |
| Apprentice 4 | 2 days |
| Guru 1 | 1 week |
| Guru 2 | 2 weeks |
| Master | 1 month |
| Enlightened | 4 months |
| Burned | never (can be resurrected) |

- Correct answer → +1 stage.
- Wrong answer → back 1 stage if Apprentice, back 2 if Guru or above
  (WaniKani's penalty rule). Wrong answers within one session count once.
- Due times are rounded to the hour so reviews arrive in batches.
- **Level-up** when 90 % of the level's kanji reach Guru, which unlocks the
  next level's lessons. Radicals must reach Guru before dependent kanji
  become available.
- The scheduler is a pure function `next_state(state, correct, now)` so it
  can be unit-tested and swapped for FSRS later if desired.

**Answer checking.** Normalise (lowercase, trim, strip punctuation), then
accept if it matches the keyword, any alternate, or any user-added synonym,
with WaniKani's typo tolerance: 0 typos allowed for answers ≤3 letters, 1
for 4–5, 2 for 6–8, 3 for 9+ (Damerau-Levenshtein). A near-miss shakes the
box and lets you retry once rather than marking wrong.

---

## 6. Pace and the one-year timeline

Today is 8 Sept 2026. Three pace options; pace is a setting, not a rebuild.

| Pace | New items/day | Reaches | Steady-state reviews/day |
|---|---|---|---|
| Gentle | 4 | ~1,000 most frequent kanji by mid-2027; jōyō in ~20 months | ~50 |
| **Standard (default)** | 6 | All jōyō by ~Sept 2027 (one year) | ~80 |
| Fast | 10 | ~1,000 most frequent by 31 Dec 2026; jōyō by ~April 2027 | ~140 |

The first 1,000 kanji cover roughly 90 % of characters in running text, so
even the gentle pace pays off quickly. The build includes a **simulator**
that runs a year of virtual daily sessions at each pace with a configurable
error rate and reports the daily review load, so we can check these numbers
before committing.

---

## 7. Architecture

Keep it small and dependency-light.

```
kanjr/
├── PLAN.md               this file
├── rules.txt             working rules
├── prompts/              logged prompts and responses
├── data/
│   ├── raw/              downloaded sources (git-ignored, fetched by script)
│   ├── overrides/        keyword_overrides.csv, level_pins.csv, radical_names.csv
│   ├── LICENSES.md
│   └── kanji.json        built output
├── pipeline/             Python 3.12, no heavy deps
│   ├── fetch.py          download sources
│   ├── parse.py          KANJIDIC2 / KRADFILE / JMdict / frequency → records
│   ├── keywords.py       unique keyword assignment
│   ├── order.py          scoring + topological level fill
│   ├── mnemonics.py      batch mnemonic generation + caching
│   ├── build.py          runs everything, writes kanji.json + order.csv
│   └── simulate.py       year-long load simulation
├── app/                  static web app, no build step
│   ├── index.html
│   ├── app.js            screens: home, lessons, reviews, item page, stats, settings
│   ├── srs.js            scheduler (pure functions)
│   ├── match.js          answer normalisation + typo tolerance
│   ├── store.js          progress persistence + export/import
│   ├── style.css
│   └── sw.js             service worker so it works offline / installs on phone
└── tests/
    ├── test_order.py, test_keywords.py, test_simulate.py
    └── srs.test.js, match.test.js  (run with node --test)
```

**Why a static web app.** It runs in any browser, installs to a phone home
screen as a PWA, needs no server, and can be served from this machine
(`python -m http.server`) or GitHub Pages. Progress lives in `localStorage`
with one-click JSON export/import so it is never trapped in a browser.
A tiny optional sync server (FastAPI + one JSON file) is a Phase 5 add-on if
multi-device use becomes a nuisance.

**Why vanilla JS.** Three screens and a few hundred lines. A framework would
add a build step and nothing else.

---

## 8. Build phases

| Phase | Days | Deliverable | Done when |
|---|---|---|---|
| 0 Scaffold | 1 | Repo layout, rules, logging convention, `git init`, licences file | Directory tree exists, first commit |
| 1 Data pipeline | 1–2 | `fetch.py`, `parse.py`, `keywords.py`, `order.py`, `build.py` → `kanji.json`, `order.csv` | All 2,136 jōyō present, keywords unique, ordering sanity checks pass, tests green |
| 2 Core app | 2–3 | Home, lessons, reviews, SRS, storage, export/import | Can do a full lesson→review cycle; `srs.test.js` and `match.test.js` green |
| 3 Content | 4–5 | Radical names, mnemonics for levels 1–10, example words | Every item in levels 1–10 has a mnemonic and 2 example words |
| 4 Daily-use polish | 5–7 | Stats page, review forecast, streak, keyboard shortcuts, mobile layout, service worker, settings (pace, synonyms) | Installed on phone; used for one real day |
| 5 Ongoing | weekly | Mnemonics for later levels generated ahead of the user's level; tune ordering from real mistake data; optional sync server | Rolling |

**Start using it at the end of Phase 2** with levels 1–3, even before content
polish. Real use surfaces the right bugs.

---

## 9. Testing and quality

- Pipeline: unit tests for keyword uniqueness, dependency order (no kanji
  before its components), level size, and presence of all jōyō.
- App: pure-function tests for the scheduler (every stage transition, the
  penalty rule, rounding) and for answer matching (typo thresholds, synonyms,
  Unicode normalisation).
- Simulation: `simulate.py` at each pace, asserting daily reviews stay under
  the table in §6 by a margin.
- Manual: a checklist run on phone and desktop before each weekly release.

---

## 10. Risks and decisions already made

- **Keyword collisions** are the main data-quality risk. Mitigation: unique
  keyword step plus override file, reviewed by the user for the first 10
  levels.
- **Mnemonic quality** varies. Mitigation: generated from named components,
  editable in-app, user edits are exported with progress.
- **Losing progress** in `localStorage`. Mitigation: export reminder every 7
  days, plus automatic daily snapshot into IndexedDB.
- **Review debt** if a day is skipped. Mitigation: lessons are gated on
  Apprentice count (WaniKani's approach), so a backlog self-limits.
- **Decision: meanings only, one card type.** No reverse (meaning → kanji)
  cards by default; can be added as a setting later.
- **Decision: jōyō is the scope**, with the top ~1,000 as the first
  milestone. Jinmeiyō and rarer kanji are out of scope.

---

## 11. Immediate next steps

1. `git init`, add `.gitignore` for `data/raw/`.
2. Write `pipeline/fetch.py` and download the four sources.
3. Build the first `kanji.json` and inspect `order.csv` for levels 1–5.
4. Build the review screen and start using it.

---

## Status log

- **2026-09-08** Phase 0 and Phase 1 complete. Sources fetched, pipeline built
  (`parse`, `decompose`, `keywords`, `order`, `build`, `simulate`), 95 radicals
  named, keywords curated for the ~300 most common kanji, mnemonics written
  for levels 1–3, 17 pipeline tests passing. Simulation at the standard pace
  (6 new items/day, 90 % accuracy): 1,000 kanji by day 181, all jōyō by day
  373, about 59 reviews a day. Phase 2 (web app) in progress.
- **2026-09-08 (later)** Phase 2 and Phase 4 delivered in one pass: the web app
  (seven screens, WaniKani SRS, typed answers with typo tolerance, lessons in
  batches with quiz, reload-safe review sessions, export/import, IndexedDB
  backups, PWA manifest and service worker, light/dark, mobile tab bar) with
  77 passing unit tests and a headless-Chromium walkthrough free of console
  errors. Phase 3 target met: every item in levels 1–10 (340 items) has a
  mnemonic. Added `pipeline/bundle.py` for a single-file build. Next: mnemonics
  for levels 11+, review of the automatic decompositions and keywords beyond
  level 10, and real daily use to surface the rest.
- **2026-09-09** Grid tab (every item as a colour-coded box), manual "mark as
  caught" for known kanji, lenient answer matching (canonical forms plus a
  curated synonym table), immediate review for manual adds, default pace 10.
  Repository published at github.com/williamtoner/Kanjr and served by GitHub
  Pages at williamtoner.github.io/Kanjr/app/; the prompt log was removed from
  history first (rule 6). Device sync via a private GitHub Gist, with
  copy/paste transfer for sandboxed copies.
- **2026-09-10** Leeches with a practice drill, richer stats (projected
  finish, accuracy by stage, items-learned chart, activity heatmap), typeface
  variety in reviews, and a prominent "No, I got this right" override.
  Sounds and haptics: synthesised dings that climb with a streak, stage-up and
  burn chimes, bursts, streak counters and confetti.
- **2026-09-11** Kanjidex redesign: ink/vermilion/paper identity, adventure
  vocabulary (encounters, sightings, dex, catch, trainer level), rarity tiers,
  dex numbers, shiny encounters (1 in 64), Kanjiland intro screen, seal-stamp
  app icon. Photo capture reworked around a draggable capture square with
  candidate picking (multi-scale OCR passes plus a shape-template second
  opinion and a stroke-complexity check).
- **2026-09-12** Four-channel chiptune music with five original tunes per
  scene, plus iOS audio fixes (unlock on touchend, silent-mode workaround).
  Celebration tune that loops on summary screens, an evolution moment when a
  kanji reaches a new stage group, softened light and dark themes, and
  shimmering shiny stamps in the dex.

### Open threads (as of 2026-09-12)

1. **Mnemonics stop at level 10** (340 of 2,231 items). Levels 11–20 are the
   next content batch; keywords and decompositions beyond level 10 are
   automatic and unreviewed.
2. **Learning order**: a "simplicity-leaning" re-weighting was measured and
   recommended (nothing above 10 strokes in levels 1–4) but never applied.
   The user has not said yes or no.
3. **Photo capture**: still the weakest feature on real photographs. The next
   step needs real photos from the user to benchmark against, or a switch to
   a scene-text model (PaddleOCR via ONNX) or a cloud recogniser.
