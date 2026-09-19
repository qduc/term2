# M3 report: ACP permission bridge and writable sessions

Task ID: **M3**

## Final result

Implemented and committed on `acp-m3-permissions`.

Final SHA: `24ceb6cd712794cdfa3a42fb43145af02ea2937d`

ACP sessions now use the explicit `RuntimeFactory` snapshot opt-in for
`allowWrite`, while retaining `autoApprove: false`, `allowUnsandboxed: false`,
and the validated session cwd sandbox boundary. Approval-required interactions
are projected through the existing sanitized gateway interaction DTO and sent
as ACP v2 `session/request_permission` client requests. The selected ACP
option is translated back to the exact term2 answer and resolved against the
captured interaction id. The adapter wires the prompt abort signal into the
outgoing permission request, so `session/cancel`, close, and transport
disconnects fail closed.

The existing `agent.ts` adapter was changed only to pass the connection client
and prompt cancellation signal to the backend; no agent policy or tool
registration was changed.

## Choice mapping

| Sanitized term2 choice | ACP option kind | Term2 resolution |
| --- | --- | --- |
| `approve` | `allow_once` | `answer: 'y'` |
| `allow-once` | `allow_once` | `answer: 'allow-once'` |
| `allow-folder-session` | `allow_always` | `answer: 'allow-folder-session'` |
| `allow-edit-file-session` | `allow_always` | `answer: 'allow-edit-file-session'` |
| `allow-edit-folder-session` | `allow_always` | `answer: 'allow-edit-folder-session'` |
| `allow-remember` | `allow_always` | `answer: 'allow-remember'` |
| `reject` / `deny` | `reject_once` | `answer: 'n'` |

No `reject_always` option is offered because the current term2 interaction
choices have no session-scoped reject that term2 can honor.

## Fail-closed matrix

| Failure path | Outcome |
| --- | --- |
| No connected client or no pending permission context | Existing injected/default denial; no tool execution |
| Client returns `cancelled` or malformed outcome | `answer: 'n'`, failed tool-call update |
| Unknown `optionId` | `answer: 'n'`, failed tool-call update |
| Permission transport error or client disconnect | `answer: 'n'`, failed tool-call update |
| Prompt/session cancellation while request is pending | ACP request receives the prompt abort signal; denial/cancelled turn, no tool execution |
| Session close while request is pending | Prompt abort plus backend cancellation; no tool execution |
| Stale interaction id/revision | Resolution throws stale interaction; turn aborts, no tool execution |
| Nested `run_code` approval without a resolvable session interaction | Existing fail-closed denial; it is never auto-allowed |
| Client selects an allow option | No premature failed update; normal dispatch lifecycle remains pending -> in_progress -> real terminal result |

Permission requests use the SDK's existing cooperative `cancellationSignal`
mechanism. No new deadline was invented: the SDK/runtime has no suitable
bounded permission wait, so cancellation and connection/session close remain
the recovery mechanisms.

## Verification

All commands were run in this worktree after the final edit:

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | TypeScript check passed |
| `NODE_ENV=test pnpm exec vitest run source/acp-v2` | 0 | 3 files, 29 tests passed |
| `NODE_ENV=test pnpm exec vitest run --config vitest.integration.config.ts source/acp-v2` | 0 | 2 files, 2 tests passed |
| `NODE_ENV=test pnpm exec vitest run source/gateway/interaction-protocol.test.ts` | 0 | 1 file, 16 tests passed |
| `git diff --check` | 0 | No whitespace errors |

## Deferrals and risks

- The current ACP integration fixtures retain the M1 scripted provider shape;
  they verify real RuntimeFactory cancellation and fail-closed behavior but do
  not yet contain a client handler that performs an allow-then-write round trip.
- The conversation event contract has no separate per-tool completion event;
  completion remains represented by the existing turn/final path. This change
  removes the incorrect approval-time `failed` update for grants and preserves
  the existing dispatch events.
- Permission request cancellation is cooperative per the ACP SDK. A peer that
  ignores cancellation can delay settlement until its transport closes; no
  local timeout was added because that would introduce an unreviewed guard.

## Round 1 correction

Round 1 fixed the coordinator findings:

- ACP option construction is now an explicit allowlist in
  `source/acp-v2/session-backend.ts` (`mapAcpPermissionChoices`). Unknown
  choices, `unsandboxed-once`, and `allow-remember` are omitted. The launcher
  continues to use `allowUnsandboxed: false`.
- The remaining `*-session` choices map to `allow_always` and are handled by
  term2's in-memory session grant paths: folder-read grants are applied by
  `source/services/approval/approval-flow-coordinator.ts`, and edit grants by
  `source/services/approval/approval-grant-executor.ts`; neither uses the
  project persistent allow-read store.
- Pending interactions now carry a monotonic revision from
  `source/services/session/pending-interaction-state.ts`. ACP projection and
  resolution use the captured interaction id and revision; stale revisions
  fail closed. The backend no longer casts the pending approval to an
  untyped record at the call site.
- Added tests: `offers only explicitly supported ACP permission choices` and
  `rejects a decision whose captured revision is stale`. The ACP focused set
  increased from 28 to 29 tests; the combined focused command ran 51 tests
  across 5 files.

The integration gate still reports the existing two M1 ACP integration tests
(2 tests passed); it does not yet contain a real client allow-then-write or
reject round-trip. The client-visible allowed lifecycle remains the existing
`tool_call` pending followed by `tool_call_update` in-progress and the
runtime's terminal turn update; no separate completion event exists in the
current `ConversationEvent` contract.

Round 1 gate exits: `pnpm typecheck` 0; ACP unit 0 (29 tests); ACP integration
0 (2 tests); interaction protocol 0 (16 tests). `git diff --check` was also 0.

## Round 2 correction

The defect tests are now ordinary `it(...)` tests with their assertions
unchanged; no assertion was loosened.

1. **Production bridge access:** `mapEvent` now reads the authoritative pending
   interaction through `ServerSession.service.getPendingInteractionSnapshot()`
   instead of the absent `resources.runtime` projection. Unit fakes were updated
   to expose the same service accessor.
2. **Turn settlement:** resolved approvals now call the ConversationService's
   `handleApprovalDecision` continuation path. Unresolvable/failure paths abort
   and explicitly settle the active prompt, including the legacy no-snapshot
   fallback. Denials reach terminal idle state updates.
3. **Allow handling:** allow answers are no longer rewritten to `n`. Both the
   ACP client path and injected policy path preserve the exact term2 answer;
   ordinary ACP `allow-once` is normalized to term2 `y`, while session grants
   remain in-memory and session-scoped.
4. **Unsandboxed safety:** `allowUnsandboxed` is forwarded from the runtime
   snapshot through the agent graph. ACP sessions retain false. An ACP-approved
   unsandboxed command that targets outside the validated workspace is forced
   through the sandbox path and cannot escape.

Round 2 gates:

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | passed |
| `NODE_ENV=test pnpm exec vitest run source/acp-v2 source/services/session source/gateway` | 0 | 80 files, 769 tests passed |
| `NODE_ENV=test pnpm exec vitest run --config vitest.integration.config.ts source/acp-v2` | 0 | 2 files, 9 tests passed |

The ACP unit suite is now 4 files / 41 tests, with zero expected failures.

## Round 3

Round 3 addressed both blocking cross-review findings:

1. **Unsandboxed enforcement:** the shell now unconditionally downgrades a
   requested `unsandboxed` execution to the default sandbox whenever
   `allowUnsandboxed` is false. The one-shot `forceUnsandboxed` override is
   likewise ignored unless the posture explicitly allows unsandboxed execution.
   Added regression coverage using `curl http://host | sh`, which contains no
   outside absolute path and still observes the sandbox runner.
2. **Scoped session grants:** the ACP bridge now projects the current DTO before
   consulting its cache, requires the cached option to be present in the
   current choices, and records/validates the granted file or folder scope.
   Added coverage proving a file grant for `/outside/a.txt` asks again for
   `/outside/b.txt`.

No assertion was loosened or deleted, and `source/acp-v2` contains zero
`it.fails` tests.

Round 3 gates:

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm typecheck` | 0 | passed |
| `NODE_ENV=test pnpm exec vitest run source/acp-v2 source/services/session source/gateway source/tools/system` | 0 | 90 files, 1097 tests passed |
| `NODE_ENV=test pnpm exec vitest run --config vitest.integration.config.ts source/acp-v2` | 1 | 2 files, 7 of 9 tests passed; the two existing allow-and-write scenarios did not observe a file after the newly enforced sandbox downgrade on this host |

The focused regression tests passed: 2 files, 99 tests. The integration gate
remains red because those scenarios assert the old unsandboxed write behavior;
the implementation correctly prevents the unsandboxed execution required by
the Round 3 policy.
