# Stage 1 protocol (tool-interface-bench)

Read this before launching cells. Paid launch is blocked until this protocol is reviewed.

## Pins

- Baseline: `76e51d2497a2009f6011c15b694e201a08e9de79`
- Candidate final: `80f7488401c1043445cf3974f163633693c8c20f` (Claude revision2 APPROVED)
- Not a pin: `67560fa9` (BLOCKED on F1/F2/F3; superseded)
- Models: luna `gpt-5.6-luna#medium` (codex), glm `glm-5.3-flash#medium` (zai), deepseek `deepseek-v4-flash#medium` (DeepSeek)
- Seed: 7. Trials: 3 (pass `--trials 2` to cut cost). Serial. 30 min/cell.
- Combined treatment only. No isolated-catalog causality.

## F3 / measurement surface (binding)

The candidate's `+8,471 B` figure is an **exploratory interactive fixture with a replica baseline**, not acceptance evidence. It measures `appRegistries()` (session browser, ask-user, background shell, `enable_agent_workflow`) via a hand-authored replica of `renderToolsHeader`, does not assert the byte delta, and is not the benchmark registry.

This driver owns reproducible measurement:

- **Construction snapshot** (preflight / B1): factory-bound `buildAgentTools` + `bindRunCodeRegistry` on the **non-interactive CLI** surface. Session tools are absent. Label: `non-interactive-factory-bind`. Preflight snapshots **every pinned model**; pair name-set equality is within-model (luna's native-patch registry is 17 names including `apply_patch`; glm/deepseek are 20 names including grep/glob/create_file/search_replace).
- **Trial measurement** (B4): `provider-traffic-raw` sidecar only. Construction snapshots never substitute for trial bytes.
- Interactive production is an **upper bound** this driver does not claim. Report the non-interactive figure as a lower bound on interactive.

Measured construction headers (2026-09-07, factory-bound, this worktree's snapshot script vs baseline `dist` and candidate `80f74884` `dist`):

| model | baseline B | candidate B | delta B | names | static prose |
| --- | ---: | ---: | ---: | ---: | --- |
| luna | 1454 | 6821 | +5367 | 18 match | match |
| glm | 2651 | 8018 | +5367 | 21 match | match |
| deepseek | 2651 | 8018 | +5367 | 21 match | match |

Includes `configure_task_check_in`. Luna construction matches the candidate pilot raw header (18 / 6821 B). Same absolute +5367 B on all three. **Not** the F3 replica +8471 / 3.31x–4.42x interactive fixture. Prior 3.9x signature-only plan-doc figure is reopened under these tri-model construction measurements; trial prompt tokens remain the live primary cost metric.

## Hard gates (B1–B9)

| ID | Gate | Enforcement |
| --- | --- | --- |
| B1 | Factory-bound header, not unbound `getAgentDefinition` | `snapshot-header.mjs` calls `buildAgentTools`. Empty/stub (`<8` names) fails preflight. Empirically: baseline glm header 20 names / 2619 B; interactive extras = session_list/search/read. |
| B2 | Baseline pin by `source/` tree, not HEAD identity | `git diff --quiet <pin> HEAD -- source/` plus dirty `source/` checks. |
| B3 | Candidate HEAD == `candidateCommitFinal` and clean | `80f74884`. Protocol review pending still refuses `--go`. |
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
node scripts/experiments/tool-interface-stage1/driver.mjs run --go   # refused until protocol review clears pendingFinalReview
```

Do not launch paid cells from this revision.

## Pilot repair (2026-09-07)

Non-interactive `--json` does **not** write `*.jsonl` under `TERM2_CONVERSATIONS_DIR`. The cell event stream is stdout JSON (and harvested `logs/provider-traffic`). Missing jsonl is not a wrong-model. Identity comes from `session_init` when present, else `cost_update.record` / `final.costRecords`. Proven wrong-model aborts; identity-missing is a distinct infra reason. An aborted pair must headline `INVALID`, including when `--only` was a pairId that only finished one cell.

Live luna raw header includes `configure_task_check_in` (18 names / 6821 B on the candidate pilot). Construction snapshots must pass the same `configureTaskCheckIn` stub production uses; that is the 17-vs-18 seam, not a treatment effect.
