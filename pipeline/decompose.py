"""Turn KRADFILE's flat element lists into hierarchical components.

KRADFILE lists every visible element of a kanji, so 話 is given as
言 口 舌 even though 口 is part of 舌. WaniKani-style learning wants the
opposite: 話 = 言 + 舌, and 時 = 日 + 寺, reusing kanji the learner already
knows as building blocks. `recompose` does that greedily: it covers the
flat element set with the largest known kanji whose own element sets fit
inside it, and whatever is left over is a primitive radical or an atomic
kanji.

Because the element sets are flat (no position information) the greedy
cover is a heuristic. Known mistakes are corrected through
data/overrides/parts.csv, which wins over the algorithm.
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from .parse import STANDIN_GLYPHS

OVERRIDES = Path(__file__).resolve().parent.parent / "data" / "overrides" / "parts.csv"

# 2010 joyo additions whose official glyph is outside JIS X 0208; KRADFILE
# only has the JIS form.
GLYPH_VARIANTS = {"剝": "剥", "頰": "頬", "𠮟": "叱", "塡": "填"}

# Elements that wrap around or sit above/below/beside the rest of a kanji.
# A kanji containing an enclosure is never an inner part of another kanji
# (過 cannot be inside 週). A kanji containing a side radical can only be a
# part when the target has a top or enclosing element around it
# (荷 = 艹 + 何 is fine; 何 cannot be the right half of something).
ENCLOSURES = {"込", "廴", "疔", "門", "气", "阡", "邦"}
SIDE = {"化", "汁", "扎", "忙", "犯", "礼", "初", "阡", "彳"}
TOP = {"艾", "宀", "冖", "買", "老", "尚", "个", "亠", "并", "杰", "癶", "乞"}
WRAPPERS = ENCLOSURES | TOP | {"广", "厂", "尸", "囗", "匚", "凵", "勹"}
RIGHT = {"刈", "攵", "頁", "隹", "殳", "邦", "欠", "斤", "卩", "彡"}
BOTTOM = {"杰", "儿", "心", "皿", "廾", "夂", "又", "寸", "灬"}

# Generic strokes and tiny elements that KRADFILE lists for search purposes.
# They are dropped from a decomposition that already has two real parts.
MINOR = {"一", "｜", "ノ", "丶", "亅", "二", "ハ", "并", "亠", "乞"}

# Approximate visual position, used only to order parts for display:
# left-side radicals first, then the body, then right/bottom elements.
POSITION = {**{s: 0 for s in SIDE}, **{s: 0 for s in ENCLOSURES}, **{s: 1 for s in TOP},
            **{s: 1 for s in ("广", "厂", "尸", "囗", "匚")},
            **{s: 3 for s in RIGHT}, **{s: 4 for s in BOTTOM}}

# A kanji is only used as a part of another if it is reasonably common in
# its own right (rank within the first ~35 levels) or at least as common as
# the kanji it would be part of. Otherwise its elements stand on their own,
# so that a level-2 kanji does not drag a level-55 kanji forward with it.
PART_RANK_CAP = 1300


@dataclass
class Decomposition:
    char: str
    flat: frozenset[str]          # KRADFILE symbols (stand-ins kept as-is)
    parts: list[str]              # ids: "k:<kanji>" or "r:<symbol>"
    overridden: bool = False


def flat_elements(krad: dict[str, list[str]], char: str) -> frozenset[str]:
    src = GLYPH_VARIANTS.get(char, char)
    return frozenset(krad.get(src, [src]))


def load_overrides(path: Path = OVERRIDES) -> dict[str, list[str]]:
    """parts.csv: kanji,parts  where parts is space separated ids or glyphs.

    A part written as a bare kanji means that kanji; a part written as
    r:<symbol> means the KRADFILE radical symbol.
    """
    out: dict[str, list[str]] = {}
    if not path.exists():
        return out
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            if not row.get("kanji") or row["kanji"].startswith("#"):
                continue
            parts = []
            for p in row["parts"].split():
                parts.append(p if p.startswith(("k:", "r:")) else f"k:{p}")
            out[row["kanji"]] = parts
    return out


def recompose(
    char: str,
    krad: dict[str, list[str]],
    item_set: set[str],
    rank: dict[str, int],
    overrides: dict[str, list[str]] | None = None,
) -> Decomposition:
    flat = flat_elements(krad, char)
    if overrides and char in overrides:
        return Decomposition(char=char, flat=flat, parts=overrides[char], overridden=True)

    # A kanji that KRADFILE lists as an element of itself (見 : 見 目) is a
    # recurring unit; treat it as an atom rather than decomposing it.
    if char in flat or GLYPH_VARIANTS.get(char, char) in flat:
        return Decomposition(char=char, flat=flat, parts=[])

    remaining = set(flat)
    parts: list[str] = []
    my_rank = rank.get(char, 10**6)
    has_wrapper = bool(flat & WRAPPERS)

    candidates = []
    for k in item_set:
        if k == char:
            continue
        es = flat_elements(krad, k)
        if len(es) < 2 or not es <= flat or es == flat:
            continue
        if es & ENCLOSURES:
            continue
        if es & SIDE and not has_wrapper:
            continue
        k_rank = rank.get(k, 10**6)
        if k_rank > PART_RANK_CAP and k_rank > my_rank:
            continue
        candidates.append((-len(es), k_rank, k, es))
    candidates.sort()

    chosen_es: set[str] = set()
    for _neg, _r, k, es in candidates:
        if es <= remaining:
            parts.append(f"k:{k}")
            remaining -= es
            chosen_es |= es

    # Leftover elements. A kanji in the item set is a kanji part; anything
    # else is a radical. Drop leftovers that are themselves elements of
    # another leftover kanji (新 lists both 辛 and 立; 辛 contains 立).
    leftovers = sorted(remaining, key=lambda s: rank.get(s, 10**6))
    covered_by_kanji: set[str] = set()
    for s in leftovers:
        if s in item_set or s not in STANDIN_GLYPHS:
            covered_by_kanji |= flat_elements(krad, s) - {s}
    leftovers = [s for s in leftovers if s not in covered_by_kanji]

    real = [s for s in leftovers if s not in MINOR] + parts
    for s in leftovers:
        if s in MINOR and len(real) >= 2:
            continue
        # Stand-in symbols always denote the element (汁 means 氵, never the
        # kanji "juice"), so they are radicals even when the kanji is joyo.
        is_kanji_part = s in item_set and s != char and s not in STANDIN_GLYPHS
        parts.append(f"k:{s}" if is_kanji_part else f"r:{s}")

    if parts == [f"k:{char}"] or parts == [f"r:{char}"]:
        parts = []
    parts = order_parts(parts, rank)
    return Decomposition(char=char, flat=flat, parts=parts)


def order_parts(parts: list[str], rank: dict[str, int]) -> list[str]:
    def key(p: str):
        sym = p[2:]
        return (POSITION.get(sym, 2), rank.get(sym, 10**6))
    return sorted(dict.fromkeys(parts), key=key)


def all_decompositions(
    krad: dict[str, list[str]],
    item_set: set[str],
    rank: dict[str, int],
    overrides: dict[str, list[str]] | None = None,
) -> dict[str, Decomposition]:
    return {k: recompose(k, krad, item_set, rank, overrides) for k in item_set}


def radical_symbols(decomps: dict[str, Decomposition]) -> dict[str, int]:
    """Radical symbols used as parts -> usage count."""
    counts: dict[str, int] = {}
    for d in decomps.values():
        for p in d.parts:
            if p.startswith("r:"):
                counts[p[2:]] = counts.get(p[2:], 0) + 1
    return counts


def display_glyph(symbol: str) -> str:
    return STANDIN_GLYPHS.get(symbol, symbol)


def part_label(p: str) -> str:
    return p[2:] if p.startswith("k:") else display_glyph(p[2:])
