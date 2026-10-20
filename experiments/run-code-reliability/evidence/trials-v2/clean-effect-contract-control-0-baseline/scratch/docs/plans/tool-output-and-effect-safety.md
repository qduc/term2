# Tool output bounding and effect safety

Status: **implemented and merged** (Milestones 1 and 2; `a41186d6`, from branch `tool-output-effect-safety`).

## Resume here

Both defects are fixed. Compaction can rely on:

1. **Bounded tool results** — `read_file`, `web_fetch`, and `apply_patch` results that enter model context are capped; oversize payloads spool to a temp file with the shell note `Full output saved to \`<path>\``.
2. **Ambiguous effect status** — `ToolExecutionStatus` includes `'unknown'`. Stream recovery settles never-dispatched open calls as `aborted` and dispatched-but-unobserved calls as `unknown` with a verify-before-retry synthetic result (not a failure).

**Why this is a separate plan.** These pay off with or without compaction, and
two of them were live bugs. More importantly, compaction cannot own either
guarantee: a summary is not a mechanism for at-most-once execution, and a
compaction policy cannot bound a tool result that was already unbounded when it
entered history. `docs/plans/provider-neutral-context-compaction.md` depends on
this plan's Milestones 1 and 2; its `blocked: single_turn_too_large` outcome and
its "completed calls must not be executed again" invariant are only enforceable
once these land.

Before touching this area, also read:

- `docs/plans/chain-settlement.md` for outstanding tool debt and continuity;
- `docs/plans/provider-neutral-context-compaction.md` for the consumer;
- `docs/plans/background-shell-monitor/MAP.md` for the background output store,
  which already solves an adjacent overflow problem;
- the `architecture`, `testing`, and `provider-testing` skills.

## Destination

- Every tool result entering model context is bounded, and the full payload
  stays retrievable through the mechanism shell output already uses.
- Every externally visible operation has a durable record whose status
  distinguishes "did not happen" from "we do not know whether it happened".
- An ambiguous outcome is never reported to the model as a failure, and a
  non-idempotent operation is never silently re-dispatched after one.

Exactly-once execution for arbitrary shell commands is not achievable and is not
claimed. For an opaque command with an ambiguous outcome the correct recorded
state is `unknown`, not "probably failed, try again."

## Existing baseline that must survive

- `utils/shell/shell-output.ts` already implements the target pattern for the
  highest-volume tool: trim to `maxOutputLength`, write the full stdout/stderr
  plus command, cwd, status, and runtime to a file, and append a
  `Full output saved to \`<path>\`` note. The note's shape is load-bearing — the
  agent reads that path back today. Do not change the prose contract without
  updating the shell tool description in the same commit.
- The tool ledger is a recovery structure. `projectProviderHistory` reinserts
  completed call/result pairs that are missing from history, and drops
  incomplete ones. Adding a status must not make an unfinished operation look
  completable.
- Chain settlement: a terminated stream must leave no live `previousResponseId`
  and no unpaired function call.
- Sandbox write policy (`utils/shell/sandbox/sandbox-policy.ts`) bounds where
  spooled output may be written.

## Milestone 1 — bounded tool results

Status: **done.**

- Cap `read_file` by UTF-8 bytes as well as by line range. Over the cap, return path,
  total line count, requested range, bounded content, and a spooled-file path with
  `Full output saved to \`<path>\``. Binary files are refused without dumping.
- `web_fetch` uses the same spool helper and note shape (replacing the prior
  "Full content saved to temp file" prose).
- `apply_patch` results and large error fragments are bounded via the same helper.
- Shared helpers: `saveOutputArtifact` / `formatFullOutputSavedNote` in
  `utils/shell/shell-output.ts`, and `boundToolResultText` /
  `truncateToUtf8Bytes` in `utils/output/bound-tool-result.ts`.
- Covered: oversize file, binary file, multibyte character on the cap boundary,
  unchanged shell note shape.

## Milestone 2 — ambiguous effect status and verify-before-retry

Status: **done.**

- `'unknown'` added to `ToolExecutionStatus` and `conversation-state-schema.ts`,
  with migration of unrecognized historical statuses to `aborted`.
- `dispatchedAt` + `markDispatched` / `settleOpenCallsOnStreamFailure` on the
  ledger. Run loop calls `getOnToolDispatch` before `execute`; session
  composition wires it to the tool tracker.
- Never-dispatched open calls → `aborted` with synthetic error result.
  Dispatched, unobserved → `unknown` with verify-before-retry message (not a failure).
- Projection / restore treat `unknown` pairs like aborted pairs for history
  repair. Local synthetic pairs still do not pay provider-side tool debt while
  `previousResponseId` is live (chain settlement still clears the chain).
- Covered: stream failure after/before dispatch, resume with unknown present,
  projection and ledger reconciliation of unknown, run-loop dispatch ordering,
  existing black-box "side effect not re-executed after recovery" (compaction path).

## Explicitly out of scope

- Exactly-once effects for arbitrary shell commands.
- Structured wrappers for deploy/publish/migrate classes.
- Full-text or vector indexing over history.
- Changing the compaction summarizer or its prompt.

## Considered and deferred

Recorded so the reasoning is not re-derived. Neither has a demonstrated present
failure, and both were proposed as seams for work that is itself deferred.

- **A typed session artifact store** — content-addressed ids, durable under the
  session log directory, a retention policy, and an `artifact.read(id, range)`
  tool. This buys machine-resolvable retrieval and survival across restart. The
  present requirement is only that results are *bounded*, and the existing
  spool-and-name-the-path mechanism already lets the agent read the payload
  back. Build it when retrieval is built.
- **Canonical operation keys and approval rebinding** — binding approvals to a
  normalized action key rather than `{ toolName, callId }`, with a pre-dispatch
  lookup that surfaces an existing verified-succeeded record. This was proposed
  as the hook for a forced memory lookup that the compaction plan defers. No
  approval-rebinding defect has been observed or investigated; find one first.

## Open questions, not design blockers

- Whether an `unknown` operation should block the turn pending user
  confirmation, or annotate and continue. (Shipped: annotate and continue.)
- Whether the `read_file` byte cap should be a setting or a constant.
  (Shipped: constant aligned with `getTrimConfig().maxCharacters`, default 40_000.)
