#!/usr/bin/env python3
"""Serve the benchmark index read-only; LAN binding requires explicit opt-in."""

import argparse
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"
HTML = Path(__file__).resolve().parent.parent / "eval/model-benchmark/viewer.html"
DEFAULT_DB = Path(__file__).resolve().parent.parent / "eval/model-benchmark/results.sqlite"


def results(path):
    # Open read-only, including on machines where the tracked database is not writable.
    with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(row) for row in db.execute("""SELECT r.id AS run_id, r.task_id,
            r.created_at, r.comparison_mode, c.name, c.harness, c.provider,
            c.model_id, c.effort, c.run_status, c.evaluator_status,
            c.duration_seconds, c.cost_usd, c.model_calls, c.usage_json,
            c.cost_source, c.judge_mean, c.judge_stdev, c.judge_samples,
            c.judge_source FROM candidates c JOIN runs r ON r.id=c.run_id
            ORDER BY r.created_at DESC, r.id DESC, c.name""")]


def handler_for(db_path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/":
                body = HTML.read_bytes()
                content_type = "text/html; charset=utf-8"
            elif self.path == "/api/results":
                body = json.dumps(results(db_path), ensure_ascii=True).encode("utf-8")
                content_type = "application/json; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", CSP)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.send_error(405)

    return Handler


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1", help="IPv4 bind address (0.0.0.0 for LAN access)")
    return parser.parse_args(argv)


def main():
    args = parse_args()
    if not args.db.is_file():
        raise SystemExit(f"Database not found: {args.db}")
    # Fail before serving if this is not a readable benchmark database.
    results(args.db)
    with ThreadingHTTPServer((args.host, args.port), handler_for(args.db)) as server:
        address = "<this-computer's-LAN-IP>" if args.host == "0.0.0.0" else args.host
        print(f"Model benchmark viewer: http://{address}:{server.server_port}/", flush=True)
        if args.host not in ("127.0.0.1", "localhost"):
            print("LAN access enabled: no authentication or TLS; use only on a trusted network.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
