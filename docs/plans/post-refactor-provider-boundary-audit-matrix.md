# Post-refactor provider boundary audit — cartography matrix

**Phase:** A (read-only architecture inventory)  
**Scope:** Current `post-refactor-provider-boundary-audit` worktree at `8ed71544`; no repository files modified.  
**Terminology:** “audited” in this document means the routing/conversion code was located and recorded, **not** that its semantic behavior has passed the later vertical-slice proof. “Pending” means test- and provider-review evidence remains required by the audit plan.

## 1. End-to-end lifecycle routing map

| Stage | Primary owner / representation | Main conversion or routing point | Terminal / persistence / UI consequence |
|---|---|---|---|
| Settings and session identity | `AgentConfiguration`, provider registry, session context | `AgentConfiguration.getAgent(sessionId)` (`source/lib/agent-configuration.ts`, ~91–115) adds a cache key only for non-transient agents where the provider capability permits it; `getApplicationAgent()` (~135–166) builds application shape. | Session ID is separately carried by session context and `ApplicationRunLoopOptions.sessionId`; the latter is currently not projected by the loop into a turn request. |
| Application agent | `ApplicationAgent` | `ApplicationRunLoop.#execute()` (`source/services/agent-runtime/application-run-loop.ts`, ~270–390) constructs one `StreamedModelTurnRequest` per model turn. | Agent instructions, previous response ID, normalized input, tools, temperature, reasoning, provider data, and abort signal are projected. |
| Application request | `StreamedModelTurnRequest` | Provider registry `createStreamedModel` (`source/providers/registry.ts`, ~14–53; ~126–135); concrete provider adapters below. | Every route must turn the request into provider-native request/options. |
| Native request/transport | Responses HTTP/WS, Chat Completions, AI SDK native calls | Codex `codexStream`; OpenAI `bridgeBackToTurn`; Chat `OpenAIChatCompletionsModel.stream`; AI SDK `toCallOptions`. | Native stream frames become application events; transport close/incomplete behavior is route-specific. |
| Native event → application turn event | `StreamedModelTurnEvent` | Codex event normalizer/converters (`source/providers/codex.provider.ts`, ~565–742); Chat stream (~106–186); AI SDK adapter (`source/providers/ai-sdk-streamed-model.ts`, ~33–166); legacy bridge (`source/providers/agents-model-bridge.ts`, ~16–67). | Run loop accepts text/reasoning/tool events until exactly one completion; missing completion is an error. |
| Run state / continuation | `RunState`, `AgentStream` | Loop commits completion `responseId`, accumulates usage, emits canonical provider history, and handles tools/approval (`application-run-loop.ts`, ~320–485; `commitPendingNativeReasoning` ~548–573). | `stream.lastResponseId`, `stream.runUsage`, `stream.history`, `stream.output/newItems`, `stream.rawResponses`, interruption handle. |
| Event processing | `ConversationEvent`, stream accumulator | `processStreamEvents()` (`source/services/stream-event-processor.ts`, ~77–449) parses raw event envelopes, emits deltas/tool starts/usage, then selects final usage. | `usage_update`, text/reasoning deltas, tool events, Codex rate limits. |
| Conversation terminal | `ConversationTerminal` | `collectTerminalResult()` (`source/services/session/terminal-result-collector.ts`, ~16–142). | Requires a `final` event; emits response/approval terminal with resolved usage and canonical turn items. |
| Durable history and continuity | Provider history, turn journal, JSONL log/replay state | `SessionStreamProcessor.finalize()` (`source/services/session/session-stream-processor.ts`, ~287–379); `projectProviderHistory()`; `conversation-turn-items.ts`; `replayEvents()`. | Persists assistant turn/journal and rehydrates messages, tool ledger, provider history, previous response ID and accumulated usage. |
| UI | `ConversationUIState`, `Message`, `NormalizedUsage` | Conversation/session processing delivers final/usage updates; `StatusBar` calls `formatFooterUsage()` (`source/components/layout/StatusBar.tsx`, ~65–69; `token-usage.ts`, ~251–278). | Footer renders `Tok: <input> in (<cached> cached[, <writes> cache write]) / <output> out`; cache warning is integrated only when cache-read usage exists. |

### Settings-to-request projection observed today

`ApplicationRunLoop.#execute()` constructs requests with:

* `instructions ← agent.instructions`
* `previousResponseId ← state.responseId` only when truthy
* `input ← state.input`, originally normalized from `ProviderInput`
* `tools ← toModelTools(agent.tools)` (name, optional description, JSON-schema parameters)
* `temperature ← modelSettings.temperature` only
* `reasoning ← modelSettings.reasoning` only
* `providerOptions ← modelSettings.providerData` only
* `signal ← run signal`

This is intentionally an inventory rather than a defect claim: the request contract contains other typed settings, while this particular producer currently selects the fields above. The plan requires every such selection to receive a forwarding/unsupported decision in Phase B/C.

## 2. Provider and transport routing map

| Plan family/path | Registry/runtime entry | Application request → native request conversion | Native stream → application events | Evidence status |
|---|---|---|---|---|
| **Codex Responses HTTP** | `CodexProvider.getStreamedModel()` (`source/providers/codex.provider.ts`, ~502–545), HTTP `CodexResponsesModel` | `toCodexResponsesInput()` + `toCodexModelSettings()` (`source/providers/codex-turn-converter.ts`, ~10–112); `OpenAIResponsesModel._buildResponsesCreateRequest()` and `CodexResponsesModel._buildResponsesCreateRequest()` (`codex-responses-model.ts`, ~33–91, ~1320–1347). | `codexStream()` maps native response deltas/items/terminal usage and rejects incomplete/failed/no-terminal (`codex.provider.ts`, ~584–728). | Cartographed; semantic cells pending. |
| **Codex Responses WebSocket** | Same provider, `CodexResponsesWSModel` | Same converter plus Codex server-history and WS identity/header preparation (`codex-responses-model.ts`, `CodexResponsesWSModel`); `#buildCodexWebSocketIdentity()` carries session/thread/turn/window metadata (~1130–1181). | `OpenAIResponsesModel.getStreamedResponse()` wraps WS raw events; `normalizeCodexStreamEvent()` unwraps; `codexStream()` is shared. WS close/error without terminal throws. | Cartographed; semantic cells pending. |
| **OpenAI Responses HTTP** | registered `openai.createStreamedModel` (`source/providers/openai.provider.ts`, ~78–111), `OpenAIResponsesModelWithPromptCacheKey` | `bridgeBackToTurn()` produces legacy request; `requestBody()` and `toResponsesApiInput()` (`source/providers/openai-responses-model.ts`, ~47–117). `providerData.extraBody` is appended. | `normalizeResponseEvent()` maps deltas/terminal and throws failed/incomplete (~219–234); bridge maps completion back to `StreamedModelTurnEvent`. | Cartographed; semantic cells pending. |
| **OpenAI Responses WebSocket** | Same registration when transport is not `http` | Same `requestBody`; `ResponsesWS` sends `{type:'response.create', ...requestData}` (`openai-responses-model.ts`, ~178–217). | Same normalizer; socket error/close throw and socket is closed in `finally`. | Cartographed; semantic cells pending. |
| **OpenAI-compatible Chat Completions** | Runtime/custom definition from `createOpenAICompatibleProviderDefinition()` (`source/providers/openai-compatible.provider.ts`, ~244–349) → `OpenAIChatCompletionsModel` | `openAICompatibleMessages()` (`openai-chat-completions-model.ts`, ~188–277); `stream()` adds tools, temp, max tokens, reasoning effort, top-level provider options (~106–126). | Accumulates text, `reasoning_content`, tools by stream index; requires finish reason; creates generated response ID and completion (~128–186). | Cartographed; semantic cells pending. |
| **OpenCode Anthropic route** | `OpencodeAnthropicFormatProvider.getStreamedModel()` (`openai-compatible.provider.ts`, ~174–182), route selected by `selectOpencodeModelTransport` | `AiSdkAnthropicProvider` → `createAiSdkStreamedModel`; OpenCode Anthropic middleware; prompt caching predicate. | AI SDK stream adapter. OpenCode fallback session ID derives from conversation session (`~94–105`). | Cartographed; semantic cells pending. |
| **OpenCode OpenAI-compatible route** | Same provider where router selects Chat route | `buildOpenAICompatibleModel()` → `OpenAIChatCompletionsModel`; OpenCode middleware and fallback session ID. | Chat adapter. | Cartographed; semantic cells pending. |
| **Anthropic native Messages** | `AiSdkAnthropicProvider.getStreamedModel()` (`source/providers/ai-sdk-anthropic.provider.ts`, ~152–170) (also custom type `anthropic`) | `createAiSdkStreamedModel(toCallOptions)`; `withForwardedProviderSettings(forwardExplicitProviderSettings(...,'anthropic'))`; prompt-cache middleware marks last system/user/tool inputs. | AI SDK `doStream` parts map through `createAiSdkStreamedModel`. | Cartographed; semantic cells pending. |
| **Google native GenerateContent** | `AiSdkGoogleProvider.getStreamedModel()` (`source/providers/ai-sdk-google.provider.ts`, ~28–46) (also custom type `google`) | AI SDK call options with explicit Google provider settings; `withFallbackResponseId()` prepends `FAKE_ID` when stream metadata is absent (~49–66). | AI SDK stream adapter. | Cartographed; semantic cells pending. |
| **OpenRouter AI SDK** | Built-in OpenRouter provider registration is imported by `source/providers/index.ts`; `AiSdkOpenRouterProvider.getStreamedModel()` (`source/providers/ai-sdk-openrouter.provider.ts`, ~29–49). | `forwardOpenRouterSettings()` maps top-level provider data into `providerOptions.openrouter`, preserving nested precedence (~59–87). | AI SDK stream adapter. | Cartographed; semantic cells pending. |
| **Runtime custom / llama.cpp-compatible** | Runtime configs decode/resolve in `openai-compatible.provider.ts`; types `openai`, `anthropic`, `google`, `opencode`, `openai-compatible`, `llama.cpp` route in `createCustomProviderModelProvider()` (~184–242). | `llama.cpp` is Chat-compatible then middleware transform calls `applyLlamaCppRequestTransform()` (`source/providers/llama-cpp.provider.ts`, ~20–29), translating `reasoning_effort` into `chat_template_kwargs`. | Chat or AI SDK route according to custom type. | Cartographed; semantic cells pending. |

## 3. Exhaustive typed-field inventory

### 3.1 `ApplicationAgent` / model settings

`source/services/agent-runtime/application-run-loop.ts`, ~24–48:

| Type/field | Type | Current meaning / route |
|---|---|---|
| `ApplicationAgent.name` | `string` | Application identity; used by orchestration/approval presentation, not passed to `StreamedModelTurnRequest`. |
| `instructions` | `string` | Projected to request `instructions`. |
| `model` | `string` | Input to `resolveModel()` each turn. |
| `modelSettings` | optional `AgentModelSettings` | Settings envelope below. |
| `defaultRunOptions` | `any` | Typed compatibility field; not read by loop request construction. |
| `outputType` | `any` | Typed compatibility field; not read by loop request construction. |
| `tools` | `ToolRegistry` | Converted by `toModelTools()` to name/description/schema. |
| `AgentModelSettings.temperature` | optional number | Projected. |
| `.reasoning` | optional `{ effort?: string; summary?: string }` | Projected. |
| `.maxTokens` | optional number | Documented comment says provider boundary reads it; current loop request construction does not select it. |
| `.retry` | optional `{maxRetries?: number}` | Provider construction/retry concern; not a turn field. |
| `.providerData` | optional record | Projected as `providerOptions`. |
| `[key: string]` | `unknown` | Deliberate open compatibility envelope; e.g. Codex `include`/`prompt_cache_key` must be traced explicitly. |

### 3.2 `StreamedModelTurnRequest` and transcript types

`source/contracts/streamed-model-turn.ts`, ~1–91:

| Field / variant | Type | Conversion inventory |
|---|---|---|
| `instructions` | optional string | Codex → `systemInstructions`/Responses `instructions`; AI SDK prepended system prompt; Chat does **not** independently serialize it (input must contain history/instructions as applicable). |
| `previousResponseId` | optional string/null | Codex/OpenAI Responses `previous_response_id` where supported; run loop sources from completion; no Chat/AI SDK provider-native common equivalent. |
| `input` | readonly `StreamedModelTurnInput[]` | Codex `toCodexResponsesInput`; Chat `openAICompatibleMessages`; AI SDK `toPromptMessage`; bridge has `toInput` reverse compatibility. |
| `tools` | readonly `{name,description?,parameters,strict?}[]` | Codex functions; Chat `{type:'function', function}`; AI SDK V3 function tool. |
| `toolChoice` | `'auto'|'required'|'none'|{name}` | Codex settings / Responses tool choice; AI SDK `toToolChoice`; loop does not currently source it from `ApplicationAgent`. |
| `temperature` | number | All main adapter classes have a path, subject to Codex normalizer deleting unsupported temperature. |
| `topP`, `frequencyPenalty`, `presencePenalty` | number | Codex and AI SDK call option converters have explicit paths; Chat stream currently only projects temperature/maxTokens/reasoning/options. |
| `maxTokens` | number | Codex → `max_output_tokens`; Chat → `max_tokens`; AI SDK → `maxOutputTokens`; source loop currently does not project. |
| `reasoning` | `{effort?,summary?}` | Codex settings/Responses; Chat `reasoning_effort` only; AI SDK maps effort to Anthropic/Google provider options; OpenRouter provider-settings path. |
| `providerOptions` | readonly record | Codex → `providerData`; Chat spreads top-level; AI SDK provider options and explicit provider forwarding; Responses bridge → `providerData`. |
| `signal` | `AbortSignal` | Native request abort signal / fetch signal; AI SDK `abortSignal`. |
| input `message.system` | text parts only | Codex text-only system; AI SDK system prompt; Chat role message. |
| input `message.user/assistant` | text/image parts | Provider-specific content converters. |
| input `reasoning` | id?, text, provider metadata | Codex requires codex-namespaced/legacy encrypted metadata; Chat recognizes `reasoning_content`; AI SDK provider options on reasoning part. |
| input `tool_call` | id/name/arguments | Codex function call; Chat assistant tool call; AI SDK assistant tool-call. |
| input `tool_result` | id/output string or rich parts | Codex function output; Chat tool message JSON conversion; AI SDK tool result requires preceding matching call name. |

### 3.3 `StreamedModelTurnEvent`, output and usage

`source/contracts/streamed-model-turn.ts`, ~94–128:

| Variant/field | Type | Ownership and downstream path |
|---|---|---|
| `text_delta.text` | string | UI stream and final output accumulation; run loop emits raw stream event. |
| `reasoning_delta.id/text/providerMetadata` | optional id/string/options | UI reasoning event; loop buffers provider-native reasoning and commits safe continuation history before a tool call. |
| `tool_call.id/name/arguments` | strings | Loop appends provider history/input, calls tool/approval system. |
| `completion.responseId` | string | Authoritative continuity anchor in run state and session continuity publication. |
| `completion.output` | message/reasoning/tool call output list | Used to emit terminal-only calls/reasoning and assistant text. |
| `completion.providerMetadata` | options record | Exists in contract; legacy `toModelResponse()` returns it as `providerData`; direct loop currently does not otherwise consume completion-level metadata. |
| `completion.finishReason` | optional string | Provider semantic terminal detail; loop does not make policy decision from it after adapter acceptance. |
| `completion.usage` | optional `StreamedModelUsage` | Normalized and cumulatively accumulated into run state. |
| output `message.content[].text` | string | Joined into assistant transcript. |
| output `reasoning.id/text/providerMetadata` | optional ID/text/options | Preserved/committed before tool continuation where recognized. |
| output `tool_call.id/name/arguments` | strings | Terminal-only calls are replayed through loop tool handling. |
| `StreamedModelUsage.inputTokens` | number | `normalizeModelUsage` → normalized prompt tokens → run state `inputTokens`. |
| `.outputTokens` | number | → completion tokens → run state `outputTokens`. |
| `.cachedInputTokens` | number | → cache read tokens → run state `cachedInputTokens`. |
| `.cacheWriteTokens` | number | → cache creation tokens → run state `cacheWriteTokens`. |

### 3.4 `NormalizedUsage` and live/persisted representations

`source/utils/ai/token-usage.ts`, ~5–14:

| Normalized field | Accepted aliases / producers | Durable and UI representation |
|---|---|---|
| `prompt_tokens` | `inputTokens`, OpenAI/Codex `input_tokens`, AI SDK input total, Google aliases | `ConversationTerminal.usage`; assistant-turn `usage`/`displayUsage`; `Message.usage`; footer and usage commands. |
| `completion_tokens` | `outputTokens`, `output_tokens`, completion aliases | Same. |
| `total_tokens` | native total aliases or computed input + output + cache creation | Same; display formatter does not render it directly. |
| `reasoning_tokens` | native output detail/reasoning aliases | Same; no footer segment. |
| `cache_read_tokens` | native cache aliases/details; direct app accumulation is `cachedInputTokens` | Same; footer renders it. |
| `cache_creation_tokens` | creation/write aliases; direct app accumulation is `cacheWriteTokens` | Same; footer renders it. |
| `prompt_ms` | timing aliases | Normalized/session persistence only. |
| `completion_ms` | timing aliases | Normalized/session persistence only. |

Relevant persistence representations:

* `ConversationTerminal` (`source/contracts/conversation.ts`, ~92–113): approval and response terminals carry optional `NormalizedUsage`; final has canonical `turnItems` and deprecated derived `reasoningText`.
* `PersistedAssistantTurn`/`Item` (`source/contracts/conversation-items.ts`, re-exported by `source/services/conversation/conversation-persistence-types.ts`, ~1–25): canonical items are reasoning, assistant text, tool call and tool result; item normalizers capture raw provider items/metadata for replay.
* JSONL log events (`source/services/logging/conversation-log-events.ts`): replay consumes assistant-turn `usage` and `displayUsage`; `replayEvents()` (`conversation-replay.ts`, ~700 onward) uses `createUsageAccumulator` for session/main and subagent usage.
* `RestoredState` (`conversation-replay.ts`, ~28–47) holds `previousResponseId`, provider history, tool ledger, `usage`, `subagentUsage`, provider/model and reasoning setting. `loadConversation()` (`conversation-persistence.ts`, ~144–169) reads/decode/replays JSONL.

## 4. Primary boundary conversion table

| # | Boundary | Primary conversion symbols/files | Projection / non-projection rule |
|---|---|---|---|
| 1 | Settings/session → `ApplicationAgent.modelSettings` | `buildAgent()` (`source/lib/agent-factory.ts`); `AgentConfiguration.getAgent()` and `getApplicationAgent()` | Session-specific cache key is injected only in `getAgent(sessionId)` and only for capability-enabled, non-transient clients. OpenAI nests it in `providerData.extraBody`; others get `modelSettings.prompt_cache_key`. |
| 2 | `ApplicationAgent` → streamed request | `ApplicationRunLoop.#execute()`, `toModelTools()` | Explicit manual projection, not a spread. See section 1 exact selection list. |
| 3 | streamed request → native request | `toCodexResponsesInput`, `toCodexModelSettings`; `requestBody`/`toResponsesApiInput`; `openAICompatibleMessages`; `toCallOptions` | Each is a manual conversion boundary and must be audited independently. |
| 4 | native stream → streamed events | `codexStream`; `OpenAIChatCompletionsModel.stream`; `createAiSdkStreamedModel`; `bridgeBackToTurn` | Completion is mandatory in every adapter path; no terminal must throw. |
| 5 | completion usage/output → run state | `normalizeModelUsage`, `addTokenUsage`, completion handling in `ApplicationRunLoop.#execute()` | Completion usage becomes a cumulative application-owned `state.usage`; output produces history/run items and response ID. |
| 6 | run state/stream fallback → normalized usage | `normalizeAgentRunUsage`, `extractUsage`, `mergeUsage`; final selection in `processStreamEvents()` | Run state is preferred only when it normalizes to a non-zero signal; otherwise completed result, stream object, then latest raw response. |
| 7 | terminal → persisted turn/session | `collectTerminalResult`; `SessionStreamProcessor.finalize`; `buildPersistedAssistantTurnItems`; `synthesizeHistoryFromAssistantTurn`; log writer/replay | Canonical turn items are authoritative for durable replay; raw provider history is normalized at persistence boundary. |
| 8 | normalized usage → footer/commands | `formatFooterUsage`, `formatSessionTokenUsage`, `formatSessionUsageBreakdown`; `StatusBar` | Footer shows input/cache/write/output; usage command formatter renders input/cached/output. |
| 9 | persisted state → resumed/replayed request | `replayEvents`, `projectProviderHistory`, `ConversationStore`/session continuation, then loop input normalization | Restored history becomes `ProviderInputItem[]`, normalized into streamed input on the next loop start. `previousResponseId` is cleared for interrupted/cross-model state. |

## 5. Authority, fallback, and precedence rules

| Subject | Rule / source evidence |
|---|---|
| Model terminal | `ApplicationRunLoop` throws if a model turn ends without a `completion` event (`application-run-loop.ts`, ~319, ~396). Codex, Chat and AI SDK adapters independently enforce native terminal evidence. |
| Response ID | Completion `responseId` is committed before terminal-only tool/approval processing, so continuation owns the call-producing response (`application-run-loop.ts`, ~398–425). Resume compatibility uses caller `previousResponseId` only if older continuation state lacks one (~178–182). |
| Usage—run total | `normalizeAgentRunUsage(stream.runUsage)` is declared authoritative/cumulative in `processStreamEvents` (~429–449). It replaces, rather than adds to, latest per-turn streamed state to avoid double counting. |
| Usage—fallback order | If no usable run state: completed result → stream object → most recent raw response. During stream, `extractUsage` pulls raw/event/data alternatives and merges latest observed fields (`stream-event-processor.ts`, ~111–125). |
| Usage—field merge | `mergeUsage(preferred,fallback)` overlays preferred values over fallback then re-normalizes (`token-usage.ts`, ~233–242). `addTokenUsage` sums every normalized dimension; session accumulator makes prompt billable by subtracting cache reads. |
| Terminal collector | `collectTerminalResult` prefers non-empty terminal run usage over live `usage_update`; latest update is fallback only (`terminal-result-collector.ts`, ~49–78). No final event is ambiguous outcome/error. |
| Native reasoning | Only recognized native metadata is replayed: Chat `reasoning_content`, or namespaced Codex metadata. Generic reasoning is display-only to avoid foreign wire fields (`application-run-loop.ts`, `appendNativeReasoning`, ~520–547). |
| Persisted transcript | Final `assistant_turn` beats incomplete journal entries; provider-backed journal items beat text/reasoning fragments; canonical persisted turn items drive rehydrated history (`conversation-replay.ts`, comments/logic around `applyInterruptedTurnJournals`). |
| Tool history | Completed ledger pairs missing from history are inserted once; already present pairs are not duplicated; incomplete calls are never injected as completed history (`conversation-state-projector.ts`, ~43–64). Session finalization similarly removes duplicate tool call/result signatures. |
| Provider options | AI SDK explicit top-level data is copied to provider namespace, while explicitly nested namespace options win (`ai-sdk-provider-settings.ts`, ~23–46). OpenRouter similarly preserves nested `openrouter` values over extra top-level fields. |
| Codex history fallback | Codex server-managed prior-response chaining is attempted, may warm up/replay a delta, and clears/avoids chaining under characterized unavailable/transport conditions; tool-result continuation failure is rethrown rather than silently replayed (`codex-responses-model.ts`, `CodexResponsesWSModel` methods). |

## 6. Live compatibility and persistence paths still executable

1. **Application compatibility runner.** `createApplicationCompatibilityRunner()` (`source/providers/registry.ts`, ~55–110) invokes `ApplicationRunLoop`, then exposes SDK-era `LegacyRunner.run`/`runToCompletion`; it is live for result-shaped callers. `settleProviderRun()` supports both compatibility and hand-built runner shapes.
2. **Agents bridge, both directions.** `bridgeBackToTurn()` adapts legacy Responses models to application turns (used by OpenAI registration). `adaptStreamedModelTurnForAgents()` adapts AI SDK-backed application turns for legacy consumers (`source/providers/agents-model-bridge.ts`, ~16–123). These are live compatibility seams, not dead historical code.
3. **Legacy branch inside Chat adapter.** `OpenAIChatCompletionsModel.getResponse/getStreamedResponse` select `#legacyResponse/#legacyStream` when `request.modelSettings` exists (`openai-chat-completions-model.ts`, ~20–104). Application `stream()` is the direct path.
4. **Provider `createRunner` compatibility.** Registering only `createStreamedModel` auto-populates `createRunner` (`registry.ts`, ~126–133). Custom providers also explicitly create a compatibility runner.
5. **Persisted legacy and current formats.** Conversation persistence migrates legacy log-root files, decodes envelopes, and replays legacy/current fields. `conversation-persistence-types.ts` retains deprecated aliases to canonical `conversation-items` contracts. `replayEvents()` provides legacy journal/turn fallback, interrupted recovery, tool reconciliation and cross-model chaining invalidation.
6. **Codex persisted reasoning compatibility.** `codexNativeMetadata()` accepts namespaced `codex` metadata and the narrow historical direct `encrypted_content` spelling only (`codex-turn-converter.ts`, ~145–176).
7. **OpenAI/Google transport compatibility.** OpenAI selects HTTP or WS with `agent.transport`; Google streams may receive a local fallback response ID (`FAKE_ID`) before native frames. Both require provider-review evidence because they are behaviorally live.

## 7. Initial two-axis provider × semantic matrix

Legend: **C** = cartographed (source/conversion evidence listed here); **P** = pending semantic proof, provider-row review, and test/unsupported rationale required by the plan. No cell is complete merely because it shares a transport.

| Provider family / distinct path | Identity | Usage | Settings | Tools | Content / reasoning | Terminal |
|---|---|---|---|---|---|---|
| Codex Responses HTTP | C/P — `codex.provider.ts:584–728`; `codex-responses-model.ts` | C/P — `toCodexUsage()` | C/P — `toCodexModelSettings`, normalized request data | C/P — `toCodexToolCallOutput`, function output normalization | C/P — `toCodexResponsesInput`, Codex metadata | C/P — completed/incomplete/failed branches |
| Codex Responses WebSocket | C/P — WS session/thread/turn identity method | C/P — shared `toCodexUsage` | C/P — WS headers/client metadata + request normalizer | C/P — shared `codexStream` | C/P — wrapped event/unwrapper + terminal reasoning | C/P — close/error/watchdog/terminal handling |
| OpenAI Responses HTTP | C/P — bridge previous response / responses IDs | C/P — legacy completion usage → bridge | C/P — `requestBody`, extra body | C/P — bridge mappings | C/P — `toResponsesApiInput` | C/P — `normalizeResponseEvent` |
| OpenAI Responses WebSocket | C/P — same + request lifecycle observation | C/P — same | C/P — WS `response.create` | C/P — same bridge | C/P — same | C/P — close/error/finally close |
| OpenAI-compatible Chat | C/P — generated `chatcmpl-*`, tool IDs | C/P — terminal usage currently needs route proof | C/P — stream allowlist + options spread | C/P — index accumulator | C/P — roles/images/reasoning content | C/P — finish reason required |
| OpenCode Anthropic route | C/P — derived OpenCode session ID | C/P — AI SDK usage map | C/P — explicit Anthropic options/cache middleware | C/P — AI SDK calls | C/P — AI SDK messages/reasoning | C/P — AI SDK finish event |
| OpenCode Chat route | C/P — derived OpenCode session ID | C/P — Chat route | C/P — Chat/middleware | C/P — Chat route | C/P — Chat route | C/P — Chat route |
| Anthropic Messages | C/P — AI SDK response metadata | C/P — AI SDK cache read/write mapping | C/P — Anthropic thinking/options | C/P — AI SDK tool schema | C/P — prompt cache/reasoning | C/P — finish/error handling |
| Google GenerateContent | C/P — native metadata or local fallback ID | C/P — AI SDK map | C/P — Google thinking config | C/P — AI SDK tool map | C/P — V3 prompt/file mapping | C/P — finish/error + fallback ID |
| OpenRouter AI SDK | C/P — AI SDK response ID | C/P — AI SDK map | C/P — `forwardOpenRouterSettings` | C/P — AI SDK map | C/P — reasoning/provider data | C/P — AI SDK finish/error |
| Runtime custom: anthropic | C/P — custom config route | C/P — AI SDK map | C/P — custom config/middleware | C/P | C/P | C/P |
| Runtime custom: google | C/P — custom config route | C/P — AI SDK map | C/P — custom config | C/P | C/P | C/P |
| Runtime custom: openai/openai-compatible | C/P — Chat route IDs | C/P — Chat route | C/P — middleware/options | C/P | C/P | C/P |
| Runtime custom: llama.cpp-compatible | C/P — Chat route IDs | C/P — Chat route | C/P — llama request transform | C/P | C/P — reasoning transform | C/P |

### Concrete existing test evidence to carry into later cells

* `source/providers/openai-chat-completions-model.test.ts`: existing named regression, **“application tool continuation keeps one reasoning-bearing assistant message for parallel tool calls,”** was added by `fcc66bc0` (plan handoff).
* `source/providers/codex.provider.test.ts`, `codex-responses-model.test.ts`, `openai-responses-model.test.ts`, `agents-model-bridge.test.ts`, `ai-sdk-streamed-model.test.ts`, and provider-specific AI SDK/custom provider tests exist and are the focused local seams for rows above.
* Conversation/persistence coverage exists in `source/services/session/terminal-result-collector.test.ts`, `session-stream-processor` tests, `source/services/conversation/conversation-persistence.test.ts`, `conversation-replay.test.ts`, and `conversation-state-projector.test.ts`.
* The plan explicitly says this evidence is not sufficient for the two known production-seam regressions; planned cells remain pending until the prescribed run-loop/registry/UI black-box evidence exists.

### Post-implementation evidence and disposition (2026-08-02)

Legend: **V** = deterministic implementation evidence; **D** = documented live/provider-policy deferral; **U** = explicitly unsupported by the shared contract. Existing row lifecycle evidence remains in the provider capability manifest; `scripts/provider-black-box/provider-session-responses.blackbox.ts` now asserts Codex HTTP and WebSocket `prompt_cache_key` and `include` on the shipped CLI two-turn scenario.

| Provider family | Identity | Usage | Settings | Tools | Content/reasoning | Terminal |
|---|---|---|---|---|---|---|
| Codex HTTP/WS | V: Codex session fields, loop/converter tests and CLI request capture | V: direct cumulative counters and total convention | V: max tokens/cache key/include; temperature rejected | V: canonical unknown-tool result | V: recognized reasoning persistence | V: existing lifecycle resilience |
| OpenAI Responses HTTP/WS | V: chaining; D: cache-key policy | D: native cache representation | V: bridge options/max tokens | V: shared canonical result | D: native reasoning representation | V: existing lifecycle resilience |
| Chat/OpenCode Chat/custom Chat/llama.cpp | V: local response IDs | V: terminal usage → run usage | V: Chat option conversion/max tokens | V: indexed calls/shared result | V: recognized Chat reasoning | V: finish reason retained |
| Anthropic/OpenCode Anthropic/custom Anthropic | V: native/fallback identity | V: direct cumulative counters | V: max-token cap precedence and unary settings | V: shared canonical result | U: display-only reasoning replay | V: AI SDK terminal adapter |
| Google/custom Google | V: documented local fallback ID | V: direct cumulative counters | V: max tokens and unary settings | V: shared canonical result | V: Google thinking route | V: AI SDK terminal adapter |
| OpenRouter/custom OpenRouter | V: native response IDs | V: direct cumulative counters | V: max tokens/unary forwarding; D: enabled reasoning | V: shared canonical result | D: enabled reasoning representation | V: AI SDK terminal adapter |

The assembled authority seam is covered by `source/services/stream-event-processor.test.ts` (multi-turn cache writes and cache reads), `source/utils/ai/token-usage.test.ts` (direct/detail aliases and total convention), and the existing terminal/footer/persistence suites. PB-09/PB-10 canonical-history coverage is in `session-stream-processor.test.ts`; a full JSONL replay round-trip remains a tracked test gap rather than an unsupported field claim. OpenAI Responses cache/reasoning, OpenRouter enabled reasoning, per-turn headers, retry acknowledgement, and OpenCode Minimax caching remain **D** and are not claimed resolved.

## 8. Explicit uncertainties and disproven premises

### Confirmed by direct code cartography

1. **The application loop is not an SDK-only accumulator.** It owns application run state and writes cumulative usage as `{inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens}` after each completion (`application-run-loop.ts`, ~398–421).
2. **The direct application loop does not pass arbitrary `modelSettings` through.** Its manual request object selects only temperature, reasoning and provider data from the settings envelope (plus common request fields). This disproves any premise that adding a key to `AgentModelSettings` automatically reaches all adapters.
3. **`prompt_cache_key` has two current configuration spellings.** Non-OpenAI capability providers receive top-level `modelSettings.prompt_cache_key`; OpenAI receives `modelSettings.providerData.extraBody.prompt_cache_key` (`agent-configuration.ts`, ~91–115). Whether either spelling reaches a direct run-loop request must be verified at the production seam, as the plan requires.
4. **“OpenAI-compatible” is not one semantic row.** It includes generic Chat, OpenCode Chat, and llama.cpp transformations; OpenCode additionally has an Anthropic route.
5. **“AI SDK” is not one provider semantic row.** Anthropic, Google, and OpenRouter each wrap provider options differently; Google adds a response-ID fallback.
6. **No terminal frame is not empty success in recorded adapter paths.** Codex, Chat, AI SDK, and bridges have explicit missing-terminal errors. This does not prove every lower transport/middleware path behaves correctly; it rules out the simplistic premise that the application loop itself fabricates a completion when no adapter completion is emitted.
7. **Provider-native history is deliberately not reduced to UI deltas.** Session finalization unwraps only run-item event envelopes and preserves provider items/metadata; persistence reconstructs canonical history with provider-data compatibility rules.

### Open items requiring later audit evidence (not defect findings)

1. The exact all-family behavior of `prompt_cache_key`, `include`, headers and other index-signature settings after `ApplicationAgent → StreamedModelTurnRequest` remains pending.
2. Chat completion usage is not emitted in the direct stream completion shown in `OpenAIChatCompletionsModel.stream()`; whether an outer compatibility/transport path supplies it for all live routes requires a focused usage slice, not inference.
3. `StreamedModelUsage` omits typed total/reasoning token fields while `NormalizedUsage` includes them. This is a contract asymmetry to classify (unsupported, derived, or missing) rather than a conclusion about behavior.
4. `ApplicationRunLoopOptions.sessionId` is a typed option but was not observed in direct request projection; session context independently supplies provider identity for Codex/OpenCode. The intended ownership relationship must be stated/tested by the identity slice.
5. The comment in `normalizeAgentRunUsage()` describes Agents-SDK detail-array semantics, while current application run state carries direct cumulative fields. Authority and all aliases need deterministic tests before a fix decision; do not assume comments imply current shape compatibility.
6. The `FAKE_ID` Google fallback is executable compatibility behavior. Its impact on continuity and persistence must be documented/tested, not silently generalized as a real provider ID.
7. The exact registration topology for built-in OpenRouter and runtime registration is partly import/module-load driven (`providers/index.ts` imports OpenRouter); later provider review should verify test harness registration and all named CLI IDs rather than infer from class presence.

## 9. History landmarks

`git log --oneline -15` in this worktree identifies the relevant post-refactor boundary preservation history:

* `fcc66bc0 fix: preserve reasoning across parallel tool calls` (explicitly called out by the plan as existing evidence).
* `c07e9116 fix: persist canonical application stream items`.
* `ec559632 fix: preserve stream event envelopes for stateless continuity`.
* `452b9201 fix: persist native reasoning across provider continuations`.
* `1894f764 fix: replay native reasoning on chat tool continuation`.
* `1f0f3e84 merge: preserve stream usage and terminal items`; `3f84fd74 fix stream usage and history boundaries`.

These commits establish why the cartography keeps native metadata, event envelopes, canonical items and usage authority separate. They are comparison points for later differential evidence, not proof that every current matrix cell is complete.

---

## Evidence / commands appendix

### Read evidence

* `AGENTS.md` (worktree), especially provider black-box ownership and active-work guidance.
* `docs/plans/post-refactor-provider-boundary-audit.md` (full plan).
* `docs/plans/provider-bug-sweep.md` (full completed sweep/historical live evidence).
* Typed contracts and conversion implementations listed in sections 1–6.
* Existing test inventories listed in section 7; tests were not executed because Phase A was read-only cartography and no baseline command was requested for this subtask.

### Commands run

```text
git status --short && git log --oneline -15
```

Result: repository status showed the audit plan as untracked (`?? docs/plans/post-refactor-provider-boundary-audit.md`); recent history recorded above. No source or repository file was edited.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Complete Phase A cartography with concrete source paths, symbols/ranges, provider routing, typed field inventory, authority rules, live compatibility/persistence paths, initialized matrix, and bounded uncertainties."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "git status --short && git log --oneline -15",
      "result": "passed",
      "summary": "Read-only repository-state and history inspection completed."
    }
  ],
  "validationOutput": [
    "No repository files modified; artifact written only to the authoritative external output path.",
    "Tests not run: this assigned Phase A task was read-only cartography, not implementation verification."
  ],
  "residualRisks": [
    "All semantic matrix cells remain pending test/provider-review proof; cartography is not behavioral completion.",
    "Known cache-usage and prompt-cache-key diagnoses from the plan remain implementation/test work, not changed by this review."
  ],
  "noStagedFiles": true,
  "diffSummary": "No repository diff produced; external cartography draft only.",
  "reviewFindings": [
    "note: source/services/agent-runtime/application-run-loop.ts (~270–320) manually projects a subset of AgentModelSettings into StreamedModelTurnRequest; later audit must make an explicit decision for every typed setting.",
    "note: source/utils/ai/token-usage.ts normalizeAgentRunUsage uses detail-array cache fields while ApplicationRunLoop writes direct cachedInputTokens/cacheWriteTokens; the plan already classifies this as a confirmed diagnostic requiring production-seam proof and fix.",
    "note: source/lib/agent-configuration.ts (~91–115) injects prompt_cache_key in model settings but direct loop request projection records only providerData, temperature, and reasoning; later audit must test registry/run-loop native request capture."
  ],
  "manualNotes": "No blocker was asserted because this assignment was cartography, not triage. The stated notes are evidence-backed boundary observations, with plan-confirmed regression context where applicable."
}
```