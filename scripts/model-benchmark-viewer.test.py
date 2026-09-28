"""Browser viewer contract: local-only, read-only, and faithful to missing data."""

import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


spec = importlib.util.spec_from_file_location("benchmark_viewer", Path(__file__).with_name("model-benchmark-viewer.py"))
viewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(viewer)


class ViewerTest(unittest.TestCase):
    def test_results_and_page_are_read_only_and_missing_values_stay_null(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "results.sqlite"
            with sqlite3.connect(db_path) as db:
                db.executescript("""CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id TEXT,
                    created_at TEXT, comparison_mode TEXT, source_path TEXT);
                    CREATE TABLE candidates (run_id INTEGER, name TEXT, harness TEXT,
                    provider TEXT, model_id TEXT, effort TEXT, run_status TEXT,
                    evaluator_status TEXT, duration_seconds REAL, cost_usd REAL,
                    model_calls INTEGER, usage_json TEXT, cost_source TEXT,
                    judge_mean REAL, judge_stdev REAL, judge_samples INTEGER,
                    judge_source TEXT);""")
                db.execute("INSERT INTO runs VALUES (1, 'task', '2026-01-01', 'mixed', '/private/path')")
                db.execute("INSERT INTO candidates(run_id, name, model_id, run_status) VALUES (1, 'a', 'model', 'TIMEOUT')")
            server = ThreadingHTTPServer(("127.0.0.1", 0), viewer.handler_for(db_path))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"
            try:
                with urlopen(base + "/api/results") as response:
                    rows = json.load(response)
                    self.assertEqual(response.headers["Content-Type"], "application/json; charset=utf-8")
                self.assertEqual(len(rows), 1)
                self.assertEqual(rows[0]["run_status"], "TIMEOUT")
                self.assertIsNone(rows[0]["evaluator_status"])
                self.assertNotIn("source_path", rows[0])
                with urlopen(base + "/") as response:
                    page = response.read().decode()
                    self.assertIn("Model benchmark", page)
                    self.assertEqual(response.headers["Content-Security-Policy"], viewer.CSP)
                for path in ("/api/unknown", "/../results.sqlite"):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(base + path)
                    self.assertEqual(error.exception.code, 404)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + "/api/results", data=b"{}", method="POST"))
                self.assertEqual(error.exception.code, 405)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
