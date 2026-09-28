# Model benchmark results index

`results.sqlite` is a committed snapshot of the local `model-benchmark` skill's
saved runs. To refresh it after a new run or a late evaluator/judge result:

```bash
python3 scripts/model-benchmark-db.py ingest "$BENCH_DIR"
python3 scripts/model-benchmark-db.py summary
```

To backfill saved runs: `python3 scripts/model-benchmark-db.py ingest ~/.agents/runtime`.
The importer reads `bench-*/control/meta.json` plus per-candidate status,
duration, cost, and `judge-summary.json` files. It is repeatable and leaves
unavailable fields NULL. `runs.source_path` identifies the original local run;
it may not exist on another machine. `runs.metadata_json` preserves the
original candidate specifications for audit. `candidates` is keyed by run and
candidate name; query `runs` with `candidates` to compare task and model.

The initial snapshot indexes 24 prepared runs and 61 candidates from the
surviving runtime directory; 49 have evaluator status and 6 have in-run judge
scores. Some judge results exist only in pooled runs or prose and are not
indexed. This is **not** a raw-artifact archive: preserve candidate diffs,
transcripts, and evaluator logs separately before cleaning `.agents/runtime`.
Do not equate absent evaluator status with failure, or compare judge scores
from different rubrics/cohorts without checking their provenance.
