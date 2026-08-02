# Post-refactor provider boundary audit

**Status: complete.** Cartography, triage, PB-01 through PB-13 fixes, deterministic completion evidence, independent review, and all verification gates are complete; live-only policy questions remain documented deferrals.

**Last updated:** 2026-08-02

## Resume here

Completed artifacts:

- `docs/plans/post-refactor-provider-boundary-audit-baseline.md` — baseline evidence, pre-refactor comparison point, focused tests/typecheck, and compact Codex cache aggregate.
- `docs/plans/post-refactor-provider-boundary-audit-matrix.md` — shared routing map, typed field inventory, authority rules, compatibility paths, and initialized two-axis matrix.
- `docs/plans/post-refactor-provider-boundary-audit-findings.md` — independently triaged Phase B/C finding register, provider matrix, rejected claims, and implementation waves.

The audit retained PB-01 through PB-13. Phase C narrowed PB-02 to proven direct-counter producers, PB-05 to application-sourced `maxTokens`, and PB-10 to recognized Chat/Codex native reasoning. It rejected speculative foreign-provider leakage, strictness/parallel-policy loss, generic message-file loss, and the claim that runtime custom `openai` must use Responses. Do not reintroduce those claims without new native evidence.

Implementation waves PB-01 through PB-13 are applied. The authoritative total-token convention is now `input + output + cache creation` unless a provider supplies `total_tokens`; `ApplicationRunLoop` preserves that cumulative total. Deterministic evidence includes the loop → event processor cache-write test, JSONL replay coverage for native reasoning/tool results, and shipped-CLI Codex HTTP/WS request assertions for `prompt_cache_key`/`include` in the provider black-box suite. The remaining live-only/provider-policy deferrals are explicitly marked **D** in the matrix and must not be claimed fixed.

### Verification record

- Focused usage, loop, event-processor, persistence, and Responses black-box tests pass after the completion fixes.
- Provider black-box and typecheck pass. The initial full-suite attempt exposed a worktree-path-only Unix-socket length limit in `docker-host-control.runtime.test.ts`; moving the same worktree from `.worktrees/post-refactor-provider-boundary-audit` to `.worktrees/pba` resolved the environmental constraint without changing sandbox behavior. Final `pnpm test`: 406 files passed, 1 skipped; 5,052 tests passed, 1 skipped.
- Targeted lint/format and `git diff --check` pass. Repository-wide lint still reports pre-existing formatting issues outside this audit diff.
- The original Handoff section below is historical context superseded by this Resume section where it says the audit has not started.

## Handoff / start here

This plan is intended to be sufficient context for a fresh session. The audit has **not started**, and neither confirmed Codex defect described below has been fixed. At the time this plan was written, the file itself was untracked and the primary checkout also contained unrelated changes in:

- `.claude/skills/architecture/SKILL.md`
- `.claude/skills/architecture/reference/runtime-path.md`
- `AGENTS.md`
- `docs/architecture-overview.md`

Do not modify, stash, discard, or absorb those unrelated changes. Re-check `git status` because shared-checkout state may have changed since this handoff.

A nearby regression in the same defect family was already fixed before this audit was planned: commit `fcc66bc0` (`fix: preserve reasoning across parallel tool calls`) added the regression test `application tool continuation keeps one reasoning-bearing assistant message for parallel tool calls` in `source/providers/openai-chat-completions-model.test.ts`. Treat it as evidence and existing coverage, not pending audit work.

### Evidence already established

Provider traffic showed that Codex automatic prefix caching works even though the footer can omit it and interactive requests can omit `prompt_cache_key`. On 2026-08-02, the inspected traffic contained 13 Codex requests, 9 with nonzero cache reads, totaling 111,997 input tokens and 68,352 cached tokens (61.0%). Reproduce the aggregate without dumping traffic files:

```bash
D="$HOME/Library/Logs/term2-nodejs/logs/provider-traffic/2026-08-02"
for f in "$D"/*/*.json; do
  jq -rc 'select(.sent.provider=="codex" and (.received.summary.payload.usage.input_tokens // 0)>0)
    | [.sent.sessionId,
       .received.summary.payload.usage.input_tokens,
       .received.summary.payload.usage.input_tokens_details.cached_tokens]
    | @tsv' "$f" 2>/dev/null || true
done | awk -F '\t' '
  {n++; total+=$2; cached+=$3; if($3>0) hits++}
  END {printf "requests=%d cache_hits=%d input_tokens=%d cached_tokens=%d cached_rate=%.1f%%\\n",
              n,hits,total,cached,total?100*cached/total:0}'
```

The relevant current code mismatch is:

- `source/services/agent-runtime/application-run-loop.ts` stores cumulative cache reads as `cachedInputTokens`;
- `source/utils/ai/token-usage.ts` `normalizeAgentRunUsage()` reads cache details arrays but not that direct field;
- `source/services/stream-event-processor.ts` prefers the resulting run-state usage over richer response usage;
- `source/lib/agent-configuration.ts` adds `prompt_cache_key` to Codex model settings;
- `ApplicationRunLoop` does not project that setting into `StreamedModelTurnRequest`;
- `source/providers/codex-responses-model.ts` only forwards the key when it reaches its expected model-settings shape.

These are confirmed code-path diagnoses, but the required production-seam red tests have not yet been written or run.

### First actions in a new session

1. Read `AGENTS.md`, this plan, `docs/plans/provider-bug-sweep.md`, and the provider black-box ownership instructions before editing provider code.
2. Re-check the primary checkout and create an isolated worktree under `.worktrees/`; run `pnpm install` inside it.
3. Do **Phase A — Shared cartography first**. Do not immediately fan out all semantic auditors.
4. Save the cartographer's shared artifact as `docs/plans/post-refactor-provider-boundary-audit-matrix.md`. It must contain the routing map, field inventory, authority/precedence rules, and initialized two-axis matrix. Later agents read this artifact rather than reconstructing the architecture independently.
5. After coordinator review of that artifact, launch the semantic vertical slices. Keep them read-only.
6. Before implementation begins, change this document to `Status: in progress`, add a current `Resume here` section naming completed artifacts and disproven premises, and add this plan to the active-work list in `AGENTS.md`.
7. Keep one writer for shared contracts and conversion code. Use independent read-only reviewers and coordinator triage as specified below.

## Trigger

Two Codex defects were found while investigating apparently missing prompt caching:

1. **Footer cache usage is dropped.** `ApplicationRunLoop` accumulates cache reads as `cachedInputTokens`, but `normalizeAgentRunUsage()` only reads cache values from `inputTokensDetails`. `processStreamEvents()` then treats the incomplete run-state usage as authoritative and replaces richer provider-response usage, so the footer omits cached tokens even when Codex reports them.
2. **`prompt_cache_key` is dropped.** `AgentConfiguration.getAgent(sessionId)` adds the session key to Codex model settings, but `ApplicationRunLoop` does not project it into `StreamedModelTurnRequest`, and the Codex conversion path therefore cannot put it on the wire.

Provider traffic proves that automatic Codex prefix caching still works: on 2026-08-02, 13 inspected Codex requests reported 68,352 cached tokens out of 111,997 input tokens (61%). The audit must distinguish provider behavior from UI/accounting and request-projection defects.

These defects follow recent reasoning, continuation, history, and tool-call regressions documented in `docs/plans/provider-bug-sweep.md`. Their common shape is not provider failure but information lost between two valid representations during the refactor away from the Agents SDK.

## Goal

Prove that every supported semantic field survives all application/provider translation boundaries, or is rejected explicitly when unsupported. Fix confirmed omissions and add contract coverage that makes future shape drift fail loudly.

This is a targeted boundary audit, not a provider rewrite and not a general architecture refactor.

## Coordination and decomposition strategy

Use a **two-axis audit**. Semantic agents trace columns end-to-end; provider reviewers verify rows afterward. The coordinator owns intersections, triage, integration, and final verification.

Do not split primarily by file: that loses lifecycle semantics. Do not split only by provider: that duplicates architectural discovery and can miss shared defects. Do not split only by individual boundary: an agent may not see whether information lost at one boundary is recovered or corrupted later.

### Phase A — Shared cartography

Before parallel auditing, assign one strong read-only agent to produce the common boundary map:

```text
Agent settings
  → StreamedModelTurnRequest
  → provider-native request
  → provider-native response/events
  → application run-state
  → normalized terminal state
  → persistence and UI
```

The cartographer must deliver:

- the field inventory;
- conversion functions at every boundary;
- provider and transport routing map;
- authoritative versus fallback representations;
- the initial two-axis audit matrix;
- known compatibility and persistence paths that remain live.

Every later agent receives this map. They should verify it in their assigned area rather than independently reconstructing the whole architecture.

### Phase B — Semantic vertical slices

Run approximately six read-only audit agents concurrently. Each owns one semantic invariant family across the complete lifecycle and every provider route.

1. **Identity and continuity**
   - session ID;
   - `prompt_cache_key`;
   - response and previous-response IDs;
   - provider thread/turn IDs;
   - restart and restored-session continuity.

2. **Usage and accounting**
   - input, output, and total tokens;
   - cached-input and cache-write tokens;
   - reasoning tokens;
   - per-response versus cumulative semantics;
   - terminal collection, persistence, usage commands, and footer rendering.

3. **Generation and provider options**
   - temperature, top-p, penalties, and max tokens;
   - reasoning effort and summary;
   - tool choice and parallel-tool settings;
   - `providerOptions`, `providerData`, `extraBody`, includes, and headers.

4. **Tools and approvals**
   - tool schema and strictness;
   - call IDs and arguments;
   - parallel calls and result ordering;
   - approval pause, accept, reject, and resume;
   - continuation after execution.

5. **Content, reasoning, and persistence**
   - system/user/assistant roles;
   - text, images, and files;
   - native reasoning metadata;
   - stateless replay;
   - persistence, restoration, and ordering.

6. **Terminal and resilience semantics**
   - successful completion;
   - incomplete and failed responses;
   - early transport close;
   - cancellation;
   - retry ambiguity;
   - fabricated empty-success risks.

Each semantic agent must return findings in the common evidence format below. They do not edit production code.

### Phase C — Horizontal provider review

After semantic findings are triaged, assign different read-only agents to these provider/wire families:

1. OpenAI and Codex Responses, including HTTP and WebSocket differences;
2. OpenAI-compatible Chat Completions and both OpenCode routes;
3. Anthropic native Messages;
4. Google and OpenRouter AI SDK paths;
5. Runtime custom providers and llama.cpp-compatible routing where not already covered.

Provider reviewers receive the shared map and triaged semantic findings. Their bounded question is:

> For this provider family, verify every semantic matrix row, identify native exceptions, and test whether shared fixes would leak foreign fields or alter valid provider behavior.

They should not restart a general repository audit.

### Phase D — Central triage

Raw audit findings are not implementation instructions. The coordinator classifies each as:

- confirmed defect;
- missing test only;
- intentional provider difference;
- duplicate;
- unsupported claim;
- requires live evidence.

Every proposed defect must include:

```text
Field/invariant:
Source representation:
Boundary where lost or corrupted:
Destination representation:
Affected providers:
User-visible effect:
Evidence:
Correct regression-test seam:
```

An empty actionable finding set is acceptable. Do not retain speculative findings merely to justify the audit.

### Phase E — Controlled implementation waves

Keep a single writer for shared files and contracts. Read-only reviewers may run concurrently; writers may run concurrently only in isolated worktrees with non-overlapping ownership.

1. **Known regressions:** one writer fixes footer cache usage and Codex `prompt_cache_key`, test-first.
2. **Shared boundary fixes:** group confirmed defects by shared seam, such as request projection, usage normalization, conversation persistence, or turn conversion. Use one writer per seam and serialize overlapping files.
3. **Provider-specific fixes:** use isolated worktrees concurrently only when they do not change shared contracts or the same test infrastructure.
4. **Integration:** one integrator updates shared contracts, capability matrix, provider black-box coverage, documentation, and verification evidence.

Do not allow parallel agents to make independent competing edits to `ApplicationRunLoop`, streamed model contracts, usage normalization, registry wiring, or shared black-box manifests.

### Phase F — Independent review

Use reviewers who did not implement the changes:

- a **completeness reviewer** compares the final matrix against every typed field and provider route;
- an **integration reviewer** examines the combined diff for precedence errors, double counting, cross-provider leakage, incompatible aliases, and conflicting transformations.

Where practical, use a different model/provider for independent review. Findings still pass through coordinator triage before changes are made.

### Two-axis completion matrix

Semantic agents fill columns; provider reviewers verify rows. A cell is complete only with test evidence or a documented unsupported rationale.

| Provider family | Identity | Usage | Settings | Tools | Content/reasoning | Terminal |
| --- | --- | --- | --- | --- | --- | --- |
| Codex Responses |  |  |  |  |  |  |
| OpenAI Responses |  |  |  |  |  |  |
| OpenAI-compatible Chat |  |  |  |  |  |  |
| OpenCode routes |  |  |  |  |  |  |
| Anthropic Messages |  |  |  |  |  |  |
| Google/OpenRouter AI SDK |  |  |  |  |  |  |
| Runtime custom/llama.cpp |  |  |  |  |  |  |

This structure deliberately creates overlapping review without overlapping implementation: semantic agents understand whole lifecycles, provider agents understand native exceptions, and one coordinator resolves their intersections.

## Primary boundaries

Audit each direction independently:

1. Settings/session configuration → `ApplicationAgent.modelSettings`
2. `ApplicationAgent` → `StreamedModelTurnRequest`
3. `StreamedModelTurnRequest` → provider-native request
4. Provider-native stream/response → `StreamedModelTurnEvent`
5. Completion usage/output → application run-state accumulator
6. Run-state/stream fallback usage → `NormalizedUsage`
7. Conversation terminal result → persisted turn/session state
8. `NormalizedUsage` → status-bar/footer and usage commands
9. Persisted state → resumed/replayed provider request

For every boundary, inventory source fields, destination fields, ownership, unsupported behavior, and tests. A field must be forwarded, deliberately transformed, deliberately omitted with rationale, or rejected. Silent disappearance is a defect.

## Audit matrix

Build a checked-in matrix covering these semantic families:

| Family | Fields/invariants to trace |
| --- | --- |
| Identity and continuity | session ID, response ID, previous response ID, prompt cache key, provider thread/turn IDs |
| Generation settings | temperature, top-p, penalties, max tokens, tool choice, parallel tool calls |
| Reasoning | effort, summary mode, native reasoning content, encrypted/signed metadata, reasoning token usage |
| Provider options | provider data, extra body, extra headers, include fields, transport-specific metadata |
| Tools | definitions, strictness, IDs, arguments, parallel calls, results, approval pause/resume |
| Usage | input/output/total, cached input, cache writes, reasoning tokens, per-turn versus cumulative semantics |
| Content/history | roles, text, images/files, ordering, stateless replay, persisted/restored representation |
| Terminal behavior | completion, incomplete response, provider failure, early close, cancellation, retry ambiguity |

Apply the matrix to every registry/runtime family and every distinct transport path:

- Codex Responses HTTP and WebSocket
- OpenAI Responses HTTP and WebSocket
- OpenAI-compatible Chat Completions
- Anthropic native Messages
- Google native GenerateContent
- OpenRouter AI SDK
- OpenCode Anthropic and OpenAI-compatible routes
- Runtime custom providers, including llama.cpp-compatible routes

Do not infer completeness from one provider sharing a transport. Provider-specific wrappers and routing decisions must be represented explicitly.

## Phase 0 — Baseline and evidence

1. Create an isolated worktree under `.worktrees/` and install with `pnpm install`.
2. Record current focused tests, provider black-box suite, typecheck, and unrelated primary-checkout changes.
3. Preserve compact `jq` evidence for the Codex cache discrepancy without copying prompts or credentials into fixtures.
4. Add a matrix row for every field currently present in `ApplicationAgent`, `StreamedModelTurnRequest`, `StreamedModelTurnEvent`, `StreamedModelUsage`, and `NormalizedUsage`.
5. Identify the pre-refactor comparison point and record which old-path behaviors remain executable. Use history/source comparison where the old runtime can no longer run.

Gate: no fixes until the two known bugs have deterministic red-capable tests exercising their real production seams.

## Phase 1 — Lock down the two confirmed regressions

### 1A. Footer cache usage

Add tests proving the complete path:

- Codex completion reports `cachedInputTokens`.
- `ApplicationRunLoop.runUsage` retains it across multiple model turns.
- `processStreamEvents()` produces `cache_read_tokens` in authoritative final usage.
- `collectTerminalResult()` and UI state retain it.
- `StatusBar` renders `Tok: … in (… cached) / … out` from the resulting production-shaped usage.

The red test must use the direct run-state shape actually emitted by `ApplicationRunLoop`, not a hand-crafted legacy `inputTokensDetails` shape.

Likely fix seam: make `normalizeAgentRunUsage()` accept direct cumulative cache/reasoning fields while preserving detail-array summation for the legacy SDK shape. Verify no double counting when both forms are present.

### 1B. Codex prompt cache key

Add tests proving:

- A real session ID becomes `prompt_cache_key` on the first Codex request.
- The same key remains stable across internal tool turns, approval resume, ordinary follow-up turns, and restored sessions.
- Different sessions receive different keys.
- Transient/subagent clients follow an explicit policy rather than inheriting a root session accidentally.
- Providers without this capability do not receive a foreign option.

The test must drive the registry/application run loop and inspect captured provider-native request bodies. Existing tests that inspect only `AgentConfiguration` or directly call `_buildResponsesCreateRequest()` are insufficient.

Choose one owned representation for the field. Prefer extending the typed streamed request contract over hiding application semantics in an untyped provider-data bag. Update every adapter exhaustively.

Gate: both tests fail on the pre-fix code, pass after the fix, and the focused provider/UI tests remain green.

## Phase 2 — Static projection audit

For each primary boundary:

1. Enumerate source fields from the TypeScript types and constructors.
2. Enumerate destination fields from conversion functions and native request builders.
3. Produce a source-to-destination table with one of: forwarded, renamed, accumulated, provider-specific, deliberately unsupported, or missing.
4. Confirm every spread/allowlist/destructuring site. Pay special attention to code that manually selects fields, because it does not fail when a new field is added.
5. Audit aliases and cumulative shapes such as:
   - `cachedInputTokens` / `cacheReadTokens` / `cached_tokens` / `cache_read_tokens`
   - `cacheWriteTokens` / `cacheCreationTokens`
   - `previousResponseId` / `previous_response_id`
   - `providerOptions` / `providerData` / `extraBody`
6. Audit precedence where both authoritative run totals and richer per-response data exist. Replacing one with the other must not discard dimensions absent from the preferred source.

Record each confirmed omission as a numbered finding with affected providers, user-visible impact, exact boundary, and regression-test seam.

## Phase 3 — Differential and contract testing

Add table-driven tests that generate representative application requests containing every supported field, pass them through production registry wiring, and assert semantic native request fields.

Add reverse-path tests that feed minimal provider-native success, tool, reasoning, usage, incomplete, and failure events and assert application events and terminal state.

Where practical, run the same fixture through the pre-refactor and current converters and compare normalized semantics. Ignore expected transport-only differences; require explicit approval for semantic differences.

Required scenarios:

- Single-turn text
- Multi-turn text
- Tool call and continuation
- Parallel tool calls
- Approval accept and reject
- Reasoning plus tool continuation
- Session restart/replay
- Cache hit and cache write usage
- Missing terminal frame
- Native failure frame
- Cancellation and retry boundary

Extend `scripts/provider-black-box/provider-contract.test.ts` and the capability manifest rather than creating a second disconnected provider harness.

## Phase 4 — Assembled UI/accounting coverage

Add an assembled test from a provider completion through conversation processing to the rendered status bar. It must cover:

- zero cache on a warm-up request;
- nonzero cache on a later request;
- cumulative multi-turn cache usage;
- no double counting after approval resume;
- footer restoration after loading a persisted session;
- absence of misleading “uncached” warnings when cache-read data exists.

Keep component-only `StatusBar` tests, but do not treat them as sufficient: they prove formatting, not that production usage reaches the component.

## Phase 5 — Prevention

After fixing findings:

1. Replace duplicated field allowlists with shared typed conversion helpers where that reduces drift without creating a generic mega-abstraction.
2. Add exhaustive compile-time switches for discriminated unions.
3. Add contract tests that fail when a new typed request/usage field lacks a projection decision.
4. Document authoritative versus fallback usage semantics next to `StreamedModelUsage` and `normalizeAgentRunUsage()`.
5. Keep provider-native escape hatches namespaced and test that they do not leak across providers.
6. Update `AGENTS.md` and the provider black-box ownership section only if suite ownership or mandatory commands change.

## Verification gates

Every fix must include red-proof evidence when practical. Before handoff run:

```bash
pnpm exec vitest run source/utils/ai/token-usage.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  source/services/stream-event-processor.test.ts \
  source/services/session/terminal-result-collector.test.ts \
  source/components/layout/StatusBar.test.tsx
pnpm exec vitest run source/providers
pnpm test:provider-black-box
pnpm typecheck
pnpm test
```

Also run `git diff --check` and the project lint/format checks. Provider, registry, bridge, run-loop, or non-interactive changes require the provider black-box suite.

For live verification, use only approved configured providers and compact provider-traffic `jq` queries. Never store credentials, complete prompts, or private reasoning in fixtures. Live checks supplement deterministic tests; they do not replace them.

## Deliverables

- Completed boundary audit matrix
- Numbered, evidence-backed findings
- Regression tests for every confirmed defect
- Fixes separated into reviewable commits by boundary or semantic family
- Updated provider black-box capability/accounting coverage
- Verification record with commands, results, changed files, and residual risks
- Final status update in this document naming the shipped symbols and commits

## Non-goals

- Replacing all provider adapters with one abstraction
- Rewriting the conversation/session architecture
- Assuming all providers share OpenAI field names
- Optimizing provider cache policy before correctness and observability are proven
- Treating cache-write token value `0` as evidence that cache reads are broken
- Adding live-provider CI canaries without separate secret, billing, and OAuth-storage decisions

## Completion criteria

The audit is complete only when:

1. The two known Codex regressions are fixed and red-proven.
2. Every matrix cell has an explicit projection decision and test evidence or a documented unsupported rationale.
3. No supported semantic field silently disappears at an audited boundary.
4. Provider-native usage agrees with conversation terminal usage and footer output for deterministic cache scenarios.
5. The full provider black-box suite, focused provider tests, typecheck, and full test suite pass.
6. Residual live-only risks and deferred canary work are documented.
