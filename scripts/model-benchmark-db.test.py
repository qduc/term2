"""Tests for indexing partial and completed model benchmark runs."""

import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("model_benchmark_db", Path(__file__).with_name("model-benchmark-db.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BenchmarkDatabaseTest(unittest.TestCase):
    def test_partial_run_incremental_refresh_and_judge(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "bench-task-1"
            control = run / "control"
            control.mkdir(parents=True)
            (control / "meta.json").write_text(json.dumps({
                "task_id": "task", "candidates": ["alpha", "beta"],
                "candidate_specs": {"alpha": {"model_id": "model", "effort": "low"}}
            }))
            (control / "alpha.run.status").write_text("TIMEOUT\n")
            with sqlite3.connect(":memory:") as db:
                db.execute("PRAGMA foreign_keys=ON")
                db.executescript(module.SCHEMA)
                self.assertTrue(module.ingest_run(db, run))
                rows = db.execute("SELECT name, evaluator_status FROM candidates ORDER BY name").fetchall()
                self.assertEqual(rows, [("alpha", None), ("beta", None)])
                (control / "alpha.evaluator.status").write_text("PASS\n")
                (control / "alpha.cost.json").write_text(json.dumps({
                    "usd": 0.12, "model_calls": 3, "usage": {"input": 10}, "source": "logs"
                }))
                (control / "judge-summary.json").write_text(json.dumps({
                    "candidates": {"alpha": {"total_mean": 8.5, "samples": 2, "score_source": "judge"}}
                }))
                module.ingest_run(db, run)
                self.assertEqual(db.execute("SELECT count(*) FROM runs").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT count(*) FROM candidates").fetchone()[0], 2)
                result = db.execute("""SELECT model_id, effort, run_status, evaluator_status,
                    cost_usd, model_calls, usage_json, judge_mean, judge_samples
                    FROM candidates WHERE name='alpha'""").fetchone()
                self.assertEqual(result, ("model", "low", "TIMEOUT", "PASS", 0.12, 3,
                                          '{"input": 10}', 8.5, 2))
                (control / "alpha.evaluator.status").unlink()
                module.ingest_run(db, run)
                self.assertIsNone(db.execute("SELECT evaluator_status FROM candidates WHERE name='alpha'").fetchone()[0])

    def test_legacy_resumed_candidate_from_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp)
            control = run / "control"
            control.mkdir()
            (control / "meta.json").write_text(json.dumps({
                "task_id": "task", "candidates": ["new"],
                "candidate_specs": {"old": {"model_id": "legacy"}}
            }))
            (control / "old.evaluator.status").write_text("FAIL")
            with sqlite3.connect(":memory:") as db:
                db.executescript(module.SCHEMA)
                module.ingest_run(db, run)
                self.assertEqual(db.execute("SELECT name, model_id FROM candidates ORDER BY name").fetchall(),
                                 [("new", None), ("old", "legacy")])


if __name__ == "__main__":
    unittest.main()
