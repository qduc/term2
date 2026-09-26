#!/usr/bin/env python3
"""Run the preregistered scoped-only Jev challenge set after coordinator admission.

This module imports the verified runner's transport and record construction
unchanged.  It deliberately has its own narrow validator because this is an
80-case challenge holdout (four cases for each of twenty tasks), not a dev/
holdout lane eligible for prompt selection.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import tempfile
from collections import Counter
from typing import Any, Callable

import runner as verified_runner

INFRA_ROOT = pathlib.Path(__file__).resolve().parent
DEFAULT_CHALLENGE_ROOT = INFRA_ROOT.parent / "challenge"
TASKS = tuple([f"D{number}" for number in range(1, 7)] + [f"R{number}" for number in range(1, 7)] + [f"E{number}" for number in range(1, 9)])
VARIANTS = ("minimal", "rubric", "scoped")
PHASE = "challenge"
MANIFEST_NAME = "challenge-manifest.json"
RESULT_NAME = "challenge.jsonl"
MAX_CONCURRENCY = 4


def paths(root: pathlib.Path) -> tuple[pathlib.Path, pathlib.Path, pathlib.Path, pathlib.Path]:
    return root / "dataset.json", root / "prompts.json", root / MANIFEST_NAME, root / "results" / RESULT_NAME


def wire_digest(value: Any) -> str:
    return hashlib.sha256(verified_runner.wire_bytes(value)).hexdigest()


def validation_errors(dataset: Any, prompts: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(dataset, list):
        return ["challenge dataset must be a JSON array"]
    if not isinstance(prompts, dict):
        return ["challenge prompts must be a JSON object"]
    ids: set[str] = set()
    counts: Counter[str] = Counter()
    for index, case in enumerate(dataset):
        prefix = f"case[{index}]"
        if not isinstance(case, dict):
            errors.append(f"{prefix} must be an object")
            continue
        required = {"id", "task", "split", "state", "criteria", "expected", "rationale", "provenance", "tags", "baseline"}
        if missing := required - set(case):
            errors.append(f"{prefix} missing {sorted(missing)}")
            continue
        case_id, task = case["id"], case["task"]
        if not isinstance(case_id, str) or not case_id:
            errors.append(f"{prefix}.id must be a nonempty string")
        elif case_id in ids:
            errors.append(f"duplicate challenge id {case_id}")
        else:
            ids.add(case_id)
        if task not in TASKS:
            errors.append(f"{prefix}.task must be one of the 20 preregistered task IDs")
        else:
            counts[task] += 1
        if case["split"] != "holdout":
            errors.append(f"{prefix}.split must be holdout")
        if not isinstance(case["state"], dict):
            errors.append(f"{prefix}.state must be an object")
        criteria = case["criteria"]
        if not isinstance(criteria, dict) or not criteria or not all(isinstance(label, str) and label and isinstance(description, str) and description.strip() for label, description in criteria.items()):
            errors.append(f"{prefix}.criteria must map nonempty labels to descriptions")
        elif case["expected"] not in criteria or case["baseline"] not in criteria:
            errors.append(f"{prefix}.expected and .baseline must be allowed choices")
        if not all(isinstance(case[key], str) and case[key].strip() for key in ("expected", "rationale", "baseline")):
            errors.append(f"{prefix} has invalid expected, rationale, or baseline")
        if not verified_runner.valid_provenance(case["provenance"]):
            errors.append(f"{prefix}.provenance must be a nonempty string or nonempty object")
        if not isinstance(case["tags"], list) or not all(isinstance(tag, str) and tag for tag in case["tags"]):
            errors.append(f"{prefix}.tags must be a string array")
        elif "independent_challenge" not in case["tags"]:
            errors.append(f"{prefix}.tags must contain independent_challenge")
    if len(dataset) != 80:
        errors.append(f"challenge needs exactly 80 cases, got {len(dataset)}")
    for task in TASKS:
        if counts[task] != 4:
            errors.append(f"{task} needs exactly four challenge holdout cases, got {counts[task]}")
    if set(prompts) != set(TASKS):
        errors.append("challenge prompts must contain exactly the 20 preregistered task IDs")
    for task in TASKS:
        variants = prompts.get(task)
        if not isinstance(variants, dict):
            continue
        for variant in VARIANTS:
            entry = variants.get(variant)
            if not isinstance(entry, dict) or not isinstance(entry.get("instructions"), str) or not entry["instructions"].strip():
                errors.append(f"prompts.{task}.{variant}.instructions must be a nonempty string")
    return errors


def load_validated(root: pathlib.Path) -> tuple[list[dict[str, Any]], dict[str, Any], str, str]:
    dataset_path, prompts_path, _, _ = paths(root)
    dataset, prompts = verified_runner.read_json(dataset_path), verified_runner.read_json(prompts_path)
    errors = validation_errors(dataset, prompts)
    if errors:
        raise ValueError("challenge validation failed:\n- " + "\n- ".join(errors))
    return dataset, prompts, verified_runner.file_digest(dataset_path), verified_runner.file_digest(prompts_path)


def expected_manifest(root: pathlib.Path, dataset_sha256: str, prompts_sha256: str) -> dict[str, Any]:
    return {
        "run_id": "jev-fit-20260919",
        "task_id": "C",
        "phase": PHASE,
        "model": verified_runner.MODEL,
        "variant": "scoped",
        "case_count": 80,
        "dataset_sha256": dataset_sha256,
        "prompts_sha256": prompts_sha256,
        "challenge_runner_sha256": verified_runner.file_digest(pathlib.Path(__file__)),
        "verified_runner_sha256": verified_runner.file_digest(INFRA_ROOT / "runner.py"),
    }


def prepare(root: pathlib.Path) -> int:
    """Validate and atomically preregister frozen inputs; this performs no API work."""
    _dataset, _prompts, dataset_sha256, prompts_sha256 = load_validated(root)
    _dataset_path, _prompts_path, manifest_path, _result_path = paths(root)
    manifest = expected_manifest(root, dataset_sha256, prompts_sha256)
    if manifest_path.exists():
        existing = verified_runner.read_json(manifest_path)
        if existing != manifest:
            raise ValueError("challenge prepare refused: immutable manifest differs from current inputs or executable")
        print("challenge manifest already prepared and unchanged; no API call made")
        return 0
    verified_runner.write_json(manifest_path, manifest)
    print(f"prepared immutable challenge manifest at {manifest_path}; no API call made")
    return 0


def read_records(result_path: pathlib.Path) -> list[dict[str, Any]]:
    if not result_path.exists():
        return []
    return [json.loads(line) for line in result_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def append_record(result_path: pathlib.Path, record: dict[str, Any]) -> None:
    result_path.parent.mkdir(exist_ok=True)
    with result_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, separators=(",", ":"), ensure_ascii=True) + "\n")


def run(root: pathlib.Path, evaluate: Callable[..., dict[str, Any]] = verified_runner.evaluate, api_key: str | None = None) -> int:
    dataset, prompts, dataset_sha256, prompts_sha256 = load_validated(root)
    _dataset_path, _prompts_path, manifest_path, result_path = paths(root)
    if not manifest_path.exists():
        raise ValueError("challenge run refused: execute prepare before any API call")
    if verified_runner.read_json(manifest_path) != expected_manifest(root, dataset_sha256, prompts_sha256):
        raise ValueError("challenge run refused: inputs or executable differ from the immutable pre-request manifest")
    key = api_key if api_key is not None else verified_runner.get_api_key()
    if not key:
        raise ValueError("OPENROUTER_API_KEY or term2 agent.openrouter.apiKey is required; no request was sent")
    existing = {(record.get("phase"), record.get("case_id"), record.get("variant")) for record in read_records(result_path)}
    jobs = [case for case in dataset if (PHASE, case["id"], "scoped") not in existing]
    if not jobs:
        print("no new challenge calls: append-only records cover all cases")
        return 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY) as pool:
        futures = [pool.submit(evaluate, PHASE, case, "scoped", prompts[case["task"]]["scoped"]["instructions"], key, dataset_sha256, prompts_sha256) for case in jobs]
        for future in concurrent.futures.as_completed(futures):
            append_record(result_path, future.result())
    print(f"wrote {len(jobs)} append-only challenge record(s)")
    return 0


def mock_fixture() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    dataset: list[dict[str, Any]] = []
    prompts: dict[str, Any] = {}
    for task in TASKS:
        prompts[task] = {variant: {"instructions": f"Mock {variant} instructions for {task}."} for variant in VARIANTS}
        for number in range(4):
            labels = {"A": "A is directly supported.", "UNKNOWN": "Evidence is insufficient or hostile."}
            dataset.append({"id": f"mock-{task}-{number}", "task": task, "split": "holdout", "state": {"fixture": f"{task}-{number}", "evidence": "mock only"}, "criteria": labels, "expected": "A" if number % 2 == 0 else "UNKNOWN", "rationale": "mock frozen rationale", "provenance": {"source": "mock selftest"}, "tags": ["independent_challenge", "mock"], "baseline": "A"})
    return dataset, prompts


def selftest() -> int:
    """Mock-only contract coverage. It never reads challenge data or uses a credential."""
    dataset, prompts = mock_fixture()
    assert not validation_errors(dataset, prompts)
    assert len(dataset) == 80 and len({case["id"] for case in dataset}) == 80
    broken = [dict(case) for case in dataset]
    broken[0]["split"] = "dev"
    assert any("split must be holdout" in error for error in validation_errors(broken, prompts))
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        dataset_path, prompts_path, _manifest_path, result_path = paths(root)
        verified_runner.write_json(dataset_path, dataset)
        verified_runner.write_json(prompts_path, prompts)
        assert prepare(root) == 0
        assert prepare(root) == 0
        def fake_evaluate(phase: str, case: dict[str, Any], variant: str, instructions: str, _key: str, dataset_hash: str, prompts_hash: str) -> dict[str, Any]:
            body = verified_runner.payload_for(case, instructions)
            return {"record_id": f"mock-{case['id']}", "live": False, "phase": phase, "task": case["task"], "case_id": case["id"], "variant": variant, "started_at": "mock", "model": verified_runner.MODEL, "endpoint": verified_runner.ENDPOINT, "dataset_sha256": dataset_hash, "prompts_sha256": prompts_hash, "body": body, "payload_sha256": verified_runner.payload_digest(body), "http_status": 200, "raw_response": {"answers": {"case": {"type": "choice", "choice": case["expected"], "confidence": 1.0}}}, "status": "success", "choice": case["expected"], "confidence": 1.0, "raw_choice": {"type": "choice", "choice": case["expected"], "confidence": 1.0}, "duration_ms": 1.0, "ended_at": "mock"}
        assert run(root, evaluate=fake_evaluate, api_key="mock-key") == 0
        records = read_records(result_path)
        assert len(records) == 80 and all(record["variant"] == "scoped" and record["phase"] == PHASE for record in records)
        assert run(root, evaluate=fake_evaluate, api_key="mock-key") == 0
    print("challenge selftest passed: 80-case validation, immutable manifest, scoped-only append-only mock run")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "run", "selftest"))
    parser.add_argument("challenge_root", nargs="?", default=str(DEFAULT_CHALLENGE_ROOT), help="challenge artifact directory")
    args = parser.parse_args()
    if args.command == "selftest":
        return selftest()
    root = pathlib.Path(args.challenge_root).resolve()
    if not root.is_dir():
        raise ValueError(f"challenge root is not an existing directory: {root}")
    return prepare(root) if args.command == "prepare" else run(root)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, AssertionError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}")
        raise SystemExit(1)
