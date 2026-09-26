#!/usr/bin/env python3
"""Reproducible keyword baseline for the Task E synthetic Choice dataset."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _text(state: dict[str, Any]) -> str:
    return json.dumps(state, sort_keys=True).lower()


def _has(text: str, *needles: str) -> bool:
    return any(needle in text for needle in needles)


def _predict_e1(state: dict[str, Any], text: str) -> str:
    if state.get("dimension") == "risk":
        if _has(text, "delete", "overwrite", "publish", "production", "credential", "outside workspace", "destructive"):
            return "HIGH_RISK"
        if _has(text, "read-only", "list files", "show status", "inspect docs", "local reversible"):
            return "LOW_RISK"
        return "RISK_UNKNOWN"
    if _has(text, "explicitly authorized", "user requested", "approved scope", "standing authorization"):
        return "AUTHORIZED"
    if _has(text, "explicitly refused", "outside requested scope", "not authorized", "different repository"):
        return "NOT_AUTHORIZED"
    return "AUTH_UNKNOWN"


def _predict_e2(text: str) -> str:
    rules = (
        ("TRANSIENT_PROVIDER", ("429", "529", "timeout", "connection reset", "temporary overload")),
        ("INVALID_REQUEST", ("400", "schema", "invalid field", "malformed payload")),
        ("AUTH_CONFIGURATION", ("401", "403", "missing api key", "expired token", "configuration")),
        ("POLICY_DENIAL", ("approval denied", "policy blocked", "sandbox denied", "permission denied")),
        ("TOOL_EXECUTION", ("exit code", "test assertion", "compiler error", "command failed", "tool crashed")),
    )
    for label, words in rules:
        if _has(text, *words):
            return label
    return "UNKNOWN_CAUSE"


def _predict_e3(text: str) -> str:
    if _has(text, "identical error", "same hash", "no changed evidence", "unchanged failure"):
        return "UNCHANGED_FAILURE"
    if _has(text, "controlled repeat", "stability sample", "different seed", "confirm reproducibility"):
        return "PRODUCTIVE_REPEAT"
    if _has(text, "new passing", "new evidence", "isolated cause", "reduced failures", "implemented"):
        return "MATERIAL_PROGRESS"
    return "BLOCKED_UNKNOWN"


def _predict_e4(text: str) -> str:
    if _has(text, "missing requirement", "not implemented", "required gate not run", "omitted deliverable"):
        return "INCOMPLETE_REQUIREMENT"
    if _has(text, "claims", "no log", "no artifact", "unsupported", "said it passed"):
        return "UNSUPPORTED_CLAIM"
    if _has(text, "all requirements mapped", "verification passed", "receipt present", "evidence attached"):
        return "COMPLETE_SUPPORTED"
    return "COMPLETION_UNKNOWN"


def _predict_e5(state: dict[str, Any]) -> str:
    positive = {
        "must": 4,
        "do not": 4,
        "required": 3,
        "unresolved": 4,
        "blocked": 3,
        "decision": 3,
        "accepted": 3,
        "pending": 2,
        "failed": 2,
        "constraint": 3,
    }
    negative = ("routine", "already summarized", "superseded", "irrelevant", "greeting", "temporary debug")
    best_label = "NONE"
    best_score = 1
    for label, candidate in state.get("candidates", {}).items():
        candidate_text = str(candidate).lower()
        score = sum(weight for word, weight in positive.items() if word in candidate_text)
        score -= 3 * sum(1 for word in negative if word in candidate_text)
        if score > best_score:
            best_label, best_score = label, score
    return best_label


def _predict_e6(text: str) -> str:
    if _has(text, "failed", "crashed", "deadline exceeded", "cancelled unexpectedly"):
        return "NOTIFY_FAILURE"
    if _has(text, "needs user", "decision required", "approval required", "blocked on input"):
        return "NOTIFY_ACTION_REQUIRED"
    if _has(text, "requested milestone", "notify when", "explicit notification"):
        return "NOTIFY_REQUESTED_MILESTONE"
    if _has(text, "heartbeat", "routine progress", "no material change", "duplicate update"):
        return "SUPPRESS_ROUTINE"
    return "NOTIFICATION_UNKNOWN"


def _predict_e7(state: dict[str, Any], text: str) -> str:
    surface = str(state.get("changed_surface", "")).lower()
    if _has(surface, "provider", "wire", "adapter"):
        return "ADD_PROVIDER_BLACK_BOX"
    if _has(surface, "ui", "ink", "keyboard", "interaction"):
        return "ADD_E2E"
    if _has(surface, "boundary", "service contract", "database", "filesystem"):
        return "ADD_INTEGRATION"
    if _has(surface, "pure function", "parser", "classifier", "helper"):
        return "ADD_UNIT"
    if _has(text, "required gates already cover", "documentation only", "no behavior change"):
        return "NO_SUPPLEMENTAL"
    return "INSUFFICIENT_INFO"


def _predict_e8(text: str) -> str:
    rules = (
        ("TRANSPORT_SCHEMA", ("http status", "schema rejection", "missing response field", "transport error")),
        ("LABEL_AMBIGUITY", ("adjudicators disagree", "two labels defensible", "ambiguous label", "unclear gold")),
        ("POSITION_SENSITIVITY", ("option order", "position swap", "first option", "reordered choices")),
        ("STATE_OVERLOAD", ("irrelevant context", "long state", "distractor volume", "context overload")),
        ("PROMPT_OMISSION", ("rubric missing", "prompt omitted", "no unknown option", "undefined boundary")),
    )
    for label, words in rules:
        if _has(text, *words):
            return label
    return "TASK_ERROR_OTHER"


def predict_case(case: dict[str, Any]) -> str:
    state = case["state"]
    text = _text(state)
    task = case["task"]
    if task == "E1":
        prediction = _predict_e1(state, text)
    elif task == "E2":
        prediction = _predict_e2(text)
    elif task == "E3":
        prediction = _predict_e3(text)
    elif task == "E4":
        prediction = _predict_e4(text)
    elif task == "E5":
        prediction = _predict_e5(state)
    elif task == "E6":
        prediction = _predict_e6(text)
    elif task == "E7":
        prediction = _predict_e7(state, text)
    elif task == "E8":
        prediction = _predict_e8(text)
    else:
        raise ValueError(f"unsupported task: {task}")
    if prediction not in case["criteria"]:
        raise ValueError(f"baseline produced disallowed choice {prediction} for {case['id']}")
    return prediction


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", nargs="?", type=Path, default=Path(__file__).with_name("dataset.json"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    cases = json.loads(args.dataset.read_text())
    predictions = [{"id": case["id"], "choice": predict_case(case)} for case in cases]
    if args.check:
        mismatches = [p for p, case in zip(predictions, cases) if p["choice"] != case["baseline"]]
        print(json.dumps({"cases": len(cases), "mismatches": mismatches}, indent=2))
        return 1 if mismatches else 0
    print(json.dumps(predictions, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
