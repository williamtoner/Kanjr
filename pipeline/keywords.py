"""Assign each kanji a unique primary keyword plus accepted alternates.

Sources, in priority order:
1. data/overrides/keywords.csv (hand curated)
2. KANJIDIC2 glosses, cleaned, first unused gloss wins; kanji are processed
   in learning-priority order so the common kanji keep the obvious word.
"""
from __future__ import annotations

import csv
import re
from dataclasses import dataclass, field
from pathlib import Path

OVERRIDES = Path(__file__).resolve().parent.parent / "data" / "overrides" / "keywords.csv"

# Glosses that never make a good primary keyword.
_BAD_PRIMARY = re.compile(
    r"^(counter for|radical|\(kokuji\)|no\.|-|.*\(.*\)$|.*radical.*|.*\bnumber\b.*of.*)",
    re.IGNORECASE,
)


@dataclass
class Keyword:
    primary: str
    alt: list[str] = field(default_factory=list)
    source: str = "auto"


def load_overrides(path: Path = OVERRIDES) -> dict[str, Keyword]:
    out: dict[str, Keyword] = {}
    if not path.exists():
        return out
    with open(path, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            k = (row.get("kanji") or "").strip()
            if not k or k.startswith("#"):
                continue
            alts = [a.strip() for a in (row.get("alt") or "").split(";") if a.strip()]
            out[k] = Keyword(primary=row["keyword"].strip(), alt=alts, source="override")
    return out


def clean_gloss(g: str) -> str:
    g = g.strip()
    g = re.sub(r"\s+", " ", g)
    return g


def assign_keywords(
    meanings: dict[str, list[str]],
    order: list[str],
    overrides: dict[str, Keyword] | None = None,
    reserved: set[str] | None = None,
) -> dict[str, Keyword]:
    """meanings: kanji -> KANJIDIC glosses; order: kanji in learning priority.

    reserved: names already used by radicals; never chosen automatically.
    """
    overrides = overrides or {}
    taken: dict[str, str] = {r.lower(): "<radical>" for r in (reserved or set())}
    result: dict[str, Keyword] = {}

    # Overrides claim their keywords first so automatic assignment avoids them.
    for k in order:
        if k in overrides:
            kw = overrides[k]
            low = kw.primary.lower()
            if low in taken:
                raise ValueError(f"duplicate keyword override {kw.primary!r}: {taken[low]} and {k}")
            taken[low] = k

    for k in order:
        glosses = [clean_gloss(g) for g in meanings.get(k, [])]
        if k in overrides:
            kw = overrides[k]
            # Keep KANJIDIC glosses as extra alternates (deduplicated).
            extra = [g for g in glosses if g.lower() not in {kw.primary.lower(), *[a.lower() for a in kw.alt]}]
            result[k] = Keyword(primary=kw.primary, alt=kw.alt + extra, source="override")
            continue
        primary = None
        for g in glosses:
            if _BAD_PRIMARY.match(g):
                continue
            if g.lower() in taken:
                continue
            primary = g
            break
        if primary is None:
            # Everything collides or is unusable: qualify the first gloss.
            base = glosses[0] if glosses else k
            primary = base
            n = 2
            while primary.lower() in taken:
                primary = f"{base} ({n})"
                n += 1
        taken[primary.lower()] = k
        alt = [g for g in glosses if g.lower() != primary.lower()]
        result[k] = Keyword(primary=primary, alt=alt, source="auto")
    return result


def collision_report(result: dict[str, Keyword]) -> list[tuple[str, str, str]]:
    """Pairs where one kanji's primary keyword is another's alternate."""
    prim = {kw.primary.lower(): k for k, kw in result.items()}
    out = []
    for k, kw in result.items():
        for a in kw.alt:
            other = prim.get(a.lower())
            if other and other != k:
                out.append((k, a, other))
    return out
