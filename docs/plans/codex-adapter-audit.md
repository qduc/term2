# Codex adapter contract audit

**Status: plan.** Not yet implemented; waiting to be scheduled as dedicated provider work.
**Last updated:** 2026-08-02

## Why this exists

The Codex compatibility adapter in `source/providers/codex.provider.ts` manually translates the application-owned `StreamedModelTurn` contract into the Codex/OpenAI Responses model contract. This conversion duplicated behavior from the shared provider bridge and drifted during the Agents SDK decoupling.

A production report showed that `gpt-5.6-luna` received no project context. The immediate regression was fixed in merge commit `b5a5aaa3`: `codexStream()` now forwards application instructions as `systemInstructions`, and Codex completion usage is preserved. The audit below is the remaining work; do not re-fix those two landed issues.

Related historical context:

- `docs/plans/decouple-from-openai-agents-sdk.md`
- `docs/plans/provider-bug-sweep.md`
- `source/contracts/streamed-model-turn.ts`
- `source/providers/agents-model-bridge.ts`
- `source/providers/codex.provider.ts`
- `source/providers/codex-responses-model.ts`

## Remaining work

### 1. Audit every request field

Build a field-by-field matrix for `StreamedModelTurnRequest` and verify that Codex either:

1. preserves it semantically on the wire,
2. intentionally transforms it with a documented Codex/Luna rule, or
3. rejects it explicitly as unsupported.

Do not silently drop fields. Include:

- `instructions` and `previousResponseId`
- `input`
- `tools` and `toolChoice`
- `temperature`
- `topP`
- `frequencyPenalty` and `presencePenalty`
- `maxTokens`
- reasoning effort/summary
- provider options
- abort signal

`temperature` is currently intentionally stripped because the Codex endpoint rejects it; preserve that characterized behavior.

### 2. Fix input conversion

Audit every `StreamedModelTurnInput` variant:

- Text messages and roles
- Image message parts; they must not become `"[object Object]"`
- Reasoning-history items; they must not fall through as malformed function-call outputs
- Tool calls
- Text, image, and file tool results
- Provider-native reasoning metadata and IDs where continuation requires them

Unsupported shapes must fail with a precise error rather than produce malformed wire input.

### 3. Audit output and terminal conversion

Verify:

- Text and reasoning deltas
- Tool-call IDs, names, and streamed arguments
- Assistant output reconstruction
- Provider-native reasoning output needed by later turns
- Completion IDs and finish reasons
- Input/output/cache token accounting
- Incomplete, failed, error, close, timeout, and EOF behavior
- Exactly one authoritative completion and no events after completion

Usage propagation was fixed with the project-context regression; retain and broaden its coverage.

### 4. Prove HTTP/WebSocket parity

Run the same semantic contract scenarios through both transports:

- First request
- Chained request with `previousResponseId`
- Tool-call continuation
- Reasoning continuation
- Transport reconnect/recovery
- Missing or malformed terminal event

Account for intentional wire differences, but require equivalent application-visible behavior.

### 5. Prove Luna Responses Lite behavior

Cover Luna-specific normalization explicitly:

- Initial instructions become one developer input message
- Chained requests neither lose required context nor duplicate the established prefix
- Additional-tools developer input remains ordered correctly relative to project instructions and user history
- First-turn and chained behavior work over HTTP and WebSocket

### 6. Reduce future adapter drift

Prefer one of these outcomes:

- Reuse shared exhaustive conversion helpers with Codex-specific policy hooks, or
- Keep a Codex-specific converter whose input and output switches are exhaustive and whose unsupported cases throw.

Avoid another loosely typed manual mapping in `codexStream()`.

### 7. Close the test gap

Current tests separately prove prompt construction and downstream Codex normalization, which allowed the adapter boundary to drop instructions while both suites stayed green.

Add tests that cross the production boundary:

- Obtain providers through `source/providers/registry.ts`
- Include a unique project-context sentinel and assert its semantic wire representation
- Cover Codex HTTP and WebSocket
- Cover first and chained turns
- Assert all request-contract fields through a table-driven matrix
- Assert output, usage, and terminal behavior
- Add or extend provider black-box scenarios against the built CLI

For every regression, add a red-proof case when practical.

## Acceptance criteria

- Every field and variant in `StreamedModelTurnRequest`, `StreamedModelTurnInput`, and `StreamedModelTurnEvent` has a tested Codex disposition.
- No supported field is silently dropped or corrupted.
- Unsupported fields fail explicitly with actionable errors.
- HTTP, WebSocket, first-turn, chained-turn, tool, reasoning, image, usage, and failure paths are covered.
- Luna receives project instructions correctly without duplication across continuation.
- Relevant unit tests, fake-Codex E2E, `pnpm test:provider-black-box`, `pnpm typecheck`, and the full suite pass.
- Sanitized live-provider verification is recorded when credentials are available; inspect traffic through the provider-traffic workflow without committing credentials or raw sensitive traffic.

## Known test-infrastructure note

In a dependency-symlinked worktree, commands that invoke `pnpm exec` may attempt dependency maintenance and abort. Follow the worktree dependency instructions in `AGENTS.md`; do not install through the symlink. This is infrastructure behavior, not evidence that a provider test passed or failed.
