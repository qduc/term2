#!/usr/bin/env python3
"""Assemble the discovery-extra D2-D6 Choice dataset.

Each case is an authored scenario. Helpers only wrap metadata; they do not
cycle a template over renamed files.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from baseline import predict
from cases_d2 import D2_CASES
from cases_d3 import D3_CASES
from cases_d4 import D4_CASES
from cases_d5 import D5_CASES
from cases_d6 import D6_CASES

ROOT = Path(__file__).resolve().parent
PROVENANCE = "handcrafted-synthetic:discovery-extra:2026-09-19"
CANDIDATE_KEYS = {"D3": "memories", "D4": "sessions", "D5": "passages", "D6": "sections"}


def _offsets(case_id: str) -> tuple[int, int]:
    digest = hashlib.sha256(case_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big"), int.from_bytes(digest[8:16], "big")


def _rotate(items: list, offset: int) -> list:
    if not items:
        return items
    k = offset % len(items)
    return items[k:] + items[:k]


def apply_id_order(task: str, case_id: str, state: dict, criteria: dict) -> tuple[dict, dict]:
    """Rotate candidate lists and criteria from case id only; never from expected."""
    if task not in CANDIDATE_KEYS:
        return state, criteria
    off_cand, off_crit = _offsets(case_id)
    key = CANDIDATE_KEYS[task]
    ordered = dict(state)
    candidates = list(ordered.get(key) or [])
    ordered[key] = _rotate(candidates, off_cand)
    labels = list(criteria)
    rotated_labels = _rotate(labels, off_crit)
    rotated_criteria = {label: criteria[label] for label in rotated_labels}
    return ordered, rotated_criteria


def numbered(task: str, rows: list[dict]) -> list[dict]:
    counters = {"dev": 0, "holdout": 0}
    out: list[dict] = []
    for row in rows:
        split = row["split"]
        counters[split] += 1
        n = counters[split]
        case_id = f"jev-fit-20260919-DX-{task}-{split}-{n:02d}"
        state, criteria = apply_id_order(task, case_id, row["state"], row["criteria"])
        expected = row["expected"]
        if expected not in criteria:
            raise SystemExit(f"{case_id}: expected {expected!r} missing from criteria")
        if "none" not in criteria:
            raise SystemExit(f"{case_id}: criteria must include none")
        tags = list(dict.fromkeys([*row["tags"], "synthetic", "main_pilot"]))
        case = {
            "id": case_id,
            "task": task,
            "split": split,
            "state": state,
            "criteria": criteria,
            "expected": expected,
            "rationale": row["rationale"],
            "provenance": PROVENANCE,
            "tags": tags,
            "baseline": None,
        }
        case["baseline"] = predict(case)
        out.append(case)
    if counters != {"dev": 24, "holdout": 24}:
        raise SystemExit(f"{task} split counts {counters}")
    return out


def main() -> None:
    cases = []
    for task, rows in (
        ("D2", D2_CASES),
        ("D3", D3_CASES),
        ("D4", D4_CASES),
        ("D5", D5_CASES),
        ("D6", D6_CASES),
    ):
        cases.extend(numbered(task, rows))
    fingerprints = []
    for case in cases:
        state = case["state"]
        fingerprints.append(
            json.dumps(
                {
                    "task": case["task"],
                    "user_request": state.get("user_request"),
                    "query": state.get("query"),
                    "goal": state.get("goal"),
                    "tools": [t.get("id") for t in state.get("tools", [])] if "tools" in state else None,
                    "injected": state.get("injected"),
                    "memories": state.get("memories"),
                    "sessions": state.get("sessions"),
                    "passages": state.get("passages"),
                    "sections": state.get("sections"),
                },
                sort_keys=True,
            )
        )
    if len(fingerprints) != len(set(fingerprints)):
        raise SystemExit("duplicate scenario fingerprints")
    ids = [c["id"] for c in cases]
    if len(ids) != len(set(ids)):
        raise SystemExit("duplicate ids")
    path = ROOT / "dataset.json"
    path.write_text(json.dumps(cases, indent=2) + "\n")
    print(f"wrote {len(cases)} cases to {path}")


if __name__ == "__main__":
    main()
