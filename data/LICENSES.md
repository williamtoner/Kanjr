# Data sources and licences

Kanjr is built on freely licensed data. Raw files are downloaded into
`data/raw/` by `pipeline/fetch.py` and are not committed.

| Source | Used for | Licence | URL |
|---|---|---|---|
| KANJIDIC2 | kanji list, English meanings, grade, JLPT, stroke count, newspaper frequency, radicals | Creative Commons Attribution-ShareAlike 4.0 (EDRDG) | https://www.edrdg.org/wiki/index.php/KANJIDIC_Project |
| KRADFILE | component decomposition of kanji | EDRDG licence (CC BY-SA 4.0 compatible, attribution required) | https://www.edrdg.org/krad/kradinf.html |
| JMdict (English) | example words with English glosses | Creative Commons Attribution-ShareAlike 4.0 (EDRDG) | https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project |
| scriptin/kanji-frequency | modern corpus frequency (Aozora, Wikipedia, Wikinews) | Creative Commons Attribution 4.0 | https://github.com/scriptin/kanji-frequency |

The generated `data/kanji.json` is a derived work of the above and is
therefore distributed under CC BY-SA 4.0. Attribution: this product uses the
KANJIDIC2, KRADFILE and JMdict dictionary files, which are the property of
the Electronic Dictionary Research and Development Group and are used in
conformance with the Group's licence.
