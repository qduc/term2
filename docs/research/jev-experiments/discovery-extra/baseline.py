#!/usr/bin/env python3
"""Lexical Choice baseline for jev-fit-20260919 discovery-extra (D2-D6).

Uses query-like state fields versus option labels, criteria text, and
candidate bodies. Does not read expected. Stored dataset baseline fields
must match this script.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

TOKEN_RE = re.compile(r"[a-z0-9_]+")
ABSTAIN = ("none", "unknown", "none_additional")
STOP = {
    "a",
    "an",
    "the",
    "and",
    "or",
    "to",
    "of",
    "in",
    "on",
    "for",
    "with",
    "is",
    "this",
    "that",
    "be",
    "as",
    "at",
    "by",
    "from",
    "it",
    "its",
    "if",
    "not",
    "are",
    "was",
    "can",
    "user",
    "request",
    "state",
    "choose",
    "select",
}

QUERY_KEYS = (
    "user_request",
    "query",
    "goal",
    "incoming_message",
    "error",
    "item_body",
    "diff_summary",
)

CANDIDATE_LIST_KEYS = (
    "tools",
    "memories",
    "sessions",
    "passages",
    "sections",
    "skills",
    "candidates",
    "excerpts",
)


def tokenize(text: str) -> set[str]:
    return {t for t in TOKEN_RE.findall(text.lower()) if t not in STOP and len(t) > 1}


def flatten(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return "\n".join(flatten(item) for item in value)
    if isinstance(value, dict):
        return "\n".join(f"{k} {flatten(v)}" for k, v in value.items())
    return str(value)


def overlap(query_tokens: set[str], text: str) -> float:
    other = tokenize(text)
    if not query_tokens or not other:
        return 0.0
    inter = query_tokens & other
    if not inter:
        return 0.0
    return len(inter) / len(query_tokens | other)


def query_text(state: dict[str, Any]) -> str:
    chunks = [flatten(state[key]) for key in QUERY_KEYS if key in state]
    if chunks:
        return "\n".join(chunks)
    skip = {"noise", "injected"} | set(CANDIDATE_LIST_KEYS)
    return flatten({k: v for k, v in state.items() if k not in skip})


def candidate_texts(state: dict[str, Any]) -> dict[str, str]:
    found: dict[str, str] = {}
    for key in CANDIDATE_LIST_KEYS:
        items = state.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            label = item.get("id") or item.get("name") or item.get("label")
            if isinstance(label, str) and label:
                found[label] = flatten(item)
    return found


def abstain_label(criteria: dict[str, str]) -> str | None:
    for label in ABSTAIN:
        if label in criteria:
            return label
    return None


def predict(case: dict[str, Any]) -> str:
    criteria: dict[str, str] = case["criteria"]
    state = case.get("state") if isinstance(case.get("state"), dict) else {}
    q_tokens = tokenize(query_text(state))
    bodies = candidate_texts(state)
    scores: dict[str, float] = {}
    for label, description in criteria.items():
        parts = [label.replace("_", " "), description]
        if label in bodies:
            parts.append(bodies[label])
        scores[label] = overlap(q_tokens, "\n".join(parts))
    ranked = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    abstain = abstain_label(criteria)
    non_abstain = [(label, score) for label, score in ranked if label not in ABSTAIN]
    if abstain is not None:
        if not non_abstain or non_abstain[0][1] <= 0.0:
            return abstain
        return non_abstain[0][0]
    best_label, best_score = ranked[0]
    return best_label if best_score > 0 else ranked[-1][0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, default=Path(__file__).with_name("dataset.json"))
    parser.add_argument("--write-baselines", action="store_true")
    args = parser.parse_args()
    cases = json.loads(args.dataset.read_text())
    if not isinstance(cases, list):
        raise SystemExit("dataset.json must be a JSON array")
    predictions = {case["id"]: predict(case) for case in cases}
    mismatches = []
    for case in cases:
        predicted = predictions[case["id"]]
        if predicted not in case["criteria"]:
            raise SystemExit(f"{case['id']}: baseline {predicted!r} not in criteria")
        if case.get("baseline") != predicted:
            mismatches.append((case["id"], case.get("baseline"), predicted))
    if args.write_baselines:
        for case in cases:
            case["baseline"] = predictions[case["id"]]
        args.dataset.write_text(json.dumps(cases, indent=2) + "\n")
        print(f"wrote {len(cases)} baselines to {args.dataset}", file=sys.stderr)
        return 0
    print(json.dumps(predictions, indent=2))
    if mismatches:
        print(f"{len(mismatches)} stored baseline mismatches", file=sys.stderr)
        for row in mismatches[:20]:
            print(f"{row[0]} stored={row[1]!r} predicted={row[2]!r}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
