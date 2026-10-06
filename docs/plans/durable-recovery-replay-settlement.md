# Durable recovery — replay-time settlement of interrupted tool calls

Status: **implemented and verified** (worktree `durable-recovery`, base
`efeda93a`, commits `b4a67e26` + `db0b4e5f` + the final corrective commit).
This document describes the implemented code (unreleased draft PR); the early draft that proposed
replay-time `aborted` settlement was superseded during implementation and is
recorded only under "Rejected approach" below.

## Final semantics

Replay-time settlement uses **status `unknown`**, not `aborted`. Replay has
no dispatch evidence, so absence of a `tool_result` never proves the tool
body did not run — a crash can land after the effect but before any terminal
receipt was persisted. The live path's own contract (Contract 02 C2.5) uses
`unknown` + UNKNOWN_OUTCOME_TOOL_RESULT for exactly this
dispatched-but-unobserved shape; replay matches it with
`RESTART_UNOBSERVED_TOOL_RESULT` ("Outcome unobserved: the session restarted
before this operation's result was recorded… Verify the current state before
any retry, and do not re-run non-idempotent operations blindly.").

Implementation (implemented, unreleased):

- `conversation-replay.ts`: `settleInterruptedToolEntries` runs at the
  mid-turn crash block, class-wide (journal-backed calls and legacy
  `tool_started`-only markers both settle). Status `unknown`,
  failureReason "Session ended unexpectedly", deterministic `completedAt`
  = last durable envelope timestamp (never wall-clock replay time). A
  synthetic `function_call_output` is appended, and for legacy entries that
  lack a provider `function_call` item, one is rebuilt first so the
  projected pair is call-then-output. Entries already carrying a result are
  preserved.
- `buildMessagesFromJournal` seeds every journal-backed call as `unknown` with
  failureReason "Session ended unexpectedly" before its `tool_result` is
  projected; a recorded terminal result then overwrites status/output/success
  truthfully and deletes the seeded failureReason (a `delete existing.failureReason`
  in the tool_result branch), so completed calls carry no stale restart residue
  (conversation-replay.test.ts covers the completed-case metadata).
- `tool-execution-ledger.ts`: reopening a call (`recordCall` on an existing
  entry) clears settlement residue (output/failureReason/completedAt);
  exports `isToolCallHistoryItem` / `isToolResultHistoryItem` guards for
  replay.
- Journal-backed interrupted calls render as `unknown` in the restored UI,
  not `running`. Trailing-turn replay still severs `previousResponseId` so
  the resumed request is stateless full-history.
- Black-box scenario `interrupted-tool`
  (provider-session-resilience.blackbox.ts, PTY, built CLI): updated from
  "dropped calls" to the settled-pair contract — resumed request contains the
  function_call plus a synthetic function_call_output with "Outcome
  unobserved", and no stale response id. Verified green against the built CLI.

## Crash-after-effect regression (provider-crash-window.blackbox.ts)

The interrupted-approval scenario only kills the CLI **before any tool
effect**, so it did not cover the dangerous window: tool body already ran and
wrote its external effect, process killed before any terminal
`tool_result` is persisted. The original released build dropped the executed
call from the next provider request entirely on this wire family, so the model
could blindly repeat the action.

`scripts/provider-black-box/provider-crash-window.blackbox.ts` closes that
gap as a repository-owned CI regression (chat-completions SSE lane, built
`dist/cli.js` under a PTY, local mock provider, no paid calls):

1. A local OpenAI-compatible mock instructs the CLI to run a lease-local
   effect fixture that appends + fsyncs a marker, then blocks — so the
   effect is durable before the crash.
2. The test polls until the marker content is actually observed (asserting
   the effect happened), then SIGKILLs the CLI and asserts the journal
   records `tool_started` for the call but no `tool_result` for it.
3. It resumes with `--resume <id> --fork` against the same mock, submits a
   continuation prompt, and asserts the next provider request (a) retains the
   interrupted call id, (b) carries the "may or may not have occurred"
   uncertainty text and the "do not re-run non-idempotent operations blindly"
   guidance, and (c) contains the new user message (no automatic redispatch).
4. It asserts the marker still holds exactly one effect — no duplicated
   external action after continuation.

All state lives inside the isolated workspace lease (effect fixture, marker,
settings, conversation journal); nothing is written to the repository or home
directories. Settings are verified through the real `SettingsService`
coupled setter: `shell.autoApproveMode` set to `always` demotes
`sandbox.enabled` to `false` (persisting raw `always` with the sandbox
default `true` loads back as `auto`).

This mirrors the supervisor's independently verified out-of-repo runtime
verifier (`/workspace/durable-task/independent-runtime-recovery.mts` +
`fixture-effect.mjs`, evidence `/workspace/durable-task/evidence/
independent-runtime/receipt.json`), which passed against the corrected built
CLI (exit 0, ~45s, marker count exactly 1, SIGKILL before tool_result,
resumed request retained call + uncertainty warning, final output rendered).

## Verification record

- Coding-worker model calls (paid): used only during implementation exploration
  under the provider-capped OpenRouter route; all final verification below is
  mock-only.
- Focused: 249 passed across conversation-replay, journal, ledger,
  completed-result, and approval unit regressions.
- Related: 2160 passed + 1 expected failure (`pnpm test:related`).
- Typecheck: passed. Formatting: applied to changed files.
- Crash-after-effect black-box regression: passed locally (~5s per run)
  against the built CLI with a local mock provider.
- Independent actual-CLI crash-resume verifier (supervisor-owned,
  out-of-repo): exit 0, marker count 1, uncertainty retained — no CI
  equivalent gap remains now that the repository regression above passes.
- Full unit suite: 10844 passed, 1 session-index ordering failure that
  reproduces on the ORIGINAL base (independent baseline run: 25 pass /
  1 fail) — pre-existing, not introduced here.
- Full provider black-box: 178 pass / 1 skip (independent sequential rerun).
- Integration: 106 pass / 1 skip (independent run).

## Rejected approach (superseded draft)

The original plan proposed settling replay-time interrupted calls as
`aborted` with a synthetic result asserting the operation was "not
performed". This was rejected during implementation: replay cannot know
whether the tool body ran, and asserting "not performed" is exactly the
unsafe assumption that lets a crash-after-effect window cause a blind
repeat. The conservative-but-truthful choice is `unknown` with the
unobserved-outcome wording, matching the live path.

## Limitations

- Approval-pending UI restoration on resume: replay records the pending
  approval in messages but does not repark the SDK interruption — the user
  re-prompts naturally (C12-style conservative pause).
- The black-box regression runs only when the built `dist/` exists
  (`pnpm test:provider-black-box` builds first); like the other PTY
  scenarios it is not part of the unit tier.

## Constraints honored

- No merge/release/deploy by the worker; supervisor creates the draft PR.
- No paid verification calls; local mocks only.
- Outer sandbox/proc restrictions untouched; settings coupling verified
  through the supported service API, not bypassed.
