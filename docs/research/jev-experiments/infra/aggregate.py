#!/usr/bin/env python3
"""Aggregate completed Jev lanes with the independent review audit.

This script never invokes a provider and never changes lane inputs, runners, or
results.  Its only writes are JSON files below docs/research/jev-experiments/
aggregate/, which may be regenerated as more lanes finish.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EXPERIMENT_ROOT = Path(__file__).resolve().parent.parent
AUDIT = EXPERIMENT_ROOT / "review" / "audit.py"
LANES = ("evidence", "routing", "discovery", "discovery-extra")
CHALLENGE = "challenge"


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number}: record is not an object")
        records.append(value)
    return records


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def nearest_rank(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def audit_call(args: list[str]) -> dict[str, Any]:
    """Run the independent audit CLI; retain stdout/stderr failures as data."""
    argv = [sys.executable, str(AUDIT), *args]
    completed = subprocess.run(argv, text=True, capture_output=True, check=False)
    result: dict[str, Any] = {"argv": argv, "returncode": completed.returncode}
    try:
        result["output"] = json.loads(completed.stdout) if completed.stdout.strip() else None
    except json.JSONDecodeError:
        result["output"] = None
        result["stdout"] = completed.stdout
    if completed.stderr:
        result["stderr"] = completed.stderr
    return result


def normal_complete(root: Path) -> tuple[bool, str, dict[str, Path]]:
    files = {
        "dataset": root / "dataset.json", "prompts": root / "prompts.json", "freeze": root / "freeze.json",
        "dev": root / "results" / "dev.jsonl", "holdout": root / "results" / "holdout.jsonl", "stability": root / "results" / "stability.jsonl",
        "baseline": root / "baseline.py",
    }
    required = ("dataset", "prompts", "freeze", "holdout", "baseline")
    missing = [name for name in required if not files[name].is_file()]
    if missing:
        return False, f"missing {', '.join(missing)}", files
    try:
        dataset, freeze, records = read_json(files["dataset"]), read_json(files["freeze"]), read_jsonl(files["holdout"])
        if not isinstance(dataset, list) or not isinstance(freeze, dict):
            return False, "dataset or freeze schema is invalid", files
        selected = freeze.get("selected_variants")
        if not isinstance(selected, dict):
            return False, "freeze has no selected_variants", files
        expected = {(case["id"], selected.get(case["task"])) for case in dataset if isinstance(case, dict) and case.get("split") == "holdout"}
        observed = {(record.get("case_id"), record.get("variant")) for record in records if record.get("phase") == "holdout"}
        if not expected:
            return False, "dataset has no holdout cases", files
        if not expected <= observed:
            return False, f"holdout incomplete: {len(observed & expected)}/{len(expected)} selected tuples recorded", files
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        return False, f"cannot inspect completion: {type(error).__name__}: {error}", files
    return True, "complete", files


def challenge_complete(root: Path) -> tuple[bool, str, dict[str, Path]]:
    files = {"dataset": root / "dataset.json", "prompts": root / "prompts.json", "manifest": root / "challenge-manifest.json", "records": root / "results" / "challenge.jsonl", "baseline": root / "baseline.py"}
    missing = [name for name, path in files.items() if not path.is_file()]
    if missing:
        return False, f"missing {', '.join(missing)}", files
    try:
        dataset, manifest, records = read_json(files["dataset"]), read_json(files["manifest"]), read_jsonl(files["records"])
        counts = Counter(case.get("task") for case in dataset if isinstance(case, dict) and case.get("split") == "holdout")
        task_ids = {f"D{i}" for i in range(1, 7)} | {f"R{i}" for i in range(1, 7)} | {f"E{i}" for i in range(1, 9)}
        expected = {case["id"] for case in dataset if isinstance(case, dict) and case.get("split") == "holdout"}
        observed = {record.get("case_id") for record in records if record.get("phase") == "challenge" and record.get("variant") == "scoped"}
        if not isinstance(manifest, dict) or manifest.get("variant") != "scoped":
            return False, "challenge manifest is not scoped", files
        if len(dataset) != 80 or set(counts) != task_ids or any(counts[task] != 4 for task in task_ids):
            return False, "challenge dataset is not 20 tasks x 4 holdout cases", files
        if len(expected) != 80 or not expected <= observed:
            return False, f"challenge incomplete: {len(expected & observed)}/80 scoped tuples recorded", files
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        return False, f"cannot inspect challenge completion: {type(error).__name__}: {error}", files
    return True, "complete", files


def first_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Respect append-only semantics and avoid charging duplicated tuples twice."""
    first: dict[tuple[Any, Any, Any], dict[str, Any]] = {}
    for record in records:
        first.setdefault((record.get("phase"), record.get("case_id"), record.get("variant")), record)
    return list(first.values())


def operational(records_by_phase: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    per_phase: dict[str, Any] = {}
    all_records: list[dict[str, Any]] = []
    for phase, records in records_by_phase.items():
        records = first_records(records)
        all_records.extend(records)
        per_phase[phase] = operational_rows(records)
    # A provider generation ID is stronger than a local record ID for dedupe.
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for record in all_records:
        identity = str(record.get("provider_id") or record.get("record_id") or record.get("payload_sha256") or (record.get("phase"), record.get("case_id"), record.get("variant")))
        if identity not in seen:
            seen.add(identity)
            unique.append(record)
    return {"by_phase": per_phase, "deduplicated_total": operational_rows(unique), "dedupe_key": "provider_id, then record_id, then payload_sha256, then tuple"}


def operational_rows(records: list[dict[str, Any]]) -> dict[str, Any]:
    durations = [float(record["duration_ms"]) for record in records if isinstance(record.get("duration_ms"), (int, float))]
    usage = [record.get("usage") for record in records if isinstance(record.get("usage"), dict)]
    numeric_usage: dict[str, float] = defaultdict(float)
    for item in usage:
        for key, value in item.items():
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                numeric_usage[key] += value
    return {"unique_records": len(records), "latency_ms": {"n": len(durations), "p50": nearest_rank(durations, .50), "p95": nearest_rank(durations, .95)}, "returned_usage_records": len(usage), "returned_usage_sums": dict(sorted(numeric_usage.items())), "cost_is_returned_only": True}


def stability_summary(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {"present": False}
    records = first_records(read_jsonl(path))
    grouped: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for record in records:
        if record.get("phase") == "stability" and record.get("variant") in ("repeat", "reversed"):
            grouped[str(record.get("case_id"))][str(record["variant"])] = record
    pairs = [(case_id, values["repeat"], values["reversed"]) for case_id, values in grouped.items() if {"repeat", "reversed"} <= set(values)]
    answered = [(case_id, original, reversed_record) for case_id, original, reversed_record in pairs if original.get("status") == "success" and reversed_record.get("status") == "success"]
    disagreements = [case_id for case_id, original, reversed_record in answered if original.get("choice") != reversed_record.get("choice")]
    return {"present": True, "records": len(records), "paired_original_reverse": len(pairs), "answered_pairs": len(answered), "choice_disagreements": len(disagreements), "disagreement_case_ids": sorted(disagreements)}


def compact_score(score: dict[str, Any] | None, phase: str) -> dict[str, Any] | None:
    if not isinstance(score, dict):
        return None
    tasks = {}
    for key, row in score.get("tasks", {}).items():
        tasks[key] = {name: row.get(name) for name in ("universe", "attempted", "answered", "correct_over_attempted", "correct_over_answered", "balanced_accuracy_attempted", "paired_vs_baselines", "latency_ms", "failure_classes")}
    result = {"phase": phase, "records_in_phase_used": score.get("records_in_phase_used"), "tasks": tasks}
    if phase == "dev":
        result["variant_margins"] = score.get("variant_selection", {})
    return result


def run_audits(files: dict[str, Path], phase_records: dict[str, Path], freeze: Path | None) -> dict[str, Any]:
    dataset, baseline = files["dataset"], files["baseline"]
    output = {
        "contract": audit_call(["contract", str(dataset)]),
        "overlap": audit_call(["overlap", str(dataset)]),
        "baselines": audit_call(["baselines", str(dataset), "--baseline-script", str(baseline)]),
        "scores": {},
    }
    for phase, records in phase_records.items():
        if not records.is_file():
            continue
        arguments = ["score", str(dataset), "--records", str(records), "--phase", phase]
        if freeze is not None and freeze.is_file():
            arguments.extend(["--freeze", str(freeze)])
        output["scores"][phase] = audit_call(arguments)
    return output


def audit_problems(audits: dict[str, Any]) -> dict[str, Any]:
    """Keep both process failures and audit findings visible in summary.json."""
    problems: dict[str, Any] = {}
    for name, result in audits.items():
        entries = result.items() if name == "scores" else [(name, result)]
        for label, item in entries:
            finding: dict[str, Any] = {}
            if item.get("returncode") != 0:
                finding["process"] = {key: item.get(key) for key in ("returncode", "stderr", "stdout") if key in item}
            output = item.get("output")
            if isinstance(output, dict):
                for key in ("errors", "jsonl_problems", "unknown_case_ids", "duplicate_case_variant_tuples"):
                    if output.get(key):
                        finding[key] = output[key]
            if finding:
                problems[label] = finding
    return problems


def aggregate_lane(name: str, root: Path, output_root: Path, challenge: bool = False) -> dict[str, Any]:
    complete, state, files = challenge_complete(root) if challenge else normal_complete(root)
    lane_summary: dict[str, Any] = {"state": state, "complete": complete, "root": str(root)}
    if not complete:
        return lane_summary
    phase_records = {"challenge": files["records"]} if challenge else {phase: files[phase] for phase in ("dev", "holdout", "stability") if files[phase].is_file()}
    audits = run_audits(files, phase_records, None if challenge else files["freeze"])
    lane_output = output_root / name
    for audit_name in ("contract", "overlap", "baselines"):
        write_json(lane_output / f"{audit_name}.json", audits[audit_name])
    for phase, audit in audits["scores"].items():
        write_json(lane_output / f"score-{phase}.json", audit)
    records_by_phase = {phase: read_jsonl(path) for phase, path in phase_records.items()}
    score_outputs = {phase: result.get("output") for phase, result in audits["scores"].items()}
    lane_summary.update({"audit_files": sorted(str(path.relative_to(output_root)) for path in lane_output.glob("*.json")), "main_dev": compact_score(score_outputs.get("dev"), "dev"), "holdout_selected_vs_baseline": compact_score(score_outputs.get("holdout"), "holdout"), "challenge_scoped": compact_score(score_outputs.get("challenge"), "challenge") if challenge else None, "stability": stability_summary(files["stability"]) if not challenge else None, "operational": operational(records_by_phase), "audit_reported_problems": audit_problems(audits)})
    return lane_summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=EXPERIMENT_ROOT, help="jev-experiments root")
    parser.add_argument("--output", type=Path, help="must be ROOT/aggregate (default)")
    args = parser.parse_args()
    root = args.root.resolve()
    output = (args.output or root / "aggregate").resolve()
    if output != root / "aggregate":
        raise ValueError("output must be the aggregate directory directly under --root")
    summary: dict[str, Any] = {"run_id": "jev-fit-20260919", "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "lanes": {}, "errors": []}
    for lane in LANES:
        try:
            summary["lanes"][lane] = aggregate_lane(lane, root / lane, output)
        except Exception as error:
            summary["lanes"][lane] = {"complete": False, "state": f"aggregate error: {type(error).__name__}: {error}"}
            summary["errors"].append(f"{lane}: {type(error).__name__}: {error}")
    try:
        summary["challenge"] = aggregate_lane(CHALLENGE, root / CHALLENGE, output, challenge=True)
    except Exception as error:
        summary["challenge"] = {"complete": False, "state": f"aggregate error: {type(error).__name__}: {error}"}
        summary["errors"].append(f"challenge: {type(error).__name__}: {error}")
    write_json(output / "summary.json", summary)
    print(json.dumps({"summary": str(output / "summary.json"), "completed": [name for name, value in summary["lanes"].items() if value.get("complete")] + (["challenge"] if summary["challenge"].get("complete") else []), "pending": [name for name, value in summary["lanes"].items() if not value.get("complete")]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
