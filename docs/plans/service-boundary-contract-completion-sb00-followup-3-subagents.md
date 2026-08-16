# SB-00 Follow-up 3 — `subagents/` cluster disposition

Status: **audit/docs — all 18 `source/services/subagents/` production files disposed.**
Evidence basis: export inventory (`grep '^export'` per file), bounded source reads of every
member, line counts (`wc -l`), and cross-references to contract records (Contract 03
child-run identity/authority/lifecycle; Contract 11 C11-D10; Contract 02/04/05) and merged
plans (`background-work-control/MAP.md`, `background-work-control/unified-subagent-ui.md`,
`mid-turn-injection.md`, `run-budget-stall-escalation.md`, `guard-ledger.md`,
`chain-settlement.md`, `worker_subagents.md`). No test was executed; no claim of passing
tests is made. No production source changed; no new formal contract created; no commit or
merge. Framing applied (immutable, terminal): **C11-D10
`require_interactive_equivalent_provenance`**; no production repair is authorized by this
record.

## Disposition summary (18 files)

**Already owned — recorded, not re-owned (1):**

| File | Ownership |
| --- | --- |
| `tool-policy.ts` (1055) | **Contract 11 C11-D10** (Contract 11 record §1 C11.3, §2, §7, §10): owner `SubagentToolPolicy`, enforcement `wrapShellTool` (`:361`) / `isYellowCommandApproved` (`:339`) for non-interactive worker YELLOW shell approval; red `source/services/subagents/c11-d10-provenance-boundary.test.ts`. Also **Contract 03 C3.3** (permission/capability attenuation, `tool-policy.test.ts:90-146`). Recorded, not re-owned here. |

**Not a seam (4):**

| File | Evidence |
| --- | --- |
| `types.ts` (267) | `SubagentRequest`/`SubagentResult`/`SubagentDefinition`/`SubagentRunHandle`/`SubagentRunStatus` + steer/cancel acknowledgement unions. Types only; Contract 03 cites the shapes directly (`:6-10` roles, `:155-161` status union, `:196-209` `NestedSubagentResult`, `:211-219` handle). |
| `subagent-client-types.ts` (23) | `ISubagentClient`/`ISubagentClientFactory` narrow interface breaking the SubagentManager↔OpenAIAgentClient circular import. Interface only; no alternate adapter. |
| `utils.ts` (247) | Pure helpers: abort-like detection, max-turns classification/`buildTurnBudgetExhaustedFinalText`, final-text extraction, composite abort signal, preview truncation, `formatSubagentResult`. Behavior owned at call sites (`run-budget-stall-escalation` max-turns text; `background-work-control` preview/liveness). |
| `test-helpers/subagent-manager-fixtures.ts` (215) | Non-production test fixtures (mock logger/settings/session services, `TestSubagentManager`). Scoped out on the same basis as top-level `test-helpers/` (SB-00 correction §1/§5: non-production fixtures/mocks). |

**Local interface is sufficient — contract/plan cross-referenced (13):**

| File | Role / cross-reference |
| --- | --- |
| `runtime.ts` (159) | `createSubagentRuntime` composition facade over the five runners + tool policy. Named owner in **Contract 03** (header §owner). Local composition. |
| `subagent-manager.ts` (260) | `SubagentManager` facade: run/runAsTool/startRunAsync/`moveForegroundSubagent`/steer/cancel/getRunStatus. **Contract 03** (child lifecycle), `background-work-control` (foreground-subagent transfer), `mid-turn-injection` (steering). Local. |
| `subagent-async-registry.ts` (911) | `SubagentAsyncRegistry` — async identity, admission, cancellation, settlement, retention/eviction, steering mailbox, foreground-lease adoption. **Contract 03** (C3.1/C3.2/C3.5/C3.6, §2/§4/§5/§7), `background-work-control/MAP.md` (background registries, task-control port, transfer leases, adopted-child approval), `mid-turn-injection` (steering delivery lanes). Local. |
| `nested-runner.ts` (776) | `NestedSubagentRunner` — foreground nested runs via `ApplicationRunLoop`, role-tool cache, parent `ApprovalLedger` replay, lease adoption, worker worktree pin. **Contract 03** (C3.2/C3.5, §4/§5/§7), **Contract 11 C11-D5** (parent approvals replayed onto the nested ledger, `nested-runner.ts:95-98`), `background-work-control` (adopted-child approval, transfer), `run-budget-stall-escalation` (run-budget clamp + wrap-up). Local. |
| `execution-runner.ts` (519) | `ExecutionSubagentRunner` — session-runtime execution, child-slot budgets, worktree pin, diff/validation evidence capture, turn-budget containment settlement. **Contract 03** (C3.3 budgets, §7), **Contract 02** (continuity/settlement), `run-budget-stall-escalation` (max-turns budget stop), `tool-output-and-effect-safety` (diffStat/validation evidence), **C11-D10 framing** (worker shell tools built here flow through the `SubagentToolPolicy` seam; recorded, no repair). Local. |
| `mentor-runner.ts` (342) | `MentorRunner` — consultation fan-out, persistent mentor session, `runBudget`/wrap-up. **Contract 03** (§2/§7), **Contract 04** (`agent.mentorPool`/`mentorSamples`/`mentorMode` settings), `run-budget-stall-escalation` (wrapUpOnCriticalRunBudget), Contract 02 (previousResponseId chaining). Local. |
| `subagent-session.ts` (144) | `SubagentSession` — persistent/one-shot session state (history, `previousResponseId`, tool ledger). **Contract 02** (provider-input continuity, chaining), `chain-settlement` (`previousResponseId` debt must not outlive unpaid tool calls), `provider-neutral-context-compaction` (tool-ledger/continuity safety). Local. |
| `foreground-subagent-lease.ts` (237) | `ForegroundSubagentLease` — cancellation link, detach/adopt, exactly-once resumable pause. **Contract 03** (C3.2/C3.4, §2/§5/§7), `background-work-control` (transfer leases, adopted-child approval queue), `guard-ledger.md:657` (lifecycle state-machine guards). Local. |
| `subagent-run-control.ts` (200) | `SubagentRunControl` — per-run steering mailbox (4 messages / 4000 chars), continuation segments, question waiters, abort reasons. `guard-ledger.md:190`, `:306-323` (steering-mailbox guard; enforcement owner), `mid-turn-injection` (**Segment**/**Injection** vocabulary). Local. |
| `subagent-notification-store.ts` (554) | `SubagentNotificationStore` — background notification dedup/replay protection, drain/retain delivery, task projection. `background-work-control` (unified-subagent-ui: `BackgroundTasksPanel`/notification lanes), `mid-turn-injection` (**Background Notification**), `run-budget-stall-escalation.md:204-205` (budget notifications inject at the store). Local. |
| `role-loader.ts` (266) | Role markdown frontmatter → `SubagentDefinition`; model/provider resolution via ancillary tiers. **Contract 04** (settings consumption: `agent.mentorPool`, `agent.<tier>Model` etc.); local prompt surface (`source/prompts/subagents/`). Local. |
| `codename-run-id.ts` (694) | Codename runId generator (`adjective-noun-number`). **Contract 03 C3.1/§4** (async id identity; cited at `:645`, `:681-693`). Pure generation helper; explicit non-determinism is a recorded decision. Local. |
| `worker-worktree.ts` (97) | `pinWorkerWorktree` — resolve an existing worktree by name and pin the worker's `ExecutionContext`; worker-only, refuses remote mode. `worker_subagents.md:321` (shipped pin), **Contract 05** (fail-closed sandbox/scope authority), **Contract 03** (child scope attenuation). Local. |

**Formal contract (0 new):** `tool-policy.ts` already earned Contract 11 C11-D10 (recorded,
not re-owned); no other member warranted a contract — every seam already earned
contract/plan ownership (Contract 02/03/04/05/11, guard-ledger, and the named merged
plans). No port added for export alone.

## C11-D10 framing (applied as framing only, no repair)

- **Owned surface:** `SubagentToolPolicy.wrapShellTool`/`isYellowCommandApproved`
  (`tool-policy.ts`) — Contract 11 C11-D10; the retained red is
  `c11-d10-provenance-boundary.test.ts`. Recorded, not re-owned.
- **Framing on consumers:** `execution-runner.ts` and `nested-runner.ts` build worker
  shell tools through the shared `SubagentToolFactory` → `SubagentToolPolicy` seam; a
  future D10 repair (separately authorized, provider black-box required) lands at the
  tool-policy seam and flows through both runners unchanged. Recorded only.

## Remaining undisposed after this follow-up

SB-00 remains **open**: 4 clusters / **32 files** now undisposed at cluster level —
`settings/` (12), `hooks/` (10), `retry/` (9), `queue/` (1) — each carrying only the
partial module-level dispositions recorded in the SB-00 correction record. Follow-ups 4–5
(`settings/`, `retry/`) and the `hooks/`/`queue/` rows were not started in this packet.

## Gates

Prettier clean; `git diff --check` clean; worktree touch set exactly four docs files
(correction + follow-up 1 + follow-up 2 + this record). No test suite applicable. Primary
protected dirt and HANDOFF.md byte-identical.
