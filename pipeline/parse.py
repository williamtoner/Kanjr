"""Parsers for the raw data sources.

Each loader returns plain Python data so the rest of the pipeline never
touches XML or CSV directly.
"""
from __future__ import annotations

import csv
import gzip
import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"

# Grades in KANJIDIC2: 1-6 primary school, 8 secondary school (rest of joyo),
# 9-10 jinmeiyo (name kanji). Joyo = 1-6 and 8.
JOYO_GRADES = {1, 2, 3, 4, 5, 6, 8}

# KRADFILE uses JIS X 0208 kanji as stand-ins for elements that are not in
# that character set. Map stand-in -> (display glyph, note). The display glyph
# is the Unicode radical form. Some fonts lack the rarer ones; the app falls
# back to the note text if the glyph does not render.
STANDIN_GLYPHS: dict[str, str] = {
    "化": "亻",   # person on the left (ninben)
    "个": "𠆢",   # person on top (hitoyane)
    "并": "丷",   # horns / two drops on top
    "刈": "刂",   # knife on the right (rittou)
    "込": "辶",   # road / walk (shinnyou)
    "尚": "⺌",   # small on top (shou)
    "忙": "忄",   # heart on the left (risshinben)
    "扎": "扌",   # hand on the left (tehen)
    "汁": "氵",   # water on the left (sanzui)
    "犯": "犭",   # animal on the left (kemonohen)
    "艾": "艹",   # grass on top (kusakanmuri)
    "邦": "阝",   # right-side mound (oozato)
    "阡": "阝",   # left-side mound (kozatohen)
    "老": "耂",   # old on top
    "杰": "灬",   # fire on the bottom (rekka)
    "礼": "礻",   # altar on the left (shimesuhen)
    "疔": "疒",   # sickness enclosure (yamaidare)
    "禹": "禸",   # animal track
    "初": "衤",   # clothes on the left (koromohen)
    "買": "罒",   # net on top (amigashira)
    "滴": "啇",   # base of teki
    "乞": "𠂉",   # hook-and-line top (as in 毎, 海)
}


@dataclass
class KanjiRecord:
    char: str
    ucs: str
    grade: int | None
    strokes: int
    freq_news: int | None        # KANJIDIC2 newspaper rank (1 = most common), top 2501 only
    jlpt: int | None             # old JLPT level 1-4 (4 = easiest)
    meanings: list[str]          # English glosses in KANJIDIC2 order
    heisig: int | None
    radical: int | None          # classical (Kangxi) radical number

    @property
    def joyo(self) -> bool:
        return self.grade in JOYO_GRADES


def load_kanjidic(path: Path = RAW / "kanjidic2.xml.gz") -> dict[str, KanjiRecord]:
    """Parse KANJIDIC2 into a dict keyed by kanji literal."""
    out: dict[str, KanjiRecord] = {}
    with gzip.open(path, "rb") as fh:
        for _event, elem in ET.iterparse(fh, events=("end",)):
            if elem.tag != "character":
                continue
            literal = elem.findtext("literal")
            ucs = ""
            for cp in elem.iter("cp_value"):
                if cp.get("cp_type") == "ucs":
                    ucs = cp.text or ""
            misc = elem.find("misc")
            grade = _int(misc.findtext("grade")) if misc is not None else None
            strokes = _int(misc.findtext("stroke_count")) if misc is not None else 0
            freq = _int(misc.findtext("freq")) if misc is not None else None
            jlpt = _int(misc.findtext("jlpt")) if misc is not None else None
            heisig = None
            for ref in elem.iter("dic_ref"):
                if ref.get("dr_type") == "heisig6":
                    heisig = _int(ref.text)
            radical = None
            for rv in elem.iter("rad_value"):
                if rv.get("rad_type") == "classical":
                    radical = _int(rv.text)
            meanings = [
                (m.text or "").strip()
                for m in elem.iter("meaning")
                if m.get("m_lang") is None and (m.text or "").strip()
            ]
            out[literal] = KanjiRecord(
                char=literal, ucs=ucs, grade=grade, strokes=strokes or 0,
                freq_news=freq, jlpt=jlpt, meanings=meanings, heisig=heisig,
                radical=radical,
            )
            elem.clear()
    return out


def load_kradfile(path: Path = RAW / "kradfile.gz") -> dict[str, list[str]]:
    """Parse KRADFILE into kanji -> list of flat elements (KRADFILE symbols)."""
    out: dict[str, list[str]] = {}
    with gzip.open(path, "rb") as fh:
        text = fh.read().decode("euc-jp")
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        kanji, _, rest = line.partition(" : ")
        elems = rest.split()
        if kanji and elems:
            out[kanji] = elems
    return out


def load_frequency(
    weights: dict[str, float] | None = None,
) -> dict[str, float]:
    """Combine the corpus frequency files into one score per character.

    Returns char -> share of all kanji occurrences (weighted mean across
    corpora). Higher is more frequent.
    """
    weights = weights or {"wikipedia": 0.4, "news": 0.4, "aozora": 0.2}
    combined: dict[str, float] = {}
    for corpus, w in weights.items():
        total = None
        with open(RAW / f"freq_{corpus}.csv", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                if row["char"] == "all":
                    total = int(row["char_count"])
                    continue
                assert total, f"{corpus}: 'all' row must come first"
                share = int(row["char_count"]) / total
                combined[row["char"]] = combined.get(row["char"], 0.0) + w * share
    return combined


def frequency_ranks(scores: dict[str, float]) -> dict[str, int]:
    """Turn frequency shares into dense ranks, 1 = most frequent."""
    ordered = sorted(scores.items(), key=lambda kv: -kv[1])
    return {ch: i + 1 for i, (ch, _) in enumerate(ordered)}


# --------------------------------------------------------------------------
# JMdict example words
# --------------------------------------------------------------------------

_PRI_SCORE = {
    "ichi1": 3.0, "news1": 3.0, "spec1": 2.5, "gai1": 1.0,
    "ichi2": 1.5, "news2": 1.5, "spec2": 1.5, "gai2": 0.5,
}


def _pri_score(tags: list[str]) -> float:
    score = 0.0
    for t in tags:
        if t.startswith("nf"):
            # nf01 (most common) .. nf48
            score += (49 - int(t[2:])) / 16.0
        else:
            score += _PRI_SCORE.get(t, 0.0)
    return score


@dataclass
class ExampleWord:
    word: str
    gloss: str
    score: float
    kanji: list[str] = field(default_factory=list)


def load_jmdict_examples(
    candidate_kanji: set[str],
    path: Path = RAW / "JMdict_e.gz",
    cache: Path = RAW / "jmdict_examples_cache.json",
    per_kanji: int = 12,
) -> dict[str, list[ExampleWord]]:
    """For every kanji in candidate_kanji, collect common words containing it.

    Only words made entirely of candidate kanji and kana are kept, so the
    learner never meets a kanji they cannot yet be shown. Results are cached
    because parsing JMdict takes about a minute.
    """
    if cache.exists():
        with open(cache, encoding="utf-8") as fh:
            data = json.load(fh)
        if set(data["candidates"]) == candidate_kanji:
            return {
                k: [ExampleWord(**w) for w in ws] for k, ws in data["examples"].items()
            }

    per: dict[str, list[ExampleWord]] = {k: [] for k in candidate_kanji}
    with gzip.open(path, "rb") as fh:
        for _event, elem in ET.iterparse(fh, events=("end",)):
            if elem.tag != "entry":
                continue
            k_eles = elem.findall("k_ele")
            if not k_eles:
                elem.clear()
                continue
            sense = elem.find("sense")
            if sense is None:
                elem.clear()
                continue
            pos = {p.text for p in sense.findall("pos")}
            misc = {m.text for m in sense.findall("misc")}
            # Skip usually-kana words, proper nouns, archaic/obscure terms.
            if misc & {"uk", "arch", "obsc", "rare", "obs"} or pos & {"n-pr"}:
                elem.clear()
                continue
            glosses = [g.text for g in sense.findall("gloss") if g.text]
            if not glosses:
                elem.clear()
                continue
            gloss = "; ".join(glosses[:2])
            for k_ele in k_eles:
                keb = k_ele.findtext("keb") or ""
                tags = [t.text for t in k_ele.findall("ke_pri") if t.text]
                if not tags:
                    continue
                kanji_in = [c for c in keb if c in candidate_kanji]
                if not kanji_in:
                    continue
                if not all(c in candidate_kanji or _is_kana(c) for c in keb):
                    continue
                if len(keb) > 4:
                    continue
                score = _pri_score(tags)
                # Prefer short kanji compounds: they show the kanji's meaning best.
                if len(keb) == 2 and len(kanji_in) == 2:
                    score += 1.0
                elif len(keb) == 1:
                    score += 0.3
                ex = ExampleWord(word=keb, gloss=gloss, score=score, kanji=kanji_in)
                for c in set(kanji_in):
                    lst = per[c]
                    lst.append(ex)
            elem.clear()

    for k, lst in per.items():
        lst.sort(key=lambda w: -w.score)
        # Drop duplicate words (same keb from different entries).
        seen: set[str] = set()
        uniq: list[ExampleWord] = []
        for w in lst:
            if w.word not in seen:
                seen.add(w.word)
                uniq.append(w)
        per[k] = uniq[:per_kanji]

    with open(cache, "w", encoding="utf-8") as fh:
        json.dump(
            {"candidates": sorted(candidate_kanji),
             "examples": {k: [w.__dict__ for w in ws] for k, ws in per.items()}},
            fh, ensure_ascii=False,
        )
    return per


def _is_kana(c: str) -> bool:
    o = ord(c)
    return 0x3040 <= o <= 0x30FF or c in "ーゝゞ々"


def _int(s: str | None) -> int | None:
    try:
        return int(s) if s is not None else None
    except ValueError:
        return None


if __name__ == "__main__":
    kd = load_kanjidic()
    joyo = {k for k, r in kd.items() if r.joyo}
    print(f"KANJIDIC2: {len(kd):,} characters, {len(joyo):,} joyo")
    krad = load_kradfile()
    print(f"KRADFILE: {len(krad):,} kanji decomposed")
    missing = [k for k in joyo if k not in krad]
    print(f"joyo kanji missing from KRADFILE: {len(missing)} {missing[:20]}")
    freq = load_frequency()
    ranks = frequency_ranks(freq)
    print(f"frequency: {len(freq):,} characters scored")
    top = sorted(joyo, key=lambda k: ranks.get(k, 10**6))[:30]
    print("top 30 joyo by corpus frequency:", "".join(top))
    no_freq = [k for k in joyo if k not in ranks]
    print(f"joyo without corpus frequency: {len(no_freq)} {no_freq[:20]}")
