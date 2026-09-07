# Stage1 tool-interface paired benchmark protocol

Status: **prep only**. No paid cells have been launched. Candidate `c9a47777` was reviewed and is **not final**.

## What is being asked

After each catalog-wide tool-interface stage, measure the change with real model runs across three pinned models. Stage1's discovery candidate expands the `run_code` tools-header from names-only nonessentials to compact signature + short purpose + declared return shape for every scriptable member, plus an honest unconvertible-schema marker.

This protocol reopens a prior measurement, it does not pretend the question is new. `docs/plans/run-code-authoring-friction.md` recorded that promoting full signatures grew the rendered header ~3.9x (honest delta +8,080 chars over the exact rendered registry), so the header stayed names-only and signatures were taught at failure time. That figure is a plan-doc hint: it covers **signatures only**, and a previous receipt was already wrong once because it used a stub registry nine tools larger than production. Stage1 supersedes that decision only if the three-model comparison shows a correctness win that outweighs the **combined** header (signature + purpose + declared returns) measured against the exact production non-interactive registry. Do not treat any declaration-site count as fact.

## Combined treatment (N1 KEEP)

Arm B is the whole Stage1 candidate, not catalog expansion in isolation:

1. Catalog expansion (signatures + purpose + declared returns for every scriptable `tools.*` member).
2. Honest schema fallback (unconvertible schemas must not render as `tools.x()`).
3. Model-visible schema-lookup telemetry (`[N tool calls: …; M schema lookup(s)]` on the `run_code` result). This can shape describe behavior; do not claim isolated catalog causality.

`RUN_CODE_DESCRIPTION` static prose (everything before `Available inside the script`) must stay byte-identical across arms, or the candidate must quote the full diff via `--declare-description-treatment`. Construction-path snapshot and raw-traffic extraction both check this.

## Arms, models, settings

| Arm | Commit / tree |
| --- | --- |
| Original baseline | `76e51d2497a2009f6011c15b694e201a08e9de79` (this worktree) |
| Previous accepted stage | none yet; keep the original baseline forever |
| Candidate | `tool-interface-stage1` worktree; reviewed `c9a47777` is not final |

Pinned identities (must be read back from `session_init`, not from argv):

| id | `--provider` | `--model` | `--reasoning` |
| --- | --- | --- | --- |
| luna | `codex` | `gpt-5.6-luna` | `medium` |
| glm | `zai` | `glm-5.3-flash` | `medium` |
| deepseek | `DeepSeek` (case-sensitive custom id) | `deepseek-v4-flash` | `medium` |

Driver: production non-interactive CLI (`node dist/cli.js -p … -m … -r … --auto-approve --json --quiet`). Real production registry/`run_code`, not a hand-authored catalog. Isolated per-cell `XDG_STATE_HOME` / `XDG_DATA_HOME` / `TERM2_CONVERSATIONS_DIR` / memory directory; OAuth stays at the real `TERM2_CONFIG_DIR`. Settings are copied into the isolated state dir and rewritten only for `memory.directory`, debug logging, sandbox-on, and mode pins. Global settings and credentials are not modified. Secrets never enter artifacts (provider summaries record ids only).

`searchViaShell` stays `auto` (production). GPT-5-family models therefore see `apply_patch` where others see `create_file`/`search_replace`. Pair fairness is within a model, not across models.

## Header evidence (N2)

Sanitized provider-traffic envelopes store `tools` as **names only**. Combined header bytes and tool-name sets must be taken from `TERM2_RAW_TRAFFIC=1` `_raw.json` sidecars. Preflight/construction snapshots (importing `dist` `getAgentDefinition` with non-interactive flags) are a stub-vs-production check (O1: print non-interactive vs interactive tool counts). Pair scoring fails if the raw header is missing/empty or the name **sets** differ.

Primary metrics, in this order:

1. Task correctness (hidden oracle).
2. Combined actual header bytes from the raw sidecar.
3. Per-turn prompt tokens (and their sum) from `assistant_turn.usage`.

Cache-read tokens are **within-arm only**. The header sits in the cached `run_code` prefix, so cross-arm cache-hit deltas are an artifact of the design.

## Call accounting

Count these separately; do not collapse them:

| Counter | Source | Admitted? |
| --- | --- | --- |
| describe lookups (script) | `tools.describe(` in `run_code` arguments | no |
| model-visible schema lookups | `; N schema lookup(s)` on candidate results; absent on baseline | no |
| invalid params attempted | `Invalid parameters for "…"` in nested results | recorded, not admitted |
| unknown tool attempted | `Unknown tool "…"` | recorded, not admitted |
| recorded nested calls | `[N tool calls: …]` | mixed |
| admitted nested executions | **not separately visible** in conversation output; report unknown | — |

Direct-tool schema failures (`Tool input did not match schema`) are a separate counter.

## Tasks

Four hidden-oracle tasks spanning families without naming tools:

| id | family | oracle |
| --- | --- | --- |
| `retrieve-config-token` | filesystem read | exact token `canary-osprey-7f3a` |
| `contained-edit-port` | contained edit | `config/gateway.json` `listenPort=9417` |
| `aggregate-owners` | run_code-style aggregation | three sorted emails |
| `memory-billing-contact` | memory retrieval | exact token `ora-keel-19` |

The analyzer greps each prompt for `tools.`, `run_code`, compact signature prefixes, and several implementation names, and fails on a hit.

Documented exclusions of the non-interactive production surface: `session_list`/`search`/`read` (no `sessionBrowser`), `ask_user`, background-shell job tools, `session_rollover`. Web and paid subagent fan-out are not required actions. `run_subagent` remains on the real registry.

## Design

- 3 models × 2 arms × 3 trials × 4 tasks = **72 serial cells**.
- Pair order is balanced (`(trial + modelIndex + taskIndex) % 2`).
- Timeout 900,000 ms per cell. Wrong `session_init` provider/model/effort aborts.
- Stop rule (O7): a candidate that reduces correctness on **any** of the three models is rejected before any efficiency column.

## Commands

Dry-run / preflight (no paid calls):

```bash
node scripts/experiments/tool-interface-stage1/driver.mjs preflight \\
  --baseline-worktree /home/qduc/term2/.worktrees/tool-interface-bench \\
  --candidate-worktree /home/qduc/term2/.worktrees/tool-interface-stage1 \\
  --output-dir /home/qduc/.agents/runtime/tool-interface-stage1
```

Exact next launch command (do not run until the candidate hash is final and parent/Claude say go):

```bash
node scripts/experiments/tool-interface-stage1/driver.mjs run --go \\
  --baseline-worktree /home/qduc/term2/.worktrees/tool-interface-bench \\
  --candidate-worktree /home/qduc/term2/.worktrees/tool-interface-stage1 \\
  --output-dir /home/qduc/.agents/runtime/tool-interface-stage1
```

`--go` refuses if the candidate SHA equals the baseline, unless `--allow-identical-candidate` is passed. Build each worktree's `dist/cli.js` before launch (`pnpm build` in that tree).

## Missing metrics (honest)

- Admitted nested executions are not a separate conversation field.
- USD cost is recorded only when `assistant_turn.costRecords[].usdMicros` is present. Custom `zai` / `DeepSeek` provider keys may not match catalog lookup; then cost is unknown.
- Wire header bytes require the raw sidecar. If `TERM2_RAW_TRAFFIC` failed to write, the pair is invalid rather than reported as a zero delta.
- Candidate construction snapshot cannot be the launch authority until the final hash exists.

