#!/usr/bin/env python3
"""Paired four-cell analysis for the approval replay harness."""
from __future__ import annotations

import argparse
import json
import pathlib
import random
from collections import Counter, defaultdict
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent
CELLS = ("compact_direct", "full_direct", "compact_reviewer", "full_reviewer")
ELIGIBLE = {"explicit", "implied"}
DOMINANCE_THRESHOLD = 0.15
DOMINANCE_RATIO = 1.25


def read_jsonl(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number} must be an object")
            rows.append(value)
    return rows


def mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def quantile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, min(len(ordered) - 1, round((len(ordered) - 1) * fraction)))]


def effects(values: dict[str, int]) -> dict[str, float]:
    return {
        "context_only": values["full_direct"] - values["compact_direct"],
        "rubric_only": values["compact_reviewer"] - values["compact_direct"],
        "interaction": (values["full_reviewer"] - values["full_direct"]) - (values["compact_reviewer"] - values["compact_direct"]),
    }


def bootstrap(observations: list[dict[str, float]], samples: int = 10_000) -> dict[str, dict[str, float | None]]:
    if not observations:
        return {name: {"low": None, "high": None} for name in ("context_only", "rubric_only", "interaction")}
    generator = random.Random(20260919)
    draws: dict[str, list[float]] = defaultdict(list)
    for _ in range(samples):
        sample = [observations[generator.randrange(len(observations))] for _ in observations]
        for name in ("context_only", "rubric_only", "interaction"):
            draws[name].append(sum(item[name] for item in sample) / len(sample))
    return {name: {"low": quantile(draws[name], .025), "high": quantile(draws[name], .975)} for name in draws}


def paired(records: list[dict[str, Any]], bootstrap_samples: int = 10_000) -> dict[str, Any]:
    by_case: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    attempted = Counter()
    for record in records:
        case_id, cell = record.get("case_id"), record.get("cell")
        if not isinstance(case_id, str) or cell not in CELLS:
            continue
        attempted[(case_id, cell)] += 1
        if attempted[(case_id, cell)] > 1:
            raise ValueError(f"duplicate attempted record violates append-only key {(case_id, cell)}")
        by_case.setdefault(case_id, {})
        if record.get("status") == "success":
            by_case[case_id][cell] = record
    complete = {case_id: cells for case_id, cells in by_case.items() if set(cells) == set(CELLS)}
    metrics: dict[str, Any] = {}
    for metric, extractor in {
        "authorization_eligible": lambda record: int(record.get("authorization") in ELIGIBLE),
        "final_approval": lambda record: int(record.get("would_approve") is True),
    }.items():
        per_case = {case_id: effects({cell: extractor(record) for cell, record in cells.items()}) for case_id, cells in complete.items()}
        metrics[metric] = {
            name: {"estimate": mean([item[name] for item in per_case.values()]), **bootstrap(list(per_case.values()), bootstrap_samples)[name]}
            for name in ("context_only", "rubric_only", "interaction")
        }
    incomplete = sorted(case_id for case_id in {case for case, _ in attempted} if case_id not in complete)
    return {
        "denominator": len(complete),
        "complete_case_ids": sorted(complete),
        "attempted_case_count": len({case_id for case_id, _ in attempted}),
        "incomplete_case_ids": incomplete,
        "failed_or_missing_cell_count": sum(1 for case_id in {case for case, _ in attempted} for cell in CELLS if cell not in by_case[case_id]),
        **metrics,
    }


def excludes_zero(interval: dict[str, float | None]) -> bool:
    return interval["low"] is not None and (interval["low"] > 0 or interval["high"] < 0)


def classify_dominance(summary: dict[str, Any], ambiguity: dict[str, str]) -> dict[str, Any]:
    primary = summary["final_approval"]
    context, rubric = primary["context_only"], primary["rubric_only"]
    context_strong = abs(context["estimate"] or 0) >= DOMINANCE_THRESHOLD and excludes_zero(context)
    rubric_strong = abs(rubric["estimate"] or 0) >= DOMINANCE_THRESHOLD and excludes_zero(rubric)
    complete = summary["denominator"]
    labels = [ambiguity[case_id] for case_id in summary["complete_case_ids"] if case_id in ambiguity]
    valid = [label for label in labels if label in {"genuine_ambiguity", "not_ambiguous", "unresolved"}]
    ambiguity_share = (sum(label == "genuine_ambiguity" for label in valid) / len(valid)) if valid else None
    coverage = len(valid) / complete if complete else 0
    if context_strong and abs(context["estimate"]) >= DOMINANCE_RATIO * max(abs(rubric["estimate"] or 0), .000001):
        label = "missing_or_truncated_context_dominant"
    elif rubric_strong and abs(rubric["estimate"]) >= DOMINANCE_RATIO * max(abs(context["estimate"] or 0), .000001):
        label = "rubric_interpretation_dominant"
    elif coverage >= .80 and ambiguity_share is not None and ambiguity_share >= .50 and not context_strong and not rubric_strong:
        label = "genuine_ambiguity_dominant_after_independent_adjudication"
    else:
        label = "mixed_or_inconclusive"
    return {
        "classification": label,
        "thresholds": {"minimum_effect": DOMINANCE_THRESHOLD, "dominance_ratio": DOMINANCE_RATIO, "minimum_adjudication_coverage": .80, "minimum_ambiguity_share": .50},
        "adjudication_coverage": coverage,
        "genuine_ambiguity_share": ambiguity_share,
    }


def read_ambiguity(path: pathlib.Path | None) -> dict[str, str]:
    if path is None:
        return {}
    labels: dict[str, str] = {}
    for row in read_jsonl(path):
        case_id, label = row.get("case_id"), row.get("label")
        if not isinstance(case_id, str) or not isinstance(label, str):
            raise ValueError("ambiguity rows require string case_id and label")
        if case_id in labels:
            raise ValueError(f"duplicate ambiguity adjudication for {case_id}")
        labels[case_id] = label
    return labels


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=pathlib.Path, default=ROOT / "results.jsonl")
    parser.add_argument("--ambiguity", type=pathlib.Path, help="frozen independent ambiguity JSONL")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT / "analysis.json")
    parser.add_argument("--bootstrap-samples", type=int, default=10_000)
    args = parser.parse_args(argv)
    if args.bootstrap_samples < 1:
        parser.error("--bootstrap-samples must be positive")
    summary = paired(read_jsonl(args.results), args.bootstrap_samples)
    summary["decision_rule"] = classify_dominance(summary, read_ambiguity(args.ambiguity))
    args.output.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
