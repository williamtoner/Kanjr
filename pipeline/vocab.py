"""Vocabulary: common JMdict words written with the kanji the learner knows.

    parse JMdict -> candidate words (jōyō kanji + kana only, common, not
    usually-kana) -> one list per level (a word belongs to the level of the
    last kanji it needs) -> items of type "vocab".

Each level gets roughly as many words as it has kanji, chosen so that every
kanji in the level gets at least one word, then the most common words fill
the rest. A word's `parts` are the kanji it is made of, so the same unlock
rule as kanji applies: all parts must reach `unlockStage` first.
"""
from __future__ import annotations

import gzip
import json
import re
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from . import parse

RAW = parse.RAW
MAX_LEN = 5

# JMdict_e expands its entity codes into descriptions ("noun (common)
# (futsuumeishi)", "word usually written using kana alone"), so the filters
# below match on fragments of that text.
BAD_KE_INF = ("search-only", "rarely used", "ateji", "irregular", "out-dated")
BAD_RE_INF = ("search-only", "rarely used", "irregular", "out-dated")
BAD_MISC = ("kana alone", "archaic", "obsolete", "rare term", "vulgar", "derogatory",
            "slang", "abbreviation", "historical", "poetical", "colloquial", "jocular",
            "familiar", "honorific", "humble", "polite", "children", "male term", "female term",
            "onomatopoeic", "yojijukugo", "proverb", "quotation", "legend", "formal or literary",
            "dated", "sensitive", "euphemistic", "full name", "place name", "work of art")
# Word classes that make poor flashcards on their own.
BAD_POS = ("suffix", "prefix", "counter", "auxiliary", "conjunction", "particle",
           "interjection", "unclassified", "copula", "pre-noun", "numeric")

KIND_BY_POS = [
    ("verb", "verb"),
    ("adject", "adjective"),
    ("adverb", "adverb"),
    ("noun", "noun"),
    ("pronoun", "noun"),
    ("expression", "expression"),
]


def _any(texts, fragments) -> bool:
    return any(f in t for t in texts for f in fragments)


def kind_of(pos: set[str]) -> str:
    """A coarse word class for the card: nouns that take suru count as nouns."""
    if any(p.startswith("noun") or p.startswith("pronoun") for p in pos):
        return "noun"
    if any("verb" in p and not p.startswith("adverb") for p in pos):
        return "verb"
    if any("adject" in p for p in pos):
        return "adjective"
    if any(p.startswith("adverb") for p in pos):
        return "adverb"
    if any(p.startswith("expression") for p in pos):
        return "expression"
    return "word"


_PAREN = re.compile(r"\s*\([^)]*\)|\s*\{[^}]*\}|\s*\[[^\]]*\]")


def clean_gloss(g: str) -> str:
    """'meal (e.g. lunch)' -> 'meal'; drop glosses that stay too long or that
    start with a bracketed part ('(what) the heck' is a fragment without it)."""
    if g.lstrip().startswith("("):
        return ""
    s = _PAREN.sub("", g).strip().strip(".,;:").strip()
    s = re.sub(r"\s+", " ", s)
    if not s or len(s) > 32 or "/" in s:
        return ""
    return s


@dataclass
class VocabWord:
    word: str
    reading: str
    glosses: list[str]          # cleaned, first sense first
    kind: str
    score: float
    kanji: list[str] = field(default_factory=list)   # distinct, in order
    tags: list[str] = field(default_factory=list)    # JMdict ke_pri tags

    @property
    def name(self) -> str:
        return self.glosses[0]


# ichi1 marks the "Ichimango goi bunruishu" basic-vocabulary list: the best
# signal that a word is worth a learner's time. news* is newspaper frequency,
# which favours bureaucratic and business words.
_TAG_SCORE = {"ichi1": 4.0, "spec1": 2.5, "news1": 2.0, "gai1": 0.5,
              "ichi2": 2.0, "spec2": 1.5, "news2": 1.0, "gai2": 0.3}


def priority_score(tags: list[str]) -> float:
    score = 0.0
    for t in tags:
        if t.startswith("nf"):
            score += (49 - int(t[2:])) / 48.0     # nf01 = 1.0 ... nf48 = 0
        else:
            score += _TAG_SCORE.get(t, 0.0)
    return score


def _reading_for(elem: ET.Element, keb: str) -> str:
    for r_ele in elem.findall("r_ele"):
        if r_ele.find("re_nokanji") is not None:
            continue
        restr = [x.text for x in r_ele.findall("re_restr")]
        if restr and keb not in restr:
            continue
        if _any({x.text for x in r_ele.findall("re_inf")}, BAD_RE_INF):
            continue
        reb = r_ele.findtext("reb")
        if reb:
            return reb
    return ""


def load_jmdict_vocab(
    joyo: set[str],
    path: Path = RAW / "JMdict_e.gz",
    cache: Path = RAW / "jmdict_vocab_cache.json",
) -> list[VocabWord]:
    """Every common JMdict word spelt only with jōyō kanji and kana."""
    if cache.exists():
        with open(cache, encoding="utf-8") as fh:
            data = json.load(fh)
        if set(data["joyo"]) == joyo and data.get("version") == 3:
            return [VocabWord(**w) for w in data["words"]]

    out: list[VocabWord] = []
    seen: set[str] = set()
    with gzip.open(path, "rb") as fh:
        for _event, elem in ET.iterparse(fh, events=("end",)):
            if elem.tag != "entry":
                continue
            try:
                k_eles = elem.findall("k_ele")
                if not k_eles:
                    continue
                senses = elem.findall("sense")
                if not senses:
                    continue
                first = senses[0]
                pos = {p.text for p in first.findall("pos")}
                misc = {m.text for m in first.findall("misc")}
                if not pos or _any(misc, BAD_MISC) or _any(pos, BAD_POS):
                    continue
                glosses: list[str] = []
                for i, sense in enumerate(senses[:3]):
                    if i and _any({m.text for m in sense.findall("misc")}, BAD_MISC):
                        continue
                    if i and ({p.text for p in sense.findall("pos")} - pos):
                        continue   # a later sense with a different word class
                    for g in sense.findall("gloss"):
                        if g.get("{http://www.w3.org/XML/1998/namespace}lang", "eng") != "eng":
                            continue
                        c = clean_gloss(g.text or "")
                        if c and c.lower() not in {x.lower() for x in glosses}:
                            glosses.append(c)
                    if i == 0 and not glosses:
                        break
                if not glosses:
                    continue
                kind = kind_of(pos)
                if kind == "noun":
                    glosses = [g for g in glosses if not g.startswith("to ")] + [g for g in glosses if g.startswith("to ")]
                for k_ele in k_eles:
                    keb = k_ele.findtext("keb") or ""
                    if not keb or keb in seen:
                        continue
                    tags = [t.text for t in k_ele.findall("ke_pri") if t.text]
                    if not tags:
                        continue
                    if _any({x.text for x in k_ele.findall("ke_inf")}, BAD_KE_INF):
                        continue
                    if len(keb) > MAX_LEN:
                        continue
                    if not all(c in joyo or parse._is_kana(c) for c in keb):
                        continue
                    kanji = []
                    for c in keb:
                        if c in joyo and c not in kanji:
                            kanji.append(c)
                    if not kanji:
                        continue
                    reading = _reading_for(elem, keb)
                    if not reading:
                        continue
                    seen.add(keb)
                    out.append(VocabWord(word=keb, reading=reading, glosses=glosses[:8], kind=kind,
                                         score=priority_score(tags), kanji=kanji, tags=tags))
            finally:
                elem.clear()

    with open(cache, "w", encoding="utf-8") as fh:
        json.dump({"version": 3, "joyo": sorted(joyo), "words": [w.__dict__ for w in out]}, fh, ensure_ascii=False)
    return out


MIN_SCORE = 3.0        # below this a word is not worth a card, even for coverage
EXTRA_PER_LEVEL = 10   # words per level beyond one per kanji: still a rough 1:1 split


def word_score(w: VocabWord) -> float:
    """Higher = better flashcard: everyday, and a compound or an inflecting
    word rather than a bare kanji."""
    s = w.score
    kset = set(w.kanji)
    n_kanji = sum(1 for c in w.word if c in kset)
    news_only = w.tags and all(t.startswith("news") or t.startswith("nf") for t in w.tags)
    if news_only:
        s -= 1.0                    # newspaper-only words: place names, jargon
        if len(w.glosses) == 1:
            s -= 1.0
    if len(w.word) == 1:
        s -= 0.8                    # 山 on its own repeats the kanji card
    elif n_kanji == 2 and len(w.word) == 2:
        s += 0.6                    # two-kanji compounds read the kanji best
    elif n_kanji == 1 and w.kind in ("verb", "adjective"):
        s += 0.8                    # 見る, 大きい: the everyday inflecting words
    if len(w.word) >= 4:
        s -= 0.4
    return s


def select_by_level(
    words: list[VocabWord],
    kanji_level: dict[str, int],
    level_kanji: dict[int, list[str]],
    per_level: int | None = None,
) -> dict[int, list[VocabWord]]:
    """Pick the words for every level.

    A word belongs to the level of its last-taught kanji. Within a level the
    quota defaults to the number of kanji taught there; every kanji gets its
    best word first (coverage), then the most common words fill the rest.
    """
    by_level: dict[int, list[VocabWord]] = defaultdict(list)
    for w in words:
        if any(k not in kanji_level for k in w.kanji):
            continue
        by_level[max(kanji_level[k] for k in w.kanji)].append(w)

    chosen: dict[int, list[VocabWord]] = {}
    for lvl, ks in level_kanji.items():
        pool = [w for w in sorted(by_level.get(lvl, []), key=word_score, reverse=True) if word_score(w) >= MIN_SCORE]
        quota = per_level if per_level is not None else len(ks) + EXTRA_PER_LEVEL
        picked: list[VocabWord] = []
        used_words: set[str] = set()
        used_names: set[str] = set()

        def take(w: VocabWord) -> None:
            picked.append(w)
            used_words.add(w.word)
            used_names.add(w.name.lower())

        # Coverage pass: the best word for each kanji taught at this level.
        for k in ks:
            if len(picked) >= quota:
                break
            for w in pool:
                if w.word in used_words or w.name.lower() in used_names:
                    continue
                if k in w.kanji:
                    take(w)
                    break
        for w in pool:
            if len(picked) >= quota:
                break
            if w.word in used_words or w.name.lower() in used_names:
                continue
            take(w)
        chosen[lvl] = picked
    return chosen


def to_items(chosen: dict[int, list[VocabWord]], kanji_level: dict[str, int]) -> dict[str, dict]:
    """Build the item records; `pos` is filled by the caller once ordered."""
    ranked = sorted((w for ws in chosen.values() for w in ws), key=lambda w: -w.score)
    rank = {w.word: i + 1 for i, w in enumerate(ranked)}
    items: dict[str, dict] = {}
    for lvl, ws in chosen.items():
        for w in ws:
            alts = [g for g in w.glosses[1:]]
            items[f"v:{w.word}"] = {
                "id": f"v:{w.word}", "type": "vocab", "char": w.word,
                "name": w.name, "alt": alts,
                "level": lvl, "pos": 0, "kind": w.kind, "freq": rank[w.word],
                "parts": [f"k:{k}" for k in w.kanji], "used_in": [],
                "speak": w.reading,
            }
    return items
