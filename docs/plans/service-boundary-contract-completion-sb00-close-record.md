# SB-00 close-or-not record

Status: audit/docs record — no production change; no commit/merge; tracker row update
remains grant-gated (the primary plan `service-boundary-contract-completion.md` was NOT
edited).

## Verdict

`SB-00 CLOSED`

## Criterion restated

> All production service clusters and root `source/services/*.ts` files map to an existing contract, local-interface disposition, or not-a-seam rationale with verified source/test citations.

## 1. Count-delta reconciliation (handoff 94 vs verified 96)

The handoff record claimed 7 clusters / 94 implementation files. The later verified audit counted 7 clusters / **96** files.

Mechanical reproduction across all 7 clusters:

| Cluster | Handoff-claimed | Verified count | Delta file(s) | Cause |
| --- | --- | --- | --- | --- |
| `agent-runtime/` | 28 | 28 | None (0) | Match |
| `approval/` | 18 | 18 | None (0) | Match |
| `subagents/` | 17 | 18 | `source/services/subagents/test-helpers/subagent-manager-fixtures.ts` (+1) | Handoff count excluded cluster-local `test-helpers/` subdirectory |
| `settings/` | 11 | 12 | `source/services/settings/test-helpers/settings-consumer-inventory.ts` (+1) | Handoff count excluded cluster-local `test-helpers/` subdirectory |
| `hooks/` | 10 | 10 | None (0) | Match |
| `retry/` | 9 | 9 | None (0) | Match |
| `queue/` | 1 | 1 | None (0) | Match |
| **Total** | **94** | **96** | **2 files** | **Exclusion of non-`*.test.ts` fixtures in cluster-local `test-helpers/`** |

### Reconciliation analysis

- **Which count is correct:** The **96** count is the mechanically correct file count for all non-`*.test.ts` `.ts` files under these 7 cluster directories (`rg --files source/services/<cluster> -g '*.ts' -g '!*.test.ts'`).
- **Exact delta files identified:**
  1. `source/services/subagents/test-helpers/subagent-manager-fixtures.ts` (215 lines)
  2. `source/services/settings/test-helpers/settings-consumer-inventory.ts` (163 lines)
- **Cause:** The outgoing handoff count filtered out cluster-local `test-helpers/` subdirectories (treating them as fixtures/mocks like the top-level `source/services/test-helpers/`), whereas the verified mechanical audit counted all `.ts` files not ending with `.test.ts`.
- **Follow-up document coverage:** Both files are explicitly named and accounted for in the follow-up doc set:
  - `subagents/test-helpers/subagent-manager-fixtures.ts` is explicitly scoped out in `service-boundary-contract-completion-sb00-followup-3-subagents.md` on the same basis as top-level `test-helpers/` (non-production test fixtures/mocks).
  - `settings/test-helpers/settings-consumer-inventory.ts` is documented in `service-boundary-contract-completion-sb00-followup-4-settings.md` as the **Contract 04 §8.1 canonical artifact** (exhaustive 126-value consumer/classification inventory imported by `settings-schema.test.ts` to reject drift).

## 2. Accepted unit-test gaps (four) — verification

All four deterministic unit tests recommended in the SB-00 correction audit (§7) have been implemented and verified in dedicated, isolated worktrees under `NODE_ENV=test`.

| Gap | Worktree path | Test file | Isolation status (`git status --short`) | Test command | Pass/Fail + counts |
| --- | --- | --- | --- | --- | --- |
| 1 | `/home/qduc/term2/.worktrees/sb00-gap-1-openai-root-provider-identity` | `source/services/openai-root-provider-identity.test.ts` | Isolated (`?? docs/plans/2026-08-15T16:39:06Z--vp-engineering-deepseek--sb00-gap-1.md`<br>`?? source/services/openai-root-provider-identity.test.ts`) | `NODE_ENV=test pnpm --dir ... exec vitest run source/services/openai-root-provider-identity.test.ts` | **PASS**: 1 file passed, 5 tests passed (5) |
| 2 | `/home/qduc/term2/.worktrees/sb00-gap-2-parse-tool-call-arguments` | `source/services/tool-call-arguments.test.ts` | Isolated (`?? source/services/tool-call-arguments.test.ts`) | `NODE_ENV=test pnpm --dir ... exec vitest run source/services/tool-call-arguments.test.ts` | **PASS**: 1 file passed, 8 tests passed (8) |
| 3 | `/home/qduc/term2/.worktrees/sb00-gap-3-stream-snapshot` | `source/services/stream-snapshot.test.ts` | Isolated (`?? source/services/stream-snapshot.test.ts`) | `NODE_ENV=test pnpm --dir ... exec vitest run source/services/stream-snapshot.test.ts` | **PASS**: 1 file passed, 8 tests passed (8) |
| 4 | `/home/qduc/term2/.worktrees/sb00-gap-4-plan-mode-notice` | `source/services/runtime-setting-router.test.ts` | Isolated (`M source/services/runtime-setting-router.test.ts`) | `NODE_ENV=test pnpm --dir ... exec vitest run source/services/runtime-setting-router.test.ts` | **PASS**: 1 file passed, 4 tests passed (4) |

## 3. Disposition completeness

### 19-Cluster coverage (180 cluster files total)

Every one of the 19 first-level subdirectories under `source/services/` has a verified disposition:

| Cluster | `rg` count | Disposition status & source |
| --- | --- | --- |
| `session/` | 34 | SB-01 / SB-03 / SB-04 contracts |
| `agent-runtime/` | 28 | `service-boundary-contract-completion-sb00-followup-1-agent-runtime.md` |
| `conversation/` | 24 | SB-02 / SB-04 contracts |
| `subagents/` | 18 | `service-boundary-contract-completion-sb00-followup-3-subagents.md` |
| `approval/` | 18 | `service-boundary-contract-completion-sb00-followup-2-approval.md` |
| `settings/` | 12 | `service-boundary-contract-completion-sb00-followup-4-settings.md` |
| `hooks/` | 10 | `service-boundary-contract-completion-sb00-hooks.md` |
| `retry/` | 9 | `service-boundary-contract-completion-sb00-followup-5-retry.md` |
| `logging/` | 7 | SB-05 Contract 07 |
| `workspace/` | 4 | SB-08 row 3 / Contract 09 |
| `shell/` | 4 | SB-08 row 9 |
| `cost/` | 3 | SB-08 row 7 |
| `memory/` | 2 | SB-08 row 5 |
| `handoff/` | 2 | SB-08 row 1 |
| `test-helpers/` | 1 | Explicitly scoped out (non-production fixture `mock-stream.ts`) |
| `skills/` | 1 | SB-08 row 4 |
| `queue/` | 1 | `service-boundary-contract-completion-sb00-queue.md` |
| `providers/` | 1 | SB-08 row 2 |
| `models/` | 1 | SB-08 row 2 |
| **Sum of clusters** | **180** | **19/19 clusters fully disposed/accounted for** |

### 28 Root modules (`source/services/*.ts`)

All 28 root-level service files are mapped in the primary plan's ledger (`docs/plans/service-boundary-contract-completion.md`) and/or corrected in `service-boundary-contract-completion-sb00-correction.md`:

1. `agent-stream.ts` (89) — Local interface is sufficient; branded-type guard and item selector.
2. `background-task-activity.ts` (96) — Contract 03 / 05 (formats background subagent and shell task activity).
3. `command-message-streaming.ts` (53) — Local interface is sufficient (extracts command messages from stream events; captures tool-call arguments).
4. `conversation-agent-client.ts` (149) — SB-03 (local role interfaces; retain composite facade).
5. `execution-context.ts` (86) — Contract 05 & SB-06 (manages execution root leasing and remote SSH directory authority).
6. `file-service.ts` (207) — Local interface is sufficient (workspace directory traversal with depth/entry caps; mutable globals documented).
7. `generation-guard.ts` (34) — Contract 05 (guards turn generation tokens against concurrent race conditions).
8. `history-service.ts` (165) — SB-02 (manages composer prompt history persistence).
9. `input-surge-guard.ts` (148) — Contract 05 (detects high-frequency user input surges and applies throttling).
10. `interruption-info.ts` (114) — Local interface is sufficient (Contract 01 / 05 duck-typing primitive at `getMethod`).
11. `large-uncached-input-guard.ts` (250) — Contract 05 (estimates uncached prompt tokens and issues warnings).
12. `mode-notices.ts` (24) — Not a seam (model-facing system-notice prompt text).
13. `model-service.ts` (136) — Local interface is sufficient (fetches model lists and manages in-memory caching).
14. `notification-service.ts` (196) — Not a seam (stateless terminal escape sequence formatter).
15. `openai-candidate-observer.ts` (60) — Contract 01 / 02 (observes candidate responses across stream retries).
16. `openai-root-checkpoint-lifecycle-observer.ts` (69) — Contract 02 (observes OpenAI server-side compaction checkpoint lifecycle).
17. `openai-root-provider-identity.ts` (18) — Local interface is sufficient; session-scoped shared identity state (gap 1 tested).
18. `openai-root-selector-parity-observer.ts` (123) — Contract 01 / 02 (validates selector parity during initial stream retries).
19. `plan-mode-interceptor.ts` (55) — Local interface is sufficient (intercepts tool calls in plan mode).
20. `provider-continuity.ts` (323) — Formal contract (Contract 02 session continuity / tracks upstream response IDs).
21. `rtk-service.ts` (294) — SB-08 (Local interface is sufficient / External-effect) (downloads binaries, verifies checksums, AST command rewriting).
22. `runtime-setting-router.ts` (134) — Contract 04 (local interface is sufficient; dispatches runtime setting changes; gap 4 tested).
23. `service-interfaces.ts` (139) — SB-05 / SB-06 (defines `ILoggingService`, `ISSHService`, `IProviderTraffic`, `ISessionContextService`, `ISettingsService`).
24. `ssh-service.ts` (150) — SB-06 (Formal contract draft) (manages remote SSH connection lifecycle and `executeCommand`).
25. `stream-event-processor.ts` (244) — Local interface is sufficient (processes streaming tokens and updates turn accumulator).
26. `stream-snapshot.ts` (75) — Local interface is sufficient; SDK-shape isolation boundary (gap 3 tested).
27. `tool-call-arguments.ts` (77) — Local interface is sufficient; malformed-JSON diagnostic policy (gap 2 tested).
28. `tool-execution-ledger.ts` (609) — Contract 02 / 05 (reconciles uncommitted tool executions against streaming journals).

### Totals summary

- Root modules: 28
- Cluster files: 180 (across 19 clusters)
- Total files under `source/services/**`: **208**
- Total files mapped/disposed: **208**
- Uncovered files: **none (0)**

## 4. Recommended verdict justification

The recommendation is **`SB-00 CLOSED`** based on the following verified facts:

1. **Complete coverage of all production clusters (19/19):** Every cluster directory under `source/services/` has an evidence-backed disposition. The 7 follow-up clusters (`agent-runtime`, `approval`, `subagents`, `settings`, `retry`, `hooks`, `queue`) comprising 96 files have complete per-file disposition records with verified line counts, exports, and citations.
2. **Complete coverage of all root modules (28/28):** Every root module under `source/services/*.ts` is mapped to a contract, local interface, or not-a-seam rationale in the ledger and correction records.
3. **Reconciled count delta:** The 94 vs 96 file-count delta between the handoff and verified audit is mechanically explained by the 2 non-`*.test.ts` fixtures in cluster-local `test-helpers/` subdirectories (`subagents` and `settings`), both of which are documented and disposed.
4. **All four gap tests passing in isolation:** The four ranked deterministic unit tests from §7 of the correction audit (`openai-root-provider-identity.test.ts`, `tool-call-arguments.test.ts`, `stream-snapshot.test.ts`, and `runtime-setting-router.test.ts`) are implemented in isolated worktrees and pass under `NODE_ENV=test` (total 25 passing tests across the 4 suites).

SB-00's completion criterion is met in full.

## Evidence

### 1. File Counts & Mechanical Verification

```bash
$ cd /home/qduc/term2
$ for c in agent-runtime approval subagents settings hooks retry queue; do
>   printf "%-14s %s\n" "$c" "$(rg --files source/services/$c -g '*.ts' -g '!*.test.ts' | wc -l)"
> done
agent-runtime  28
approval       18
subagents      18
settings       12
hooks          10
retry          9
queue          1

$ rg --files source/services/subagents/test-helpers source/services/settings/test-helpers -g '*.ts' -g '!*.test.ts'
source/services/subagents/test-helpers/subagent-manager-fixtures.ts
source/services/settings/test-helpers/settings-consumer-inventory.ts

$ find source/services -maxdepth 1 -name '*.ts' ! -name '*.test.ts' | wc -l
28

$ rg --files source/services -g '*.ts' -g '!*.test.ts' | wc -l
208
```

### 2. Gap Unit-Test Suites (`NODE_ENV=test`)

```bash
$ NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb00-gap-1-openai-root-provider-identity exec vitest run source/services/openai-root-provider-identity.test.ts
Already up to date
Done in 403ms using pnpm v11.7.0

 RUN  v4.1.9 /home/qduc/term2/.worktrees/sb00-gap-1-openai-root-provider-identity


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  00:02:46
   Duration  152ms (transform 21ms, setup 0ms, import 32ms, tests 5ms, environment 0ms)
```

```bash
$ NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb00-gap-2-parse-tool-call-arguments exec vitest run source/services/tool-call-arguments.test.ts
Already up to date
Done in 394ms using pnpm v11.7.0

 RUN  v4.1.9 /home/qduc/term2/.worktrees/sb00-gap-2-parse-tool-call-arguments


 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  00:02:48
   Duration  165ms (transform 24ms, setup 0ms, import 34ms, tests 6ms, environment 0ms)
```

```bash
$ NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb00-gap-3-stream-snapshot exec vitest run source/services/stream-snapshot.test.ts
Already up to date
Done in 397ms using pnpm v11.7.0

 RUN  v4.1.9 /home/qduc/term2/.worktrees/sb00-gap-3-stream-snapshot


 Test Files  1 passed (1)
      Tests  8 passed (8)
   Start at  00:02:49
   Duration  169ms (transform 31ms, setup 0ms, import 43ms, tests 6ms, environment 0ms)
```

```bash
$ NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/sb00-gap-4-plan-mode-notice exec vitest run source/services/runtime-setting-router.test.ts
Already up to date
Done in 400ms using pnpm v11.7.0

 RUN  v4.1.9 /home/qduc/term2/.worktrees/sb00-gap-4-plan-mode-notice


 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  00:02:51
   Duration  169ms (transform 34ms, setup 0ms, import 49ms, tests 7ms, environment 0ms)
```

### 3. Worktree Isolation Status

```bash
$ git -C /home/qduc/term2/.worktrees/sb00-gap-1-openai-root-provider-identity status --short
?? docs/plans/2026-08-15T16:39:06Z--vp-engineering-deepseek--sb00-gap-1.md
?? source/services/openai-root-provider-identity.test.ts

$ git -C /home/qduc/term2/.worktrees/sb00-gap-2-parse-tool-call-arguments status --short
?? source/services/tool-call-arguments.test.ts

$ git -C /home/qduc/term2/.worktrees/sb00-gap-3-stream-snapshot status --short
?? source/services/stream-snapshot.test.ts

$ git -C /home/qduc/term2/.worktrees/sb00-gap-4-plan-mode-notice status --short
 M source/services/runtime-setting-router.test.ts

$ git -C /home/qduc/term2/.worktrees/sb00-close-record status --short
?? docs/plans/service-boundary-contract-completion-sb00-close-record.md
```
