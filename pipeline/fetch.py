"""Download the raw data sources into data/raw/.

Idempotent: a file is skipped if it already exists and is non-empty.
Run with --force to re-download everything.
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"

FREQ_BASE = "https://raw.githubusercontent.com/scriptin/kanji-frequency/master/data/"

SOURCES: dict[str, str] = {
    "kanjidic2.xml.gz": "https://www.edrdg.org/kanjidic/kanjidic2.xml.gz",
    "kradfile.gz": "http://ftp.edrdg.org/pub/Nihongo/kradfile.gz",
    "JMdict_e.gz": "http://ftp.edrdg.org/pub/Nihongo/JMdict_e.gz",
    "freq_aozora.csv": FREQ_BASE + "aozora_characters.csv",
    "freq_wikipedia.csv": FREQ_BASE + "wikipedia_characters.csv",
    "freq_news.csv": FREQ_BASE + "news_characters.csv",
}


def fetch(name: str, url: str, force: bool = False) -> Path:
    dest = RAW / name
    if dest.exists() and dest.stat().st_size > 0 and not force:
        print(f"  skip   {name} (exists)")
        return dest
    print(f"  fetch  {name} <- {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "kanjr-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as fh:
        while chunk := resp.read(1 << 16):
            fh.write(chunk)
    print(f"         {dest.stat().st_size:,} bytes")
    return dest


def main(argv: list[str]) -> int:
    force = "--force" in argv
    RAW.mkdir(parents=True, exist_ok=True)
    print(f"Downloading into {RAW}")
    for name, url in SOURCES.items():
        fetch(name, url, force)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
