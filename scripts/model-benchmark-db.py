#!/usr/bin/env python3
"""Index model-benchmark run artifacts without treating prepared runs as successes."""

import argparse
import json
import sqlite3
from pathlib import Path


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    source_path TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    created_at TEXT,
    comparison_mode TEXT,
    metadata_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    harness TEXT,
    provider TEXT,
    model_id TEXT,
    effort TEXT,
    candidate_spec TEXT,
    run_status TEXT,
    evaluator_status TEXT,
    duration_seconds REAL,
    cost_usd REAL,
    model_calls INTEGER,
    usage_json TEXT,
    cost_source TEXT,
    judge_mean REAL,
    judge_stdev REAL,
    judge_samples INTEGER,
    judge_source TEXT,
    PRIMARY KEY (run_id, name)
);
CREATE INDEX IF NOT EXISTS candidates_model ON candidates(model_id, effort);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
"""


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def read_text(path):
    return path.read_text(encoding="utf-8").strip() if path.is_file() else None


def number(value, kind):
    try:
        return kind(value) if value is not None else None
    except (ValueError, TypeError):
        return None


def ingest_run(db, directory):
    directory = directory.resolve()
    control = directory / "control"
    meta_file = control / "meta.json"
    if not meta_file.is_file():
        return False
    meta = read_json(meta_file)
    if not isinstance(meta.get("candidates"), list) or not meta.get("task_id"):
        raise ValueError(f"Invalid benchmark metadata: {meta_file}")
    db.execute("""INSERT INTO runs(source_path, task_id, created_at, comparison_mode, metadata_json)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(source_path) DO UPDATE SET
        task_id=excluded.task_id, created_at=excluded.created_at,
        comparison_mode=excluded.comparison_mode, metadata_json=excluded.metadata_json""",
        (str(directory), meta["task_id"], meta.get("created_at"), meta.get("comparison_mode"),
         json.dumps(meta, sort_keys=True)))
    run_id = db.execute("SELECT id FROM runs WHERE source_path=?", (str(directory),)).fetchone()[0]
    # Refresh the run as a unit: removed or changed artifacts must not leave stale rows.
    db.execute("DELETE FROM candidates WHERE run_id=?", (run_id,))
    judge = read_json(control / "judge-summary.json").get("candidates", {})
    specs = meta.get("candidate_specs") or {}
    names = set(meta["candidates"])
    # Older manifests sometimes listed only the latest candidate on a resumed run.
    for suffix in ("run.status", "evaluator.status", "cost.json", "seconds"):
        names.update(path.name[: -len(suffix) - 1] for path in control.glob(f"*.{suffix}"))
    for name in sorted(names):
        if not name or "/" in name or name in (".", ".."):
            raise ValueError(f"Invalid candidate name in {meta_file}: {name!r}")
        spec = specs.get(name) or {}
        cost = read_json(control / f"{name}.cost.json")
        score = judge.get(name) or {}
        db.execute("""INSERT INTO candidates (
            run_id, name, harness, provider, model_id, effort, candidate_spec,
            run_status, evaluator_status, duration_seconds, cost_usd, model_calls,
            usage_json, cost_source, judge_mean, judge_stdev, judge_samples, judge_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
            run_id, name, spec.get("harness") or cost.get("harness"), spec.get("provider"),
            spec.get("model_id") or cost.get("model_id"), spec.get("effort") or cost.get("effort"),
            spec.get("spec"), read_text(control / f"{name}.run.status"),
            read_text(control / f"{name}.evaluator.status"),
            number(read_text(control / f"{name}.seconds"), float), number(cost.get("usd"), float),
            number(cost.get("model_calls"), int),
            json.dumps(cost["usage"], sort_keys=True) if isinstance(cost.get("usage"), dict) else None,
            cost.get("source"), number(score.get("total_mean"), float),
            number(score.get("total_stdev"), float), number(score.get("samples"), int),
            score.get("score_source")))
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path(__file__).resolve().parent.parent / "eval/model-benchmark/results.sqlite")
    sub = parser.add_subparsers(dest="command", required=True)
    ingest = sub.add_parser("ingest", help="Upsert benchmark runs from a root or explicit run directory")
    ingest.add_argument("path", type=Path, help="Runtime root or benchmark run directory")
    sub.add_parser("summary", help="Show indexed coverage and candidate results")
    args = parser.parse_args()
    if args.command == "summary" and not args.db.is_file():
        parser.error(f"Database not found: {args.db}; run ingest first")
    if args.command == "ingest":
        args.db.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(args.db) as db:
        db.execute("PRAGMA foreign_keys=ON")
        if args.command == "ingest":
            db.executescript(SCHEMA)
            root = args.path.expanduser().resolve()
            if not root.is_dir():
                parser.error(f"Directory not found: {root}")
            dirs = [root] if (root / "control/meta.json").is_file() else sorted(root.glob("bench-*"))
            with db:
                count = sum(ingest_run(db, directory) for directory in dirs)
            print(f"Indexed {count} runs in {args.db}")
        else:
            runs = db.execute("SELECT count(*) FROM runs").fetchone()[0]
            total, evaluated, judged = db.execute("""SELECT count(*),
                count(evaluator_status), count(judge_mean) FROM candidates""").fetchone()
            print(f"{runs} runs, {total} candidates, {evaluated} evaluated, {judged} judged")
            for row in db.execute("""SELECT r.task_id, c.name, c.model_id, c.effort,
                c.run_status, c.evaluator_status, c.judge_mean FROM candidates c
                JOIN runs r ON r.id=c.run_id ORDER BY r.created_at, r.id, c.name"""):
                print("\t".join("-" if value is None else str(value) for value in row))


if __name__ == "__main__":
    main()
