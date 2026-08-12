# Tool output bounding and effect safety

Status: **design only, awaiting implementation approval.** Nobody is on it.

## Resume here

Two defects exist in the shipped code today, independent of context compaction.
Both are cheap to fix and both block the compaction plan from delivering what it
promises.

1. **`read_file` returns an unbounded slice.** `tools/file/read-file.ts` filters
   the requested line range and returns it with no byte cap. A lockfile, a
   minified bundle, or a generated file enters context whole. A "verbatim hot
   tail" is not achievable while one tool result can exceed the model window on
   its own.
2. **The tool ledger cannot express an ambiguous outcome.** `ToolExecutionStatus`
   is `'started' | 'completed' | 'failed' | 'approval_required' | 'aborted'`
   (`services/tool-execution-ledger.ts`). On stream failure,
   `services/retry/recovery-executor.ts` calls `recordAbortedApproval` and
   `markOpenCallsAborted` so in-flight calls receive synthetic **error** results
   and history stays self-contained. A shell command that dispatched, performed
   an irreversible side effect, and then lost its stream is therefore reported to
   the model as failed — and the model retries it.

**Why this is a separate plan.** These pay off with or without compaction, and
two of them are live bugs. More importantly, compaction cannot own either
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

Status: **pending.**

The requirement is that results are **bounded**. Retrieval of the full payload
already works: `saveShellOutputArtifact` writes it to a file and the result text
names the path, which the agent reads back with an ordinary file read. Reuse
that; do not build a store.

- Cap `read_file` by bytes as well as by line range. Over the cap, return path,
  total line count, requested range, bounded content, and a spooled-file path in
  the same shape shell already uses.
- Apply the same treatment to the other unbounded producers: web fetch and
  `apply-patch` diffs. (The search-style tools — `grep`, `glob`, `code-context`
  — already cap their result counts.)
- Reuse `formatShellExecutionOutput`'s spooling helper rather than duplicating
  it, and keep the `Full output saved to \`<path>\`` note shape unchanged; the
  agent's follow-up read depends on it.
- Cover: a file larger than the cap, a binary file, a multibyte character on the
  cap boundary, and the unchanged shell note.

This milestone has no effect-safety semantics and no model-behavior change
beyond smaller results.

## Milestone 2 — ambiguous effect status and verify-before-retry

Status: **pending.**

- Add `'unknown'` to `ToolExecutionStatus` and to
  `conversation-state-schema.ts`, with a migration path for logs written before
  it existed.
- Split today's single failure mapping in `recovery-executor.ts`. A call that
  never dispatched settles as `aborted`. A call that dispatched but whose
  outcome was never observed settles as `unknown`.
- The synthetic tool result injected for an `unknown` call must state that the
  outcome is unobserved and that the operation must be verified before any
  retry. It must not read as a failure.
- Never auto-retry an `unknown` non-idempotent operation. Recovery paths that
  currently replay must consult status first.
- Cover: stream failure after dispatch, stream failure before dispatch, resume
  with an `unknown` entry present, projection and ledger reconciliation of
  `unknown`, and the black-box scenario where a completed side effect is not
  repeated after recovery.

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
  confirmation, or annotate and continue.
- Whether the `read_file` byte cap should be a setting or a constant.
