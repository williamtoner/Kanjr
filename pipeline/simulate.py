"""Simulate a year of daily use to predict review load and progress.

    python3 -m pipeline.simulate [--days 400] [--accuracy 0.9]

Models the app's rules: WaniKani intervals, penalty on mistakes, lessons in
learning order gated on parts reaching the unlock stage, a daily lesson cap
and an apprentice cap. Prints a table per pace setting.
"""
from __future__ import annotations

import json
import math
import random
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "kanji.json"
INTERVAL_H = {1: 4, 2: 8, 3: 24, 4: 48, 5: 168, 6: 336, 7: 720, 8: 2880}
PACES = {"gentle": 4, "standard": 6, "fast": 10}


def simulate(data: dict, daily_lessons: int, days: int, accuracy: float, apprentice_cap: int = 120,
             unlock_stage: int = 3, seed: int = 1) -> dict:
    rng = random.Random(seed)
    items = data["items"]
    order = [i for lvl in data["levels"] for i in lvl["items"]]
    stage = {i: 0 for i in items}
    due = {}
    n_kanji_total = sum(1 for i in items.values() if i["type"] == "kanji")
    log = []
    hour = 0
    day_of_1000 = day_done = None
    for day in range(days):
        # Three review sessions a day: 8:00, 13:00, 20:00.
        reviews_today = 0
        for h in (8, 13, 20):
            now = day * 24 + h
            due_now = [i for i, t in due.items() if t <= now]
            for i in due_now:
                # A stage-dependent accuracy: apprentice items are shakier.
                acc = accuracy - (0.08 if stage[i] <= 2 else 0.0)
                wrong = 0
                while rng.random() > acc:
                    wrong += 1
                    if wrong > 3:
                        break
                s = stage[i]
                if wrong:
                    pen = 2 if s >= 5 else 1
                    s = max(1, s - math.ceil(wrong / 2) * pen)
                else:
                    s += 1
                stage[i] = s
                reviews_today += 1
                if s >= 9:
                    del due[i]
                else:
                    due[i] = now + INTERVAL_H[s]
        # Lessons once a day at 8:00 after reviews.
        apprentice = sum(1 for s in stage.values() if 1 <= s <= 4)
        lessons = 0
        if apprentice < apprentice_cap:
            for i in order:
                if lessons >= daily_lessons:
                    break
                if stage[i] != 0:
                    continue
                if all(stage[p] >= unlock_stage for p in items[i].get("parts", [])):
                    stage[i] = 1
                    due[i] = day * 24 + 8 + INTERVAL_H[1]
                    lessons += 1
        learned_kanji = sum(1 for i, s in stage.items() if s > 0 and items[i]["type"] == "kanji")
        if learned_kanji >= 1000 and day_of_1000 is None:
            day_of_1000 = day + 1
        if learned_kanji >= n_kanji_total and day_done is None:
            day_done = day + 1
        log.append((day + 1, lessons, reviews_today, learned_kanji, apprentice))
    steady = [r for _, _, r, _, _ in log[60:]] or [0]
    return {
        "daily_lessons": daily_lessons,
        "day_1000_kanji": day_of_1000,
        "day_all_kanji": day_done,
        "avg_reviews_after_60d": sum(steady) / len(steady),
        "max_reviews": max(r for _, _, r, _, _ in log),
        "kanji_at_end": log[-1][3],
        "burned_at_end": sum(1 for s in stage.values() if s == 9),
        "log": log,
    }


def main(argv: list[str]) -> int:
    days = int(argv[argv.index("--days") + 1]) if "--days" in argv else 400
    accuracy = float(argv[argv.index("--accuracy") + 1]) if "--accuracy" in argv else 0.9
    with open(DATA, encoding="utf-8") as fh:
        data = json.load(fh)
    print(f"Simulating {days} days at {accuracy:.0%} accuracy, starting 2026-09-09\n")
    print(f"{'pace':<10}{'new/day':>8}{'1000 kanji':>12}{'all joyo':>10}{'avg rev/day':>13}{'max rev/day':>13}{'kanji@end':>11}")
    for name, n in PACES.items():
        r = simulate(data, n, days, accuracy)
        d1 = f"day {r['day_1000_kanji']}" if r["day_1000_kanji"] else "-"
        d2 = f"day {r['day_all_kanji']}" if r["day_all_kanji"] else "-"
        print(f"{name:<10}{n:>8}{d1:>12}{d2:>10}{r['avg_reviews_after_60d']:>13.0f}{r['max_reviews']:>13}{r['kanji_at_end']:>11}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
