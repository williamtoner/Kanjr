"""Generate spoken-kanji clips: one small MP3 per kanji, from its hidden
spoken form, with Open JTalk (open-source Japanese TTS).

    python3 pipeline/voices.py            # writes app/voices/<ucs>.mp3

The clips are played by the app's own audio engine, mixed over the music at
full volume, instead of the phone's speech synthesiser (which on iPhones
ducks other audio and clips the first syllable). Requires pyopenjtalk and
lameenc in the interpreter used to run this script.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pyopenjtalk
import lameenc

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "voices"
RATE = 24000


def synth(text: str) -> tuple[np.ndarray, int]:
    wav, sr = pyopenjtalk.tts(text, speed=1.0)
    return wav.astype(np.float32), sr


def resample(x: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return x
    n = int(round(len(x) * target / sr))
    idx = np.linspace(0, len(x) - 1, n)
    return np.interp(idx, np.arange(len(x)), x).astype(np.float32)


def trim_and_normalise(x: np.ndarray, sr: int, thresh: float = 0.01, pad_ms: int = 40) -> np.ndarray:
    peak = float(np.max(np.abs(x))) or 1.0
    x = x / peak
    above = np.where(np.abs(x) > thresh)[0]
    if len(above) == 0:
        return x
    pad = int(sr * pad_ms / 1000)
    a, b = max(0, above[0] - pad), min(len(x), above[-1] + pad * 3)
    x = x[a:b]
    # Short fade in/out so clips never click.
    f = min(len(x) // 4, int(sr * 0.008))
    if f > 0:
        x[:f] *= np.linspace(0, 1, f, dtype=np.float32)
        x[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
    return x * 0.9


def to_mp3(x: np.ndarray, sr: int, kbps: int = 32) -> bytes:
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(sr)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()
    return bytes(enc.encode(pcm)) + bytes(enc.flush())


def main(argv: list[str]) -> int:
    data = json.loads((ROOT / "data" / "kanji.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    only = set(argv[1:])
    done = skipped = 0
    for it in data["items"].values():
        if it["type"] != "kanji" or not it.get("speak"):
            continue
        if only and it["char"] not in only:
            continue
        dest = OUT / f"{ord(it['char']):x}.mp3"
        if dest.exists() and not only:
            skipped += 1
            continue
        x, sr = synth(it["speak"])
        x = trim_and_normalise(x, sr)
        x = resample(x, sr, RATE)
        dest.write_bytes(to_mp3(x, RATE))
        done += 1
        if done % 100 == 0:
            print(f"  {done} clips ...", flush=True)
    total = sum(1 for _ in OUT.glob("*.mp3"))
    size = sum(f.stat().st_size for f in OUT.glob("*.mp3"))
    print(f"wrote {done} clips, skipped {skipped} existing; {total} clips, {size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
