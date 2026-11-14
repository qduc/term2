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
entered history. `docs/plans/context-and-memory/provider-neutral-context-compaction.md` depends on
this plan's Milestones 1 and 2; its `blocked: single_turn_too_large` outcome and
its "completed calls must not be executed again" invariant are only enforceable
once these land.

Before touching this area, also read:

- `docs/plans/providers/chain-settlement.md` for outstanding tool debt and continuity;
- `docs/plans/context-and-memory/provider-neutral-context-compaction.md` for the consumer;
- `docs/plans/background-work/background-shell-monitor/MAP.md` for the background output store,
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
  The prefix and path are unchanged; the note may now end with the spooled file's
  total line count (`(1090 lines)`), which is the file's `wc -l` and always right.
  A shell stream trimmed by lines carries `... [lines 408-697 of 1101 trimmed] ...`
  in the spooled file's own line numbers (header lines included) only when no later
  layer re-cuts it: no character bound re-trimmed the marked stream, and the finished
  result is within the line and character limits the generic tool-result trim applies
  afterwards. Otherwise (long lines, stdout and stderr both over the limit, other
  producers' generic `trimOutput`) the marker is the count-only `... [N lines
  trimmed] ...`, which makes no range claim. A precise-looking wrong range sends the
  model to the wrong place, so a range is emitted or not at all. What is kept and how
  much is unchanged.
- The tool ledger is a recovery structure. `projectProviderHistory` reinserts
  completed call/result pairs that are missing from history, and drops
  incomplete ones. Adding a status must not make an unfinished operation look
  completable.
- Chain settlement: a terminated stream must leave no live `previousResponseId`
  and no unpaired function call.
- Sandbox write policy (`utils/shell/sandbox/sandbox-policy.ts`) bounds where
  spooled output may be written.

### Shell command quoting at the sandbox boundary

The sandbox runtime uses `shell-quote` repeatedly to carry a command through
nested shells. Version 1.8.4 backslash-escaped `!` inside double quotes, where
non-interactive Bash preserves that backslash. Commands containing both quote
styles could therefore turn Python `!=` or `!r` into invalid source, causing
the agent to regenerate otherwise valid validation scripts. The pinned patch
emits a single-quoted bang between double-quoted segments, preserving the
argument bytes without interpreting shell metacharacters. Remove it when the
upstream dependency provides equivalent byte-preserving quoting.

`tests/tools/shell/sandbox-quoting.integration.test.ts` exercises the real
sandbox and child processes, including quoted heredocs, literal arguments and
genuine interpreter failure. Mocking the wrapper misses this defect. When
investigating similar failures, compare the original command, the wrapped
command and the interpreter's received bytes before changing model guidance.

### Source shell output preferences

The source `createShellToolDefinition` and `executeFormattedShellCommand` pass the effective
`shell.maxOutputLines` and `shell.maxOutputChars` settings to
`formatShellExecutionOutput`. Limits apply independently to stdout and stderr,
not to the total tool-result envelope. Lines are logical data lines: interior
blank lines count, an empty stream has zero, and a final newline is a delimiter
rather than an extra line. Above the line threshold the formatter retains head
and tail data (at a limit of one, the first line), with an omitted-line marker;
status, runtime, marker and artifact note are additional metadata. Equality does
not truncate. Existing presentation trimming of trailing whitespace is unchanged.
Character bounding follows line bounding and can reduce retained data further.
Neither preference changes the command's exit status or stops its execution.

Any omitted data triggers the existing complete captured stdout/stderr artifact
and `Full output saved to` note. The settings do not enlarge the executor's
capture buffer or change artifact lifetime. This contract covers the source
formatter and its callers, not native background output storage or readback.

Failure lesson: reading only `shell.maxOutputChars` at the shell callers left the
stored line preference inert; simply forwarding lines to the generic `trimOutput`
was insufficient because its ten-line retention floor also defeats small limits.
Keep small positive limits and delimiter/blank-line boundaries in real-executor
checks, alongside the character-cap and nonzero-exit controls. The shell-specific
formatter owns strict line retention without changing other tools' trim policy.

The direct application's shared trim scope must also start from the resolved
session settings, not wait for a settings-change event. Shell-only checks miss
this because shell reads its own limits; `run_code`'s outer character trim can
also hide the stale shared character cap. Check a non-shell multiline result
and a direct file read's full-output artifact: outer truncation alone can drop
data without saving it. Keep the scripted-read 100 KB cap and `run_code`'s
separate final-output cap intact, and check overlapping sessions with different
limits rather than changing a process-global trim default.

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
