#!/usr/bin/env python3
"""Deterministic, offline verification for the approval replay harness."""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile


ROOT = pathlib.Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "reconstruction.jsonl"


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    runner = load("runner")
    analyze = load("analyze")
    rows = runner.read_jsonl(FIXTURE)
    cohort = runner.select_cohort(rows)
    assert [row["case_id"] for row in cohort] == ["case-001"]

    cells = runner.materialize_cells(cohort[0])
    assert [cell["cell"] for cell in cells] == list(runner.CELLS)
    direct = cells[0]["payload"]
    full_direct = cells[1]["payload"]
    compact_reviewer = cells[2]["payload"]
    full_reviewer = cells[3]["payload"]
    assert direct["state"]["evidence"]["recentContext"] != full_direct["state"]["evidence"]["recentContext"]
    assert direct["questions"]["authorization"]["criteria"] == full_direct["questions"]["authorization"]["criteria"]
    assert direct["state"] == compact_reviewer["state"]
    assert direct["questions"]["authorization"]["criteria"] != compact_reviewer["questions"]["authorization"]["criteria"]
    assert full_direct["state"]["evidence"]["recentContext"] == full_reviewer["state"]["evidence"]["recentContext"]
    assert direct["state"]["evidence"]["requests"] == [rows[0]["command_request"]]

    with tempfile.TemporaryDirectory() as temporary:
        results = pathlib.Path(temporary) / "results.jsonl"
        dry = subprocess.run(
            [sys.executable, str(ROOT / "runner.py"), "--input", str(FIXTURE), "--results", str(results), "--dry-run"],
            check=True,
            capture_output=True,
            text=True,
        )
        assert "dry-run: 4 call(s); no provider request sent" in dry.stdout
        assert not results.exists()
        runner.append_record(results, {"case_id": "case-001", "cell": "compact_direct", "status": "transport_error"})
        pending = runner.pending_cells(cells, runner.read_jsonl(results))
        assert [cell["cell"] for cell in pending] == ["full_direct", "compact_reviewer", "full_reviewer"]
        runner.append_record(results, {"case_id": "case-001", "cell": "full_direct", "status": "success"})
        assert len(runner.read_jsonl(results)) == 2

    records = [
        {"case_id": "one", "cell": "compact_direct", "status": "success", "authorization": "weak", "would_approve": False},
        {"case_id": "one", "cell": "full_direct", "status": "success", "authorization": "implied", "would_approve": True},
        {"case_id": "one", "cell": "compact_reviewer", "status": "success", "authorization": "implied", "would_approve": True},
        {"case_id": "one", "cell": "full_reviewer", "status": "success", "authorization": "implied", "would_approve": True},
        {"case_id": "two", "cell": "compact_direct", "status": "success", "authorization": "weak", "would_approve": False},
        {"case_id": "two", "cell": "full_direct", "status": "success", "authorization": "weak", "would_approve": False},
        {"case_id": "two", "cell": "compact_reviewer", "status": "success", "authorization": "implied", "would_approve": True},
        {"case_id": "two", "cell": "full_reviewer", "status": "success", "authorization": "implied", "would_approve": True},
    ]
    paired = analyze.paired(records)
    assert paired["denominator"] == 2
    assert paired["authorization_eligible"]["context_only"]["estimate"] == 0.5
    assert paired["authorization_eligible"]["rubric_only"]["estimate"] == 1.0
    assert paired["final_approval"]["interaction"]["estimate"] == -0.5
    print("verify: PASS (cell isolation, append-only/idempotent behavior, no-call dry run, paired calculations)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
