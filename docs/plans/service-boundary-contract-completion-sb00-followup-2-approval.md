# SB-00 Follow-up 2 — `approval/` cluster disposition

Status: **audit/docs — all 18 `source/services/approval/` production files disposed.**
Evidence basis: export inventory (`grep '^export'` per file), bounded source reads, line
counts (`wc -l`), and cross-references to contract records and merged plans. No test was
executed; no claim of passing tests is made. No production source changed; no new formal
contract created; no commit or merge. Framing applied (immutable, terminal): **C11-D5
`record_rejected`** and **C11-D8 `additive_grant_kind`**; no production repair is
authorized by this record.

## Disposition summary (18 files)

**Already owned — recorded, not re-owned (2):**

| File | Ownership |
| --- | --- |
| `tool-approval-batch-coordinator.ts` (229) | **Contract 11 C11-D5** (packet evidence ref `:84-106`). Local interface sufficient; owns the batch-denial durable decision. Not re-owned here. |
| `approval-decision-executor.ts` (293) | Settles per-call decisions (`decisionsByCallId` 'approved'/'rejected'; `ApprovalDecisionSource` user/policy/system). **C11-D5 durable-decision surface** (batch-denial settlement flows through it); cross-ref Contract 11. Local interface sufficient. |

**Local interface is sufficient — contract/plan cross-referenced (16):**

| File | Role / cross-reference |
| --- | --- |
| `approval-flow-coordinator.ts` (206) | `ContinuationPlan`/`AbortResolutionPlan` — SB-01 owner surface (`turn-workflow` continuation via `approval-flow-coordinator.ts:39-42`); Contract 01. |
| `approval-state.ts` (88) | `PendingApprovalContext`/`ApprovalState` shared state; Contract 01/SB-01 turn state. C11-D8 note: durable grant-kind flows through this surface at repair time (recorded, no repair). |
| `approval-replay.ts` (100) | `replayApprovals` parent→child replay; Contract 02 (replay) + Contract 03 (child identity). C11-D8 note: additive `grantKind` is a replay/decoder surface at repair time (recorded, no repair). |
| `non-interactive-approval-policy.ts` (116) | `NonInteractiveApprovalPolicy` — root non-interactive approval policy. **C11-D10 framing applies directly** (`require_interactive_equivalent_provenance`: non-interactive mode requires `--auto-approve` or equivalent provenance). Local interface sufficient. |
| `shell-auto-approval-evaluator.ts` (655) | LLM advisory evaluation. **C11-D10 framing** (metadata-less advisory is the D10 red surface at the worker tool-policy seam); Contract 05 (shell approval safety). Local. |
| `shell-auto-approval-resolver.ts` (208) | `AutoApproveMode` off/advisory/auto/always policy. Contract 05; C11-D10 framing. Local. |
| `shell-sandbox-approval.ts` (64) | `requiresHumanShellApproval`/`isUnsandboxedShell`/`isDockerHostControlShellApproval`. Contract 05 C5.5 (fail-closed sandbox). Local. |
| `tool-approval-policy-registry.ts` (44) | `auto_approve`/`prompt`/`unknown` policy registry. Contract 05 auto-approval policy. Local. |
| `approval-decision-policy.ts` (29) | Manual/ShellAutoApproval decision policies. Contract 05. Local. |
| `approval-presentation-policy.ts` (82) | Command-message filter/annotation for presentation. Local UI-facing helper; no alternate adapter. |
| `background-subagent-approval-controller.ts` (102) | Background subagent approval flow. `background-work-control` plans (merged) + Contract 03 (child-run approvals) + `mid-turn-injection` (background notifications). Local. |
| `background-subagent-approval-queue.ts` (318) | Stable per-generation approval identity for adopted runs. `background-work-control` (transfer leases/adopted-child approval) + Contract 03. Local. |
| `session-read-access.ts` (61) | `SessionReadAccess` singleton + `isSessionReadGranted`. Read-authorization default consumed by tool policy; Contract 04 (settings consumption) / workspace read defaults (Contract 09). Local. |
| `session-read-grant-target.ts` (39) | `resolveSessionReadFolder` helper. Local. |
| `tool-ownership-registry.ts` (52) | `ToolOwnershipRegistry`. Contract 03 (child-run authority/ownership). Local. |
| `tool-owner.ts` (14) | `ToolOwner`/`PARENT_TOOL_OWNER` types. Contract 03. Not a seam (types). |

**Formal contract (0 new):** `tool-approval-batch-coordinator.ts` already earned Contract 11;
no other member warranted a contract. No port added for export alone.

## Remaining undisposed after this follow-up

SB-00 remains **open**: 5 clusters / **50 files** now undisposed at cluster level —
`subagents/` (18), `settings/` (12), `hooks/` (10), `retry/` (9), `queue/` (1) — each
carrying only the partial module-level dispositions recorded in the SB-00 correction
record. Follow-ups 3–5 were not started in this packet.

## Gates

Prettier clean; `git diff --check` clean; worktree touch set exactly three docs files
(correction + follow-up 1 + this record). No test suite applicable. Primary protected
dirt and HANDOFF.md byte-identical.
