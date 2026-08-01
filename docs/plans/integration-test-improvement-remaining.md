# Provider black-box suite: remaining implementation plan

**Status:** ready to execute after the inherited-work gate below
**Source plan:** `docs/plans/integration-test-improvement.md`
**Last audited:** 2026-08-01

## Resume here

Do not rebuild the provider black-box suite from the source plan. Its reusable
HTTP/WS fixture infrastructure, registry contract foundation, dedicated Vitest
configuration, build-first command, and basic shipped-CLI success/error cases are
already merged.

The remaining work is the expanded acceptance added after that foundation:

- a provider-family capability matrix with executable coverage accounting;
- a stateful driver through the shipped conversation path;
- application-level multi-turn and approval continuity;
- Codex and OpenAI Responses HTTP/WS coverage;
- native failure, incomplete-stream, reasoning-output, and restart/resume cases;
- durable black-box red-proof evidence;
- one recorded full verification gate.

The primary checkout currently contains inherited uncommitted fixture and
continuity work in files this plan needs. Determine its owner and finish or commit
it before creating implementation worktrees. Do not copy, stash, or overwrite the
whole dirty checkout.

## What is already complete

| Area | Current evidence | Disposition |
| --- | --- | --- |
| Provider regression fixes | `4640429a` plus the verification record in `provider-bug-sweep.md` | Historical Gate 0 is complete; remove the stale “uncommitted” premise when the source plan is next reconciled. |
| Reusable HTTP harness | `provider-test-harness.ts`, `fake-provider-http-server.ts`, `provider-wire-fixtures.ts` | Keep and harden; do not replace. |
| WS replay machinery | `fake-provider-websocket-server.ts` and its unit test | Extend with provider terminal/failure scenarios. A live WS recording is not required for deterministic error mutations. |
| Registry contract foundation | `provider-contract.test.ts` covers OpenAI Responses HTTP, Chat Completions, Anthropic, Google, and OpenRouter | Retain as provider-boundary coverage; it does not prove session continuity. |
| Real HTTP replay pilots | OpenAI, OpenRouter, Google, OpenCode Chat, and OpenCode Anthropic fixtures | Finish the inherited fixture work first. Direct Anthropic remains an explicit credit-gated exclusion. |
| Shipped CLI foundation | `provider-cli.blackbox.ts` runs `dist/cli.js` for generic Chat success and HTTP error | Expand exact-output cases; use a PTY driver for stateful behavior. |
| Dedicated gate | `pnpm test:provider-black-box` builds, then runs `vitest.provider-black-box.config.ts` | Keep as the focused first gate. |

No durable artifact yet demonstrates the black-box suite failing against the
pre-fix implementation. The unit-level red/green record in
`provider-bug-sweep.md` is useful historical evidence, but does not satisfy this
plan's black-box red-proof requirement.

## Target capability matrix

Create `scripts/provider-black-box/provider-capability-matrix.ts` as test-owned
data. Do not expand the production registry capability interface unless a runtime
consumer actually needs the additional fields.

Each row must declare: registry/runtime route, wire family, transport, chaining
mode, tool/approval support, reasoning support, native continuation field,
required scenarios, and any explicit exclusion.

Minimum rows:

| Row | Wire/transport | Continuity assertion |
| --- | --- | --- |
| Built-in OpenAI, HTTP | Responses HTTP/SSE | `previous_response_id` |
| Built-in OpenAI, WS | Responses WS | `previous_response_id` |
| Built-in Codex, HTTP | Codex Responses HTTP/SSE | `previous_response_id` plus stable `call_id` mapping |
| Built-in Codex, WS | Codex Responses WS | `previous_response_id` plus stable `call_id` mapping |
| Built-in OpenRouter | AI SDK Chat HTTP/SSE | complete ordered history |
| Runtime `openai` | Chat Completions HTTP/SSE | complete ordered history |
| Runtime `openai-compatible` | Chat Completions HTTP/SSE | complete ordered history |
| Runtime `llama.cpp` | Chat Completions HTTP/SSE | complete ordered history; shared-wire exclusions must be explicit |
| Runtime Anthropic | Messages HTTP/SSE | complete ordered history |
| Runtime Google | GenerateContent streaming | complete ordered history |
| OpenCode Chat route | Chat Completions HTTP/SSE | complete ordered history plus stable OpenCode session header |
| OpenCode Anthropic route | Messages HTTP/SSE | complete ordered history plus stable OpenCode session header |

Add a matrix-accounting test that fails when a row has neither an executed
scenario nor a documented exclusion. A shared wire-family test may satisfy a row
only when routing and lifecycle behavior are genuinely identical.

## Execution plan

### Gate A — Reconcile the inherited checkout

1. Resolve ownership of the dirty fixture, plan, bridge, Codex, `AgentClient`,
   registry, and application-loop files.
2. Finish and commit the real-traffic fixture work separately from continuity
   behavior.
3. Finish or explicitly hand off the in-progress `previousResponseId` propagation
   changes; do not count them complete until the stateful wire test is green.
4. Record a clean baseline: branch/commit, `git status`, focused unit results, and
   any unrelated failures.
5. Stop `tsc --watch` before any build-based test.

After the gate is clean, create the foundation worktree under the repository:

```text
.worktrees/provider-black-box-stateful
codex/provider-black-box-stateful
```

If `pnpm-lock.yaml` matches the primary checkout, symlink that worktree's
`node_modules` to `../../node_modules`; do not run `pnpm install` through the
symlink.

### Gate B — Add red approval-continuity regressions

Before building more black-box cases, add application-loop regressions for the
approval boundary.

The current risk is that `ApplicationRunLoop` returns an approval handle as soon
as it sees a streamed tool call, before it consumes the authoritative completion
that carries the tool-producing response ID. The resumed request can therefore
use an older or absent continuity anchor.

Add red tests for both decisions:

1. The fake model emits a tool call followed by a completion with `responseId`.
2. The run pauses for approval.
3. Approve, then resume through the opaque continuation handle.
4. Assert the next model request carries that exact response ID and exactly one
   paired tool result.
5. Repeat with rejection; assert the tool is not executed, a rejection result is
   sent once, and the same response ID anchors the resumed request.

Fix the loop only after the tests fail. The fix must consume enough of the stream
to preserve the authoritative terminal state without executing the pending tool
before approval. Keep the behavioral fix in its own worktree and commit, separate
from the later coverage-only changes.

### Work package 1 — Harden and state-enable the harness

Owned shared files:

- `scripts/provider-black-box/provider-test-harness.ts`
- `scripts/provider-black-box/fake-provider-websocket-server.ts`
- `scripts/provider-black-box/provider-capability-matrix.ts`
- focused harness/matrix tests

Deliver:

1. Put process, output-stream, fake-server, and temporary-root cleanup behind
   `try/finally`; prepare/spawn/read failures must not leak processes or roots.
2. Add a reusable isolated workspace lease so multiple child launches share the
   same settings, conversations, logs, cache, and Codex state.
3. Add a PTY-backed child driver using the established pattern in
   `source/test-helpers/terminal-e2e.ts`.
4. Expose bounded operations: start, write, wait for visible output/state, wait for
   exit, terminate, relaunch with the same root, read captured output, and cleanup.
5. Extend the WS fake with deterministic success, native terminal error,
   incomplete terminal, and abnormal-close behaviors. It must still fail when no
   client connects or outbound ordering differs.
6. Prove whether the installed OpenAI SDK honors `OPENAI_BASE_URL`. If it does not,
   add the narrowest client-construction injection seam; do not add a user-facing
   test setting or rely on a global-fetch URL rewrite as the acceptance proof.

Harness acceptance:

- two prompts can be sent to one built `dist/cli.js` process;
- approval input can be entered through the real UI path;
- the same isolated state can be reopened by a second process;
- timeouts terminate and await the child;
- cleanup runs after success, assertion failure, prepare failure, and timeout.

### Work package 2 — Chaining-provider lifecycle coverage

New test ownership:

- `scripts/provider-black-box/provider-session-responses.blackbox.ts`
- Responses/Codex fixture additions that do not overlap the active fixture plan

For OpenAI Responses and Codex, over both supported transports:

1. Drive two real user turns through the shipped `ConversationService` /
   `TurnWorkflow` / `AgentClient` / application-loop path.
2. Capture the second provider request at the fake wire boundary.
3. Assert the first terminal response ID appears as `previous_response_id`.
4. Drive a tool requiring approval; cover approve and reject.
5. Assert `call_id` is present, `callId` is absent, and the paired tool result is
   sent once against the response that produced the call.
6. Cover success, native terminal failure, missing terminal event, and abnormal WS
   close without fabricated completion or leaked handles.

Codex must be obtained from `registry.ts` with a session context and redirected by
`CODEX_BASE_URL`; do not instantiate its transport model directly.

### Work package 3 — Stateless-provider lifecycle coverage

New test ownership:

- `scripts/provider-black-box/provider-session-stateless.blackbox.ts`

Run the same two-user-turn and approve/reject flow for every stateless matrix row.
On the second and resumed requests, assert complete required history with native
roles and ordering:

```text
user -> assistant/tool call -> tool result or rejection -> assistant -> user
```

Also assert provider-specific request shapes and session headers. OpenRouter needs
application continuity plus its intentionally smaller provider-boundary set of
success, error, and request shape; do not duplicate unrelated AI SDK cases merely
to increase test count.

### Work package 4 — Output, resilience, reasoning, and restart

Owned files:

- `scripts/provider-black-box/provider-session-resilience.blackbox.ts`
- coordinator-only additions to `provider-cli.blackbox.ts`

Deliver:

1. Tighten one-shot CLI success to exact output and prove final-only text prints
   exactly once.
2. Drive HTTP error, early close, incomplete stream, and native provider failure
   once per distinct wire family; require non-zero failure and no fake empty
   success.
3. Drive WS terminal error, incomplete stream, and abnormal close for both OpenAI
   Responses WS and Codex WS.
4. Assert response-side reasoning survives as streamed events and final/persisted
   output for each reasoning-capable family. Request-side `reasoning`, `thinking`,
   or `thinkingConfig` assertions alone are insufficient.
5. Add two restart cases using the same isolated workspace:
   - completed conversation: restart, send full history without a stale response
     ID, obtain a fresh response ID, then chain the following turn;
   - interrupted/tool-bearing conversation: restart with repaired history and
     tool ledger, without an orphaned call or stale response ID.

Restart acceptance intentionally does not reuse a persisted server response ID on
the first resumed turn. The application must resynchronize with full history, then
establish fresh chaining state.

### Gate C — Capability accounting and proportionality review

After the scenario files are green:

1. Fail the matrix-accounting test for any unexercised row.
2. Permit only evidence-backed exclusions, including the credit-gated direct
   Anthropic real capture and shared-wire aliases with identical routing.
3. Confirm that provider-boundary tests remain provider-boundary tests; do not
   label manually assembled `model.stream()` continuation as application-level
   coverage.
4. Remove duplicate scenarios that do not protect a distinct transport, routing,
   lifecycle, or escaped bug class.

### Gate D — Produce durable red-proof evidence

Commit tests/harness separately from behavioral fixes. Then create:

```text
.worktrees/provider-contract-red-proof
```

at `5f3bc83a` (`4640429a^`), or at the more precise parent for a specific fix when
one exists.

Apply only the neutral harness/observability seams and test commits. Record in
`docs/plans/integration-test-improvement-red-proof.md`:

- escaped bug class and provider family;
- exact test/scenario name;
- pre-fix commit;
- failing exit/status/assertion;
- fixed-tree green result;
- explicit exclusion, if any.

At minimum, demonstrate red failures for every escaped bug class covered by the
original plan, plus application continuity and approval continuity. The continuity
scenario must execute for every capability row on the fixed tree; every row need
not be red if that route never contained the historical bug.

Remove the disposable worktree after the evidence is captured.

### Gate E — Verify and merge

Run in this order, with no active build watcher:

```bash
pnpm test:provider-black-box
pnpm exec vitest run --reporter=minimal scripts/fake-codex-server.e2e.test.ts
pnpm exec vitest run --reporter=minimal source/providers/*.test.ts source/services/agent-runtime/application-run-loop.test.ts source/lib/openai-agent-client.public-methods.test.ts source/non-interactive.test.ts
pnpm typecheck
pnpm build
pnpm test
git diff --check
pnpm lint
```

Record exact results and separate baseline-only failures from introduced failures.
Update `AGENTS.md` and the source plan only when the suite's command, ownership, or
acceptance workflow actually changes.

## Coordination and merge order

1. The coordinator clears Gate A and owns shared matrix/harness interfaces.
2. Merge Work package 1 before starting provider-family implementation.
3. After that interface is fixed, chaining, stateless, and resilience workers may
   work concurrently in separate in-repository worktrees with exclusive new test
   files.
4. The coordinator alone edits `provider-cli.blackbox.ts`, package scripts, and the
   source plan.
5. Merge provider-family branches serially, run their focused tests after each
   merge, then run matrix accounting.
6. Any production bug discovered by a red case gets its own bug-fix worktree and
   commit; do not bury it in a coverage commit.
7. Run Gates D and E only after all deterministic branches are integrated.

## Separate follow-up — scheduled live canaries

Do not include live canaries or optional new live captures in the deterministic
minimum merge.

There is no tracked CI workflow, so first confirm the CI platform, secret/billing
owner, and Codex OAuth storage policy. Then add manual and scheduled triggers only,
isolated provider-family jobs, strict timeouts, `fail-fast: false`, informational
results initially, and sanitized summaries without raw traffic or credentials.
Revalidate cheap model choices at implementation time; the historical list in
`provider-bug-sweep.md` may be stale.

## Deterministic definition of done

- Every matrix row has an executed scenario or explicit exclusion.
- Two-user-turn continuity is proven at the actual provider wire boundary.
- Approve and reject are proven through the real continuation handle for every
  tool-capable row.
- OpenAI and Codex HTTP/WS terminal and continuation paths are covered.
- Failure and incomplete streams cannot become empty success.
- Reasoning survives both request configuration and response processing.
- Restart resynchronizes full history and tool state before fresh chaining.
- The red-proof matrix maps escaped bugs to pre-fix failure and fixed-tree success.
- The complete Gate E sequence is recorded green, with baseline failures separated.
