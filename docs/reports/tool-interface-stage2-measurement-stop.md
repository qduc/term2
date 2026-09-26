> Copied to main on 2026-09-26 from branch `tool-interface-stage2-bench` (commit `5e7204b3`, file `scripts/experiments/tool-interface-stage2/calibration/measurement-stop-decision.md`) when its worktree was retired. The branch is kept and also holds `ack-pilot-adjudication.md`. Raw `.bench-runs/` are archived in `~/archives/term2-worktree-artifacts-2026-09-26.tar.gz`.

# Stage2 measurement stop decision (negative gate)

Documentary closure only. **Not** a production merge decision. **Not** an efficacy or efficiency result. Classifier, prompt, driver, and tasks remain frozen.

## Parent ruling (settled)

Apply the preexisting Stop rule to **any valid measurement**, including the ACK pilots.

> Correctness first. A candidate that reduces task correctness on any pinned model is rejected without efficiency analysis.

DeepSeek ACK candidate is incorrect (`true/not_active` vs oracle `false/not_active`) while baseline is correct. **Candidate `2763e9c9` is rejected for measurement purposes.** Required live gate is **not** passed.

Consequences (do not reopen):

- **No 72-cell matrix**
- **No more paid pilots** (neither `--only` nor bare `--go`)
- **No efficacy / efficiency analysis**
- **No tuning** (prompt, classifier, stop-rule exemptions)
- **No automatic merge or Stage3 advancement**
- Production-code acceptance remains **separate** from this measurement gate

n=1 cannot establish treatment causality or its absence. The DeepSeek candidate script ignored a resolved `ok: false` via `.then(() => "true")`; the same script would also ignore a baseline string resolution. Do **not** claim a causal regression, and do **not** claim the miss is definitively not attributable to treatment.

## Pilots (valid measurements; excluded from matrix)

Memory pilots remain calibration (`calibration/memory-pilot-adjudication.md`). ACK pilots: `calibration/ack-pilot-adjudication.md`.

| pilot | report SHA256 | outcome |
| --- | --- | --- |
| `.bench-runs/stage2-luna-ack-20260908-1155` | `98009b77e71dab560e1e2faa1aacc58453981a006a8d08462b3ba32ad673ebf4` | both arms correct |
| `.bench-runs/stage2-glm-ack-20260908-1156` | `11410fcc921cb68a06a09105e6d9ddd979739aab05f180987f220adacd7b7b25` | both arms correct |
| `.bench-runs/stage2-deepseek-ack-20260908-1200` | `cd29e20bfc68b77aeef988857876d0b82fe995575e38b0cc628498d837a4761f` | baseline correct; candidate incorrect; `correctnessRegressions: ["deepseek"]`; `rejectEfficiencyClaims: true` |

Raw reports and cell `result.json` files are **untouched**.

## Operator rule (C1 documentary close)

`matrixHeld` remains **true** and is **documentary, not executable**. Preflight/driver are not changed. **Hard operator rule at this stopped pin:** no paid launches — not `run --go`, not `--only`. This is the allowed documented-rule alternative to a classifier/driver gate. Do **not** claim executable enforcement.

Historical `pendingFinalReview: false` and historical `approve-ack-pilots-only` metadata are retained; they do not authorise further paid cells after this stop.

## Remaining gates (held)

- 72-cell matrix: **stopped**
- Analysis-sheet / matrix coding kit: **not required**; matrix will not run
- Stage2 efficacy or comparative report: **barred**
- Stage3 / roadmap success from this measurement: **barred**
- C1 executable enforcement: **not implemented**; operator rule only
- Carried: F3 dump regex, m-3, M-1, M-2, L1/L2/L4 classifier limits, frozen classifier `307dec88`

## Limitations

- Three ACK pairs, one trial each. Nothing here supports or refutes the treatment.
- Frozen ACK labels are all `treated-path` because both required tools were called; they carry no handling contrast.
- Wrapper-passthrough coding is a human convention, not a classifier revision.
