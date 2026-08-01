# Lens report: tests
Codebase: /Users/qduc/src/term2  |  Scope: whole repo (source/)  |  Date: 2026-08-01

## Summary
The bulk of the sampled suite (conversation-service, conversation-store, conversation-orchestrator,
turn-workflow, approval-flow-coordinator, agent.test.ts, subagent-manager.*, codex-responses-model)
asserts real, specific behavior against production code with narrow, purpose-built mocks — this is
not theater in general. But there is a concentrated pocket of vacuous tests, and in one case
(`source/lib/subagent-bridge.ts` event-sink buffering) the vacuous tests sit directly on top of what
appears to be dead/orphaned code from an incomplete refactor, so nothing in the suite would catch a
regression or confirm the current mechanism works. One whole test file
(`agent-client.dispose.test.ts`) was gutted to a single unrelated placeholder during the
"decouple from openai agents sdk" commit, silently deleting coverage of `AgentClient.dispose()`'s
idempotency guard and delegation with a one-line commit message. Several ownership-boundary
invariants documented in `audit/invariants.md` have no automated enforcement at all.

## Findings

### F-tests-001: subagent-bridge event-sink buffering/deferral has zero real assertions, and sits on dead code from an incomplete refactor
- **Severity**: critical
- **Confidence**: high
- **Location**: `source/lib/subagent-bridge.ts:46,78-82,216-227` (fields `#pendingClearSink`,
  `#bufferedEvents`; methods `setEventSink`, `#beginSubagentRun`); tests at
  `source/lib/subagent-bridge.test.ts:146-155` ("setEventSink stores the sink"),
  `:158-174` ("setEventSink defers clear when subagents are active"),
  `:444-464` ("deferred sink clear is applied after active subagents complete").
- **Claim**: All three tests exercise `setEventSink`'s interaction with active/buffered subagent
  events but contain no `expect()` call on the outcome (the first two literally end in
  `expect(true).toBe(true)`; the third has zero assertions at all, only comments describing what
  "should" happen) — none would fail if the sink/buffering logic were deleted or broken.
- **Evidence**: `setEventSink` (subagent-bridge.ts:78-82) unconditionally does
  `this.#subagentEventSink = sink; this.#pendingClearSink = false;` regardless of
  `#activeSubagentsCount`. `#pendingClearSink` is declared (line 46), reset to `false` in
  `setEventSink` (line 80), and checked in `#beginSubagentRun`'s disposer (line 222:
  `if (this.#pendingClearSink && this.#activeSubagentsCount === 0)`) — but is **never set to
  `true` anywhere in the file**. `git log -p --follow -- source/lib/subagent-bridge.ts` shows the
  one place that used to set it true was removed in commit `ea5311de` ("feat(subagents): add
  cross-turn async session registry"), which replaced the old deferred-clear design with an
  event-buffering design (`#bufferedEvents` / `#flushBufferedEvents`, added in the same commit).
  The old field, its false-reset, and the now-unreachable check were left behind as vestigial dead
  code. The test names/comments ("should be deferred", "Sink should now be cleared... deferred
  clear applied after count hits 0") still describe the *old*, now-nonexistent mechanism, and
  `grep -n "bufferedEvents" source/lib/subagent-bridge.test.ts` returns **zero matches** — the
  actual current buffering/flush mechanism that replaced it has no test at all.
- **Verify by**: Delete the `#pendingClearSink` field, its reset in `setEventSink`, and the check in
  `#beginSubagentRun` entirely (or replace `#bufferedEvents`/`#flushBufferedEvents` with a no-op) and
  run `pnpm test -- subagent-bridge`; none of the three tests above should fail. Then write a real
  test: attach a sink, start a subagent run, clear the sink mid-run, emit an event, and assert
  whether the old sink receives it, a new sink later receives it via flush, or it's dropped — to
  pin down what the current intended behavior actually is (this needs a decision, not just a test).
- **Invariant impact**: none directly, but this is exactly the "decision-debt" case invariants.md
  asks lenses to flag when intent can't be reconstructed — the current buffering behavior around
  `setEventSink(null)` while subagents are active is unverified and its own field-level evidence
  (`#pendingClearSink`) contradicts the code comments above it.

### F-tests-002: `agent-client.dispose.test.ts` no longer tests `AgentClient.dispose()`; coverage was silently deleted in the SDK-decoupling commit
- **Severity**: critical
- **Confidence**: high
- **Location**: `source/lib/agent-client.dispose.test.ts` (current: 14 lines);
  `source/lib/agent-client.ts:329-338` (`dispose()` — untested idempotency guard and delegation).
- **Claim**: The file that is supposed to cover `AgentClient.dispose()` was reduced from 181 lines of
  real behavior assertions to a single vacuous test of an unrelated class, in a commit with a
  one-line message and zero test-file-specific explanation; no other test in the repo covers
  `AgentClient.dispose()`.
- **Evidence**: `git show 5824007b -- source/lib/agent-client.dispose.test.ts` (commit message:
  "decouple from openai agents sdk", no body) deletes tests asserting: dispose is idempotent and
  delegates to `bridge.abort()`/`bridge.dispose()` with exact call counts, settings listeners are
  unsubscribed on dispose (`expect(settings.listeners).toHaveLength(0)`), and a dual-transport
  (http/websocket) OpenAI request-capture proof. It replaces all of that with:
  ```
  it('application run loop aborts an active stream on disposal-equivalent abort', () => {
    const loop = new ApplicationRunLoop({ resolveModel: async () => ({ async *stream() { await new Promise(() => {}); } }) });
    loop.abort();
    expect(true).toBe(true);
  });
  ```
  This never calls `.stream()`, so `ApplicationRunLoop`'s `#activeAbortController` is never set and
  `abort()` (application-run-loop.ts:168-170, `this.#activeAbortController?.abort()`) is a no-op via
  optional chaining — the test would pass identically if `abort()` were stubbed to do nothing.
  Current `AgentClient.dispose()` (agent-client.ts:330-338) has a real `#isDisposed` guard and
  delegates to `abort()`, `#runnerManager.invalidateRunner()`, `#subagentBridge?.dispose()`,
  `#agentConfig.dispose()` — none of this is exercised: `grep -rn "\.dispose()" source/lib/*.test.ts`
  finds no `new AgentClient(...).dispose()` call anywhere in the repo (the only `.dispose()` hits in
  that directory are for `SubagentAsyncRegistry`, a different class).
- **Verify by**: Comment out the `if (this.#isDisposed) return;` guard or the
  `this.#subagentBridge?.dispose();` line in `agent-client.ts` and run `pnpm test`; nothing should
  fail. Then check `git show 5824007b --stat` to confirm the commit's only message is
  "decouple from openai agents sdk" with no rationale for this specific file's content loss.
- **Invariant impact**: none named explicitly, but this is a direct instance of the git-history
  audit this lens was asked to perform: an assertion set was deleted in the same commit as a large
  production refactor, with no commit-message explanation for that file.

### F-tests-003: Vacuous `expect(true).toBe(true/false)` tests with names/comments claiming to verify behavior they never check
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/services/logging/logging-service.test.ts:65-79` ("respects DISABLE_LOGGING
  flag" — never checks that no files were created, despite the comment saying so);
  `:343-354` ("gracefully degrades on write errors" — never injects a write failure of any kind, just
  calls `logger.info`/`logger.error` normally); `source/services/settings/settings-service.test.ts:
  994-1003` ("respects disableLogging flag" — calls `service.set(...)` and asserts nothing about
  logging behavior).
- **Claim**: These three tests would pass unchanged if the named feature (log-suppression on
  `DISABLE_LOGGING`, graceful write-error handling, `disableLogging` respecting) were completely
  removed from production code.
- **Evidence**: Quoted inline above; each ends in a bare `expect(true).toBe(true)` with no
  observation of filesystem state, thrown errors, or logger output that the test's own name/comment
  claims to be checking.
- **Verify by**: In `logging-service.ts`, make `DISABLE_LOGGING` a no-op (always log) and rerun
  `logging-service.test.ts`; the "respects DISABLE_LOGGING flag" test still passes. Separately, force
  `fs.writeFileSync`/whatever the logger's write path uses to always throw, and confirm "gracefully
  degrades on write errors" still passes without ever having exercised a throwing write path.
- **Invariant impact**: none.

### F-tests-004: No automated enforcement for several ownership-boundary invariants
- **Severity**: medium
- **Confidence**: medium
- **Location**: `eslint.config.js` (only `no-restricted-imports` rule present is scoped to
  `tool-execution-ledger.js`'s `reconcileHistoryWithToolLedger`, lines 99-121); no matching test
  files found via `find source -iname "*architecture*" -o -iname "*boundary*"`.
- **Claim**: The invariants "components do not import `services/session`/`services/conversation`
  directly (except documented exceptions)", "new providers must go through the registry, not direct
  construction", and "`subagent-manager.ts` contains no execution/prompt/cache/tool-policy logic" are
  documented in AGENTS.md / invariants.md but have no lint rule or test asserting them — they rely
  entirely on code review discipline.
- **Evidence**: `eslint.config.js` has exactly one `no-restricted-imports` entry, unrelated to these
  boundaries. No test file matches `*architecture*`/`*boundary*`/`*structure*` naming. The provider
  registry usage in `scripts/provider-black-box/provider-contract.test.ts` demonstrates the *test
  suite itself* uses the registry correctly, but nothing prevents a future provider or service module
  from importing a transport class directly or growing logic inside `subagent-manager.ts` — a
  regression there would only surface via manual review, not CI.
- **Verify by**: Add a component that imports `ConversationService` directly, or move a chunk of
  `mentor-runner.ts` logic into `subagent-manager.ts`, and run `pnpm typecheck && pnpm test`; nothing
  should fail on those grounds specifically (typecheck may incidentally catch import cycles, but not
  the architectural violation itself).
- **Invariant impact**: invariants.md "Ownership boundaries (must hold)" section, all three bullets
  about component imports, provider registry, and subagent-manager scope.

### F-tests-005: Trivial `instanceof`-only test provides negligible signal
- **Severity**: low
- **Confidence**: high
- **Location**: `source/providers/codex-responses-model.test.ts:693-707`
  ("CodexResponsesWSModel extends OpenAIResponsesWSModel").
- **Claim**: This test only checks `model instanceof OpenAIResponsesWSModel`, which is guaranteed by
  the `class` declaration and would only fail on a `class CodexResponsesWSModel` syntax change the
  type checker would already catch.
- **Evidence**: Test body constructs the model and asserts `expect(model instanceof
  OpenAIResponsesWSModel).toBe(true)` — no behavior is exercised.
- **Verify by**: Read the test; there is no code path that could break this assertion without also
  breaking `pnpm typecheck`.
- **Invariant impact**: none.

## Non-findings
- `ConversationStore` (`conversation-store.test.ts`) is tested with no mocks against the real class —
  genuine behavior tests (type a), including multimodal content and legacy/wrapped-item interop via
  `it.each`.
- `ConversationService` (`conversation-service.test.ts`) mocks only the true I/O boundary
  (`ConversationAgentClient`) and asserts on real queueing, approval, and history-projection behavior
  of the production `ConversationService` — including the FIFO-queue, gated-continuation, and
  failed-execution-pause scenarios sampled. Assertion changes found in `git log -p` for this file
  (e.g. commit `294ece62`) reflect genuine behavior fixes with matching test-name changes and a
  descriptive commit message, not silent weakening.
- `ConversationOrchestrator` (`conversation-orchestrator.test.ts`) mocks its single collaborator
  (`ConversationService`) fully, which is appropriate since the orchestrator's job is UI-state
  projection from service output — assertions check orchestrator-owned derived state, not just
  mock-echo.
- `SubagentManager` facade (`subagent-manager.*.test.ts`, ~2935 lines across 8 files) tests the
  222-line facade's public behavior through a real provider registered via
  `registerTestProvider`/`getProvider` (matching the registry-only invariant), not through
  hand-rolled bypasses — e.g. `subagent-manager.prompts.test.ts` drives a fake provider's
  `callModelInputFilter` through 96 simulated turns to assert an injected turns-remaining warning.
- The "provider bug sweep" commit sequence (`c0010673`, `2df462f4`, `97450273`, `4cc9ae42`, etc. on
  `turn-workflow.test.ts` / `session-stream-processor.test.ts`) shows assertions being *strengthened*
  over time (e.g. commit `2df462f4` adds diagnostic-event assertions alongside existing ones,
  including a negative assertion `expect(JSON.stringify(diagnostics)).not.toContain('resp-legacy')`
  to catch a specific leak) — consistent with invariants.md's description of that sweep as thorough.
- No `toMatchSnapshot` usage anywhere in `source/` — the whole-object-snapshot anti-pattern this lens
  was asked to watch for is absent.
- `ApprovalFlowCoordinator` sandbox/denied-read tests exercise real filesystem state
  (`fs`/`os`/`path`, temp dirs) rather than mocking the sandbox layer away.

## Blocked
- Did not run `pnpm test` / `vitest --coverage` (explicitly out of scope for this read-only lens
  pass beyond `pnpm typecheck`-equivalent commands), so the "coverage-vs-confidence" task (5) is
  based on manual sampling only, not an actual line-coverage report cross-referenced against
  assertion quality. A coverage run would let a follow-up pass find more modules like
  `agent-client.dispose.test.ts` where high nominal file-level "has a test file" coverage hides a
  gutted test body.
- Did not exhaustively `git log -p` every test file in the repo (~200+ test files exist); the
  git-history audit (task 2) covered a targeted sample (conversation-service, conversation-replay,
  queue-controller, turn-workflow, session-stream-processor, subagent-bridge, agent-client.dispose)
  chosen for size/centrality and for names suggesting investigative/diagnostic work. Weakened
  assertions could exist elsewhere undetected.
- Did not verify every one of the ~99 `toHaveBeenCalled()` (no-args) call sites individually; spot
  checks in the sampled files showed these paired with `toHaveBeenCalledWith` or call-count
  assertions elsewhere in the same test, not standalone weak checks, but this was not exhaustive.
