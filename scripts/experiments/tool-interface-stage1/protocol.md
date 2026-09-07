# Stage 1 protocol (tool-interface-bench)

Read this before launching cells. Compact **source** is approved (`2890f0b9`). Compact-bench amendment `9aa4e9a8` is **launch-cleared** (`pendingFinalReview: false`; Claude compact-launch review, 0 blockers). This worker does not launch. Parent sequence: rebuild → preflight → fresh bounded live pairs on all 3 models → 72-cell matrix **only if** raw-parity, identity, and effort gates pass. Scorer remains `3485623f`. Historical full-candidate 72-cell run is in `results-20260907.md` and is **not accepted**.

## Pins

- Baseline: `76e51d2497a2009f6011c15b694e201a08e9de79` (unchanged)
- **Compact candidate (current pin):** `2890f0b9a78fa3af611d32472c6f400123485c92` at `/home/qduc/term2/.worktrees/tool-interface-stage1-compact` — source-approved; launch-cleared pending parent rebuild/preflight/bounded pairs
- **Historical full candidate (preserved, not the pin):** `80f7488401c1043445cf3974f163633693c8c20f` at `/home/qduc/term2/.worktrees/tool-interface-stage1` — 72-cell run valid, treatment not accepted
- Not a pin: `67560fa9` (BLOCKED on F1/F2/F3; superseded)
- Models: luna `gpt-5.6-luna#medium` (codex), glm `glm-5.3-flash#medium` (zai), deepseek `deepseek-v4-flash#medium` (DeepSeek)
- Seed: 7. Trials: 3. Serial. **15 min/cell** (`timeoutMs: 900000`). **72 cells** (2 treated + 2 untreated × 3 models × 2 arms × 3 trials). Controls stay. Do not reduce the matrix.
- Compact combined treatment: catalog-wide input signatures; purpose/returns on `tools.describe`. No isolated-catalog causality. Compact-vs-full is **indicative, not paired**.

## F3 / measurement surface (binding)

The candidate's `+8,471 B` figure is an **exploratory interactive fixture with a replica baseline**, not acceptance evidence. It measures `appRegistries()` (session browser, ask-user, background shell, `enable_agent_workflow`) via a hand-authored replica of `renderToolsHeader`, does not assert the byte delta, and is not the benchmark registry.

This driver owns reproducible measurement:

- **Construction snapshot** (preflight / B1): factory-bound `buildAgentTools` + `bindRunCodeRegistry` on the **non-interactive CLI** surface. Session tools are absent. Label: `non-interactive-factory-bind`. Preflight snapshots **every pinned model**; pair name-set equality is within-model (luna 18 names including `apply_patch` + `configure_task_check_in`; glm/deepseek 21 names including grep/glob/create_file/search_replace + `configure_task_check_in`).
- **Trial measurement** (B4): `provider-traffic-raw` sidecar only. Construction snapshots never substitute for trial bytes.
- Interactive production is an **upper bound** this driver does not claim. Report the non-interactive figure as a lower bound on interactive.

**Compact construction** (factory-bound non-interactive snapshot-header vs baseline `dist` and compact `2890f0b9` `dist`; name and static-prose parity):

| model | baseline B | compact B | delta B | names |
| --- | ---: | ---: | ---: | ---: |
| luna | 1454 | 2291 | +837 | 18 match |
| glm | 2651 | 3488 | +837 | 21 match |
| deepseek | 2651 | 3488 | +837 | 21 match |

**Historical full construction** (same baseline vs `80f74884`; not this run's pin): luna 6821 B / glm+ds 8018 B, +5367 B, same name counts. Compact vs full is **−4530 B** on the construction snapshot and is **not** a paired cell comparison.

Includes `configure_task_check_in`. **Not** the F3 replica +8471. Trial prompt tokens remain the live primary cost metric. Equal-turn prompt excess estimates per-request overhead with residual script/history variation; do not treat it as an exact causal header tax.

## Hard gates (B1–B9)

| ID | Gate | Enforcement |
| --- | --- | --- |
| B1 | Factory-bound header, not unbound `getAgentDefinition` | `snapshot-header.mjs` calls `buildAgentTools`. Empty/stub (`<8` names) fails preflight. Compact construction: luna 18 names / 1454→2291 B; glm/ds 21 names / 2651→3488 B. Historical full: 1454→6821 / 2651→8018. Interactive extras = session_list/search/read. |
| B2 | Baseline pin by `source/` tree, not HEAD identity | `git diff --quiet <pin> HEAD -- source/` plus dirty `source/` checks. |
| B3 | Candidate HEAD == `candidateCommitFinal` and clean | Compact `2890f0b9`. `pendingFinalReview: false` after compact-launch review of `9aa4e9a8`. |
| B4 | Trial headers from raw sidecars only | `scorePair` requires `source === 'provider-traffic-raw'`. Well-formed construction headers are `raw-header-missing`. |
| B5 | Ephemeral `XDG_STATE_HOME` | Per-cell `mkdtemp` auth dir, chmod 700, harvest logs, destroy. Real config dir is read-only for OAuth. |
| B6 | Cost | 2 treated + 2 untreated × 3 models × 2 arms × 3 trials = 72 cells. Untreated tasks are cost-only; report strata separately. |
| B7 | Timeout ≠ incorrect | `SIGKILL`, missing conversation, non-zero without completion → `infrastructure-failure`. Infra rate >10% fails the run without counting as a correctness regression. |
| B8 | Luna + glm + deepseek | Custom providers `zai` and `DeepSeek` must exist. Luna is first in `pins.json`. |
| B9 | Resume by cellId | `--resume` skips cells with `result.json`. `--only` with a single cellId does not score a pair. |
| L1 | Product call-summary strings | Parses `[no tool calls; 1 schema lookup]` and `[1 tool call: inspect; 2 schema lookups]`. |
| L2 | No nested-error-in-result heuristic | Dropped. |
| L3 | Construction vs trial provenance | Construction = preflight/B1. Trial = raw sidecar. |
| L4 | No isolated-catalog claim | Combined treatment. N1 KEEP. |

## Stop rule

Correctness first. A candidate that reduces task correctness on any pinned model is rejected without efficiency analysis. Infrastructure failures are excluded from those counts and fail the run if they exceed 10%. Cache-read tokens are within-arm only.

## Launch

```
node scripts/experiments/tool-interface-stage1/driver.mjs preflight
node scripts/experiments/tool-interface-stage1/driver.mjs run --go --output-dir <fresh-dir>
# Fresh directory only. Do not --resume. Do not reuse prior .bench-runs cells.
```

Exit codes: preflight blockers → 2; `run --go` that throws on remaining blockers → 1 (not 2); `runInvalid` → 3; incomplete single-cellId → 4.

Fresh `--output-dir` only. Do not `--resume`. Do not reuse `.bench-runs/stage1-matrix72-*` or pilot cells. Pair compact vs baseline only.

The historical full 72-cell matrix already ran (`results-20260907.md`) and is not accepted. Paid cells are parent-owned after rebuild/preflight and **fresh bounded pairs on all 3 models**; the 72-cell matrix proceeds only if those gates pass. This file does not launch cells.

## Compact-run hypothesis and reporting caveats

Qualitative only: a smaller eager input catalog should retain the memory argument-repair benefit at lower prompt overhead; missing return shapes or an inadequate describe pointer may cause extra work.

Do **not** adopt numeric claims of ~195 tokens/turn, a 1-per-51 break-even, a 1-per-12.1 production error rate, or a predicted all-model net positive. Prior equal-turn estimators have script/history confound; the 50/50 task-set error rate is not production prevalence.

Report: compact-baseline pairs only; compact-vs-full cross-run indicative not paired; skill `read_file` bypass tracked separately; no isolated-catalog causality; no production break-even claim.

## Pilot repair (2026-09-07)

Non-interactive `--json` does **not** write `*.jsonl` under `TERM2_CONVERSATIONS_DIR`. The cell event stream is stdout JSON (and harvested `logs/provider-traffic`). Missing jsonl is not a wrong-model. Identity comes from `session_init` when present, else `cost_update.record` / `final.costRecords`. Proven wrong-model aborts; identity-missing is a distinct infra reason. An aborted pair must headline `INVALID`, including when `--only` was a pairId that only finished one cell.

Live luna raw header includes `configure_task_check_in` (18 names / 6821 B on the candidate pilot). Construction snapshots must pass the same `configureTaskCheckIn` stub production uses; that is the 17-vs-18 seam, not a treatment effect.
