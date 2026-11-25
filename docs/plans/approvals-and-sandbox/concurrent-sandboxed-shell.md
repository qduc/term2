# Concurrent sandboxed shell commands

**Status:** Phase 1 (deadlock fix, bounded lease wait) lands in the same change
as this document. Phase 2 (sessions running sandboxed commands at the same time)
is not implemented and waits on the decisions listed below.

## Problem

One gateway process serves every web session. All sandboxed shell commands in
that process share one lease: the static `#managerOperation` queue in
`AnthropicShellSandboxRunner` (`shell-sandbox-runner.ts`). The shell tool takes
it with `acquire()` before wrapping and releases it in `cleanupAfterExecution`
(`shell.ts`). For a background job that release runs only when the job settles.

That produces two failures.

**Deadlock (reachable, observed).** `DirectBackgroundTasks.start` admits a
background task with its kickoff closed. `#execute` awaits `entry.kickoff`,
which opens only when the engine reports a turn boundary: the next model
request is dispatched, or the turn parks, ends or is cancelled
(`releaseParent` via `onTurnBoundary`; see "Background launch ordering" in
`src/engine/INTEGRATION.md`). Suppose one model response asks for a background
sandboxed shell and then any other sandboxed shell. The background launch holds
the lease but its body cannot start until the next request. The next request
cannot be sent until the second call returns. The second call waits for the
lease.

Observed on 2026-11-25 in gateway session `conv_83d8a297…`. One response asked
for a background `typecheck`, a background `lint` and a foreground `git diff`.
The typecheck never spawned, and the lint waited 760 s until the user stopped
the typecheck. Then the lint deadlocked the `git diff` the same way. During that
window a subagent of another session (`conv_27f25199…`, branch
`umber-stilton-358`) ran a sandboxed `git status` that waited 8 min until its
parent cancelled it. Its `timeout_ms: 120000` never applied, because the
deadline in `executeShellCommandUnleased` starts only after spawn.

**Serialization (reachable, observed).** Even without the deadlock, a running
background job holds the lease for its whole runtime, so every sandboxed shell
in every session waits for it. On 2026-11-24 `conv_5327a7d7…` showed waits of
116 s, 56 s and 52 s behind its own background vitest runs. On 2026-11-25 at
14:43:09, `conv_2d5259e6…` waited 1.85 s behind `conv_27f25199…`'s
`pnpm build`. A sandboxed background dev server therefore blocks every other
sandboxed command in the process until it exits or hits
`shell.backgroundTimeout`.

How to find these in data: the gateway persists sessions under
`~/.local/state/term2-nodejs/gateway-next/conversations/`. A lease wait shows as
a gap between a shell `tool_started` and its `task_started`. Subagent shell
calls appear only inside `branch_event` facts.

## Why the lease exists

The lease guards real process-global state, so it cannot simply be deleted.

- `SandboxManager` (`@anthropic-ai/sandbox-runtime`) is a module singleton with
  one initialized config, one proxy and one auth token. `#initialize` calls
  `reset()` when the next command's config key differs, which would tear down
  the proxy under a command that is still running.
- `cleanupAfterCommand` calls `reset()` after every command, to "revoke this
  command's proxy credential even if a descendant survived" (added in
  `9d552d754`).
- Network approval routes through module globals `activeCommand` and
  `activePauseController` (`sandbox-network-approval.ts`). The runtime's
  `SandboxAskCallback` receives only `{ host, port }`, so a concurrent ask could
  not be attributed to the command that made it, or pause the right process.
- On macOS, `network.allowLocalBinding` and `network.allowUnixSockets` (the
  Docker host-control socket) are read from the initialized config, not from a
  per-call `customConfig` (`wrapWithSandboxOnce` in the runtime's
  `sandbox-manager.js`).

## Phase 1: a lease is held only by a command that is running

Fixes the deadlock and makes lease waits bounded. It keeps the exclusive lease.

1. **Acquire inside the job body.** `acquireAndWrapSandbox` in
   `createShellToolDefinition` (`shell.ts`) takes the lease, builds the sandbox
   config and wraps the command. A foreground call runs it inline, since
   foreground calls are not kickoff-gated. A background launch runs it as the
   first step of the job's `run`, so admission takes no lease and the body
   takes one only after kickoff. `availability()` stays at admission for both:
   it only loads the runtime, checks dependencies and reads the recorded
   initialization failure, so it needs no lease, and a missing sandbox is still
   a tool error rather than a failed job. A wrap failure inside a background
   body becomes a failed job carrying the same `sandboxFailure()` text the tool
   call used to return. The read-only refusal now keys on whether a sandbox was
   requested; that is equivalent to the old check on `sandboxed`, because a
   requested sandbox either wraps the command or refuses it.
2. **The lease wait counts against the command's own timeout.** The wait is
   bounded by `timeout` (invocation `timeout_ms`, else `shell.timeout` or
   `shell.backgroundTimeout`), and the process deadline gets what is left. If
   the budget runs out while waiting, the call returns a "sandbox is busy …
   The command was not run" error naming the budget but not the holder, which
   may belong to another session (shell output is session-scoped;
   `scopedWatches` in `src/app/shell-tools.ts`).

Guard contract for step 2:

- **Harm prevented:** a shell call waiting without limit for a lease held by
  another command, ignoring its own `timeout_ms` (8 minutes against 120 s in
  the incident).
- **Class:** containment budget. **Action:** reject before start. The holder is
  untouched and the waiting command never runs, so there is no partial work to
  settle and nothing to replay.
- **Enforcement owner:** `createShellToolDefinition`. **Recovery:** the model
  retries, after the holder finishes or with a larger `timeout_ms`.
- **Configuration:** no new setting and no default change; the budget is the
  command's existing effective timeout. A missing or zero timeout leaves the
  wait unbounded, as the executor already treats it as no deadline.
- **Legitimate work with the same signal:** a short command queued behind a
  long but healthy holder, such as a sandboxed dev server. It is refused once
  its budget is spent instead of being stuck for the holder's whole lifetime.
- **Unchanged constraints** (guard ledger, "Shell repair constraints"):
  network-approval pauses stay excluded from the budget, because they are
  accounted inside `executeShellCommand` after spawn.
- **Observability:** `Shell sandbox busy; command not run` (warn) carries
  `timeout`, `timeoutSource`, `waitedMs` and `mode`. A wait of 1 s or more
  that then runs is logged at debug as `Shell waited for the sandbox lease`.
- **Timer range:** Node fires an `AbortSignal.timeout` or `setTimeout` longer
  than 2^31-1 ms after 1 ms, and `timeout_ms` has no upper bound in the
  schema. The lease wait clamps to that maximum. The executor's own deadline
  timer in `executeShellCommandUnleased` has the same overflow already; that is
  not changed here.
- **Rollback:** revert this change; no persisted state or settings are involved.

The integration tests are in the `sandbox lease ordering` block of
`tests/tools/system/run-code/shell.integration.test.ts`, using an exclusive fake
runner. All three hung until the 10 s test timeout on the code before this
change.

After Phase 1 the incident sequence runs as follows. The `git diff` takes the
free lease and finishes, the step ends and the request is dispatched. Then the
two background bodies start and run one after the other.

## Phase 2: commands that agree on global policy share the lease

Gives real concurrency for the common case: sessions on the same machine, with
the same network policy, running at the same time.

1. **Split the policy.** Pass the per-command part as `customConfig` to
   `wrapWithSandbox`: `filesystem.*`, `credentials`, `allowPty` and git safe
   directories (all read per call in the runtime). Only the process-global part
   goes to `initialize`: network allow/deny lists, `allowLocalBinding`,
   `allowUnixSockets`, proxy and MITM settings. The initialization key becomes
   that global part only, not today's `{ cwd, config }`.
2. **Shared, keyed lease.** Any number of commands with the same key hold the
   lease together. A command needing a different key waits until the current
   holders drain. To avoid starvation, once such a waiter is queued, new
   same-key arrivals queue behind it. Replace the instance-level `#heldLease`
   flag with a per-acquisition token: the runner is one shared instance
   (`getDefaultShellSandboxRunner`), so an instance flag set by one holder
   would let any other caller's `wrap()` skip the lock.
3. **Per-command identity.** Give each wrap a fresh 128-bit `commandId`
   (`WrapWithSandboxOptions`). It also fixes violation attribution, which today
   keys on command text: `annotateStderrWithSandboxFailures` would then use the
   id. Record "Allow once" grants with
   `registerCommandNetworkLists(commandId, …)` instead of the in-memory
   `allowed` set, and unregister them when the command exits.
4. **Attributed asks.** Replace `activeCommand` and `activePauseController`
   with a map from `commandId` to `{ approval handler, pause controller,
   workspace root }`. The callback looks up the asking command, prompts in
   *that* command's session and pauses *that* process. An ask from an unknown
   or finished id is denied. This needs the runtime to pass the id: it already
   has it as `encodedCommand` in `filterNetworkRequest`, but calls
   `sandboxAskCallback({ host, port })`.
5. **Reset when idle, not per command.** Call `reset()` when the last holder
   releases, which rotates the proxy token at that point. Unregister each
   command's network list on exit.

## Rejected alternatives

- **Start background shell bodies immediately (no kickoff gate).** That removes
  the deadlock at its other end, but `DirectBackgroundTasks` owns the launch
  ordering for every background kind. The gate keeps a job's notices from
  reaching the model before the launch result does. Phase 1 changes only the
  shell tool.
- **Release the lease right after `wrap()`.** The next command's
  `#initialize` or `cleanupAfterCommand` would `reset()` the manager under a
  running command and kill its proxy mid-run.
- **One sandbox-runtime process per command or session (`srt` child).** Gives
  full isolation, but needs a new IPC protocol for network asks and pause, plus
  proxy start-up per command. That is more machinery than a keyed lease for the
  same outcome in the common case.

## Invariants and owners

| Invariant | Owner | Enforced by |
| --- | --- | --- |
| A background body does not start before the engine reports a turn boundary | `DirectBackgroundTasks` | `kickoff` / `releaseParent` (existing) |
| A sandbox lease is held only by a command whose body has started | shell tool (`createShellToolDefinition`) | Phase 1 step 1 (today violated: background admission acquires) |
| A command's wait for the sandbox counts against its own `timeout_ms` | shell tool | Phase 1 step 2 |
| The manager's global policy and proxy do not change while a command runs under them | `AnthropicShellSandboxRunner` | exclusive lease today; keyed shared lease in Phase 2 |
| A network ask reaches the session and process of the command that made it | sandbox network approval | one command at a time today; `commandId` map in Phase 2 |
| A finished command's network grants stop applying | sandbox network approval | `reset()` per command today; `unregisterCommandNetworkLists` per command plus `reset()` when idle in Phase 2 |

## Decisions needed before Phase 2

- **Runtime support for attributed asks.** Either patch
  `@anthropic-ai/sandbox-runtime` locally (`pnpm patch`, one argument in
  `filterNetworkRequest`) and request it upstream, or ship Phase 2 without
  attribution. Without attribution, a foreground command that hits an
  unapproved host while another command holds the shared lease is denied with a
  "retry when no other sandboxed command is running" reason.
- **Surviving descendants.** Phase 2 relaxes `9d552d754`'s per-command
  `reset()`. A process that outlives its command keeps the proxy token until the
  lease goes idle. Its asks are denied because its id is unregistered, so it
  reaches only hosts the global config allows. Accept that, or keep per-command
  reset and give up concurrency.

## Verification

This touches the security boundary, so it needs an independent verifier.
Permanent unit tests are not allowed under the evidence-driven experiment.

- Phase 1 (done): integration tests drive `shell` through the live Session
  task adapter (`DirectBackgroundTasks` + `directShellTasks`), with
  `releaseParent` standing in for the next model dispatch. A background
  sandboxed launch followed by a foreground sandboxed call in the same step: the
  foreground call finishes and the background body runs only after release.
  With the lease held elsewhere, a foreground call and a background job each
  fail with the busy error once their `timeout_ms` is spent, without running.
  These tests do not exercise the real `AnthropicShellSandboxRunner` or a real
  provider turn.
- Phase 2: two sessions in one gateway process run overlapping sandboxed
  commands with no lease wait. A network ask from session A prompts only in A
  and pauses only A's process. An ask presented with a finished command's id is
  denied.
- Re-run the gateway-data scan described under Problem against a real
  multi-session evening: no shell `tool_started` → `task_started` gap should
  exceed the command's timeout.
