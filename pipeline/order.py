"""Learning order: priority scores, dependency-aware level assignment.

Every item (kanji or radical) gets a priority score (lower = earlier) from
frequency, school grade, JLPT level and stroke count. A component inherits
the priority of the most important kanji it appears in (minus a hair) so
that it is learned just before it is needed. Items are then dealt into
levels of LEVEL_SIZE in score order, never placing a kanji before its
parts.
"""
from __future__ import annotations

from dataclasses import dataclass

LEVEL_SIZE = 30

# Scores are in "rank units": a kanji's corpus frequency rank plus penalties
# for complexity, so that a simple common kanji comes first, a complex common
# kanji a little later, and a rare kanji last regardless of simplicity.
STROKE_PENALTY = 8            # rank units per stroke
GRADE_PENALTY = {1: 0, 2: 20, 3: 40, 4: 60, 5: 80, 6: 100, 8: 150}
JLPT_PENALTY = {4: 0, 3: 20, 2: 50, 1: 80, None: 100}
RADICAL_BASE = 10**6          # radicals are placed purely by inheritance


@dataclass
class Scored:
    id: str
    score: float           # own score
    effective: float       # after inheriting from dependants
    parts: list[str]


def own_score(freq_rank: int, grade: int | None, jlpt: int | None, strokes: int) -> float:
    return (freq_rank + STROKE_PENALTY * min(strokes, 25)
            + GRADE_PENALTY.get(grade, 150) + JLPT_PENALTY.get(jlpt, 100))


def inherit(scores: dict[str, float], parts: dict[str, list[str]], eps: float = 0.01) -> dict[str, float]:
    """effective(x) = min(score(x), min over kanji k containing x of effective(k) - eps)."""
    used_in: dict[str, list[str]] = {}
    for k, ps in parts.items():
        for p in ps:
            used_in.setdefault(p, []).append(k)
    eff = dict(scores)
    # Iterate to a fixed point; the dependency graph is a DAG so this
    # converges in at most depth+1 passes.
    changed = True
    passes = 0
    while changed and passes < 50:
        changed = False
        passes += 1
        for item, users in used_in.items():
            best = min(eff[u] for u in users if u in eff) - eps
            if best < eff.get(item, float("inf")):
                eff[item] = best
                changed = True
    return eff


def assign_levels(
    effective: dict[str, float],
    parts: dict[str, list[str]],
    pins: dict[str, int] | None = None,
    level_size: int = LEVEL_SIZE,
) -> dict[str, int]:
    """Deal items into levels in effective-score order, parts before users."""
    pins = pins or {}
    placed: dict[str, int] = {}
    pending = sorted(effective, key=lambda i: (effective[i], i))
    level = 1
    count = 0
    while pending:
        progressed = False
        rest = []
        for item in pending:
            deps = parts.get(item, [])
            if all(d in placed for d in deps):
                if count >= level_size:
                    level += 1
                    count = 0
                target = max(level, pins.get(item, level))
                placed[item] = target
                if target == level:
                    count += 1
                progressed = True
            else:
                rest.append(item)
        if not progressed:
            raise RuntimeError(f"dependency cycle among {rest[:10]}")
        pending = rest
    # Pinned items may have been placed beyond the running level; make sure
    # nothing that uses them sits at an earlier level.
    for _ in range(50):
        moved = False
        for item, deps in parts.items():
            if item in placed:
                need = max((placed[d] for d in deps if d in placed), default=1)
                if placed[item] < need:
                    placed[item] = need
                    moved = True
        if not moved:
            break
    return placed
