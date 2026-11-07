# Architecture cleanup plan

Status: proposed. Baseline measured at `8a4617c` (2026-11-06), the day after
#88 deleted the unreachable `source/` code.

## Goal

Make [`docs/architecture/layers.md`](../../architecture/layers.md) describe the
code honestly, and stop the drift. Today the rules are right, but the allowlists
record the system we actually have: 116 layer edges, 17 name exceptions, 457
unused exports and 73 line-count ceilings. Code written by agents copies the
patterns around it, so a gap between the doc and the code compounds with every
PR.

Perfect is not the goal. The work splits into two cost classes:

- **Cheap and mechanical** (Phases 0–2): ratchets, dead-code deletion and file
  moves. This takes the edges from 116 to 7 in a few days of PRs, and it is
  done up front.
- **Expensive and local** (Phases 3–4): port redesigns, file splits and folder
  regrouping. These pay off only when someone works in that code, so they are
  done **when touched**, never on a schedule.

Every step is measured before it lands; nothing is done on taste.

This plan is done when:

- The Phase 0 ratchets are live: no baseline grows without a recorded reason, and the root stays clean.
- Phases 1 and 2 are merged. `layer-allowlist.json` holds at most the 7 known
  edges from Phase 3, and `unusedExports` is empty.
- `layers.md` describes the code as it is, with a short "Known exceptions"
  section that links each remaining edge to its Phase 3 row.
- `scripts/prove-checks.sh` still shows every check failing on a seeded violation.

After that, nothing in this plan has a deadline. The remaining items shrink
through the pay-as-you-go rules in Phases 3 and 4, and the ratchets guarantee
they never grow back.

## Baseline scoreboard

| Metric | Value at `8a4617c` | Source |
| --- | --- | --- |
| Allowlisted layer edges | 116 (20 layer pairs) | `scripts/layer-allowlist.json` |
| `maxLayerEdges` ceiling | 116 | `scripts/complexity-budget.json` |
| Name exceptions (service/adapter/orchestrator) | 17 | `rule-baseline.json` |
| Unused runtime exports | 457 (`layers.md` still says 470) | `rule-baseline.json` |
| Files over 500 lines (excluding generated) | 70 | `wc -l` |
| Files over 1,000 lines | 16 | `wc -l` |
| Loose `.ts` files directly in `src/session/` | 89 | `ls` |
| Agent handoff files in repo root | 4 | `ls` |
| `docs/` size | 27 MB, 1,384 files (`docs/experiments` is 18 MB) | `du` |

Edges by layer pair: shared→tools 17, model→engine 16, engine→session 14,
clients→model 11, shared→config 10, shared→model 9, model→config 7,
model→session 5, shared→session 4, clients→config 4, shared→engine 3,
model→clients 3, config→session 3, config→model 3, config→clients 2,
and one each for tools→clients, shared→clients, engine→app, clients→session
and clients→engine.

## Key findings

1. **Most edges are misplaced files, not bad dependencies.** For every
   edge-source file, `scripts/arch-whatif.mjs` computes the layers where the
   file could legally live, given what it imports and what imports it. It
   reproduces the checker's count exactly (116). Grouped moves (changing nothing
   but import paths), one dead-code deletion and two one-line extractions remove
   94 of the 116 edges under today's rules.
2. **The rule against importing `config/` produces 21 edges by itself.** These
   are imports of pure settings types and constants (`settings-schema.ts`,
   `custom-provider-normalization.ts`, `settings-path.ts`, labels). If `config/`
   is made a pure-schema leaf that any layer may read, and its I/O moves to
   `app/`, the baseline is 95. After the moves, **7 edges remain** (22 without
   the rule change).
3. **Dead code sits on edges.** 28 of the 60 edge-source files export symbols
   already recorded as unused. Example: `engine/lib/agent-chat-service.ts` causes
   the only `engine → app` edge, yet `AgentChatService` has zero users. Its only
   live export is `AgentChatFailure`, used once by `session-composition.ts`.
   Deleting the class removes two edges.
4. **Recovery policy is a session concern by usage.** `recovery-executor.ts`,
   `retry-classifier.ts` and `retry-event-presenter.ts` sit in `engine/` but are
   imported only by `session/`, and they reach into session's durable record.
5. **The retry and failure vocabulary is a model concern by usage.**
   `engine/retry/{retry-errors, retry-error-classification, upstream-retry-policy,
   retry-recovery-budget, provider-failure-classification,
   chain-recovery-fingerprint, conversation-retry-policy}` import only `model/`
   and `shared/`, and `model/` imports them 16 times.
6. **`shared/` holds 44 of the edges.** `shared/utils/shell/` is
   tool-safety code (sandbox, command safety), and several "shared" contracts
   depend on `tools/types.ts` or on providers.
7. **Root files are stale.** `FIX_REPORT.md`, `JOURNAL_REPAIR_REPORT.md`,
   `CHANGE_MANIFEST.json` and `JOURNAL_REPAIR_MANIFEST.json` were committed with
   the rollover fix (`eee14caa`, 2026-10-25). They reference
   `source/services/...` paths that #88 deleted. Only
   `docs/experiments/rollover-queue/README.md` links to them.
8. **`clients/acp-v2/` is not a second ACP client.** It is one 48-line file,
   `serve-args.ts`, imported from `app/`.

## Rules of engagement

These apply to every PR under this plan, human or agent.

1. **The scoreboard only goes down.** Each PR pastes `arch:report` output from
   before and after into its description. A PR that raises any number is
   rejected, however small.
2. **Delete, then move, then rewrite.** Never move code that the
   unused-exports list already marks as dead. Never rewrite during a move.
   Rewriting (ports, splits) needs the short design note described in Phase 3.
3. **Moves are move-only.** A move commit changes only file locations and
   import specifiers. `git show -M --stat` must report every moved file as a
   rename, and the non-rename diff must be import lines only. Renames that clear
   a name exception (for example `session-context-service.ts` →
   `traffic-context.ts`) ride in the same commit, because the file moves anyway.
4. **Simulate first.** Run `node scripts/arch-whatif.mjs . whatif <moves.json>`
   on the PR's moves. It must show `-N +0`. A `+` means the grouping is wrong;
   regroup, don't allowlist.
5. **One step per PR, landed fast.** Moves conflict with agent worktrees. Before
   a move PR, list branches and worktrees that touch the moved files
   (`git log main..<branch> --name-only`). Land or rebase them first, note the
   move window in `AGENTS.md`, and merge the move within a day.
6. **A baseline grows only with a reason.** CI fails if, compared with the merge
   base, `layer-allowlist.json`, `rule-baseline.json`,
   `reachability-allowlist.json`, `complexity-budget.json` or
   `root-allowlist.json` gains an entry or raises a ceiling without a reason a
   reviewer can judge, and shows the reviewer every one that has a reason.
   Removing entries is always allowed. This rule originally banned all growth;
   see [When a gate fails](../../architecture/layers.md#when-a-gate-fails) for
   why it changed.
7. **Verification tier follows the change type**, under the repository's
   existing evidence policy:

   | Change | Required |
   | --- | --- |
   | Move-only | typecheck, lint, the four rule checks, `bench/hops.mts`, CI integration and e2e lanes |
   | Move-only in `engine/retry` or the recovery path | the above plus provider black-box and `parity/run.mjs check` |
   | Port or split (Phase 3 and 4) | all of the above plus an independent verifier (high risk: engine/session/model boundaries) |

## Phase 0: ratchets and tooling (1 PR)

- Add `scripts/arch-report.mjs`. It prints every scoreboard row from the files
  themselves, and `layers.md` links to its output instead of quoting numbers,
  which is how "470" went stale.
- Add `scripts/arch-whatif.mjs` (the analyzer behind this plan) and
  `scripts/arch-cleanup-moves.json` (the moves for Phase 2).
- Add the CI guard from rule 6.
- Set `maxLayerEdges` to the current edge count automatically in `arch-report`,
  so the ceiling tightens itself as edges are removed.
- Add a root-directory allowlist check. Add `.handoff/` to `.gitignore`, and
  tell agents in `AGENTS.md` that reports, manifests and evidence for a task in
  flight go there (or under the task's experiment folder), never in the root.

Exit: CI fails on a seeded allowlist addition and on a seeded root file
(add both to `prove-checks.sh`).

## Phase 1: hygiene (no behavior change)

| Item | Action | Metric |
| --- | --- | --- |
| Root handoff files | Move the 4 files into `docs/experiments/rollover-queue/handoff/` and update the two links in that README | root files 4 → 0 |
| Dated measurements in `docs/plans/` | Move `ci-bundle-experiment-2026-10-22.*` (9 files) and `test-suite-speed-2026-10-22.*` (5 files) into `docs/plans/engineering/measurements/` | plans root clean |
| Dead code on edge files | Delete unused exports in the 28 edge-source files first, starting with `AgentChatService` | edges 116 → 114, unused ↓ |
| Remaining unused exports | Delete by layer, in this order: shared 96, session 91, tools 87, model 81, engine 37, config 29, delegation 14, clients 8, protocol 6, host 6, app 6. One layer per PR, using `knip` (already configured) to confirm | unused 457 → 0 |

## Phase 2: layer edges by root cause (move-only)

Simulated in order with `CONFIG_LEAF=1` (decision D1, approved). Every step shows
`+0` new edges; step 7 also turns one existing `clients → config` edge into
`clients → app`, and Phase 3 removes it.

| Step | Moves | Edges | Files moved |
| --- | --- | --- | --- |
| 1 | Delete the dead `AgentChatService`; rename the file `agent-chat-failure.ts` | −2 | 0 |
| 2 | The 7 retry/failure vocabulary files from `engine/retry/` → `model/failure/`; `shared/contracts/streamed-model-turn.ts` and `shared/utils/error-helpers.ts` → `model/`; `shared/contracts/{nested-run-driver, application-stream, conversation}.ts` → `tools/`; `shared/gateway/interaction-protocol.ts` → `session/adopted/` (migration-only) | −23 | 13 |
| 3 | `recovery-executor`, `retry-classifier`, `retry-event-presenter` → `session/recovery/`; `session/prompts/{context-compaction, steering-notice, memory-recall-notice}`, `session/approval/approval-replay.ts` and `session/conversation/conversation-message-projection.ts` → `engine/` | −11 | 8 |
| 4 | `model-picker-host.tsx`, `StandaloneModelPickerApp.tsx`, `use-standalone-model-picker.ts`, `acp-v2/serve-args.ts` (deleting `acp-v2/`), `shared/utils/{settings-command, value-suggestions}.ts` and `tools/discord-send.ts` → `app/` | −17 | 7 |
| 5 | `session/session/session-context-service.ts` → `model/traffic-context.ts` (clears a name exception) | −5 | 1 |
| 6 | `shared/utils/shell/` → `tools/shell/` (except `shell-output.ts` and `temp-dir.ts`, which stay); `extract-command-messages`, `resume-list` → `session/`; `editor-impl`, `tool-invoke`, `conversation-utils`, `types/message` → `tools/`; `inject-warning-into-tool-output` → `engine/`; `tool-selection-policy`, `provider-credentials` → `model/`; `shared/profiles/legacy-adapter.ts` → `config/profiles/` | −23 | 35 |
| 7 | `settings-service`, `settings-completion-{config,logic}` and `profile-transition` → `app/` (drop the re-export from `config/profiles/index.ts`); `skins/names.ts` → `config/`; extract `THEME_SETTING_VALUES` into `config/` so `settings-schema.ts` stops importing `resolve-theme.ts` | −8 | 5 |
| **Total** | | **95 → 7** | **~69** |

Exit: `layer-allowlist.json` holds 7 entries, all listed in Phase 3, and
`layers.md`'s table matches the code, with a "Known exceptions" section linking
to Phase 3. **This is the end of the scheduled work.**

## Pay-as-you-go rules (Phases 3 and 4)

From here on, an item is fixed only when one of these triggers fires:

1. **You are about to change the code anyway.** A feature or bug fix touches a
   file on either end of a Phase 3 edge, or a file in the Phase 4 hotspot table.
   Do the cleanup as a **separate preparatory PR merged just before** the
   feature PR. Never mix the two in one diff.
2. **It caused a bug.** A bug retro names the item as part of the root cause.
3. **It blocks something.** A planned feature cannot be built cleanly around it.

If no trigger fires, the item waits. Leaving it is a deliberate choice, not
debt that was forgotten: the ratchets stop it from spreading, and the "Known
exceptions" list keeps it visible.

Budget per trigger: a preparatory PR should stay within roughly a day. If the
design note shows it would take longer, record that in the note, do the
smallest step that unblocks the feature, and leave the rest listed.

## Phase 3: the seven real design problems (ports, when touched)

These need code changes, not moves, and they follow the pay-as-you-go rules.
When a trigger fires, write a design note of one page or less in
`docs/plans/engineering/architecture-cleanup/` before any code. The note states
the port, who implements it, who calls it, and the test that proves behavior is
unchanged.

| # | Edge(s) | Problem | Proposed port |
| --- | --- | --- | --- |
| 3.1 | `Banner.tsx` → `engine/agent-runtime/model-resolver.ts`, `model/providers/index.ts` | A UI component resolves models itself | `app/` computes the model and provider labels and passes them as props (or as protocol state) |
| 3.2 | `use-terminal-focus-notifier.ts` → `logging-service.ts`, `settings-service.ts` | A client hook reaches concrete services | Inject `ILoggingService` and a settings reader (both already in `shared/service-interfaces.ts`) through TUI context from `app/` |
| 3.3 | `context-compaction/index.ts` → `conversation-state-projector.ts` | Compaction needs session's projection of model history | The compactor takes a `historyProjector` function; the session passes `projectModelRequestHistory` |
| 3.4 | `retry-contracts.ts` → `conversation-events.ts` (type only) | The engine's retry contract names a session event type | The engine defines its own `RetryNotice` type; session's `ConversationEvent` union includes it |
| 3.5 | `chained-input-filter.ts` → `run-item-normalizer.ts` | A shared helper used by `model/` (3 files) and `engine/` calls session normalization | Measure `run-item-normalizer` and `tool-occurrence` dependencies. Move both down if they are pure; otherwise inject the normalizer |

There is no exit deadline. Each fix removes its allowlist entry, which carries
the edge's reason. When the list is empty, delete `layer-allowlist.json`
and the allowlist code path in `check-layers.mjs`.

## Phase 4: size and structure (hotspots, when touched)

Split a file only when a pay-as-you-go trigger fires **and** the file is in the
table below. Rank by **churn and size together**, not size alone. Churn is
commits in the last 90 days, counted with `git log --follow`. Recompute the
table with `arch-report` each quarter; a file leaves it when its churn drops.

| File | Lines | Commits (90 days) | Plan |
| --- | --- | --- | --- |
| `session/session/session-composition.ts` | 1,484 | 71 | Split first: 68 imports. Check whether its wiring belongs in `app/` |
| `config/settings/settings-schema.ts` | 1,361 | 68 | Split after Phase 2 step 7 reshapes it (schema per domain) |
| `model/providers/codex-responses-model.ts` | 2,450 | 52 | Split transport / converter / retry |
| `tools/system/shell.ts` | 1,463 | 45 | Split |
| `delegation/subagents/tool-policy.ts` | 1,450 | 38 | Split |
| `clients/tui/.../CommandMessage.tsx` | 1,021 | 34 | Split |
| `session/conversation/conversation-replay.ts` | 1,974 | 32 | Split |
| `conversation-persistence.ts`, `run-code-runtime.ts` | 1,224 / 1,169 | 31 / 31 | Split |
| `provider-traffic.ts`, `discord-bridge.ts`, `session-index-database.ts` | 1,766 / 1,275 / 1,042 | 20 / 20 / 15 | Leave alone. Low churn; splitting costs more than it returns |

Structure:

- No big-bang regroup of `src/session/`. When a trigger brings you into a
  cluster of loose files, move that cluster into a named folder in the
  preparatory PR. Candidate clusters come from file prefixes (conversation 12,
  replay 5, queue 5, background 5, log 4, command 4, goal 3, input 3); confirm
  each with import cohesion first. Fold `session/session/`, `session/core/` and
  `session/lib/` into named folders the same way, piece by piece.
- Clear the remaining name exceptions when their files are next touched. Steps
  1, 5, 6 and 7 already clear 4 of the 17.

## Phase 5: documentation weight

`docs/experiments/` is 18 MB; `generated-verification/` alone is 14 MB,
mostly raw stdout/stderr captures (471 files). The plan depends on decision D3.
Whatever the choice, new experiments keep raw logs out of `docs/` by default
and commit a summary plus checksums.

## Decisions

| # | Decision | Recommendation | Why |
| --- | --- | --- | --- |
| D1 | Make `config/` a pure-schema leaf any layer may import, and move settings I/O to `app/` | **Approved 2026-11-07** | 21 edges are pure-type imports. The simulated end state is 7 edges with it and 22 without. Enforce purity with a check: `config/` imports only `config/` and `shared/`, and uses no `fs` or network |
| D2 | Amend the table: the engine owns recovery *mechanics*, the session owns recovery *policy* over the durable record | **Approved 2026-11-07** | Only `session/` imports the three policy files, and they read the session record |
| D3 | Where 14 MB of raw verification evidence lives | Your call: keep it, move it to an `evidence` branch or release assets, or prune it to summaries | It interacts with the active evidence-driven experiment's rules |
| D4 | The 500-line rule | Keep it, ban new ceilings, and let existing ceilings only fall | Phase 4 retires the ceilings that matter, by churn |

## Out of scope

Product surface (Discord, web client, control socket, remote host) is a product
decision, not an architecture cleanup item. This plan only moves its code to
the right layers.

## Reproducing the numbers

```sh
node scripts/arch-whatif.mjs . summary                      # edges, movable vs design
node scripts/arch-whatif.mjs . rows                         # per-edge legal destinations
node scripts/arch-whatif.mjs . whatif scripts/arch-cleanup-moves.json
CONFIG_LEAF=1 node scripts/arch-whatif.mjs . whatif scripts/arch-cleanup-moves.json
```

The analyzer uses the same import regex and `LAYER_DEPENDENCIES` as
`check-layers.mjs`; its baseline count matching the allowlist (116) is the
sanity check. Limits: it models only import edges, not barrel re-exports or
semantic fit, so each step's PR still gets the verification tier above.
