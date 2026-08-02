# Phase D final triage — post-refactor provider boundary audit

Read-only reconciliation of Phase B, the plan/matrix, all five Phase C reports, and current source at `8ed71544`. Provider claims are retained only where the source establishes both a supported source representation and a real loss; adapter-only or live-provider assumptions are not promoted to defects.

## Retained confirmed defects

### PB-01 — ACT — HIGH — Codex application requests lose the session cache key
- **Field/invariant:** capability-enabled, non-transient Codex sessions must send their configured `prompt_cache_key`.
- **Source representation:** `AgentConfiguration.getAgent(sessionId)` adds top-level `modelSettings.prompt_cache_key` (`source/lib/agent-configuration.ts:116-137`).
- **Boundary where lost or corrupted:** the application caller uses `getApplicationAgent()`'s uninjected base settings (`source/lib/agent-configuration.ts:155-183`), and the loop's request literal does not project the key (`source/services/agent-runtime/application-run-loop.ts:324-338`).
- **Destination representation:** Codex HTTP/WS would emit it from `request.modelSettings.prompt_cache_key` (`source/providers/codex-responses-model.ts:275-278`).
- **Affected providers:** Codex Responses HTTP and WebSocket.
- **User-visible effect:** configured per-session cache-key policy is absent from native requests.
- **Evidence:** static path is complete before the HTTP/WS split; Phase C confirms context-owned WS identity is separate and does not repair this loss.
- **Correct regression-test seam:** registry/application-run-loop native-body capture for initial, tool/approval continuation, follow-up, restored, distinct-session, and transient cases.

### PB-02 — ACT — HIGH — authoritative run usage omits direct cumulative cache counters
- **Field/invariant:** cumulative `cachedInputTokens` and `cacheWriteTokens` must normalize once as `cache_read_tokens` and `cache_creation_tokens`.
- **Source representation:** the loop accumulates direct fields (`source/services/agent-runtime/application-run-loop.ts:398-421`); Codex and AI-SDK adapters emit that shape (`source/providers/codex.provider.ts:724-735`, `source/providers/ai-sdk-streamed-model.ts:154-163`).
- **Boundary where lost or corrupted:** `normalizeAgentRunUsage()` reads only details arrays (`source/utils/ai/token-usage.ts:230-267`).
- **Destination representation:** `processStreamEvents()` makes the incomplete run-state total authoritative (`source/services/stream-event-processor.ts:440-457`).
- **Affected providers:** Codex HTTP/WS and AI-SDK application routes (Anthropic, Google, OpenRouter, including their custom routes); Chat becomes affected only when PB-04 begins supplying usage.
- **User-visible effect:** reported cache reads/writes disappear from terminal usage, persistence, accounting, and the footer.
- **Evidence:** direct producer and consumer shapes conflict; Phase C **narrows** the prior broad claim—OpenAI Responses cache dimensions require a native fixture before being attributed to that row.
- **Correct regression-test seam:** completion → loop → event processor → terminal/footer, with multi-turn and approval continuation plus direct/detail coexistence.

### PB-03 — ACT — HIGH — compatibility cache-write spelling is not normalized
- **Field/invariant:** compatibility `cache_write_tokens` must become `cache_creation_tokens`.
- **Source representation:** `adaptStreamedModelTurnForAgents()` produces `inputTokensDetails: [{cache_write_tokens: ...}]` (`source/providers/agents-model-bridge.ts:270-281`).
- **Boundary where lost or corrupted:** neither `normalizeUsage()` nor `normalizeAgentRunUsage()` accepts that spelling (`source/utils/ai/token-usage.ts:81-89,245-249`).
- **Destination representation:** normalized/terminal usage lacks cache creation.
- **Affected providers:** live legacy/compatibility consumers of application turns; not a second Codex direct-usage defect.
- **User-visible effect:** cache-write accounting is omitted on the compatibility path.
- **Evidence:** exact producer spelling conflicts with both allowlists.
- **Correct regression-test seam:** table-driven aliases through both normalizers and one compatibility stream-to-terminal path.

### PB-04 — ACT — HIGH — Chat drops supplied terminal usage
- **Field/invariant:** supplied Chat `chunk.usage` must be carried by the application completion.
- **Source representation:** the direct Chat stream sees `chunk.usage` (`source/providers/openai-chat-completions-model.ts:155-157`).
- **Boundary where lost or corrupted:** that branch is a no-op; the completion has no `usage` (`:171-202`).
- **Destination representation:** the loop cannot accumulate it.
- **Affected providers:** OpenAI-compatible Chat, OpenCode Chat, runtime `openai`, `openai-compatible`, and `llama.cpp` routes.
- **User-visible effect:** providers which send terminal usage can still show no token usage.
- **Evidence:** Phase C confirms this is not an Anthropic-route issue; AI-SDK Anthropic already emits direct usage.
- **Correct regression-test seam:** fake terminal usage frame through adapter → loop → terminal/persistence/footer; do not add a global `stream_options.include_usage` without provider compatibility evidence.

### PB-05 — ACT — HIGH — application-loop projection loses configured `maxTokens`
- **Field/invariant:** `AgentModelSettings.maxTokens` must reach a streamed request or be explicitly rejected.
- **Source representation:** `maxTokens` is an application setting and nested runs populate it (`source/services/agent-runtime/application-run-loop.ts:24-36`; `source/services/subagents/nested-runner.ts:234-238`).
- **Boundary where lost or corrupted:** the loop request literal selects only temperature, reasoning, and provider data (`source/services/agent-runtime/application-run-loop.ts:324-338`).
- **Destination representation:** Codex, Chat, and AI-SDK converters all have a max-token mapping when given a request value (`source/providers/codex-turn-converter.ts:95-105`, `openai-chat-completions-model.ts:106-117`, `ai-sdk-streamed-model.ts:218-228`).
- **Affected providers:** every application-loop route.
- **User-visible effect:** configured output limits are ignored.
- **Evidence:** static supported source and destination exist. **Narrowed by Phase C:** `toolChoice`, top-p, and penalties are typed request fields but have no identified `ApplicationAgent` source; their loop-level policy is missing/undecided, not proven loss from agent configuration. They remain independently proven at PB-07/PB-08 where direct requests are dropped.
- **Correct regression-test seam:** application agent/registry native-request capture, including nested-run max tokens and provider-specific supported/rejected assertions.

### PB-06 — ACT — HIGH — Codex factory `include` is dropped
- **Field/invariant:** factory-selected Codex `include: ['reasoning.encrypted_content']` must reach Codex.
- **Source representation:** `buildModelSettings()` sets it for Codex (`source/lib/agent-factory.ts:267-272`).
- **Boundary where lost or corrupted:** loop projection omits `include` (`source/services/agent-runtime/application-run-loop.ts:324-338`).
- **Destination representation:** Codex merges retained `request.modelSettings.include` (`source/providers/codex-responses-model.ts:267-273`).
- **Affected providers:** Codex Responses HTTP and WebSocket only.
- **User-visible effect:** encrypted reasoning content requested for continuation/replay can be unavailable.
- **Evidence:** concrete producer plus unreachable destination; Phase C confirms it must stay Codex-only.
- **Correct regression-test seam:** real Codex application agent HTTP/WS capture; assert one include and no leak to OpenAI.

### PB-07 — ACT — HIGH — OpenAI Responses bridge drops typed direct-request settings
- **Field/invariant:** direct application `toolChoice`, top-p, penalties, and max tokens must survive to OpenAI Responses.
- **Source representation:** `StreamedModelTurnRequest` declares the fields (`source/contracts/streamed-model-turn.ts:41-55`).
- **Boundary where lost or corrupted:** `bridgeBackToTurn()` builds legacy settings only from temperature, reasoning, and provider data (`source/providers/agents-model-bridge.ts:19-38`).
- **Destination representation:** `requestBody()` receives none and serializes none (`source/providers/openai-responses-model.ts:81-101`).
- **Affected providers:** OpenAI Responses HTTP and WebSocket.
- **User-visible effect:** direct/compatibility callers silently get provider defaults.
- **Evidence:** Phase C confirms both transports share this second, independent boundary; it remains after PB-05.
- **Correct regression-test seam:** bridge an all-fields streamed request and capture both HTTP and WS native bodies, including zero values.

### PB-08 — ACT — HIGH — Chat conversion omits supported direct-request options
- **Field/invariant:** Chat `toolChoice`, top-p, frequency penalty, and presence penalty must serialize when present.
- **Source representation:** common request contract (`source/contracts/streamed-model-turn.ts:47-51`).
- **Boundary where lost or corrupted:** Chat `stream()` omits all four (`source/providers/openai-chat-completions-model.ts:106-117`).
- **Destination representation:** native body lacks `tool_choice`, `top_p`, `frequency_penalty`, and `presence_penalty`.
- **Affected providers:** OpenAI-compatible Chat, OpenCode Chat, runtime `openai`, `openai-compatible`, and `llama.cpp`.
- **User-visible effect:** direct requests ignore sampling/tool-selection policy.
- **Evidence:** direct adapter allowlist omission; AI-SDK Anthropic is a verified native exception.
- **Correct regression-test seam:** direct Chat body assertions for all fields plus one full loop/registry capture.

### PB-09 — ACT — MEDIUM — unknown-tool result is transient, not durable
- **Field/invariant:** each model tool call, including an unknown-tool rejection, needs a canonical matching result.
- **Source representation:** unknown branch writes only `state.input` (`source/services/agent-runtime/application-run-loop.ts:442-455`).
- **Boundary where lost or corrupted:** it neither appends `function_call_result` to history nor emits a run item, unlike known branches (`:458-534`).
- **Destination representation:** finalization can persist an unmatched call (`source/services/session/session-stream-processor.ts:343-367`).
- **Affected providers:** every application-loop route.
- **User-visible effect:** restored/replayed history can contain unmatched tool calls.
- **Evidence:** immediate same-run continuation is counterevidence to a broader claim; the durability loss is real.
- **Correct regression-test seam:** unknown call → terminal/finalization/replay; assert one call/result pair in input, output/history, and restored provider history.

### PB-10 — ACT — HIGH — recognized no-tool native reasoning is never committed
- **Field/invariant:** recognized Chat/Codex native reasoning must reach canonical history/output before a successful no-tool finish.
- **Source representation:** loop buffers recognized metadata (`source/services/agent-runtime/application-run-loop.ts:357-365,571-603`) and terminal output can contain it (`:399-407`).
- **Boundary where lost or corrupted:** it commits pending reasoning only before tool calls; no-tool completion finishes without a commit (`:410-431`).
- **Destination representation:** persistence and stateless replay lack that native item.
- **Affected providers:** Codex HTTP/WS and Chat-compatible routes which emit `reasoning_content`; not OpenAI Responses or AI-SDK Anthropic absent a native fixture/policy.
- **User-visible effect:** continuation signatures/reasoning can be lost after an ordinary answer.
- **Evidence:** Phase C **narrows** the Phase-B all-route wording: recognized Chat/Codex only; generic AI-SDK reasoning remains intentionally display-only.
- **Correct regression-test seam:** no-tool recognized reasoning plus text → canonical history/output → next request and restored replay.

### PB-11 — ACT — MEDIUM — Chat discards native finish reason
- **Field/invariant:** Chat `finish_reason` must be retained in application completion.
- **Source representation:** `choice.finish_reason` is present (`source/providers/openai-chat-completions-model.ts:128-132`).
- **Boundary where lost or corrupted:** adapter uses it solely as a boolean and omits `finishReason` (`:159-202`).
- **Destination representation:** loop persists `length`/`content_filter` as ordinary success-shaped output.
- **Affected providers:** all Chat-adapter routes.
- **User-visible effect:** truncated/filtered output cannot be distinguished downstream.
- **Evidence:** AI-SDK routes retain unified finish reason; the remaining loop/UI incomplete-result policy is a separate product decision.
- **Correct regression-test seam:** adapter and assembled cases for `stop`, `tool_calls`, `length`, and `content_filter`; assert preservation before selecting UI/error policy.

### PB-12 — ACT — HIGH — Anthropic wrapper overwrites an explicit max-output request
- **Field/invariant:** an explicit streamed `maxTokens` must not be replaced by the model catalog maximum without an explicit precedence policy.
- **Source representation:** AI-SDK conversion maps `request.maxTokens` to `maxOutputTokens` (`source/providers/ai-sdk-streamed-model.ts:218-228`).
- **Boundary where lost or corrupted:** Anthropic wrapper unconditionally rewrites `maxOutputTokens` (`source/providers/ai-sdk-anthropic.provider.ts:105-124`).
- **Destination representation:** native call receives the catalog value; current test deliberately expects `131072` even after requesting `1` (`source/providers/ai-sdk-anthropic.provider.test.ts:175-215`).
- **Affected providers:** built-in, custom, and OpenCode Anthropic Messages routes.
- **User-visible effect:** output-limit requests can be ignored, with cost/latency consequences.
- **Evidence:** Phase C provider-specific finding independently verified; it remains after PB-05 and is not PB-08.
- **Correct regression-test seam:** all three Anthropic registrations with explicit lower/equal/higher limits and an approved cap-vs-request precedence rule.

### PB-13 — ACT — MEDIUM — AI-SDK explicit provider settings are not forwarded on unary compatibility calls
- **Field/invariant:** explicit provider settings must apply consistently to the live `getResponse()` compatibility path.
- **Source representation:** AI-SDK providers wrap `withForwardedProviderSettings(...)` (`source/providers/ai-sdk-anthropic.provider.ts:180-184`; Google analogous).
- **Boundary where lost or corrupted:** proxy forwards only `doStream` (`source/providers/ai-sdk-provider-settings.ts:4-15`); `getResponse()` calls `doGenerate` (`source/providers/ai-sdk-streamed-model.ts:37-40`).
- **Destination representation:** unary native options lack the provider-settings forwarding performed by stream calls.
- **Affected providers:** AI-SDK Anthropic/Google and their custom/OpenCode Anthropic registrations; OpenRouter uses the same stream-only helper for its own forwarding.
- **User-visible effect:** legacy/unary compatibility consumers can receive different provider options than streamed calls.
- **Evidence:** compatibility is explicitly live in the cartography; this is not an application-loop streaming defect.
- **Correct regression-test seam:** fake V3 model recording both `doStream` and `doGenerate`, then compatibility `getResponse()` with explicit provider data.

## Missing-test-only items

- PB-01 lifecycle capture (initial/tool/approval/follow-up/restore/distinct/transient) is absent, but is **not** a reason to downgrade the static defect.
- Identity: server chaining versus transcript replay, reset-native-chain-on-restore, and custom/Google fallback-ID persistence need explicit lifecycle tests; the current non-chaining/fallback behavior has an intentional rationale.
- Provider row coverage: custom Anthropic/Google/OpenRouter currently proves construction or shared-adapter behavior more often than registry/wire/terminal semantics; add matrix fixtures rather than duplicate adapters.
- PB-02/PB-03 need assembled terminal/footer and direct-plus-details anti-double-count tests; existing unit tests do not cover authority replacement.
- PB-04 needs a terminal usage fixture; do not infer an opt-in request flag from this omission.
- PB-07/PB-08 and PB-12/PB-13 need native request captures at their stated seams.
- Parallel tools, approval persistence, unknown-tool replay, and no-tool reasoning persistence lack the required assembled restore fixtures.

## Intentional provider differences

- Codex removes temperature because its endpoint rejects it (`source/providers/codex-responses-model.ts:223-226`); PB-05 must not force it back.
- Codex `include` and top-level cache key are Codex-only; OpenAI cache key uses its `providerData.extraBody` convention and no Codex field may be copied into it.
- Codex WS session/thread/turn identity is context-owned, not `ApplicationRunLoopOptions.sessionId` ownership.
- Server-side Responses chaining versus Chat/AI-SDK canonical transcript replay is capability-gated, not a field loss.
- AI-SDK Anthropic reasoning is display-only at the recognized-native replay seam; a PB-10 flush must not reinterpret it as Chat reasoning.
- Llama's guarded `reasoning_effort` → `chat_template_kwargs` transform is supported by tests; reasoning summary is not represented there.
- Runtime custom Chat response IDs and Google `FAKE_ID` are local compatibility identities with chaining disabled; they are not native server IDs.

## Unsupported/rejected claims

- **SKIP — foreign provider-data leakage:** Chat passthrough and AI-SDK explicit-provider forwarding are intentional escape-hatch conventions; no production foreign field source or rejected native request establishes a defect. Add a negative contract only if provider-data ownership is tightened.
- **SKIP — tool strictness/parallel-tool setting loss:** no production `strict` or parallel-policy source was found (`AnyToolDefinition` has no such configured policy); adapter capability alone is not loss.
- **SKIP — custom `openai` must be Responses:** code and its test select Chat (`source/providers/openai-compatible.provider.ts:201-212`); naming is not proof of a product routing contract.
- **SKIP — generic message-file loss:** shared message union lacks files; files are supported in tool results only.
- **SKIP — all supported settings are lost at PB-05:** only `maxTokens` has an application-agent producer; direct request omissions remain PB-07/PB-08.

## Live-evidence deferrals

- OpenAI Responses cache dimensions and encrypted/native reasoning continuation: a sanitized native fixture or capture must establish the provider representation before widening PB-02/PB-10.
- OpenRouter enabled reasoning effort: `toCallOptions()` creates generic reasoning options only for Anthropic/Google; whether OpenRouter expects `providerOptions.reasoning` only needs provider contract evidence.
- Per-turn `extraHeaders`, total-token incremental semantics, reasoning-token accounting, and retry at-most-once behavior require explicit policy plus live/native evidence.
- OpenCode Minimax prompt-cache exclusion needs provider capability evidence before changing `shouldApplyOpencodeAnthropicPromptCaching()`.

## Controlled implementation waves

1. **Wave 1 — shared authoritative state (single owner):** PB-02 and PB-03 in `source/utils/ai/token-usage.ts`, with PB-04 adapter retention only after the normalization tests establish no double count. This serializes `application-run-loop`/event-processor/terminal integration.
2. **Wave 2 — application projection (single owner):** PB-01, PB-05, PB-06 in `application-run-loop.ts` and typed/provider-scoped request representation. Establish explicit unsupported decisions for unowned agent settings; preserve Codex temperature and provider isolation.
3. **Wave 3 — independent adapter conversions:** PB-07 (Responses bridge), PB-08/PB-11 (Chat adapter), PB-12 (Anthropic wrapper), and PB-13 (AI-SDK forwarding). These can proceed separately after Wave 2 contract decisions, except PB-12 depends on PB-05's max-token projection test.
4. **Wave 4 — canonical continuity:** PB-09 and PB-10 in the run loop/session persistence path, serialized because both modify canonical history/output and restore tests.
5. **Wave 5 — integration:** registry native captures, provider black-box manifest, terminal/footer/persistence scenarios, capability documentation, and deferred live-evidence decisions. No parallel edits to shared loop/contracts/usage normalizer.

## Provider × semantic matrix

Legend: **F** confirmed retained defect; **P** verified/intentionally supported; **M** missing-test-only; **D** live evidence/policy deferred; **U** explicitly unsupported. Evidence paths are abbreviated to the source symbols cited above.

| Provider/path | Identity | Usage | Settings | Tools | Content/reasoning | Terminal |
|---|---|---|---|---|---|---|
| Codex HTTP | **F PB-01** loop/cache key | **F PB-02** direct counters | **F PB-05/06**; temperature P/rejected | P conversion; **F PB-09** shared | **F PB-10** recognized Codex | P failed/incomplete reject |
| Codex WS | **F PB-01**; context identity P | **F PB-02** | **F PB-05/06**; temperature P | P; **F PB-09** | **F PB-10** | P close/error fail |
| OpenAI Responses HTTP | P chaining; M cache-key policy | D native cache counters | **F PB-05/07** | P; **F PB-09** shared | D native reasoning | P failed/incomplete reject |
| OpenAI Responses WS | P chaining; M cache-key policy | D native cache counters | **F PB-05/07** | P; **F PB-09** shared | D native reasoning | P close/error fail |
| OpenAI-compatible Chat | P synthetic/non-chain identity | **F PB-04**; PB-02 after fix | **F PB-05/08** | P indexed calls; **F PB-09** | **F PB-10** recognized Chat | **F PB-11** |
| OpenCode Chat | P derived header + synthetic response ID | **F PB-04** | **F PB-05/08** | P; **F PB-09** | **F PB-10** | **F PB-11** |
| Anthropic Messages | P stream native ID; unary fallback M | **F PB-02** downstream | **F PB-05/12/13** | P adapter; **F PB-09** | P display-only native policy | P adapter finish; loop policy M |
| OpenCode Anthropic | P session header | **F PB-02** downstream | **F PB-05/12/13**; Minimax cache D | P; **F PB-09** | P display-only policy | P shared adapter; route fixture M |
| Google AI SDK | P native/FAKE_ID local fallback | **F PB-02** downstream | **F PB-05/13** | P adapter; **F PB-09** | P Google thinking; custom fixture M | P shared adapter |
| OpenRouter AI SDK | P native ID | **F PB-02** downstream | **F PB-05/13**; reasoning D | P adapter; **F PB-09** | D enabled reasoning | P shared adapter |
| Custom Anthropic/Google/OpenRouter | M registry semantics; no native chaining claim | **F PB-02** shared | **F PB-05**; PB-12 Anthropic; PB-13 AI SDK | **F PB-09** shared; M route capture | M route capture | M route capture |
| Custom `openai`/`openai-compatible`/llama.cpp | P Chat contract, not Responses | **F PB-04** | **F PB-05/08**; llama effort transform P | P indexed calls; **F PB-09** | **F PB-10** where Chat reasoning supplied | **F PB-11** |

## Implementation disposition (2026-08-02)

PB-01 through PB-13 have production fixes and focused deterministic tests. Completion evidence added after independent review includes: preserved cumulative `totalTokens` (input + output + cache creation) through `ApplicationRunLoop` and `processStreamEvents`; shipped-CLI Codex HTTP/WS `prompt_cache_key` and `include` assertions in the existing provider-session black-box harness; and JSONL persistence/replay assertions for canonical tool results and Codex native reasoning metadata. The provider-capability matrix/manifest records the Codex request-projection assertions under the existing two-user-turn lifecycle scenarios.

This closes the code-level disposition of PB-01 through PB-13, not the live-evidence deferrals. OpenAI Responses cache/reasoning, OpenRouter enabled reasoning, headers, retry acknowledgement, and OpenCode Minimax caching remain deferred pending native/provider evidence or explicit policy. The audit plan stays in progress until final suite verification is recorded.

## Final disposition

Phase C **rebutted** the foreign-provider leakage claim, a custom-`openai`-means-Responses claim, strictness/parallel-policy loss, and any rationale for sending Codex fields to OpenAI. It **narrowed** PB-02 to proven direct-counter producers, PB-05 to application-sourced `maxTokens`, and PB-10 to recognized Chat/Codex native reasoning. It added two independently source-proven provider seams, PB-12 and compatibility-only PB-13.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Thirteen severity-rated retained defects (PB-01 through PB-13) cite exact source paths, representations, loss boundaries, provider scope, effects, and regression seams; the provider × semantic matrix and residual-risk register reconcile all five Phase C reviews."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "pnpm exec vitest run source/services/agent-runtime/application-run-loop.test.ts source/utils/ai/token-usage.test.ts source/providers/openai-chat-completions-model.test.ts source/providers/agents-model-bridge.test.ts source/providers/ai-sdk-streamed-model.test.ts source/providers/ai-sdk-anthropic.provider.test.ts source/providers/ai-sdk-google.provider.test.ts source/providers/ai-sdk-openrouter.provider.test.ts",
      "result": "passed",
      "summary": "8 test files, 86 tests passed."
    }
  ],
  "validationOutput": [
    "Read Phase B semantic triage, all five Phase C provider reports, current plan/matrix, and disputed production paths.",
    "No repository files were edited; only this required external triage artifact was written."
  ],
  "residualRisks": [
    "OpenAI Responses cache/reasoning, OpenRouter enabled reasoning, header policy, retry acknowledgement, and Minimax caching require native/live evidence or a product decision.",
    "PB-01 through PB-13 remain unfixed in the reviewed worktree.",
    "Provider-row custom registration and assembled persistence/footer coverage remain incomplete as listed."
  ],
  "noStagedFiles": true,
  "diffSummary": "No repository diff; the worktree contains only untracked audit-plan documents and this was a read-only final triage.",
  "reviewFindings": [
    "high: source/lib/agent-configuration.ts:116-183 and source/services/agent-runtime/application-run-loop.ts:324-338 - Codex session prompt_cache_key is lost (PB-01).",
    "high: source/utils/ai/token-usage.ts:230-267 - direct cumulative cache dimensions are omitted from authoritative usage (PB-02).",
    "high: source/providers/openai-chat-completions-model.ts:155-202 - supplied Chat terminal usage is discarded (PB-04).",
    "high: source/services/agent-runtime/application-run-loop.ts:324-338 - application maxTokens is not projected (PB-05).",
    "high: source/services/agent-runtime/application-run-loop.ts:410-431 - recognized no-tool native reasoning is not made durable (PB-10).",
    "high: source/providers/ai-sdk-anthropic.provider.ts:105-124 - Anthropic wrapper overwrites explicit maxOutputTokens (PB-12)."
  ],
  "manualNotes": "PB-05 and PB-10 were deliberately narrowed to source-proven scope; live-provider assumptions and escape-hatch concerns were not converted into implementation work."
}
```