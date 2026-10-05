"""Lookalikes: which jōyō kanji are easily mistaken for which.

    python3 pipeline/lookalikes.py            # writes data/content/lookalikes.json

Every kanji is drawn in a headless browser (Noto Sans JP, the app's own
face), reduced to a small blurred bitmap, and compared with every other one.
Two kanji are lookalikes when their bitmaps correlate more strongly than
either does with its usual neighbours; the score is nudged up when they
share a named part (待 / 持 share 寺), and curated groups from
data/overrides/lookalikes.csv are always included. The result is
committed, so the normal build needs neither a browser nor numpy.

Needs `playwright` (with Chromium) and `numpy` in the interpreter.
"""
from __future__ import annotations

import base64
import csv
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "content" / "lookalikes.json"
OVERRIDES = ROOT / "data" / "overrides" / "lookalikes.csv"
BITMAPS = ROOT / "data" / "raw" / "glyph_bitmaps.json"   # cache, not committed

SIZE = 32            # bitmap side after downsampling
MIN_SCORE = 0.04     # similarity above the two kanji's own baselines (see `adjusted`)
PART_BONUS = 0.015   # two kanji that share a named part are easier to mix up
MAX_PER_KANJI = 4

PAGE = """<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@500&display=swap">
<canvas id="c" width="64" height="64"></canvas>"""

RENDER_JS = """async (chars) => {
  const font = '500 54px "Noto Sans JP"';
  for (let i = 0; i < chars.length; i += 40) await document.fonts.load(font, chars.slice(i, i + 40).join(''));
  await document.fonts.ready;
  const c = document.getElementById('c'), ctx = c.getContext('2d', { willReadFrequently: true });
  const out = {};
  for (const ch of chars) {
    ctx.clearRect(0, 0, 64, 64);
    ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
    ctx.fillText(ch, 32, 34);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    const small = new Uint8Array(32 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) s += d[((y * 2 + dy) * 64 + x * 2 + dx) * 4 + 3];
      small[y * 32 + x] = s >> 2;
    }
    out[ch] = btoa(String.fromCharCode(...small));
  }
  return { bitmaps: out, loaded: document.fonts.check(font, chars[0]) };
}"""


def render_bitmaps(chars: list[str]) -> dict[str, str]:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content(PAGE, wait_until="networkidle")
        res = page.evaluate(RENDER_JS, chars)
        browser.close()
    if not res["loaded"]:
        raise SystemExit("Noto Sans JP did not load; refusing to compare fallback glyphs")
    return res["bitmaps"]


def load_bitmaps(chars: list[str]) -> np.ndarray:
    cached = json.loads(BITMAPS.read_text(encoding="utf-8")) if BITMAPS.exists() else {}
    if any(c not in cached for c in chars):
        cached = render_bitmaps(chars)
        BITMAPS.write_text(json.dumps(cached, ensure_ascii=False), encoding="utf-8")
    arr = np.stack([np.frombuffer(base64.b64decode(cached[c]), dtype=np.uint8).reshape(SIZE, SIZE) for c in chars])
    return arr.astype(np.float32) / 255.0


def blur(imgs: np.ndarray, passes: int = 2) -> np.ndarray:
    """Separable [1 2 1] blur: thin strokes that are a pixel apart still overlap."""
    out = imgs
    for _ in range(passes):
        p = np.pad(out, ((0, 0), (1, 1), (0, 0)), mode="constant")
        out = (p[:, :-2] + 2 * p[:, 1:-1] + p[:, 2:]) / 4
        p = np.pad(out, ((0, 0), (0, 0), (1, 1)), mode="constant")
        out = (p[:, :, :-2] + 2 * p[:, :, 1:-1] + p[:, :, 2:]) / 4
    return out


def unit(imgs: np.ndarray) -> np.ndarray:
    v = imgs.reshape(len(imgs), -1)
    v = v - v.mean(axis=1, keepdims=True)
    return v / (np.linalg.norm(v, axis=1, keepdims=True) + 1e-9)


def shape_similarity(imgs: np.ndarray) -> np.ndarray:
    """Correlation of blurred bitmaps, best over a one-pixel shift either way."""
    base = unit(blur(imgs))
    best = base @ base.T
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            shifted = unit(blur(np.roll(np.roll(imgs, dy, axis=1), dx, axis=2)))
            best = np.maximum(best, base @ shifted.T)
    return best


def load_overrides() -> list[list[str]]:
    if not OVERRIDES.exists():
        return []
    with open(OVERRIDES, encoding="utf-8", newline="") as fh:
        return [list(row["kanji"].strip()) for row in csv.DictReader(fh) if row.get("kanji", "").strip()]


def main() -> int:
    data = json.loads((ROOT / "data" / "kanji.json").read_text(encoding="utf-8"))
    kanji = [i for i in data["items"].values() if i["type"] == "kanji"]
    chars = [k["char"] for k in kanji]
    index = {c: n for n, c in enumerate(chars)}
    imgs = load_bitmaps(chars)
    sim = shape_similarity(imgs)
    identical = int(((sim > 0.9995).sum() - len(chars)) / 2)
    if identical > 5:
        raise SystemExit(f"{identical} pairs render identically: the font is not drawing these kanji")

    # Dense kanji correlate with everything, so raw similarity is not
    # comparable between pairs. Subtract each kanji's own baseline (the mean
    # of its 20 nearest neighbours): what is left says how much closer this
    # pair is than either kanji's usual company.
    np.fill_diagonal(sim, -1)
    baseline = np.sort(sim, axis=1)[:, -20:].mean(axis=1)
    score = sim - 0.5 * (baseline[:, None] + baseline[None, :])
    np.fill_diagonal(score, -1)

    parts = [set(k.get("parts", [])) for k in kanji]
    pairs: dict[str, dict[str, float]] = {c: {} for c in chars}
    order = np.argsort(-score, axis=1)[:, :12]
    for a in range(len(chars)):
        for b in order[a]:
            s = float(score[a, b]) + (PART_BONUS if parts[a] & parts[b] else 0.0)
            if s >= MIN_SCORE:
                pairs[chars[a]][chars[b]] = pairs[chars[b]][chars[a]] = max(s, pairs[chars[a]].get(chars[b], 0))
    for group in load_overrides():
        members = [c for c in group if c in index]
        for a in members:
            for b in members:
                if a != b:
                    pairs[a][b] = 2.0 + float(score[index[a], index[b]])   # curated: always first, closest first

    out = {}
    for c in chars:
        best = sorted(pairs[c].items(), key=lambda kv: -kv[1])[:MAX_PER_KANJI]
        if best:
            out[c] = [b for b, _ in best]
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=0, sort_keys=True).replace("\n", "") + "\n", encoding="utf-8")
    n_pairs = len({tuple(sorted((a, b))) for a, bs in out.items() for b in bs})
    print(f"{len(out)} of {len(chars)} kanji have lookalikes; {n_pairs} distinct pairs -> {OUT}")
    if "--show" in sys.argv:
        for c in sys.argv[sys.argv.index("--show") + 1:]:
            if c in index:
                row = sorted(((float(score[index[c], j]), chars[j]) for j in range(len(chars))), reverse=True)[:8]
                print(c, " ".join(f"{b}{s:.2f}" for s, b in row), "| kept:", "".join(out.get(c, [])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
