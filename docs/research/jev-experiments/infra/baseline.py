"""Simple, reproducible non-oracle baseline for the synthetic screening pilot.

It chooses the candidate with the largest literal evidence score.  It cannot
recognise contradictions, adversarial wording, or insufficient evidence; those
intentional misses keep it from encoding the frozen answer labels.
"""
from __future__ import annotations

from typing import Any


def choose(case: dict[str, Any]) -> str:
    candidates = case["state"]["candidates"]
    return max(candidates, key=lambda candidate: (candidate["literal_evidence"], candidate["label"]))["label"]
