#!/usr/bin/env python3
"""Post-hoc fixture-shortcut diagnostics for main Jev lane datasets.

These are not preregistered baselines and do not measure model quality.  They
only score simple dataset-derived choices to expose possible fixture shortcuts.
Prediction helpers receive state/criteria only; expected labels are read solely
by the scoring layer after a prediction has been made.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
LANES = ("evidence", "routing", "discovery", "discovery-extra")
OUTPUT = ROOT / "aggregate" / "shortcuts.json"
LABEL_FIELDS = ("label", "id", "name")
DESCRIPTION_FIELDS = ("description", "text", "content", "summary")
RETRIEVAL_LIST_NAMES = {"candidate", "candidates", "section", "sections", "memory", "memories", "session", "sessions", "passage", "passages"}


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def candidate_section_entries(state: Any) -> list[dict[str, Any]] | None:
    """Return the first explicit retrieval-record list with object entries.

    This is deliberately narrow and order-preserving. It never infers a choice
    from unrelated state lists, criteria descriptions, rationale, or labels.
    Explicit list names cover candidates, sections, memories, sessions, and
    passages; an {id, text} object is recognized as label plus description.
    """
    if not isinstance(state, dict):
        return None
    for key, value in state.items():
        normalized = key.lower().replace("_", "")
        if normalized not in RETRIEVAL_LIST_NAMES:
            continue
        if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
            return value
    return None


def entry_label(entry: dict[str, Any]) -> str | None:
    for field in LABEL_FIELDS:
        value = entry.get(field)
        if isinstance(value, str) and value:
            return value
    return None


def entry_description(entry: dict[str, Any]) -> str | None:
    for field in DESCRIPTION_FIELDS:
        value = entry.get(field)
        if isinstance(value, str):
            return value
    return None


def first_criteria_option(_state: Any, criteria: Any) -> str | None:
    return next(iter(criteria), None) if isinstance(criteria, dict) and criteria else None


def first_candidate_or_section(state: Any, _criteria: Any) -> str | None:
    entries = candidate_section_entries(state)
    return entry_label(entries[0]) if entries else None


def longest_candidate_or_section_description(state: Any, _criteria: Any) -> str | None:
    entries = candidate_section_entries(state)
    if not entries:
        return None
    scored = [(len(description), index, entry_label(entry)) for index, entry in enumerate(entries) if (description := entry_description(entry)) is not None and entry_label(entry) is not None]
    if not scored:
        return None
    # max keeps the first list item for equal lengths because -index is larger.
    return max(scored, key=lambda item: (item[0], -item[1]))[2]


METHODS: dict[str, Callable[[Any, Any], str | None]] = {
    "first_criteria_option": first_criteria_option,
    "first_state_candidate_or_section": first_candidate_or_section,
    "longest_state_candidate_or_section_description": longest_candidate_or_section_description,
}


def score_cases(cases: list[dict[str, Any]], predictor: Callable[[Any, Any], str | None], retrieval_method: bool = False) -> dict[str, Any]:
    """Score after prediction; predictor never receives expected/rationale/tags."""
    applicable = correct = recognizable_records = 0
    for case in cases:
        if retrieval_method and candidate_section_entries(case.get("state")) is not None:
            recognizable_records += 1
        predicted = predictor(case.get("state"), case.get("criteria"))
        if predicted is None:
            continue
        applicable += 1
        if predicted == case.get("expected"):
            correct += 1
    return {"cases": len(cases), "recognizable_retrieval_records": recognizable_records if retrieval_method else None, "applicable": applicable, "inapplicable": len(cases) - applicable, "correct": correct, "accuracy": f"{correct}/{applicable}" if applicable else "n/a_no_retrieval_records" if retrieval_method and recognizable_records == 0 else None}


def summarize_dataset(dataset: Any) -> dict[str, Any]:
    if not isinstance(dataset, list):
        raise ValueError("dataset must be an array")
    by_task_split: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for case in dataset:
        if isinstance(case, dict):
            by_task_split[(str(case.get("task")), str(case.get("split")))].append(case)
    tasks: dict[str, Any] = {}
    for (task, split), cases in sorted(by_task_split.items()):
        tasks.setdefault(task, {})[split] = {name: score_cases(cases, predictor, name != "first_criteria_option") for name, predictor in METHODS.items()}
    return tasks


def run(root: Path = ROOT, output: Path | None = None) -> dict[str, Any]:
    output = output or root / "aggregate" / "shortcuts.json"
    lanes: dict[str, Any] = {}
    for lane in LANES:
        dataset_path = root / lane / "dataset.json"
        if not dataset_path.is_file():
            lanes[lane] = {"present": False}
            continue
        try:
            lanes[lane] = {"present": True, "dataset_sha256": file_sha256(dataset_path), "tasks": summarize_dataset(read_json(dataset_path))}
        except (OSError, ValueError, json.JSONDecodeError) as error:
            lanes[lane] = {"present": True, "error": f"{type(error).__name__}: {error}"}
    result = {
        "run_id": "jev-fit-20260919",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "status": "post_hoc_diagnostic_only",
        "notice": "Not preregistered baselines; detects possible fixture shortcut confounding, not model quality.",
        "methods": {
            "first_criteria_option": "Predict the first inserted criteria key.",
            "first_state_candidate_or_section": "Predict the label/id/name of the first object in the first top-level state list whose key contains candidate, section, memory, session, or passage.",
            "longest_state_candidate_or_section_description": "Predict the label/id/name of the object with the longest description/text/content/summary in that same list; equal lengths choose the first object. An id/text record uses id as the prediction and text as its description.",
        },
        "lanes": lanes,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def selftest() -> int:
    """Hand-written MOCK cases verify methods and tie/inapplicable accounting."""
    cases = [
        {"id": "mock-1", "task": "T", "split": "dev", "state": {"candidates": [{"label": "A", "description": "short"}, {"label": "B", "description": "longer text"}]}, "criteria": {"B": "first option", "A": "second option"}, "expected": "A"},
        {"id": "mock-2", "task": "T", "split": "holdout", "state": {"sections": [{"id": "B", "content": "same"}, {"id": "A", "content": "same"}]}, "criteria": {"A": "first option", "B": "second option"}, "expected": "B"},
        {"id": "mock-3", "task": "T", "split": "holdout", "state": {"memories": [{"id": "A", "text": "brief"}, {"id": "B", "text": "much longer memory text"}]}, "criteria": {"A": "first memory", "B": "second memory"}, "expected": "B"},
        {"id": "mock-4", "task": "T", "split": "holdout", "state": {"sessions": [{"id": "A", "text": "session text"}]}, "criteria": {"A": "session"}, "expected": "A"},
        {"id": "mock-5", "task": "T", "split": "holdout", "state": {"passages": [{"id": "B", "text": "passage text"}]}, "criteria": {"B": "passage"}, "expected": "B"},
        {"id": "mock-6", "task": "T", "split": "holdout", "state": {"other_list": [{"label": "A", "description": "ignored"}]}, "criteria": {"A": "only option"}, "expected": "A"},
    ]
    dev = [cases[0]]
    holdout = cases[1:]
    assert score_cases(dev, first_criteria_option) == {"cases": 1, "recognizable_retrieval_records": None, "applicable": 1, "inapplicable": 0, "correct": 0, "accuracy": "0/1"}
    assert score_cases(dev, first_candidate_or_section)["accuracy"] == "1/1"
    assert score_cases(dev, longest_candidate_or_section_description)["accuracy"] == "0/1"
    assert score_cases(holdout, first_candidate_or_section, True) == {"cases": 5, "recognizable_retrieval_records": 4, "applicable": 4, "inapplicable": 1, "correct": 3, "accuracy": "3/4"}
    assert score_cases(holdout, longest_candidate_or_section_description, True) == {"cases": 5, "recognizable_retrieval_records": 4, "applicable": 4, "inapplicable": 1, "correct": 4, "accuracy": "4/4"}
    assert candidate_section_entries(cases[2]["state"])[0]["id"] == "A"
    assert candidate_section_entries(cases[3]["state"])[0]["id"] == "A"
    assert candidate_section_entries(cases[4]["state"])[0]["id"] == "B"
    # Explicitly assert the tie rule independently of this score expectation.
    assert longest_candidate_or_section_description(cases[1]["state"], cases[1]["criteria"]) == "B"
    summary = summarize_dataset(cases)
    assert summary["T"]["dev"]["first_state_candidate_or_section"]["correct"] == 1
    print(json.dumps({"selftest": "passed", "checks": "criteria order; candidates, sections, memories, sessions, passages; id/text records; longest-description tie; inapplicable", "evidence": "hand-written MOCK cases only"}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("run", "selftest"), default="run")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "selftest":
        return selftest()
    result = run(args.root.resolve(), args.output.resolve() if args.output else None)
    print(json.dumps({"output": str((args.output or args.root / "aggregate" / "shortcuts.json").resolve()), "lanes": sorted(name for name, value in result["lanes"].items() if value.get("present"))}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(f"ERROR: {error}")
        raise SystemExit(1)
