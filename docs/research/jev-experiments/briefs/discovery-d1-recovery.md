# D1 bounded recovery assignment

You are the GLM discovery worker. The coordinator verified your Z.ai route; do not inspect authentication, processes, or model catalogs. Previous session was stopped after a long reasoning pass without a dataset. Work incrementally: write artifacts rather than planning all tasks.

Own only `/home/qduc/term2/docs/research/jev-experiments/discovery/`. Read `briefs/discovery.md` for the case contract, but override its scope: **D1 skill selection only**, 24 development and 24 distinct holdout cases. Grok now owns D2-D6 elsewhere. No nested agents. No production edits or API calls.

Write `dataset.json`, `prompts.json` (D1 minimal/rubric/scoped), `baseline.py`, `design.md`, and receipt with exact dataset SHA256. Use realistic differing user requests and candidate skill catalogs, with close alternatives, explicit none, insufficient evidence, and embedded-instruction counterexamples. No repeated four-template cycles. Freeze expected answers before any model scoring. Baseline must read only task/state/criteria, never the expected label or rationale. State should contain the actual request and candidate evidence, not preclassified applicability flags.

The common runner is ready: `python3 docs/research/jev-experiments/infra/runner.py validate docs/research/jev-experiments/discovery`. End the turn when those 48 cases validate. The coordinator will conduct live inference. Keep reasoning short and write the first artifact now.
