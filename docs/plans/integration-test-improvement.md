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
- `[user, assistant, user]` history retains role, ordering, and content.

Run the complete scenario set once per distinct wire family. Give OpenRouter only success, error, and request-shape coverage instead of duplicating the entire AI SDK matrix.

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
| Codex continuation | `call_id`, no `callId`, correct `previous_response_id` | #4, #8 |
| Registry success per family | Usable streamed model | #5 |
| Chat reasoning | Reasoning and answer both preserved | #6 |
| Responses history/tool input | Native Responses item types on the wire | #7A |
| Error, early close, incomplete stream | Non-zero exit and no fake empty success | #7B |
| Anthropic/Google reasoning | `thinking` / `thinkingConfig` captured | #9 |
| OpenAI WS success | Correct output and exit before deadline | #10 |
| Multi-turn history | Native roles and ordering | Serialization regressions |

Use harmless deterministic tool data stored in fixture files, following the repository’s shell-safety rules.

### Phase 4 — Prove the suite is capable of failing

Do not accept green-only evidence.

1. Commit the harness and tests separately from any necessary production seam.
2. Create a disposable red-proof worktree from the parent of the provider-fix commit.
3. Apply the test-only commits there.
4. Record which scenarios fail against the pre-fix implementation.
5. Return to the feature worktree and confirm all scenarios pass.

Acceptance requires at least one failing black-box scenario for every escaped bug class—not necessarily ten entirely separate tests.

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