# SB-00 Follow-up 1 — `agent-runtime/` cluster disposition

Status: **audit/docs — all 28 `source/services/agent-runtime/` production files disposed.**
Evidence basis: export inventory (`grep '^export'` per file), bounded source reads of every
member, line counts (`wc -l`), and cross-references to merged plans, the guard ledger, and
existing contract records. No test was executed and no claim of passing tests is made. No
production source changed; no new formal contract created (every seam below already earned
one or is dispositioned as local); no commit or merge.

## Disposition summary (28 files)

**Not a seam (6):** pure types/re-export barrels.

| File | Evidence |
| --- | --- |
| `types.ts` (246) | `ModelTier`, `RelativeModelPolicy`, `ExactModelPolicy`, `RunInput`/`RunResult`/`AgentConfig`/`AgentHandle` shapes. Types only. |
| `resolved-agent.ts` (42) | `ResolvedAgentDefinition` interface. Types only. |
| `index.ts` (63) | Public re-export barrel for the cluster. Deliberate surface control, not a seam. |
| `internal.ts` (45) | Internal re-export barrel narrowing the cross-cluster surface. Not a seam. |
| `context-compaction/index.ts` | Re-export of the local compactor. Not a seam. |
| `workflow/workflow-types.ts` | Workflow request/result types. Types only. |

**Local interface is sufficient (22):**

| File | Role / owner cross-reference |
| --- | --- |
| `application-run-loop.ts` (1913) | Application-owned run loop. **Contract-bound by existing records, not a new contract:** Contract 01 (turn lifecycle), Contract 02 (continuity/chaining — `chain-settlement` plan), Contract 05 (guards; guard-ledger records `deps.maxParallelToolCalls` declared at `:169`/`:343` never supplied — a classified gap), `run-budget-stall-escalation` (RunBudget/stall/`max_turns_exceeded`), `parallel-safe-tool-dispatch`, `mid-turn-injection` (steer), `tool-output-and-effect-safety` (dispatch marking/stream-failure settlement). Orchestration seam whose pieces are already owned. |
| `run-budget.ts` (344) | `RunBudgetPolicy`/`readRunBudgetPolicy`/`clampRunBudgetPolicy`. Owned by `run-budget-stall-escalation` (merged) + Contract 05. |
| `generation-guard.ts` (400) | Repetition/runaway guard family. Owned by `docs/plans/guard-ledger.md` + Contract 05; also referenced by `decouple-from-openai-agents-sdk` and `turn_coordinator_refactor`. |
| `tool-invocation-context.ts` (111) | `ApprovalLedger` (`approveTool`/`rejectTool`/`isToolApproved`/`snapshot`). Cross-ref **Contract 11 C11-D5** (packet evidence ref `:53-59`) — batch-denial durable semantics. |
| `execution-budget.ts` (262) | `ExecutionBudget`/`AcquiredChildSlot` — child slot acquisition. Cross-ref Contract 03 (child-run identity/authority/lifecycle). |
| `agent-handle.ts` (301) | `AgentHandleImpl` — handle lifecycle + permission/limit validation. Cross-ref Contract 03 and `background-work-control` (foreground-subagent transfer). |
| `compose-agent-runtime.ts` (176) | Runtime composition facade. Cross-ref Contract 03. |
| `agent-runtime.ts` (115) | `AgentRuntime` facade tying resolvers together. Local composition; cross-ref Contract 03. |
| `agent-resolver.ts` (113) | Config→definition resolution. Local; no alternate adapter. |
| `model-resolver.ts` (112) | `resolveModelPolicy`/`resolveAncillaryModelTier` via `ISettingsService`. Local. |
| `permission-resolver.ts` (239) | Permission/limit mapping + typed errors. Local; feeds scope-resolver. |
| `scope-resolver.ts` (723) | Filesystem/network scope resolution (subagent sandbox scopes). Cross-ref Contract 05 C5.5 (fail-closed sandbox) and Contract 11 C11-D10 area (non-interactive worker provenance). Local. |
| `skill-resolver.ts` (61) | Skills instruction resolution. Local. |
| `tools-resolver.ts` (96) | Tool-name→permission mapping. Local. |
| `structured-output.ts` (246) | Run output schema validation. Local. |
| `text-attachment.ts` (133) | Attachment validation/serialization. Local. |
| `legacy-adapter.ts` (70) | Legacy role/definition → `SubagentDefinition` adaptation. Local. |
| `executor.ts` (183) | Subagent/mentor run functions + result mapping. Cross-ref Contract 03. Local. |
| `context-compaction/local-context-compactor.ts` | Local cold-prefix compactor. Owned by `provider-neutral-context-compaction` (merged, Milestones 1–6). Local. |
| `workflow/workflow-evaluator.ts` | Programmable-agent-workflow evaluator. Cross-ref `agent-runtime-workflow-mvp.md` / `agent-runtime-workflow-scratchpad.md`. Local. |
| `workflow/workflow-worker.ts` | vm-sandboxed JS evaluator in a worker thread (security-relevant sandbox seam). Cross-ref the workflow plans + Contract 05 sandbox family. Local. |
| `workflow/workflow-sandbox.ts` | Workflow sandbox construction. Cross-ref the workflow plans + Contract 05. Local. |

**Formal contract (0 new):** no member needed a new formal contract — every seam already
earned contract/plan ownership (Contract 01/02/03/05/11, the guard ledger, and the four
named merged plans). No port was added for export alone.

## Remaining undisposed after this follow-up

SB-00 remains **open**: 6 clusters / **68 files** now undisposed at cluster level —
`approval/` (18), `subagents/` (18), `settings/` (12), `hooks/` (10), `retry/` (9),
`queue/` (1) — each carrying only the partial module-level dispositions recorded in the
SB-00 correction record. Follow-ups 2–5 were not started in this packet.

## Gates

Prettier clean; `git diff --check` clean; worktree touch set exactly two files
(`service-boundary-contract-completion-sb00-correction.md` + this record), both docs-only.
No test suite applicable. Primary protected dirt and HANDOFF.md byte-identical.
