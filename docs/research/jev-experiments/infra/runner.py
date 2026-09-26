#!/usr/bin/env python3
"""Reproducible, stdlib-only runner for the Jev Choice pilot.

This program deliberately has no automatic retry path.  A record, including a
transport failure, consumes its (phase, case, variant) tuple until a human
creates a new run directory.  It never sends expected labels in a request.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import os
import pathlib
import statistics
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent
DATASET = ROOT / "dataset.json"
PROMPTS = ROOT / "prompts.json"
RESULTS = ROOT / "results"
FREEZE = ROOT / "freeze.json"
PHASE_METADATA = ROOT / "phase-metadata.json"
STABILITY_PLAN = ROOT / "stability-plan.json"
MODEL = "typesafe/jev-1.13"
ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
TIMEOUT_SECONDS = 60
MAX_CONCURRENCY = 4
VARIANTS = ("minimal", "rubric", "scoped")
TIE_ORDER = {"scoped": 0, "rubric": 1, "minimal": 2}


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def file_digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wire_bytes(value: Any) -> bytes:
    """Keep insertion order: reversed-criteria trials must reach the provider reversed."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def payload_digest(value: Any) -> str:
    return hashlib.sha256(wire_bytes(value)).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def read_json(path: pathlib.Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: pathlib.Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sanitise(value: Any, credential: str = "") -> Any:
    """Only redact the credential value itself; usage and semantic keys are evidence."""
    if isinstance(value, dict):
        return {key: sanitise(item, credential) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitise(item, credential) for item in value]
    return "[redacted]" if credential and value == credential else value


def valid_provenance(value: Any) -> bool:
    return (isinstance(value, str) and bool(value.strip())) or (isinstance(value, dict) and bool(value))


def validation_errors(dataset: Any, prompts: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(dataset, list):
        return ["dataset.json must contain a JSON array"]
    if not isinstance(prompts, dict):
        return ["prompts.json must contain an object"]
    ids: set[str] = set()
    task_splits: dict[str, Counter[str]] = defaultdict(Counter)
    split_states: dict[tuple[str, str], set[str]] = defaultdict(set)
    for index, case in enumerate(dataset):
        prefix = f"case[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{prefix} must be an object")
            continue
        required = {"id", "task", "split", "state", "criteria", "expected", "rationale", "provenance", "tags", "baseline"}
        missing = required - set(case)
        if missing:
            errors.append(f"{prefix} missing {sorted(missing)}")
            continue
        case_id, task, split = case["id"], case["task"], case["split"]
        if not isinstance(case_id, str) or not case_id:
            errors.append(f"{prefix}.id must be a nonempty string")
        elif case_id in ids:
            errors.append(f"duplicate id {case_id}")
        else:
            ids.add(case_id)
        if not isinstance(task, str) or not task:
            errors.append(f"{prefix}.task must be a nonempty string")
        if split not in ("dev", "holdout"):
            errors.append(f"{prefix}.split must be dev or holdout")
        if not isinstance(case["state"], dict):
            errors.append(f"{prefix}.state must be an object")
        if not isinstance(case["criteria"], dict) or not case["criteria"] or not all(isinstance(k, str) and isinstance(v, str) and v.strip() for k, v in case["criteria"].items()):
            errors.append(f"{prefix}.criteria must map nonempty string labels to descriptions")
        else:
            if case["expected"] not in case["criteria"]:
                errors.append(f"{prefix}.expected is not an allowed choice")
            if case["baseline"] not in case["criteria"]:
                errors.append(f"{prefix}.baseline is not an allowed choice")
        if not all(isinstance(case[key], str) and case[key].strip() for key in ("expected", "rationale", "baseline")):
            errors.append(f"{prefix} has invalid label or rationale text")
        if not valid_provenance(case["provenance"]):
            errors.append(f"{prefix}.provenance must be a nonempty string or nonempty object")
        if not isinstance(case["tags"], list) or not case["tags"] or not all(isinstance(tag, str) and tag for tag in case["tags"]):
            errors.append(f"{prefix}.tags must be a nonempty string array")
        if isinstance(task, str) and split in ("dev", "holdout"):
            task_splits[task][split] += 1
            if isinstance(case["state"], dict):
                split_states[(task, split)].add(digest(case["state"]))
    for task, counts in sorted(task_splits.items()):
        if counts["dev"] < 24 or counts["holdout"] < 24:
            errors.append(f"{task} needs at least 24 dev and 24 holdout cases; got {counts['dev']}/{counts['holdout']}")
        overlap = split_states[(task, "dev")] & split_states[(task, "holdout")]
        if overlap:
            errors.append(f"{task} repeats {len(overlap)} state(s) across dev and holdout")
        variants = prompts.get(task)
        if not isinstance(variants, dict):
            errors.append(f"prompts missing task {task}")
            continue
        for variant in VARIANTS:
            entry = variants.get(variant)
            if not isinstance(entry, dict) or not isinstance(entry.get("instructions"), str) or not entry["instructions"].strip():
                errors.append(f"prompts.{task}.{variant}.instructions must be a nonempty string")
    return errors


def select_cases(dataset: list[dict[str, Any]], lane: str, split: str | None = None) -> list[dict[str, Any]]:
    def allowed(task: str) -> bool:
        return lane == "all" or task == lane or task.startswith(lane)
    return [case for case in dataset if allowed(case["task"]) and (split is None or case["split"] == split)]


def result_path(phase: str) -> pathlib.Path:
    RESULTS.mkdir(exist_ok=True)
    return RESULTS / f"{phase}.jsonl"


def read_records(phase: str) -> list[dict[str, Any]]:
    path = result_path(phase)
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as error:
                raise ValueError(f"invalid JSONL in {path}:{line_number}: {error}") from error
    return records


def append_record(phase: str, record: dict[str, Any]) -> None:
    with result_path(phase).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n")


def record_key(record: dict[str, Any]) -> tuple[str, str, str]:
    return (str(record.get("phase")), str(record.get("case_id")), str(record.get("variant")))


def get_api_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if key:
        return key
    state_home = pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state"))
    settings_dir = pathlib.Path(os.environ.get("TERM2_CONFIG_DIR", state_home / "term2-nodejs"))
    settings_path = settings_dir / "settings.json"
    try:
        settings = read_json(settings_path)
        candidate = settings.get("agent", {}).get("openrouter", {}).get("apiKey", "")
        return candidate if isinstance(candidate, str) else ""
    except (OSError, ValueError, AttributeError):
        return ""


def payload_for(case: dict[str, Any], instructions: str) -> dict[str, Any]:
    return {"model": MODEL, "state": case["state"], "questions": {"case": {"type": "choice", "instructions": instructions, "criteria": case["criteria"]}}}


def parse_answer(response: Any, criteria: dict[str, str]) -> tuple[str, float, Any]:
    if not isinstance(response, dict):
        raise ValueError("response is not an object")
    answer = response.get("answers", {}).get("case")
    if not isinstance(answer, dict):
        raise ValueError("response lacks answers.case")
    if answer.get("type") != "choice":
        raise ValueError("response answer type is not choice")
    choice = answer.get("choice")
    confidence = answer.get("confidence")
    if choice not in criteria:
        raise ValueError("response choice is absent from criteria")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
        raise ValueError("response confidence is not finite in [0,1]")
    return choice, float(confidence), answer


def post(payload: dict[str, Any], api_key: str) -> tuple[int, Any]:
    request = urllib.request.Request(ENDPOINT, data=wire_bytes(payload), headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return response.getcode(), json.loads(response.read().decode("utf-8"))


def evaluate(phase: str, case: dict[str, Any], variant: str, instructions: str, api_key: str, dataset_sha256: str, prompts_sha256: str) -> dict[str, Any]:
    payload = payload_for(case, instructions)
    started = time.perf_counter()
    started_at = now()
    record: dict[str, Any] = {"record_id": digest({"phase": phase, "case_id": case["id"], "variant": variant, "dataset_sha256": dataset_sha256, "prompts_sha256": prompts_sha256}), "live": True, "phase": phase, "task": case["task"], "case_id": case["id"], "variant": variant, "started_at": started_at, "model": MODEL, "endpoint": ENDPOINT, "dataset_sha256": dataset_sha256, "prompts_sha256": prompts_sha256, "body": payload, "payload_sha256": payload_digest(payload)}
    try:
        http_status, response = post(payload, api_key)
        record.update({"http_status": http_status, "raw_response": sanitise(response, api_key), "provider_id": response.get("id") if isinstance(response, dict) else None, "resolved_model": response.get("model") if isinstance(response, dict) else None, "usage": sanitise(response.get("usage"), api_key) if isinstance(response, dict) else None})
        choice, confidence, raw_answer = parse_answer(response, case["criteria"])
        record.update({"status": "success", "choice": choice, "confidence": confidence, "raw_choice": sanitise(raw_answer, api_key)})
    except urllib.error.HTTPError as error:
        try:
            error_body: Any = json.loads(error.read().decode("utf-8"))
        except Exception:
            error_body = None
        record.update({"status": "transport_error", "http_status": error.code, "raw_response": sanitise(error_body, api_key), "error": {"kind": "http", "message": str(error)}})
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        record.update({"status": "transport_error", "http_status": None, "error": {"kind": type(error).__name__, "message": str(error)}})
    except Exception as error:  # records unexpected local/parser failures rather than hiding them
        record.update({"status": "error", "http_status": None, "error": {"kind": type(error).__name__, "message": str(error)}})
    record["duration_ms"] = round((time.perf_counter() - started) * 1000, 3)
    record["ended_at"] = now()
    return record


def run_phase(phase: str, lane: str, split: str, variants_by_task: dict[str, list[str]], frozen: dict[str, str] | None = None) -> int:
    dataset, prompts = read_json(DATASET), read_json(PROMPTS)
    errors = validation_errors(dataset, prompts)
    if errors:
        raise ValueError("validation failed:\n- " + "\n- ".join(errors))
    dataset_sha256, prompts_sha256 = file_digest(DATASET), file_digest(PROMPTS)
    metadata = read_json(PHASE_METADATA) if PHASE_METADATA.exists() else {}
    if phase == "dev" and "dev" not in metadata:
        metadata["dev"] = {"prepared_at": now(), "dataset_sha256": dataset_sha256, "prompts_sha256": prompts_sha256, "model": MODEL}
        write_json(PHASE_METADATA, metadata)
    elif phase == "dev" and (metadata["dev"].get("dataset_sha256") != dataset_sha256 or metadata["dev"].get("prompts_sha256") != prompts_sha256):
        raise ValueError("dev refused: dataset or prompts digest differs from the pre-request dev manifest")
    api_key = get_api_key()
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY or term2 agent.openrouter.apiKey is required; no request was sent")
    existing = {record_key(record) for record in read_records(phase)}
    jobs: list[tuple[dict[str, Any], str, str]] = []
    for case in select_cases(dataset, lane, split):
        for variant in variants_by_task[case["task"]]:
            key = (phase, case["id"], variant)
            if key not in existing:
                instructions = frozen[case["task"]] if frozen else prompts[case["task"]][variant]["instructions"]
                jobs.append((case, variant, instructions))
    if not jobs:
        print("no new calls: existing append-only records cover the selected tuple(s)")
        return 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        futures = [pool.submit(evaluate, phase, case, variant, instructions, api_key, dataset_sha256, prompts_sha256) for case, variant, instructions in jobs]
        for future in concurrent.futures.as_completed(futures):
            append_record(phase, future.result())
    print(f"wrote {len(jobs)} append-only {phase} record(s)")
    return 0


def successful(records: list[dict[str, Any]], cases: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    return [record for record in records if record.get("status") == "success" and record.get("case_id") in cases and record.get("live") is True]


def accuracy(records: list[dict[str, Any]], cases: dict[str, dict[str, Any]]) -> float:
    if not records:
        return -1.0
    return sum(record.get("choice") == cases[record["case_id"]]["expected"] for record in records) / len(records)


def freeze(lane: str) -> int:
    dataset, prompts = read_json(DATASET), read_json(PROMPTS)
    errors = validation_errors(dataset, prompts)
    if errors:
        raise ValueError("validation failed:\n- " + "\n- ".join(errors))
    if not PHASE_METADATA.exists() or "dev" not in read_json(PHASE_METADATA):
        raise ValueError("cannot freeze: missing pre-request dev manifest")
    dev_manifest = read_json(PHASE_METADATA)["dev"]
    if dev_manifest.get("dataset_sha256") != file_digest(DATASET) or dev_manifest.get("prompts_sha256") != file_digest(PROMPTS):
        raise ValueError("cannot freeze: dev manifest dataset or prompts digest differs from current inputs")
    cases = {case["id"]: case for case in select_cases(dataset, lane, "dev")}
    all_records = [record for record in read_records("dev") if record.get("case_id") in cases]
    selected: dict[str, str] = {}
    for task in sorted({case["task"] for case in cases.values()}):
        task_cases = {case_id: case for case_id, case in cases.items() if case["task"] == task}
        scored = []
        for variant in VARIANTS:
            relevant = [record for record in all_records if record.get("task") == task and record.get("variant") == variant]
            if len(relevant) != len(task_cases):
                raise ValueError(f"cannot freeze {task}: {variant} has {len(relevant)}/{len(task_cases)} attempted dev results")
            if len({record_key(record) for record in relevant}) != len(relevant):
                raise ValueError(f"cannot freeze {task}: duplicate dev records require coordinator review")
            if any(record.get("dataset_sha256") != dev_manifest["dataset_sha256"] or record.get("prompts_sha256") != dev_manifest["prompts_sha256"] or record.get("live") is not True for record in relevant):
                raise ValueError(f"cannot freeze {task}: records are mock or have a mismatched dataset/prompts digest")
            if any(not isinstance(record.get("started_at"), str) or record["started_at"] < dev_manifest.get("prepared_at", "") for record in relevant):
                raise ValueError(f"cannot freeze {task}: a dev record lacks a timestamp after the pre-request manifest")
            if not any(record.get("status") == "success" for record in relevant):
                raise ValueError(f"cannot freeze {task}: {variant} has failure-only dev data")
            scored.append((accuracy(relevant, task_cases), TIE_ORDER[variant], variant))
        selected[task] = min(scored, key=lambda item: (-item[0], item[1]))[2]
    freeze_record = {"run_id": "jev-fit-20260919", "created_at": now(), "model": MODEL, "dataset_sha256": file_digest(DATASET), "prompts_sha256": file_digest(PROMPTS), "selected_variants": selected, "selected_instructions": {task: prompts[task][variant]["instructions"] for task, variant in selected.items()}}
    write_json(FREEZE, freeze_record)
    print(f"froze {len(selected)} task prompt(s) in {FREEZE}")
    return 0


def require_freeze(lane: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if not FREEZE.exists():
        raise ValueError("freeze.json is required before holdout")
    frozen = read_json(FREEZE)
    if frozen.get("dataset_sha256") != file_digest(DATASET) or frozen.get("prompts_sha256") != file_digest(PROMPTS):
        raise ValueError("holdout refused: dataset.json or prompts.json changed after freeze")
    wanted = {case["task"] for case in select_cases(read_json(DATASET), lane, "holdout")}
    if not wanted <= set(frozen.get("selected_variants", {})):
        raise ValueError("holdout refused: requested lane has no frozen selected variant")
    return frozen, read_json(DATASET)


def require_complete_holdout(lane: str, dataset: list[dict[str, Any]]) -> None:
    cases = select_cases(dataset, lane, "holdout")
    records = read_records("holdout")
    completed = {record.get("case_id") for record in records if record.get("status") == "success" and record.get("live") is True}
    missing = [case["id"] for case in cases if case["id"] not in completed]
    if missing:
        raise ValueError(f"stability requires completed holdout; {len(missing)} case(s) lack a successful recorded response")


def stability(lane: str) -> int:
    """Run the predeclared ordinary/adversarial repeat and order trials, outside scoring."""
    frozen, dataset = require_freeze(lane)
    require_complete_holdout(lane, dataset)
    dataset_sha256 = file_digest(DATASET)
    if STABILITY_PLAN.exists():
        plan = read_json(STABILITY_PLAN)
        if plan.get("dataset_sha256") != dataset_sha256 or plan.get("prompts_sha256") != file_digest(PROMPTS):
            raise ValueError("stability refused: existing predeclaration does not match frozen inputs")
    else:
        selected: dict[str, dict[str, str]] = {}
        for task in sorted({case["task"] for case in select_cases(dataset, lane, "holdout")}):
            candidates = [case for case in dataset if case["task"] == task and case["split"] == "holdout"]
            ordinary = next((case for case in candidates if "ordinary" in case["tags"]), None)
            adversarial = next((case for case in candidates if "adversarial" in case["tags"]), None)
            if ordinary is None or adversarial is None:
                raise ValueError(f"stability requires a predeclared ordinary and adversarial holdout case for {task}")
            selected[task] = {"ordinary": ordinary["id"], "adversarial": adversarial["id"]}
        plan = {"created_at": now(), "dataset_sha256": dataset_sha256, "prompts_sha256": file_digest(PROMPTS), "model": MODEL, "selected": selected, "note": "Separate stability-only records: repeat uses the frozen prompt and original criteria order; reversed reverses only criteria insertion order."}
        write_json(STABILITY_PLAN, plan)
    api_key = get_api_key()
    if not api_key:
        raise ValueError("OPENROUTER_API_KEY or term2 agent.openrouter.apiKey is required; no request was sent")
    by_id = {case["id"]: case for case in dataset}
    existing = {record_key(record) for record in read_records("stability")}
    jobs: list[tuple[dict[str, Any], str, str]] = []
    for task, selected in plan["selected"].items():
        for category, case_id in selected.items():
            case = by_id[case_id]
            if ("stability", case_id, "repeat") not in existing:
                jobs.append((case, "repeat", frozen["selected_instructions"][task]))
            if ("stability", case_id, "reversed") not in existing:
                reversed_case = {**case, "criteria": dict(reversed(list(case["criteria"].items())))}
                jobs.append((reversed_case, "reversed", frozen["selected_instructions"][task]))
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        futures = [pool.submit(evaluate, "stability", case, variant, instructions, api_key, dataset_sha256, file_digest(PROMPTS)) for case, variant, instructions in jobs]
        for future in concurrent.futures.as_completed(futures):
            append_record("stability", future.result())
    print(f"wrote {len(jobs)} separate stability record(s)")
    return 0


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def report(lane: str) -> int:
    dataset = read_json(DATASET)
    cases = {case["id"]: case for case in select_cases(dataset, lane)}
    records = read_records("holdout")
    if not records:
        records = read_records("dev")
    records = [record for record in records if record.get("case_id") in cases and record.get("live") is True]
    output: dict[str, Any] = {"run_id": "jev-fit-20260919", "lane": lane, "source_phase": records[0].get("phase") if records else None, "tasks": {}}
    for task in sorted({case["task"] for case in cases.values()}):
        task_cases = {case_id: case for case_id, case in cases.items() if case["task"] == task}
        task_records = [record for record in records if record.get("task") == task]
        good = successful(task_records, task_cases)
        confusion: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        for record in good:
            confusion[task_cases[record["case_id"]]["expected"]][record["choice"]] += 1
        labels = sorted({label for case in task_cases.values() for label in case["criteria"]})
        recalls = {label: (confusion[label][label] / sum(confusion[label].values()) if sum(confusion[label].values()) else None) for label in labels}
        baseline_accuracy = sum(case["baseline"] == case["expected"] for case in task_cases.values()) / len(task_cases) if task_cases else None
        durations = [float(record["duration_ms"]) for record in good if isinstance(record.get("duration_ms"), (int, float))]
        output["tasks"][task] = {"case_count": len(task_cases), "attempted_count": len(task_records), "answered_count": len(good), "transport_failures": sum(record.get("status") == "transport_error" for record in task_records), "other_failures": sum(record.get("status") == "error" for record in task_records), "accuracy_attempted_failure_is_wrong": accuracy(task_records, task_cases) if task_records else None, "accuracy_answered_only": accuracy(good, task_cases) if good else None, "baseline_accuracy": baseline_accuracy, "confusion_counts": {expected: dict(predicted) for expected, predicted in confusion.items()}, "per_class_recall": recalls, "latency_ms": {"p50": percentile(durations, .50), "p95": percentile(durations, .95), "n": len(durations)}, "actual_usage": [record.get("usage") for record in good if record.get("usage") is not None]}
    write_json(ROOT / "report.json", output)
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def smoke() -> int:
    key = get_api_key()
    if not key:
        raise ValueError("OPENROUTER_API_KEY or term2 settings key is required; no request was sent")
    payload = {"model": MODEL, "state": {"purpose": "neutral transport smoke test; do not infer a production decision"}, "questions": {"smoke": {"type": "choice", "instructions": "Choose the option that best describes whether this neutral request is understandable.", "criteria": {"understood": "The neutral state and question are understandable.", "unknown": "The state is insufficient to understand the question."}}}}
    started_at, started = now(), time.perf_counter()
    http_status, response = post(payload, key)
    write_json(ROOT / "smoke.json", {"live": True, "started_at": started_at, "ended_at": now(), "model": MODEL, "endpoint": ENDPOINT, "http_status": http_status, "payload_sha256": payload_digest(payload), "body": payload, "duration_ms": round((time.perf_counter() - started) * 1000, 3), "real_response": sanitise(response, key), "provider_id": response.get("id") if isinstance(response, dict) else None, "resolved_model": response.get("model") if isinstance(response, dict) else None})
    print("wrote sanitized smoke.json")
    return 0


def selftest() -> int:
    """Protocol checks using explicit fixtures only; this is not provider evidence."""
    import baseline as pilot_baseline
    from build_dataset import build_dataset, build_prompts
    dataset, prompts = build_dataset(), build_prompts()
    errors = validation_errors(dataset, prompts)
    assert not errors, errors
    assert len(dataset) == 20 * 48
    structured_provenance = [dict(case) for case in dataset]
    structured_provenance[0]["provenance"] = {"kind": "mock-fixture", "source": "selftest"}
    assert not validation_errors(structured_provenance, prompts)
    structured_provenance[0]["provenance"] = {}
    assert any("provenance must be a nonempty string or nonempty object" in error for error in validation_errors(structured_provenance, prompts))
    assert parse_answer({"answers": {"case": {"type": "choice", "choice": "A", "confidence": 0.75}}}, {"A": "allowed"})[:2] == ("A", 0.75)
    for bad in ({"answers": {"case": {"type": "choice", "choice": "Z", "confidence": 1}}}, {"answers": {"case": {"type": "choice", "choice": "A", "confidence": float("nan")}}}):
        try:
            parse_answer(bad, {"A": "allowed"})
            raise AssertionError("invalid fixture accepted")
        except ValueError:
            pass
    assert pilot_baseline.choose(dataset[0]) in dataset[0]["criteria"]
    with tempfile.TemporaryDirectory() as temporary:
        temporary_root = pathlib.Path(temporary)
        global ROOT, DATASET, PROMPTS, RESULTS, FREEZE, PHASE_METADATA, STABILITY_PLAN
        previous = (ROOT, DATASET, PROMPTS, RESULTS, FREEZE, PHASE_METADATA, STABILITY_PLAN)
        ROOT, DATASET, PROMPTS, RESULTS, FREEZE, PHASE_METADATA, STABILITY_PLAN = temporary_root, temporary_root / "dataset.json", temporary_root / "prompts.json", temporary_root / "results", temporary_root / "freeze.json", temporary_root / "phase-metadata.json", temporary_root / "stability-plan.json"
        write_json(DATASET, dataset)
        write_json(PROMPTS, prompts)
        write_json(PHASE_METADATA, {"dev": {"prepared_at": now(), "dataset_sha256": file_digest(DATASET), "prompts_sha256": file_digest(PROMPTS), "model": MODEL}})
        initial_manifest = read_json(PHASE_METADATA)
        write_json(PHASE_METADATA, {"dev": {**initial_manifest["dev"], "prompts_sha256": "mismatched-mock-digest"}})
        try:
            run_phase("dev", "D1", "dev", {"D1": list(VARIANTS)})
            raise AssertionError("dev resumed after prompts changed from the pre-request manifest")
        except ValueError as error:
            assert "dataset or prompts digest" in str(error)
        write_json(PHASE_METADATA, initial_manifest)
        cases = {case["id"]: case for case in select_cases(dataset, "D1", "dev")}
        for case in cases.values():
            for variant in VARIANTS:
                append_record("dev", {"live": True, "phase": "dev", "task": "D1", "case_id": case["id"], "variant": variant, "status": "success", "started_at": now(), "dataset_sha256": file_digest(DATASET), "prompts_sha256": file_digest(PROMPTS), "choice": case["expected"] if variant == "scoped" else case["baseline"]})
        body = payload_for(next(iter(cases.values())), prompts["D1"]["scoped"]["instructions"])
        assert set(body) == {"model", "state", "questions"}
        assert payload_digest(body) == hashlib.sha256(wire_bytes(body)).hexdigest()
        write_json(PHASE_METADATA, {"dev": {**initial_manifest["dev"], "prompts_sha256": "mismatched-mock-digest"}})
        try:
            freeze("D1")
            raise AssertionError("freeze accepted a changed prompts digest")
        except ValueError as error:
            assert "dataset or prompts digest" in str(error)
        write_json(PHASE_METADATA, initial_manifest)
        freeze("D1")
        frozen, _ = require_freeze("D1")
        assert frozen["selected_variants"]["D1"] == "scoped"
        write_json(PROMPTS, {**prompts, "D1": {**prompts["D1"], "minimal": {"instructions": "changed"}}})
        try:
            require_freeze("D1")
            raise AssertionError("changed prompts accepted after freeze")
        except ValueError:
            pass
        ROOT, DATASET, PROMPTS, RESULTS, FREEZE, PHASE_METADATA, STABILITY_PLAN = previous
    print("selftest passed: fixtures, 24/24 validation, parser, structured provenance, and dataset/prompts digest guards")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "dev", "freeze", "holdout", "stability", "report", "selftest", "smoke"))
    parser.add_argument("lane", nargs="?", help="absolute lane artifact directory (required except selftest)")
    args = parser.parse_args()
    if args.command == "selftest":
        return selftest()
    if not args.lane:
        raise ValueError("LANE must be the assigned artifact directory")
    lane_root = pathlib.Path(args.lane).resolve()
    if not lane_root.is_dir():
        raise ValueError(f"LANE is not an existing directory: {lane_root}")
    global ROOT, DATASET, PROMPTS, RESULTS, FREEZE, PHASE_METADATA, STABILITY_PLAN
    ROOT, DATASET, PROMPTS, RESULTS, FREEZE, PHASE_METADATA, STABILITY_PLAN = lane_root, lane_root / "dataset.json", lane_root / "prompts.json", lane_root / "results", lane_root / "freeze.json", lane_root / "phase-metadata.json", lane_root / "stability-plan.json"
    if args.command == "validate":
        errors = validation_errors(read_json(DATASET), read_json(PROMPTS))
        if errors:
            print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
            return 1
        print("validation passed")
        return 0
    if args.command == "dev":
        dataset = read_json(DATASET)
        return run_phase("dev", "all", "dev", {task: list(VARIANTS) for task in {case["task"] for case in dataset}})
    if args.command == "freeze":
        return freeze("all")
    if args.command == "holdout":
        frozen, dataset = require_freeze("all")
        variants = {task: [frozen["selected_variants"][task]] for task in {case["task"] for case in dataset if case["task"] in frozen["selected_variants"]}}
        return run_phase("holdout", "all", "holdout", variants, frozen["selected_instructions"])
    if args.command == "stability":
        return stability("all")
    if args.command == "report":
        return report("all")
    return smoke()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, AssertionError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
