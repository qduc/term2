## Implementation plan

The implementation should be one isolated feature branch, delivered in layers: reusable fake-wire infrastructure, provider-boundary contracts, then a small assembled CLI suite. Live canaries remain a separate follow-up because the repository currently has no tracked CI configuration.

### Gate 0 — Establish a clean baseline

The provider-sweep fixes are still uncommitted. A new worktree from `HEAD` would not contain them.

1. Review and commit the ten fixes separately from this coverage work.
2. Record the baseline:
   - typecheck;
   - full Vitest result;
   - existing fake-Codex result;
   - unrelated dirty files.
3. Stop any `tsc --watch` process before builds to avoid the known `dist` cleanup race.
4. Create:
   - Worktree: `.worktrees/provider-contract-suite`
   - Branch: `codex/provider-contract-suite`

Do not copy or stash the primary checkout’s whole dirty state into the worktree.

### Phase 1 — Build the reusable local harness

Create:

- `scripts/provider-black-box/provider-test-harness.ts`
- `scripts/provider-black-box/fake-provider-http-server.ts`
- `scripts/provider-black-box/provider-wire-fixtures.ts`
- `vitest.provider-black-box.config.ts`

Extend [fake-codex-server-lib.ts](/Users/qduc/src/term2/scripts/fake-codex-server-lib.ts) without replacing its existing interface.

The harness must provide:

- loopback HTTP, SSE, and WebSocket servers;
- captured outbound requests;
- named deterministic scenarios;
- isolated home, settings, conversations, logs, cache, and Codex auth;
- removal of inherited real provider credentials;
- stdout/stderr redirected to real temporary files;
- asynchronous child execution—a synchronous child would block the fake server;
- a hard deadline, termination, awaited process close, and server cleanup in `finally`.

Fixture families:

- OpenAI Responses HTTP/WS
- Codex Responses WS
- Chat Completions SSE
- Anthropic Messages SSE
- Google GenerateContent
- OpenRouter’s AI SDK path

Keep fixtures minimal and derived from sanitized real traffic. Assert semantic fields rather than complete JSON snapshots.

Endpoint gate:

- Use `CODEX_BASE_URL` for Codex.
- Verify that the installed OpenAI client honors `OPENAI_BASE_URL`.
- Use runtime custom-provider `baseUrl` settings for Chat Completions, Anthropic, and Google.
- If built-in OpenAI cannot be redirected, introduce a narrow client-construction dependency seam; do not add a user-facing test setting.

### Phase 2 — Add provider-boundary conformance tests

Create a table-driven provider contract suite that obtains models through [registry.ts](/Users/qduc/src/term2/source/providers/registry.ts), not by constructing transport classes directly.

Shared invariants:

- the registered provider returns a usable `StreamedModelTurn`;
- a stream emits exactly one authoritative completion or throws;
- a missing/incomplete terminal event cannot become generic empty success;
- errors survive adapters, bridges, and decorators;
- tool-call IDs remain stable;
- provider options reach their native request fields;
- `[user, assistant, user]` history retains role, ordering, and content;
- application-level follow-up continuity is preserved through the production
  session path, not only when a provider model is invoked directly.

A provider-boundary continuation test is not sufficient for this invariant. The
regression scenario must exercise `turn-workflow`/`AgentClient`/the application
run loop, complete one user turn, start a second user turn, and inspect the
second provider request. For providers with server-managed conversation
chaining, the request must carry the first response's ID in the provider-native
field (`previous_response_id` for Responses/Codex). For stateless providers,
the same scenario must assert that the second request contains the complete
required history with correct roles and ordering instead of silently sending
only the latest user message.

Approval pause/resume is a separate required path, not covered by the two-user-turn
scenario. Drive a tool call that requires approval, pause the run, approve it,
resume through the real continuation handle, and inspect the next provider
request. For chaining providers, assert that it uses the response ID that
produced the tool call and carries the paired tool output; for stateless
providers, assert the reconstructed history contains the tool call/output pair
with correct ordering. Include the rejection path where the rejected tool
result is sent back to the model. Run this approval scenario for every provider
family that supports tools, not only Codex.

Before implementation, define an explicit provider-family capability matrix covering every supported registry/runtime family: transport (HTTP/SSE/WS), chaining mode, tool/approval support, reasoning support, and native continuation fields. The matrix is the completeness checklist; “one case per wire family” is not sufficient when provider routing or lifecycle behavior differs.

Run the complete scenario set once per distinct wire family, then apply the matrix-specific additions. Give OpenRouter only success, error, and request-shape coverage instead of duplicating the entire AI SDK matrix.

### Phase 3 — Add assembled CLI black-box coverage

Create:

- `scripts/provider-black-box/provider-cli.blackbox.ts`
- `scripts/run-provider-black-box.mjs`

Use a dedicated Vitest configuration so these build-dependent tests do not silently join ordinary `pnpm test`.

Add package scripts that run, sequentially:

1. `pnpm build`
2. the dedicated black-box configuration

Run the shipped `dist/cli.js`, correcting the stale-build assumption currently present in [cli.integration.test.ts](/Users/qduc/src/term2/source/cli.integration.test.ts:221).

Required scenarios:

| Scenario | Assertions | Bugs shielded |
|---|---|---|
| Codex streamed text | Exact stdout and exit 0 | #1 |
| Final-only completion | Text printed exactly once | #2 |
| Fragmented Chat tool call | One call with complete arguments | #3 |
| Registry-backed Codex continuation | Obtain Codex through `registry.ts`; assert `call_id`, no `callId`, correct `previous_response_id`, tool output, and final response | #4, #8 |
| Registry success per family | Usable streamed model | #5 |
| Chat reasoning | Reasoning and answer both preserved | #6 |
| Responses history/tool input | Native Responses item types on the wire | #7A |
| Error, early close, incomplete stream | Non-zero exit and no fake empty success | #7B |
| Anthropic/Google reasoning | `thinking` / `thinkingConfig` captured | #9 |
| OpenAI Responses WS and Codex WS registry/assembled coverage | Correct output and exit before deadline, plus continuation, native terminal error, incomplete stream, and abnormal close | WS framing, cleanup, and continuation regressions |
| Application-level multi-turn continuity for every supported provider family | Drive two real user turns through the assembled session path; assert `previous_response_id`/provider-native continuation for chaining providers, or complete history and roles for stateless providers | Dropped `previousResponseId`, provider-specific follow-up regressions, and history truncation |
| Application-level approval pause/resume for every tool-capable provider family | Require approval for a tool, approve and resume through the real continuation handle; also cover rejection; assert the response ID/history and paired tool result on the next provider request | Lost continuity across approval, missing tool results, replayed or orphaned tool calls |
| Native failure and incomplete transport paths | Exercise early close, incomplete terminal, and native `response.failed`/equivalent events through contract and assembled paths; assert non-zero failure and no fabricated completion | Silent empty success and swallowed provider failures |
| Reasoning response preservation | Assert streamed reasoning events/output, not only native request options, across each reasoning-capable family | Dropped reasoning deltas, summaries, or signed metadata |
| Restart/resume continuity | Complete or interrupt a conversation, restart with the same isolated state, and assert persisted history, tool ledger, and response-ID/full-history recovery | Persistence and crash-recovery regressions |
| Multi-turn history | Native roles and ordering | Serialization regressions |

Use harmless deterministic tool data stored in fixture files, following the repository’s shell-safety rules.

The existing provider-contract continuation cases do not satisfy the
application-level continuity requirement: those cases call a provider model
directly and manually assemble the continuation input. Keep them as provider
wire tests, but add a separate assembled-session scenario whose outbound
request capture proves the production orchestration propagated continuity.
The current one-shot CLI harness cannot drive these scenarios: it must first
support a stateful two-send driver and real approval decisions. Do not mark
these rows complete until the driver exercises the shipped session path rather
than only direct `model.stream()` calls.

### Phase 4 — Prove the suite is capable of failing

Do not accept green-only evidence.

1. Commit the harness and tests separately from any necessary production seam.
2. Create a disposable red-proof worktree from the parent of the provider-fix commit.
3. Apply the test-only commits there.
4. Record which scenarios fail against the pre-fix implementation.
5. Return to the feature worktree and confirm all scenarios pass.

Acceptance requires at least one failing black-box scenario for every escaped bug class—not necessarily ten entirely separate tests. The application-level continuity scenario must run for every supported provider family (including Codex, OpenAI Responses, OpenAI-compatible/Chat Completions, Anthropic, Google, OpenRouter, and OpenCode where configured), with assertions selected by each provider's chaining capability; Codex-only coverage does not satisfy this requirement. The capability matrix must have a corresponding executed scenario or an explicit documented exclusion for every row, and the stateful driver must demonstrate red-proof failures against the pre-fix implementation for continuity and approval.

### Phase 5 — Integrate and gate changes

Focused verification order:

1. New provider black-box suite.
2. Existing [fake-codex-server.e2e.test.ts](/Users/qduc/src/term2/scripts/fake-codex-server.e2e.test.ts).
3. Provider and application-run-loop unit cluster.
4. `pnpm typecheck`
5. `pnpm build`
6. Full `pnpm test`
7. `git diff --check`
8. Lint, with unrelated baseline failures reported separately.

Provider, bridge, run-loop, registry, or non-interactive changes should require the provider black-box command before merge.

### Phase 6 — Scheduled live canaries

Treat this as a follow-up after the deterministic suite lands.

The repository has no tracked CI workflows, so first confirm the CI platform. Then add a scheduled/manual workflow—not a PR workflow—with:

- one cheap model per provider family;
- basic output, tool continuation, multi-turn serialization, reasoning, and invalid-model checks;
- isolated jobs with `fail-fast: false`;
- sanitized summaries only;
- no raw traffic, headers, or credentials uploaded.

Keep failures informational initially. Codex OAuth should remain manual or self-hosted until refresh-token storage is explicitly approved.

### Delivery structure

Use one feature worktree and serialize shared edits to `package.json` and the fake-Codex server. Independent review can remain read-only; parallel implementation offers little benefit because the harness establishes the interface used by every later phase.

Minimum first merge: Phases 0–5. Phase 6 should not delay deterministic protection against the ten known regression classes.