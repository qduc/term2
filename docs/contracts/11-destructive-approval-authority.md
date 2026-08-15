# Contract 11 — Destructive approval authority

Status: **audit draft — not owner-reviewed.** Owner: `ToolApprovalBatchCoordinator`
(`source/services/approval/tool-approval-batch-coordinator.ts`), `ApprovalDecisionExecutor`
(`source/services/approval/approval-decision-executor.ts`), `ConversationAdapter`
(`source/services/conversation/conversation-adapter.ts`), `SubagentToolPolicy`
(`source/services/subagents/tool-policy.ts`), and the durable log events
(`source/services/logging/conversation-log-events.ts`,
`source/services/logging/conversation-logger.ts`).

This record is **tests/docs-only**. It frames future contract tests under the three
immutable Presidential Contract 11 decisions (C11-D5 `record_rejected`, C11-D8
`additive_grant_kind`, C11-D10 `require_interactive_equivalent_provenance`). It does not
authorize production repair; every violation below is a retained public-boundary red that
may be flipped only under a separately authorized repair grant (D10 additionally requires
the provider black-box suite).

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C11.1 (D5) | A batch-denied tool call is durably recorded as an explicit **rejection** (`record_rejected`), never as approved, in every decision surface (`decisionsByCallId`, the `approval_resolved` log event, and the replay record). | Audit and replay describe a denied call as executed/approved, so a later repair or replay silently re-runs a destructive command the user denied. |
| C11.2 (D8) | The durable approval-resolution record preserves the **grant kind** additively: an optional, backward-compatible `grantKind` field distinguishes interactive, batch, policy, ask_user, and allow-once/remember/unsandboxed grants; existing `answer: 'y' \| 'n'` readers keep working. | Durable audit and replay collapse all approval modes to y/n, losing who/what granted a destructive action and why the kind matters for replay safety. |
| C11.3 (D10) | Non-interactive Yellow-risk approval requires **interactive-equivalent provenance** (risk, authority, confidence, and source evidence), exactly as interactive mode requires; a metadata-less approval is a contract violation and must be rejected. | Non-interactive automation approves Yellow-risk commands with no evidence of risk assessment, authority, or confidence, leaving a wider authority/provenance gap than interactive mode permits. |

The three invariants are deliberately independent: C11.1 fixes what the durable record says
about a denial, C11.2 fixes how much mode information the record keeps, and C11.3 fixes what
may approve a Yellow-risk command at all in non-interactive mode.

## 2. Owners

- **C11.1 enforcement:** `ToolApprovalBatchCoordinator.stageBatch` records per-call decisions
  (`decisionsByCallId`) and `ApprovalDecisionExecutor` settles them; `ConversationAdapter`
  and `conversation-log-events.ts` carry the durable `approval_resolved` event.
- **C11.2 enforcement:** `ConversationAdapter.handleApprovalDecision` emits the durable
  event; `ApprovalResolvedLogEvent` (`conversation-log-events.ts`) and
  `conversation-logger.ts` define/consume its shape.
- **C11.3 enforcement:** `SubagentToolPolicy.wrapShellTool` / `isYellowCommandApproved`
  decide non-interactive Yellow-risk shell approval in worker mode.
- **Recovery:** no repair is authorized under this record. Each invariant carries a
  retained public-boundary red that must flip only under a separately authorized repair
  grant; C11.3 additionally requires provider black-box validation.

## 3. Execution paths that share the contract

- Parallel/batch approval staging and continuation (`stageBatch`, `applyNextPlan`),
  including `isToolApproved` short-circuiting in the run context.
- Interactive and non-interactive approval resolution through
  `ConversationAdapter.handleApprovalDecision`, which clears the session projection and
  emits the durable event.
- Subagent worker shell execution through `SubagentToolPolicy.wrapShellTool` when the shell
  definition requires approval and the sandbox is not the sole boundary, with the
  `shell.autoApproveMode` policy.
- The durable log writer path for `approval_resolved` events (`conversation-logger.ts`).

## 4. Identities and state crossing the boundary

- `pending.decisionsByCallId: Map<callId, 'approved' | 'rejected'>` on the pending
  approval context; `ApprovalRecord` in `tool-invocation-context.ts`
  (`approved`/`rejected` per tool with callId lists) supplies `isToolApproved`.
- The durable `approval_resolved` event: `{ type: 'approval_resolved', turnId?, answer:
  'y' | 'n', rejectionReason? }` today; contractually extended with an optional additive
  `grantKind` field.
- Non-interactive worker YELLOW approval: `isYellowCommandApproved(command, taskContext)`
  today carries only the command and task context; contractually it must consume (and
  reject on the absence of) interactive-equivalent provenance (risk, authority, confidence,
  source).

## 5. Settlement semantics

- **Batch denial:** the call is skipped for execution (current behavior) **and** recorded as
  rejected in the durable decision surface (contract; today violated per C11.1 red).
- **Grant-kind resolution:** the durable event remains readable by existing `answer: 'y'|'n'`
  consumers; `grantKind` is additive and optional (contract; today absent per C11.2 red).
- **Non-interactive YELLOW:** without interactive-equivalent provenance the command is
  rejected with the existing blocked-for-safety error (contract; today accepted per C11.3
  red, which is the retained characterization red until a separately authorized repair).
- **Ambiguous/unknown:** any state that cannot be settled as approved-with-provenance or
  explicit rejection is treated as rejected for destructive authority.

## 6. Observability

- `approval_resolved` log events (with `grantKind` after the C11.2 repair) in the durable
  conversation log and provider-traffic artifacts.
- The batch coordinator's `decisionsByCallId` per-call decisions.
- The worker shell blocked-for-safety error string for C11.3 rejections.

## 7. Public boundary under test

- C11.1: `ToolApprovalBatchCoordinator.stageBatch` with a run context whose `isToolApproved`
  returns `false` for a call — the durable `decisionsByCallId` entry must be `'rejected'`.
  Red: `source/services/approval/c11-d5-batch-denial-boundary.test.ts`.
- C11.2: `ConversationAdapter.handleApprovalDecision` with a captured log sink — the
  `approval_resolved` event must carry an additive `grantKind`. Red:
  `source/services/conversation/c11-d8-grant-kind-boundary.test.ts`.
- C11.3: `SubagentToolPolicy.wrapShellTool` / worker manager path — a metadata-less YELLOW
  approval (positive advisory with no risk/authority/confidence/source) must be rejected.
  Red: `source/services/subagents/c11-d10-provenance-boundary.test.ts`.

## 8. Deterministic contract matrix

| Cell | C11.1 (D5) | C11.2 (D8) | C11.3 (D10) |
| --- | --- | --- | --- |
| Denied batch call | retained red (currently `'approved'`) | n/a | n/a |
| Interactive y/n event | n/a | retained red (no `grantKind`) | n/a |
| Metadata-less YELLOW, non-interactive | n/a | n/a | retained red (currently accepted) |
| YELLOW with full provenance | n/a | n/a | characterizable after repair (future) |

All three reds were first observed in ordinary `it` form and then retained as expected
failures; see the test files for the exact observed failure text.

## 9. Verification commands

- Focused: `NODE_ENV=test pnpm --dir /home/qduc/term2/.worktrees/c11-destructive-approval-contract vitest run source/services/approval/c11-d5-batch-denial-boundary.test.ts source/services/conversation/c11-d8-grant-kind-boundary.test.ts source/services/subagents/c11-d10-provenance-boundary.test.ts` (3 files; 3 retained expected failures).
- Typecheck, Prettier, and `git diff --check` pass (tests/docs-only).
- Provider black-box is **not** run for this tests/docs-only slice; C11.3's repair (not this record) requires it.

## 10. Known gaps and classification

- **C11.1 gap (product defect):** batch-denied calls are recorded as `'approved'` when
  `isToolApproved` returns any defined value (`tool-approval-batch-coordinator.ts`, short-circuit
  branch). D5 `record_rejected` requires explicit rejection. Retained red; repair separately
  authorized.
- **C11.2 gap (product defect):** `ApprovalResolvedLogEvent` carries only `answer: 'y' | 'n'`;
  the adapter emits no `grantKind` (`conversation-adapter.ts` emit; `conversation-log-events.ts`
  shape). D8 `additive_grant_kind` requires the additive field. Retained red; repair separately
  authorized.
- **C11.3 gap (product defect / security):** the non-interactive worker YELLOW path approves on a
  metadata-less advisory (`isYellowCommandApproved`). D10 `require_interactive_equivalent_provenance`
  requires rejection without equivalent provenance. Retained red; repair separately authorized and
  provider black-box validated.
- **Tracker reconciliation (paper):** `docs/plans/service-boundary-contract-completion.md`
  (protected untracked on primary; corrected copy lives only in this worktree) contains the stale
  sentence "Approval still awaits D5/D8/D10 owner decisions." in the Contract 10 section. The C11
  v2 decision cycle is terminally complete (D5 `record_rejected`, D8 `additive_grant_kind`, D10
  `require_interactive_equivalent_provenance`), so that sentence is to be replaced at integration
  time with a pointer to this record. No primary edit is made by this packet.
