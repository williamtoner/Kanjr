"""Build data/kanji.json and data/order.csv from the raw sources.

    python3 -m pipeline.build [--check]

Steps: parse sources -> decompose -> keywords -> scores -> levels ->
examples -> mnemonics -> sanity checks -> write.
"""
from __future__ import annotations

import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from . import decompose, keywords, order, parse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OVERRIDES = DATA / "overrides"
CONTENT = DATA / "content"


def load_radicals() -> dict[str, dict]:
    with open(OVERRIDES / "radicals.csv", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    return {r["symbol"]: r for r in rows}


def load_synonym_groups() -> list[list[str]]:
    """data/overrides/synonyms.csv: one group per line, members separated by ';'.

    Every kanji whose keyword or alternate is in a group accepts the whole
    group. 'soil' and 'dirt' are the same answer for 土.
    """
    path = OVERRIDES / "synonyms.csv"
    if not path.exists():
        return []
    groups = []
    with open(path, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            line = line.strip()
            if not line or line.startswith("#") or (i == 0 and line == "group"):
                continue
            groups.append([m.strip() for m in line.split(";") if m.strip()])
    return groups


def expand_synonyms(primary: str, alts: list[str], groups: list[list[str]]) -> list[str]:
    have = {primary.lower(), *[a.lower() for a in alts]}
    out = list(alts)
    for g in groups:
        if any(m.lower() in have for m in g):
            for m in g:
                if m.lower() not in have:
                    out.append(m)
                    have.add(m.lower())
    return out


def load_pins() -> dict[str, int]:
    path = OVERRIDES / "level_pins.csv"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as fh:
        return {r["id"]: int(r["level"]) for r in csv.DictReader(fh) if r.get("id") and not r["id"].startswith("#")}


def load_mnemonics() -> dict[str, dict]:
    """Merge data/content/mnemonics/*.json -> id -> {mnemonic, hint}."""
    out: dict[str, dict] = {}
    for path in sorted((CONTENT / "mnemonics").glob("*.json")):
        with open(path, encoding="utf-8") as fh:
            for item_id, val in json.load(fh).items():
                if isinstance(val, str):
                    val = {"mnemonic": val}
                out[item_id] = val
    return out


def pick_examples(words: list[parse.ExampleWord], kanji: str, n: int = 3) -> list[dict]:
    out, seen_gloss = [], set()
    for w in words:
        g = w.gloss.split(";")[0].strip().lower()
        if g in seen_gloss:
            continue
        seen_gloss.add(g)
        out.append({"word": w.word, "gloss": w.gloss})
        if len(out) >= n:
            break
    return out


def build(check_only: bool = False) -> dict:
    print("parsing sources ...")
    kd = parse.load_kanjidic()
    joyo = {k for k, r in kd.items() if r.joyo}
    krad = parse.load_kradfile()
    freq_scores = parse.load_frequency()
    corpus_rank = parse.frequency_ranks(freq_scores)
    by_freq = sorted(joyo, key=lambda k: corpus_rank.get(k, 10**6))
    rank = {k: i + 1 for i, k in enumerate(by_freq)}

    print("decomposing ...")
    part_overrides = decompose.load_overrides()
    decs = decompose.all_decompositions(krad, joyo, rank, part_overrides)
    radicals = load_radicals()
    rad_usage = decompose.radical_symbols(decs)
    missing_rads = [s for s in rad_usage if s not in radicals]
    if missing_rads:
        raise SystemExit(f"radicals.csv is missing names for: {missing_rads}")

    print("assigning keywords ...")
    rad_names = {r["name"].lower() for r in radicals.values()}
    kw = keywords.assign_keywords({k: kd[k].meanings for k in joyo}, by_freq, keywords.load_overrides(), rad_names)
    kanji_names = {kw[k].primary.lower() for k in joyo}
    clash = rad_names & kanji_names
    if clash:
        raise SystemExit(f"radical names clash with kanji keywords: {sorted(clash)}")

    print("scoring and levelling ...")
    parts: dict[str, list[str]] = {f"k:{k}": decs[k].parts for k in joyo}
    scores: dict[str, float] = {}
    n = len(joyo)
    for k in joyo:
        r = kd[k]
        scores[f"k:{k}"] = order.own_score(rank[k], r.grade, r.jlpt, r.strokes)
    for sym in rad_usage:
        scores[f"r:{sym}"] = order.RADICAL_BASE
    effective = order.inherit(scores, parts)
    levels = order.assign_levels(effective, parts, load_pins())

    print("example words ...")
    examples = parse.load_jmdict_examples(joyo)

    mnemonics = load_mnemonics()
    groups = load_synonym_groups()

    # ---- assemble items ---------------------------------------------------
    used_in: dict[str, list[str]] = defaultdict(list)
    for k in joyo:
        for p in decs[k].parts:
            used_in[p].append(f"k:{k}")

    items: dict[str, dict] = {}
    for k in joyo:
        r = kd[k]
        item_id = f"k:{k}"
        m = mnemonics.get(item_id, {})
        ex_src = examples.get(k) or examples.get(decompose.GLYPH_VARIANTS.get(k, k), [])
        items[item_id] = {
            "id": item_id, "type": "kanji", "char": k,
            "name": kw[k].primary, "alt": expand_synonyms(kw[k].primary, kw[k].alt, groups),
            "level": levels[item_id], "pos": 0,
            "strokes": r.strokes, "grade": r.grade, "jlpt": r.jlpt,
            "freq": rank[k], "freq_news": r.freq_news,
            "parts": decs[k].parts, "used_in": [], "mnemonic": m.get("mnemonic", ""),
            "hint": m.get("hint", ""), "examples": pick_examples(ex_src, k),
        }
    for sym, row in radicals.items():
        if sym not in rad_usage:
            continue
        item_id = f"r:{sym}"
        m = mnemonics.get(item_id, {})
        items[item_id] = {
            "id": item_id, "type": "radical", "char": row["glyph"], "symbol": sym,
            "name": row["name"], "alt": [a for a in row["alt"].split(";") if a],
            "level": levels[item_id], "pos": 0,
            "strokes": int(row["strokes"]) if row["strokes"] else None,
            "note": row["note"], "used_in": [],
            "mnemonic": m.get("mnemonic") or row["mnemonic"], "hint": m.get("hint", ""),
        }
    for item_id, it in items.items():
        it["used_in"] = sorted(used_in.get(item_id, []), key=lambda u: (items[u]["level"], effective[u]))

    # Order within a level: by effective score, radicals and parts first.
    level_items: dict[int, list[str]] = defaultdict(list)
    for item_id in sorted(items, key=lambda i: (items[i]["level"], effective[i], i)):
        level_items[items[item_id]["level"]].append(item_id)
    for lvl, ids in level_items.items():
        # stable topological pass so a part never follows its user in a level
        ordered: list[str] = []
        for i in ids:
            for p in items[i].get("parts", []):
                if items[p]["level"] == lvl and p not in ordered:
                    ordered.append(p)
            if i not in ordered:
                ordered.append(i)
        for pos, i in enumerate(ordered):
            items[i]["pos"] = pos
        level_items[lvl] = ordered

    data = {
        "meta": {
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "version": 1,
            "counts": {"kanji": len(joyo), "radicals": len(rad_usage), "levels": max(level_items)},
            "sources": ["KANJIDIC2", "KRADFILE", "JMdict", "scriptin/kanji-frequency"],
        },
        "items": items,
        "levels": [{"level": lvl, "items": level_items[lvl]} for lvl in sorted(level_items)],
    }

    # ---- sanity checks -----------------------------------------------------
    problems = sanity_checks(data, rank)
    coll = keywords.collision_report(kw)
    print(f"{len(problems)} sanity problems; {len(coll)} primary/alternate overlaps")
    for p in problems:
        print("  PROBLEM:", p)
    if problems:
        raise SystemExit("sanity checks failed")

    if not check_only:
        with open(DATA / "kanji.json", "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
        with open(DATA / "order.csv", "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["level", "pos", "id", "type", "char", "name", "freq", "grade", "strokes", "parts", "source"])
            for lvl in data["levels"]:
                for i in lvl["items"]:
                    it = items[i]
                    w.writerow([lvl["level"], it["pos"], i, it["type"], it["char"], it["name"],
                                it.get("freq", ""), it.get("grade", ""), it["strokes"] or "",
                                " ".join(decompose.part_label(p) for p in it.get("parts", [])),
                                kw[it["char"]].source if it["type"] == "kanji" else "radical"])
        with open(DATA / "keyword_overlaps.txt", "w", encoding="utf-8") as fh:
            for k, a, other in sorted(coll, key=lambda c: rank[c[0]]):
                fh.write(f"{k} ({kw[k].primary}) has alternate '{a}' = primary of {other}\n")
        print(f"wrote {DATA/'kanji.json'} ({(DATA/'kanji.json').stat().st_size/1e6:.1f} MB), order.csv, keyword_overlaps.txt")
    return data


def sanity_checks(data: dict, rank: dict[str, int]) -> list[str]:
    items, problems = data["items"], []
    kanji = [i for i in items.values() if i["type"] == "kanji"]
    if len(kanji) != 2136:
        problems.append(f"expected 2136 kanji, got {len(kanji)}")
    names = Counter(i["name"].lower() for i in items.values())
    for nm, c in names.items():
        if c > 1:
            problems.append(f"duplicate name {nm!r} x{c}")
    for i in items.values():
        for p in i.get("parts", []):
            if p not in items:
                problems.append(f"{i['id']} has unknown part {p}")
            elif (items[p]["level"], items[p]["pos"]) >= (i["level"], i["pos"]):
                problems.append(f"{i['id']} (L{i['level']}) comes before its part {p} (L{items[p]['level']})")
    for lvl in data["levels"]:
        if len(lvl["items"]) > order.LEVEL_SIZE + 5:
            problems.append(f"level {lvl['level']} has {len(lvl['items'])} items")
    top100 = [k for k, r in rank.items() if r <= 100]
    late = [k for k in top100 if items[f"k:{k}"]["level"] > 10]
    if late:
        problems.append(f"top-100 kanji later than level 10: {late}")
    seen = Counter(i for lvl in data["levels"] for i in lvl["items"])
    if any(c != 1 for c in seen.values()) or len(seen) != len(items):
        problems.append("levels do not list every item exactly once")
    return problems


if __name__ == "__main__":
    build(check_only="--check" in sys.argv)
