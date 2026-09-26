#!/usr/bin/env python3
"""Deterministic, non-oracle baseline for the routing pilot.

The predictor reads only each case\'s state and criteria. It returns choices in
input order; a separate validator compares them with the stored baseline field.
"""
import json
import sys


def predict(state, criteria):
    text = " ".join(str(value) for value in state.values()).lower()
    request = str(state.get("request", "")).lower()
    incoming = str(state.get("incoming_message", "")).lower()
    objective = str(state.get("objective", "")).lower()
    evidence = str(state.get("evidence", "")).lower()
    labels = set(criteria)
    if labels == {"fast", "balanced", "deep", "none"}:
        return "fast" if "reversible" in text else "balanced"
    if labels == {"minimal", "standard", "thorough", "none"}:
        return "minimal" if "one " in text and "no " in text else "standard"
    if labels == {"explorer", "worker", "reviewer", "none"}:
        return "worker" if "implement" in request else "explorer"
    if labels == {"parallel", "serial", "solo", "defer"}:
        return "parallel" if "independent" in text else "solo"
    if labels == {"correction", "follow_up", "new_topic", "unknown"}:
        return "follow_up" if any(word in incoming for word in ("also", "what ", "which ", "does ", "show ", "please include")) else "new_topic"
    if labels == {"select", "abstain", "reject", "no_fit"}:
        if any(word in objective for word in ("secret", "credential", "bypass", "audit trail", "safety logging", "token")):
            return "reject"
        if any(word in evidence for word in ("no ", "none ", "lacks", "each violate", "contradictory")):
            return "no_fit"
        return "select"
    raise ValueError("unrecognized criteria set")


def choose(case):
    return predict(case["state"], case["criteria"])


def main(path):
    with open(path, encoding="utf-8") as handle:
        cases = json.load(handle)
    print(json.dumps([predict(case["state"], case["criteria"]) for case in cases]))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) == 2 else "dataset.json")
