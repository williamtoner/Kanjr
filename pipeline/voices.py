"""Generate spoken clips: one small MP3 per kanji and per word, from the
hidden spoken form, with the Kokoro neural voice (Apache-2.0 weights,
Japanese phonemised by misaki + Open JTalk for pitch accent).

    python3 pipeline/voices.py                # everything missing
    python3 pipeline/voices.py --type kanji   # only kanji
    python3 pipeline/voices.py 見 弁当         # just these (re-made)
    python3 pipeline/voices.py --sampler out.mp3   # the five voices, for choosing

Clips go to app/voices/<hex codepoints joined by '-'>.mp3 (words prefixed
"w-", since a one-kanji word can read differently from the kanji) and are played by
the app's own audio engine, mixed over the music at full volume, instead of
the phone's speech synthesiser (which ducks other audio and clips the first
syllable). Needs the `kokoro` and `lameenc` packages in the interpreter.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "voices"
RATE = 24000
VOICE = "jf_alpha"
VOICES = ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo"]


def clip_key(text: str) -> str:
    return "-".join(f"{ord(c):x}" for c in text)


_pipe = None


def synth(text: str, voice: str = VOICE) -> np.ndarray:
    global _pipe
    if _pipe is None:
        import torch
        from kokoro import KPipeline
        torch.set_num_threads(4)
        _pipe = KPipeline(lang_code="j", repo_id="hexgrad/Kokoro-82M")
    parts = [np.asarray(r.audio) for r in _pipe(text, voice=voice, speed=1.0)]
    return np.concatenate(parts).astype(np.float32)


def trim_and_normalise(x: np.ndarray, sr: int = RATE, thresh: float = 0.02, lead_ms: int = 60, tail_ms: int = 120) -> np.ndarray:
    peak = float(np.max(np.abs(x))) or 1.0
    x = x / peak
    above = np.where(np.abs(x) > thresh)[0]
    if len(above) == 0:
        return x
    a = max(0, above[0] - int(sr * lead_ms / 1000))
    b = min(len(x), above[-1] + int(sr * tail_ms / 1000))
    x = x[a:b].copy()
    # Short fades so a clip never clicks.
    f = min(len(x) // 4, int(sr * 0.008))
    if f > 0:
        x[:f] *= np.linspace(0, 1, f, dtype=np.float32)
        x[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
    return x * 0.9


def to_mp3(x: np.ndarray, sr: int = RATE, kbps: int = 40) -> bytes:
    import lameenc
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(sr)
    enc.set_channels(1)
    enc.set_quality(2)
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()
    return bytes(enc.encode(pcm)) + bytes(enc.flush())


def make_clip(text: str, voice: str = VOICE) -> bytes:
    return to_mp3(trim_and_normalise(synth(text, voice)))


def sampler(dest: Path, words: list[str]) -> None:
    """One file: each voice says the words in turn, with a pause between."""
    gap = np.zeros(int(RATE * 0.45), dtype=np.float32)
    chunks = []
    for v in VOICES:
        for w in words:
            chunks += [trim_and_normalise(synth(w, v)), gap]
        chunks.append(np.zeros(int(RATE * 1.0), dtype=np.float32))
    dest.write_bytes(to_mp3(np.concatenate(chunks), kbps=64))


def main(argv: list[str]) -> int:
    if "--sampler" in argv:
        dest = Path(argv[argv.index("--sampler") + 1])
        sampler(dest, ["ひ", "みる", "エキ", "べんとう", "がっこう", "たべる"])
        print("wrote", dest)
        return 0
    only_type = argv[argv.index("--type") + 1] if "--type" in argv else None
    only = {a for a in argv[1:] if not a.startswith("--") and a != only_type}
    data = json.loads((ROOT / "data" / "kanji.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    done = skipped = 0
    for it in data["items"].values():
        if it["type"] not in ("kanji", "vocab") or not it.get("speak"):
            continue
        if only_type and it["type"] != only_type:
            continue
        if only and it["char"] not in only:
            continue
        dest = OUT / f"{'w-' if it['type'] == 'vocab' else ''}{clip_key(it['char'])}.mp3"
        if dest.exists() and not only:
            skipped += 1
            continue
        dest.write_bytes(make_clip(it["speak"]))
        done += 1
        if done % 100 == 0:
            print(f"  {done} clips ...", flush=True)
    total = sum(1 for _ in OUT.glob("*.mp3"))
    size = sum(f.stat().st_size for f in OUT.glob("*.mp3"))
    print(f"wrote {done} clips, skipped {skipped} existing; {total} clips, {size / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
