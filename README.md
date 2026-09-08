# Kanjr

A WaniKani-style spaced-repetition app for learning the **meanings** of the
2,136 jōyō kanji. No readings, no pronunciation. Kanji are taught in an
order that respects frequency, school grade and simplicity, and every kanji
comes after the components it is built from.

See [PLAN.md](PLAN.md) for the full plan and [docs/APP_SPEC.md](docs/APP_SPEC.md)
for the data contract and UX spec.

## Quick start

```bash
python3 pipeline/fetch.py          # download KANJIDIC2, KRADFILE, JMdict, frequency data
python3 -m pipeline.build          # build data/kanji.json and data/order.csv
python3 -m http.server 8000        # then open http://localhost:8000/app/
```

Tests:

```bash
python3 -m unittest discover -s tests -p 'test_*.py'   # pipeline
node tests/run.mjs                                     # app logic
```

Pace simulation (predicts daily review load for each pace setting):

```bash
python3 -m pipeline.simulate
```

## Layout

```
pipeline/    Python data pipeline (fetch, parse, decompose, keywords, order, build, simulate)
data/
  raw/       downloaded sources (git-ignored)
  overrides/ hand-curated corrections: radicals.csv, keywords.csv, parts.csv
  content/   hand-written mnemonics, one JSON file per level
  kanji.json built output consumed by the app
  order.csv  the learning order, for review
app/         static web app (no build step)
tests/       pipeline tests (unittest) and app tests (node)
docs/        specifications
prompts/     log of every prompt and response (see rules.txt)
```

## How the order is decided

1. Every kanji gets a score in "rank units": its corpus frequency rank plus
   penalties for stroke count, school grade and JLPT level.
2. KRADFILE's flat element lists are recomposed into hierarchical parts
   (話 = 言 + 舌, 時 = 日 + 寺). Elements that are not jōyō kanji become
   named radicals. Hand corrections live in `data/overrides/parts.csv`.
3. A part inherits the score of the most important kanji that uses it, so it
   is learned just before it is needed.
4. Items are dealt into levels of 30 in score order, parts always before the
   kanji that use them.

## Licences

Data sources and their licences are listed in [data/LICENSES.md](data/LICENSES.md).
The generated `data/kanji.json` is CC BY-SA 4.0.
