# Discovery-extra V2 blind-label uncertainties

These notes were written from `blind-discovery-extra-v2.json` and its manifest before reading the discovery-extra dataset, prior labels, results, or reports. They record uncertainty at label time; they are not post-hoc gold-label changes.

## Material uncertainties

- `jev-fit-20260919-DX-D3-holdout-17` — chose `mem_guard_last`. It directly answers the general “when can a label block or discard work?” question by requiring guard design and asymmetric-error evidence. `mem_stall` is also strongly relevant and is more specific to run-budget evidence, so top-1 depends on whether the query seeks the general authorization rule or the current stall mechanism.
- `jev-fit-20260919-DX-D4-holdout-23` — chose `sess_languages`. It directly says TypeScript-specific outline logic is in `languages/typescript.ts`. `sess_ts_language` names the fuller path and registry and is nearly equivalent; this is a duplicate-answer/top-1 ambiguity rather than a relevance disagreement.
- `jev-fit-20260919-DX-D4-holdout-12` — chose `sess_grep_include`. It directly explains that `include` filters by `*.ts`. `sess_grep_fixed` also states that `include` can limit to `*.ts`, but mixes in the unrelated `fixed_strings` fact.
- `jev-fit-20260919-DX-D6-holdout-15` — chose `sec_preview` because it records the actual truncated output and absence of a saved full-output path. `sec_trim_set` better explains the configuration that caused subsequent truncation, so the top choice depends on whether “retain evidence” prioritizes the observed symptom or its configuration cause.

## Minor uncertainty

- `jev-fit-20260919-DX-D6-holdout-21` — chose `sec_monitor_cancel` because it records both the ineffective monitor cancellation and the required job-cancellation action. `sec_heartbeat` also correctly states that cancelling a monitor does not kill the job, but reads as supporting context rather than the primary diagnostic.

All other selections were high-confidence direct matches or clear `none` cases from the supplied state and criteria.
