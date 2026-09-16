"""Pipeline unit tests. Run: python3 -m unittest discover -s tests -p 'test_*.py'"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import build, decompose, keywords, order, parse, vocab  # noqa: E402


class SourcesMixin:
    @classmethod
    def setUpClass(cls):
        cls.kd = parse.load_kanjidic()
        cls.joyo = {k for k, r in cls.kd.items() if r.joyo}
        cls.krad = parse.load_kradfile()
        ranks = parse.frequency_ranks(parse.load_frequency())
        by_freq = sorted(cls.joyo, key=lambda k: ranks.get(k, 10**6))
        cls.rank = {k: i + 1 for i, k in enumerate(by_freq)}
        cls.by_freq = by_freq
        cls.decs = decompose.all_decompositions(cls.krad, cls.joyo, cls.rank, decompose.load_overrides())


class TestParse(SourcesMixin, unittest.TestCase):
    def test_joyo_count(self):
        self.assertEqual(len(self.joyo), 2136)

    def test_top_kanji_have_frequency(self):
        self.assertLess(self.rank["日"], 5)
        self.assertLess(self.rank["人"], 5)

    def test_kradfile_covers_joyo_via_variants(self):
        for k in self.joyo:
            self.assertTrue(decompose.flat_elements(self.krad, k), k)


class TestDecompose(SourcesMixin, unittest.TestCase):
    def parts(self, k):
        return [decompose.part_label(p) for p in self.decs[k].parts]

    def test_hierarchical_examples(self):
        self.assertEqual(set(self.parts("話")), {"言", "舌"})
        self.assertEqual(set(self.parts("時")), {"日", "寺"})
        self.assertEqual(set(self.parts("週")), {"辶", "周"})
        self.assertEqual(set(self.parts("海")), {"氵", "毎"})
        self.assertEqual(set(self.parts("花")), {"艹", "化"})

    def test_atoms_have_no_parts(self):
        for k in "一口日月見言貝糸":
            self.assertEqual(self.decs[k].parts, [], k)

    def test_standins_are_radicals_unless_whole_kanji_present(self):
        # 汁 stands for 氵 in KRADFILE: 海 must use the radical, never the kanji "juice".
        self.assertIn("r:汁", self.decs["海"].parts)
        self.assertNotIn("k:汁", self.decs["海"].parts)
        self.assertIn("r:化", self.decs["休"].parts)
        # But when the whole kanji 化 (亻+匕) is present, it is used as a kanji part.
        self.assertIn("k:化", self.decs["花"].parts)

    def test_no_cycles(self):
        graph = {k: [p[2:] for p in d.parts if p.startswith("k:")] for k, d in self.decs.items()}
        state: dict[str, int] = {}

        def visit(n):
            state[n] = 1
            for m in graph.get(n, []):
                if state.get(m) == 1:
                    self.fail(f"cycle through {n} -> {m}")
                if m not in state:
                    visit(m)
            state[n] = 2

        for k in graph:
            if k not in state:
                visit(k)

    def test_every_radical_is_named(self):
        named = set(build.load_radicals())
        for sym in decompose.radical_symbols(self.decs):
            self.assertIn(sym, named)


class TestKeywords(SourcesMixin, unittest.TestCase):
    def test_primary_keywords_unique(self):
        rad_names = {r["name"].lower() for r in build.load_radicals().values()}
        kw = keywords.assign_keywords({k: self.kd[k].meanings for k in self.joyo}, self.by_freq,
                                      keywords.load_overrides(), rad_names)
        prims = [v.primary.lower() for v in kw.values()]
        self.assertEqual(len(prims), len(set(prims)))
        self.assertFalse(set(prims) & rad_names)
        self.assertEqual(kw["日"].primary, "day")
        self.assertIn("sun", kw["日"].alt)

    def test_collision_falls_back_to_next_gloss(self):
        kw = keywords.assign_keywords({"a": ["time", "x"], "b": ["time", "epoch"]}, ["a", "b"])
        self.assertEqual(kw["a"].primary, "time")
        self.assertEqual(kw["b"].primary, "epoch")

    def test_reserved_names_are_avoided(self):
        kw = keywords.assign_keywords({"a": ["fence", "wall"]}, ["a"], reserved={"fence"})
        self.assertEqual(kw["a"].primary, "wall")


class TestOrder(unittest.TestCase):
    def test_inherit_pulls_parts_forward(self):
        scores = {"k:a": 10.0, "k:b": 500.0, "r:x": 10**6}
        parts = {"k:a": ["k:b", "r:x"], "k:b": ["r:x"]}
        eff = order.inherit(scores, parts)
        self.assertLess(eff["k:b"], eff["k:a"])
        self.assertLess(eff["r:x"], eff["k:b"])

    def test_levels_respect_dependencies_and_size(self):
        n = 100
        effective = {f"k:{i}": float(i) for i in range(n)}
        parts = {f"k:{i}": [f"k:{i + 1}"] for i in range(0, n - 1, 2)}   # even depends on next odd
        effective = order.inherit(effective, parts)
        levels = order.assign_levels(effective, parts, level_size=30)
        for item, deps in parts.items():
            for d in deps:
                self.assertLessEqual(levels[d], levels[item])
        from collections import Counter
        self.assertTrue(all(c <= 30 for c in Counter(levels.values()).values()))

    def test_own_score_prefers_simple_common_kanji(self):
        simple_common = order.own_score(10, 1, 4, 3)
        complex_common = order.own_score(10, 4, 2, 18)
        simple_rare = order.own_score(1500, 1, 4, 3)
        self.assertLess(simple_common, complex_common)
        self.assertLess(complex_common, simple_rare)


class TestBuiltData(unittest.TestCase):
    path = ROOT / "data" / "kanji.json"

    def setUp(self):
        if not self.path.exists():
            self.skipTest("data/kanji.json not built")
        with open(self.path, encoding="utf-8") as fh:
            self.data = json.load(fh)

    def test_sanity_checks_pass(self):
        kanji = {i["char"]: i["freq"] for i in self.data["items"].values() if i["type"] == "kanji"}
        self.assertEqual(build.sanity_checks(self.data, kanji), [])

    def test_schema(self):
        it = self.data["items"]["k:日"]
        for key in ("id", "type", "char", "name", "alt", "level", "pos", "strokes", "grade",
                    "freq", "parts", "used_in", "mnemonic", "examples"):
            self.assertIn(key, it)
        rad = next(i for i in self.data["items"].values() if i["type"] == "radical")
        for key in ("id", "char", "name", "level", "pos", "note", "used_in", "mnemonic"):
            self.assertIn(key, rad)

    def test_every_kanji_has_a_spoken_form(self):
        for i in self.data["items"].values():
            if i["type"] == "kanji":
                self.assertTrue(i.get("speak"), i["char"])
                self.assertNotIn(".", i["speak"])
        self.assertEqual(self.data["items"]["k:山"]["speak"], "やま")
        self.assertEqual(self.data["items"]["k:見"]["speak"], "みる")
        self.assertEqual(self.data["items"]["k:駅"]["speak"], "エキ")

    def test_vocabulary_is_made_of_taught_kanji(self):
        items = self.data["items"]
        words = [i for i in items.values() if i["type"] == "vocab"]
        self.assertGreater(len(words), 2000)
        for w in words:
            self.assertTrue(w["parts"], w["id"])
            for pid in w["parts"]:
                self.assertEqual(items[pid]["type"], "kanji")
                self.assertLessEqual(items[pid]["level"], w["level"], w["id"])
            self.assertTrue(w["name"] and w["speak"], w["id"])
            self.assertIn(w["kind"], ("noun", "verb", "adjective", "adverb", "expression", "word"))
        # The user's own example: knowing 弁 and 当 unlocks 弁当.
        bento = items["v:弁当"]
        self.assertEqual(bento["parts"], ["k:弁", "k:当"])
        self.assertEqual(bento["level"], max(items["k:弁"]["level"], items["k:当"]["level"]))
        self.assertEqual(bento["speak"], "べんとう")
        # Every level lists its words once, and kanji point back at their words.
        listed = [v for lvl in self.data["levels"] for v in lvl.get("vocab", [])]
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(set(listed), {w["id"] for w in words})
        self.assertIn("v:弁当", items["k:弁"]["words"])
        # Roughly one word per kanji on the early levels.
        for lvl in self.data["levels"][:10]:
            n_kanji = sum(1 for i in lvl["items"] if items[i]["type"] == "kanji")
            self.assertGreaterEqual(len(lvl["vocab"]), n_kanji * 0.8, lvl["level"])

    def test_early_levels_have_mnemonics(self):
        for lvl in self.data["levels"][:3]:
            for i in lvl["items"]:
                self.assertTrue(self.data["items"][i]["mnemonic"], f"{i} has no mnemonic")


class VocabHelpersTest(unittest.TestCase):
    def test_clean_gloss(self):
        self.assertEqual(vocab.clean_gloss("meal (e.g. lunch)"), "meal")
        self.assertEqual(vocab.clean_gloss("(what) the heck"), "")
        self.assertEqual(vocab.clean_gloss("to eat"), "to eat")
        self.assertEqual(vocab.clean_gloss("a" * 40), "")

    def test_kind_of(self):
        self.assertEqual(vocab.kind_of({"noun (common) (futsuumeishi)", "adverb (fukushi)"}), "noun")
        self.assertEqual(vocab.kind_of({"Ichidan verb", "transitive verb"}), "verb")
        self.assertEqual(vocab.kind_of({"adjective (keiyoushi)"}), "adjective")
        self.assertEqual(vocab.kind_of({"adverb (fukushi)"}), "adverb")

    def test_select_by_level_covers_each_kanji_first(self):
        W = vocab.VocabWord
        words = [
            W("学校", "がっこう", ["school"], "noun", 9.0, ["学", "校"], ["ichi1", "news1", "nf01"]),
            W("学生", "がくせい", ["student"], "noun", 8.0, ["学", "生"], ["ichi1", "news1", "nf02"]),
            W("校", "こう", ["school"], "noun", 8.5, ["校"], ["news1"]),
            W("生", "せい", ["life"], "noun", 1.0, ["生"], ["news2"]),
            W("先生", "せんせい", ["teacher"], "noun", 9.5, ["先", "生"], ["ichi1", "news1", "nf01"]),
        ]
        levels = {"学": 1, "校": 1, "生": 1, "先": 2}
        chosen = vocab.select_by_level(words, levels, {1: ["学", "校", "生"], 2: ["先"]}, per_level=2)
        # Level 1: 学校 covers 学 and 校; 生's only own word scores too low, so 学生 fills the quota.
        self.assertEqual([w.word for w in chosen[1]], ["学校", "学生"])
        # 先生 waits for level 2, where 先 is taught.
        self.assertEqual([w.word for w in chosen[2]], ["先生"])
        # A word never repeats a meaning already used on its level (校 "school").
        self.assertNotIn("校", [w.word for w in chosen[1]])


if __name__ == "__main__":
    unittest.main()
