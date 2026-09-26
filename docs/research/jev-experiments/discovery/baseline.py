"""Simple, reproducible non-oracle baseline for the D1 skill-selection pilot.

Heuristic: score each cataloged candidate by counting content words that the
user request shares with the candidate's label and description; pick the
highest score, breaking ties alphabetically. A zero best score falls back to
insufficient_evidence, then none. It reads only the case state and criteria --
never the expected label or rationale. Paraphrase, distractor, boundary, and
embedded-instruction cases are where lexical overlap is expected to mislead,
which is intentional: this is a floor, not an oracle.
"""
from __future__ import annotations

import re
from typing import Any

STOPWORDS = frozenset(
    """a an and are as at be been but by can could do does for from had has have
    how i if in into is it its me my no not of on or our out over she should so
    than that the their them then there these they this to too up us was we were
    what when where which who why will with would you your just also need needs
    want help make get""".split()
)

_WORD = re.compile(r"[a-z][a-z0-9-]*")


def _content_words(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if len(w) > 2 and w not in STOPWORDS}


def choose(case: dict[str, Any]) -> str:
    request_words = _content_words(str(case["state"].get("request", "")))
    scored: list[tuple[int, str]] = []
    for candidate in case["state"]["candidates"]:
        label = candidate["label"]
        haystack = label + " " + str(candidate.get("description", ""))
        overlap = len(request_words & _content_words(haystack))
        scored.append((-overlap, label))
    best = min(scored)
    if best[0] == 0:  # no lexical anchor at all
        for fallback in ("insufficient_evidence", "none"):
            if fallback in case["criteria"]:
                return fallback
    return best[1]
