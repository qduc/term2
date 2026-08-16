# SB-00 inventory closure — corrected audit record

Status: **audit/docs correction — SB-00 remains open.** Reconciles the prior
independent closure audit (`/tmp/claude-sb00-closure.md`, 2026-08-15) against the
primary checkout at `11758c77` (re-verified read-only in this worktree) and the
successor ledger's in-progress record. No production source changed; no new formal
contract created (Contract 11 already drafted and accepted-unmerged); no commit or merge.

## 1. Verified inventory (re-read in this worktree)

- **28 root modules** under `source/services/*.ts` (non-test) — confirmed; matches the
  tracker claim and the prior audit.
- **19 first-level clusters** under `source/services/`. Production (non-`*.test.ts`) file
  counts verified by `rg --files <cluster> -g '*.ts' -g '!*.test.ts'`:

| Cluster | Prod files | Disposition in plan |
| --- | --- | --- |
| `session/` | 34 | SB-01 / SB-03 / SB-04 ✓ |
| `agent-runtime/` | 28 | **none — undisposed (defer, follow-up 1)** |
| `conversation/` | 24 | SB-02 / SB-04 ✓ |
| `subagents/` | 18 | **none at cluster level — partial: Contract 11 C11-D10 draft covers `tool-policy.ts` (defer, follow-up 3)** |
| `approval/` | 18 | **none at cluster level — partial: Contract 11 C11-D5 draft covers `tool-approval-batch-coordinator.ts` (defer, follow-up 2)** |
| `settings/` | 12 | **none at cluster level — partial: Contract 04 (consumption), Contract 10 (persistence) (defer, follow-up 4)** |
| `hooks/` | 10 | **none at cluster level — partial: SB-08 hooks tracker-only disposition (HookService family + public V1 package contract)** |
| `retry/` | 9 | **none at cluster level — partial: Contract 02/05 retry/recovery policy (defer, follow-up 5)** |
| `logging/` | 7 | SB-05 Contract 07 ✓ |
| `workspace/` | 4 | SB-08 row 3 / Contract 09 ✓ |
| `shell/` | 4 | SB-08 row 9 ✓ |
| `cost/` | 3 | SB-08 row 7 ✓ |
| `memory/` | 2 | SB-08 row 5 ✓ |
| `handoff/` | 2 | SB-08 row 1 ✓ |
| `test-helpers/` | 1 | **explicitly scoped out — non-production fixtures/mocks** |
| `skills/` | 1 | SB-08 row 4 ✓ |
| `queue/` | 1 | **none at cluster level — partial: Contract 01 (QueueController) + Contract 12 (persistence)** |
| `providers/` | 1 | SB-08 row 2 ✓ |
| `models/` | 1 | SB-08 row 2 ✓ |

- **Reconciled undisposed totals:** **7 production clusters / 96 implementation files**
  (`agent-runtime` 28, `approval` 18, `subagents` 18, `settings` 12, `hooks` 10, `retry` 9,
  `queue` 1) plus `test-helpers/` (1 file, non-production, scope-out). Total production
  files under `source/services/**`: **208** (28 root + 180 cluster).
- **Count deltas vs prior records (reported, not silently resolved):** the prior audit
  said 8 clusters / 97 files — its 97 includes `test-helpers/` (now explicitly scoped
  out). The outgoing handoff said 7 clusters / 94 files — 2 below this record's verified
  96; the delta is likely `.mock`/fixture files counted as implementation and must be
  reconciled at integration time, not assumed.

## 2. Corrected export-owner names (verified by `grep '^export'`)

| File | Incorrect owner (old) | Verified exports (correct) |
| --- | --- | --- |
| `command-message-streaming.ts` | `extractCommandMessages` (nonexistent) | `captureToolCallArguments`, `attachCachedArguments`, `emitCommandMessagesFromItems` |
| `interruption-info.ts` | `InterruptionInfo` (nonexistent) | `UnknownRecord`, `asRecord`, `getString`, `getMethod`, `getCallIdFromObject`, `getCommandFromArgs`, `getToolInfoFromInterruption` |
| `plan-mode-interceptor.ts` | `createPlanModeInterceptor` (nonexistent) | `installPlanModeInterceptor` |
| `mode-notices.ts` | `formatModeNotice` (nonexistent) | `PLAN_MODE_ENTER_NOTICE`, `PLAN_MODE_EXIT_NOTICE`, `planModeNotice` |
| `openai-root-provider-identity.ts` | `isOpenAIRootProvider` (nonexistent) | `class OpenAIRootProviderIdentity` |
| `agent-stream.ts` | understated | `AgentStream` (interface), `selectAgentStreamItems`, `isAgentStream`, `assertAgentStream`, `createAgentStream` |

## 3. Reclassified local interfaces (3 blockers + honest dispositions)

1. **`tool-call-arguments.ts` (was "Not a seam / pure JSON parsing helper")** → **local
   interface is sufficient — malformed-JSON diagnostic policy.** `parseToolCallArguments`
   (`:31-77`) applies a discriminating `{`/`[` heuristic and builds the fixed
   `invalidJsonDiagnostic` shape consumed by four independent owners
   (`stream-event-processor.ts`, `conversation-result-builder.ts`,
   `approval-decision-executor.ts`, `tool-approval-batch-coordinator.ts`). Non-brace
   malformed payloads silently pass through (`:75`). `normalizeToolCallArguments`
   (`:1-16`) is a dead export (delete-candidate). Range: `:1-77`.
2. **`openai-root-provider-identity.ts` (was "Not a seam / pure string matcher")** →
   **local interface is sufficient — session-scoped shared identity state.** Stateful
   class with a fail-quiet validity gate (`:15`) and last-write-wins (`:16`); producer
   `openai-candidate-observer.ts:45`, consumer `session-client-factory.ts:151` →
   selector-parity observer. Zero direct test coverage. Range: `:1-18`.
3. **`stream-snapshot.ts` (was "Type definitions only")** → **local interface is
   sufficient — SDK-shape isolation boundary.** Three extractor functions
   (`extractReplaySnapshot :36-46`, `extractFinalizationSnapshot :52-65`,
   `extractHistoryLength :71-75`) perform unchecked double casts and degrade shape
   changes to silent `[]`/`0`. Consumers: `turn-workflow.ts:653`, `session-stream-processor.ts`,
   `retry-classifier.ts:35`. Zero direct test coverage. Range: `:1-75`.
4. **`mode-notices.ts`** — keep **not a seam** but record honestly **untested**: model-
   facing `<system-notice>` prompt text (product behavior per AGENTS.md), sole consumer
   `runtime-setting-router.ts:117-118` (`planModeNotice(Boolean(value))`); transport is
   tested, content/branch selection is not. Range: `:1-24`.
5. **`interruption-info.ts`** — **local interface is sufficient**, cross-referenced to
   SB-03: `getMethod` (`:11`) is the duck-typing primitive at ~15 SB-03 catalog sites,
   including the two undeclared-method calls. Range: `:1-114`.
6. **`service-interfaces.ts`** — add the two omitted ports `ISessionContextService`
   (`:108`) and `ISettingsService` (`:113`); `ISettingsService` is a cross-owner seam into
   the undisposed `settings/` cluster. Range: `:1-139`.
7. **`file-service.ts`** — keep **local interface is sufficient**; record the five
   module-level mutable globals (`:38-42`) and worktree-switch invalidation
   (`:180-183`), cross-referenced to SB-08 row 3; traversal-caps test covers only caps.
   Range: `:1-207`.
8. **`agent-stream.ts`** — branded-type guard and item selector (not an event
   dispatcher); `assertAgentStream` is the fail-closed brand enforced by the
   architectural guard (below). Range: `:1-89`.

## 4. Corrected line ranges (all verified by `wc -l`; prior ranges unreliable)

Impossible ranges fixed: `stream-event-processor` `:1-350`→`:1-244`;
`command-message-streaming` `:1-75`→`:1-53`; `generation-guard` `:1-55`→`:1-34`;
`execution-context` `:17-87`→`:1-86`; `mode-notices` `:1-25`→`:1-24`.
Truncating ranges fixed (exact spans of classified behavior): `tool-call-arguments`
`:1-77`; `stream-snapshot` `:1-75`; `openai-root-provider-identity` `:1-18`;
`runtime-setting-router` `:1-134`; `file-service` `:1-207`; `tool-execution-ledger`
`:1-609`; `provider-continuity` `:1-323`; `large-uncached-input-guard` `:1-250`;
`notification-service` `:1-196`; `openai-root-selector-parity-observer` `:1-123`;
`input-surge-guard` `:1-148`; `history-service` `:1-165`; `background-task-activity`
`:1-96`; `model-service` `:1-136`; `interruption-info` `:1-114`; `plan-mode-interceptor`
`:1-55`; `agent-stream` `:1-89`.

## 5. Missing cluster dispositions

The completion criterion requires **clusters and root modules** to map to a disposition;
the ledger carried only root modules. This record adds the 19-row cluster table (§1).
Per the prior audit's recommendation, the three most load-bearing undisposed clusters are
**deferred to named follow-ups** (declared, not implied):

- **Follow-up 1 — `agent-runtime/` (28 files):** includes `application-run-loop.ts`, the
  application-owned run loop (AGENTS.md core). Defer to a dedicated SB-00 follow-up
  packet.
- **Follow-up 2 — `approval/` (18 files):** tool-approval + auto-approval owners;
  `tool-approval-batch-coordinator.ts` is already owned by Contract 11 C11-D5.
- **Follow-up 3 — `subagents/` (18 files):** named in three merged plans per AGENTS.md;
  `tool-policy.ts` already owned by Contract 11 C11-D10.
- Follow-ups 4–5 (`settings/` 12, `retry/` 9) and `hooks/` (10), `queue/` (1) carry the
  partial module-level dispositions noted in §1 and stay in the deferred set until every
  member file is mapped.

`test-helpers/` is **explicitly scoped out** as non-production.

## 6. Architectural guard row (add to ledger)

`source/services/application-stream-boundary.test.ts` — root-level architectural guard
with no production sibling; enforces that only `stream-event-processor.ts`,
`session/session-stream-processor.ts`, and `agent-stream.ts` touch the raw stream
boundary. **Not a seam** — it is the enforcement mechanism; cross-reference from the
`agent-stream.ts` and `stream-snapshot.ts` rows.

## 7. Deterministic tests recommended (only where the disposition is otherwise unprotected)

Ranked; none introduces a port; each requires a dedicated worktree + retained red before
any production change:

1. `OpenAIRootProviderIdentity` 3-case unit test (complete identity frozen; partial
   identity leaves `current` unchanged **including stale retention**; replacement
   overwrites) — zero coverage today, feeds two Contract 01/02 observers.
2. `parseToolCallArguments` 3-way heuristic test (parses → object; brace-prefixed
   malformed → diagnostic; non-brace malformed → silent pass-through) — pins the
   intentional heuristic.
3. `stream-snapshot` extractor degradation test (well-formed stream → arrays/lastResponseId;
   absent/non-array → `[]`/`0`, asserted as deliberate) — converts accidental silence
   into a recorded decision.
4. `planModeNotice` branch assertion in `runtime-setting-router.test.ts` (imported
   constants, not string literals) — cheapest sufficient proof of enter/exit selection.

## 8. Verdict

**SB-00 remains open** (no close evidence exists: 7 clusters / 96 files still lack
cluster-level dispositions). **Needs the President: no.** The next Engineering packet may
begin follow-up 1 (`agent-runtime/`) under the standing next-packet sequencing. This
record is audit/docs-only; its integration into the tracker (protected primary dirt) is
grant-gated.
