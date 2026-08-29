# Contract 07 — Logging and provider-traffic lifecycle

Status: **contract, repairs, and owner decisions complete 2026-08-16.** Repair
commit `c7f54ace` landed fail-open artifact boundary, corrupt-index recovery,
bounded request-path lifecycle, and typed metadata. The two C7.2 reds
(verbose-payload `encrypted_content`, evaluator-lane sanitization) are retired
by President decision: single-level sanitization depth and the unsanitized
evaluator lane are accepted behavior, now characterized by green tests.

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C7.1 | Best-effort diagnostic and telemetry logging persistence failures (`LoggingService`, `ProviderTraffic`, `ProviderTrafficArtifactStore`) must never throw into, crash, or alter an active turn, stream processing loop, or provider network operation. | Turn crashes, aborted tool dispatches, or dropped network requests when the local disk is full (`ENOSPC`), read-only (`EROFS`), or encounters permission errors during background diagnostic logging. |
| C7.2 | Ciphertext and opaque provider payloads (`encrypted_content` in Responses reasoning/compaction items, `reasoning.encrypted` in Chat Completions) are stripped to empty string `""` across all diagnostic provider traffic artifacts. In Winston application logs, `sanitizeLogMetadata` strips top-level `reasoning` and `reasoning_content`; nested `encrypted_content` in item payloads persists under `LOG_VERBOSE_PAYLOADS=1`, and `evaluator.request.started` bypasses `sanitizeLogMetadata` — both **accepted by President decision 2026-08-16** (single-level sanitization depth; evaluator lane exempt), characterized by green tests rather than retained reds. | Sensitive cryptographic ciphertext tokens or raw image payloads leaking into unencrypted local diagnostic log files. |
| C7.3 | Instruction-like text (system prompts, developer instructions) in sent provider traffic artifacts is truncated to canonical bounds (`TRAFFIC_TEXT_LIMIT = 100` characters plus `[omitted N chars]`), while user messages, tool arguments, and tool results remain intact. In application log metadata, separate truncation bounds apply (system/developer instructions truncated to 20 chars; long response text head 50 + tail 50 chars + `... (truncated, N chars omitted) ...`). | Massive log inflation and instruction token exposure across routine log dumps, while preserving user prompt and tool call visibility. |
| C7.4 | Explicit per-call `meta.correlationId` metadata takes precedence over ambient instance/session `this.correlationId`. (Subagent `providerHistoryKey` context isolation is governed by Contract 03; ambient UUID-shaped `correlationId` overwrites non-UUID `meta.traceId`). | Disconnected log events or misattributed background work that breaks single-turn telemetry and debugging. |
| C7.5 | Structured application log records pass through `RuntimeLogSchema.safeParse`; schema validation failures fallback to `log.contract_validation_failed` with `errorCode: 'LOG_SCHEMA_VALIDATION_FAILED'` without throwing or dropping error logs. | Undetected log payload drift or malformed log format crashes during critical system error reporting. |

*Cross-reference:* Durable conversation state persistence, atomic session save/replay, lockfile descriptor management, and `fsync` write durability belong to the separately tracked **SB-02** service boundary.

## 2. Owners

- **Enforcement:**
  - `LoggingService` (`source/services/logging/logging-service.ts`) — owns Winston file and console logger transports, log level filtering, category filtering (`LOG_CATEGORIES`), runtime log schema validation fallback, and correlation tracking.
  - `ProviderTraffic` & `ProviderTrafficArtifactStore` (`source/services/logging/provider-traffic.ts`) — owns provider wire request/response serialization, instruction truncation, `encrypted_content` redaction, daily directory layout (`<logDir>/provider-traffic/<date>/<session>/`), daily index (`index.jsonl`), and in-memory `#requestPaths` correlation.
- **Recovery:**
  - `LoggingService.cleanupTrafficDir` — prunes daily log folders older than retention limits (`LOG_RETENTION_DAYS = 7`).
  - `ProviderTraffic` / `ProviderTrafficArtifactStore` — intended recovery fails open for the primary operation and emits a best-effort structured warning (`provider.traffic.artifact_write_failed`).

## 3. Execution paths that share the contract

- **Fetch Provider Middleware:** `source/providers/fetch/logging-middleware.ts:113-157` (invoking `recordRequestStart`, `recordResponseReceived`, and `recordRequestFailed` around HTTP provider calls for OpenAI, Anthropic, Gemini, OpenRouter, Ollama, DeepSeek).
- **Codex / Responses Model Stream:** `source/providers/codex-responses-model.ts:1006, 1026, 1048, 1069` (invoking `recordRequestStart`, `recordResponseReceived`, `recordResponseClosed`, and `recordRequestFailed` over WebSocket / SSE transports).
- **Application Run Loop & Session Stream:** `source/services/agent-runtime/application-run-loop.ts` and `source/services/session/session-stream-processor.ts` (emitting debug/info/warn/error diagnostics across turn segments, tool dispatches, stall escalation, and stream recovery).
- **Conversation Logger Error Boundary:** `source/services/logging/conversation-logger.ts:45-56` (catching log sink errors and emitting `conversation_log.sink_failed` via `logger.warn`).
- **CLI & Non-Interactive Bootstrap:** `source/cli.tsx:399-411` and `source/non-interactive.ts` (instantiating `LoggingService` and injecting it into services, settings, and React Ink root).
- **UI Diagnostics & Menu Hooks:** `source/hooks/use-conversation.ts`, `use-model-selection.ts`, and `use-mentor-pool-selection.ts` (emitting UI lifecycle and model switch diagnostics).

## 4. Identities and state crossing the boundary

- `ILoggingService`: `info`, `warn`, `error`, `debug`, `security`, `setCorrelationId`, `getCorrelationId`, `clearCorrelationId`, `providerTraffic`.
- `IProviderTraffic`: `recordRequestStart`, `recordResponseReceived`, `recordResponseClosed`, `recordRequestFailed`.
- `ProviderTrafficRequest`: `{ requestId, provider, model, sentBody, headers?, modelClass?, modelWrapperClass? }`.
- `ProviderTrafficResponse`: `{ requestId, provider, model, status, response, error?, modelClass?, modelWrapperClass?, transport?, receiveTiming? }`.
- `ProviderTrafficClosedResponse`: `{ requestId, provider, model, outcome: 'consumer_closed' | 'aborted', eventCount, modelClass?, modelWrapperClass?, diagnostics? }`.
- `DailySessionIndexEntry` (verbatim source type from `source/services/logging/provider-traffic.ts:48-61`):
  ```ts
  export type DailySessionIndexEntry = {
    sessionId: string;
    sessionDir: string;
    firstRequestAt: string;
    lastRequestAt: string;
    requestCount: number;
    firstUserMessagePreview: string;
    latestProvider: string;
    latestModel: string;
    providersSeen: string[];
    modelsSeen: string[];
    latestMode: string;
    modesSeen: string[];
  };
  ```
- `ProviderTrafficArtifactStore.#requestPaths`: in-memory crossing state `Map<string, string>` mapping `requestId` to `requestPath`. Cleaned up on `recordRequestComplete` (`provider-traffic.test.ts:746`). Requests that never complete (e.g. abandoned streams) leak map entries until process termination.

## 5. Settlement semantics

Aligned with Contract 05 runtime guards and effect safety:

- **Pre-Dispatch Synchronous Throw (Request Start):**
  - Trigger: `ProviderTraffic.recordRequestStart`.
  - Intended Settlement: Fails open for the primary operation, completing synchronously without throwing, and emits a structured warning (`provider.traffic.artifact_write_failed`); network dispatch proceeds.
  - Current Defect: Synchronous `fs.writeFileSync` inside `writeTrafficEnvelope` throws on I/O error, aborting the turn before HTTP dispatch (`composer.test.ts:876`, `provider-traffic.test.ts:1052`).
- **Promise Rejection / Unhandled Rejection (Response Received):**
  - Trigger: `ProviderTraffic.recordResponseReceived`.
  - Intended Settlement: Resolves cleanly (`toBeUndefined()`) and emits structured warning on store write failure.
  - Current Defect: Store write failures reject the returned promise. In direct stream consumers (`codex-responses-model.ts:1026`), called without `await` or `.catch()`, triggering unhandled rejections that terminate the process under Node's default `--unhandled-rejections=strict` (`provider-traffic.test.ts:1082`).
- **Synchronous Finally Throw (Response Closed):**
  - Trigger: `ProviderTraffic.recordResponseClosed`.
  - Intended Settlement: Fails open without throwing and emits structured warning.
  - Current Defect: Called in `finally` block in `codex-responses-model.ts:1069`; if store throws, it displaces the primary stream outcome or error (`provider-traffic.test.ts:1113`).
- **Double-Fault Error Masking (Request Failed):**
  - Trigger: `ProviderTraffic.recordRequestFailed`.
  - Intended Settlement: Fails open for diagnostic capture with a structured warning; preserves the original upstream provider network/timeout error.
  - Current Defect: Synchronous store throw in fetch middleware `catch` block replaces the original upstream error with the logging error (`composer.test.ts:842`, `provider-traffic.test.ts:1144`).
- **Warning Observability Target:**
  - Any swallowed diagnostic store error must be reported as exactly one warning to `this.loggingService.warn('Provider traffic artifact write failed', { eventType: 'provider.traffic.artifact_write_failed', ... })`. If logging the warning itself fails, the primary operation still must not fail (residual error boundary).

## 6. Observability

- **Current File Logging:** Winston daily rotate logs written to `<logDir>/term2-%DATE%.log`.
- **Provider Traffic Envelopes:** Written to `<logDir>/provider-traffic/<YYYY-MM-DD>/<sessionTime>_<sessionId>/<time>_<requestId>.json`.
  - Evaluator requests use an `evaluator_` filename prefix within the session directory: `<logDir>/provider-traffic/<YYYY-MM-DD>/<sessionTime>_<sessionId>/evaluator_<time>_<requestId>.json`.
- **Daily Traffic Index:** `<logDir>/provider-traffic/<YYYY-MM-DD>/index.jsonl`.
- **Unused Root Observation:** `LoggingService` computes and prunes `<logDir>/evaluator-traffic`, but `ProviderTrafficArtifactStore` writes evaluator files with `evaluator_` prefixes under `provider-traffic/`; `evaluator-traffic` is never created or populated by the artifact store.
- **Sanitization & Redaction:**
  - Provider traffic artifact lane: replaces `encrypted_content` with `""`.
  - App-log lane: `sanitizeLogMetadata` removes `reasoning` and `reasoning_content`.
- **Known Diagnostics Gaps:**
  - Dropped or failed provider-traffic artifact writes produce no telemetry in production.
  - `RuntimeLogSchema` uses `.passthrough()`, allowing unvalidated properties to cross into structured logs.
  - `ILoggingService` declares `meta?: any`, bypassing compile-time contract enforcement at caller sites.
  - When `RuntimeLogSchema` fails validation, `eventType` is overwritten with `'log.contract_validation_failed'`, completely losing the original event identity, and category filtering occurs before schema validation for non-error levels.

## 7. Public boundary under test

The contract is tested deterministically at the public interface boundary of:
- `ILoggingService` / `LoggingService` (`source/services/logging/logging-service.ts`)
- `IProviderTraffic` / `ProviderTraffic` (`source/services/logging/provider-traffic.ts`)
- `ProviderTrafficArtifactStore` (`source/services/logging/provider-traffic.ts`)
- `RuntimeLogSchema` (`source/services/logging/logging-contract.ts`)
- `createLoggingMiddleware` (`source/providers/fetch/logging-middleware.ts` via `source/providers/fetch/composer.test.ts`)

Tests execute against isolated disk fixtures created via `fs.mkdtempSync` and typed test doubles (`CompletionOnlyThrowingStore`, `StartThrowingStore`, `ThrowingStore`). No production code was modified.

## 8. Deterministic contract matrix

| Seam / Scenario | Invariant | Expected Outcome | Classification | Exact Test Declaration & Location |
|---|---|---|---|---|
| Initialize logging service | C7.1 | Instantiates Winston logger, sets default log level | Characterized & Tested | `source/services/logging/logging-service.test.ts:73`: `it.sequential('LoggingService initializes without error')` |
| Create log directory | C7.1 | Creates missing log directory recursively | Characterized & Tested | `source/services/logging/logging-service.test.ts:82`: `it.sequential('creates log directory if it does not exist')` |
| Respect disable logging flag | C7.1 | Skips transport configuration and file writes | Characterized & Tested | `source/services/logging/logging-service.test.ts:89`: `it.sequential('respects DISABLE_LOGGING flag')` |
| Respect DISABLE_LOGGING env | C7.1 | Resolves env flag when option omitted | Characterized & Tested | `source/services/logging/logging-service.test.ts:102`: `it.sequential('uses DISABLE_LOGGING env when disableLogging is omitted')` |
| Log message format | C7.5 | Emits valid JSON log line with timestamp and level | Characterized & Tested | `source/services/logging/logging-service.test.ts:120`: `it.sequential('logs messages with correct format')` |
| Custom log levels | C7.5 | Supports info, warn, error, debug, security | Characterized & Tested | `source/services/logging/logging-service.test.ts:157`: `it.sequential('supports custom log levels including security')` |
| Automatic traffic artifacts | C7.1 | Writes sent and received payload artifacts | Characterized & Tested | `source/services/logging/logging-service.test.ts:174`: `it.sequential('automatically writes provider traffic artifacts for sent and received payloads')` |
| Traffic directory cleanup | C7.1 | Prunes log folders older than 7 days | Characterized & Tested | `source/services/logging/logging-service.test.ts:248`: `it.sequential('cleans up old provider traffic files and directories by date')` |
| Suppress console output | C7.1 | Silences console transport output | Characterized & Tested | `source/services/logging/logging-service.test.ts:277`: `it.sequential('suppresses console output when configured')` |
| Track correlation IDs | C7.4 | Sets, retrieves, and clears ambient correlation ID | Characterized & Tested | `source/services/logging/logging-service.test.ts:302`: `it.sequential('tracks correlation IDs')` |
| Explicit correlation precedence | C7.4 | Explicit metadata correlation overrides ambient | Characterized & Tested | `source/services/logging/logging-service.test.ts:344`: `it.sequential('uses explicit correlation metadata instead of an overlapping process-global correlation')` |
| Stable audit file path | C7.1 | Uses deterministic audit file path for rotation | Characterized & Tested | `source/services/logging/logging-service.test.ts:365`: `it.sequential('uses a stable audit file path for rotated app logs')` |
| Emit canonical contract fields | C7.5 | Attaches timestamp, level, eventType, messageId | Characterized & Tested | `source/services/logging/logging-service.test.ts:387`: `it.sequential('emits canonical contract fields on logs')` |
| Truncate base64 image in request | C7.3 | Truncates base64 data in `provider.request.started` | Characterized & Tested | `source/services/logging/logging-service.test.ts:427`: `it.sequential('truncates base64 image data in provider.request.started')` |
| Preserve base64 image outside request | C7.3 | Preserves base64 payload outside request start | Characterized & Tested | `source/services/logging/logging-service.test.ts:462`: `it.sequential('does not truncate base64 image data outside provider.request.started')` |
| Truncate long provider response | C7.3 | Applies head/tail truncation to long response text | Characterized & Tested | `source/services/logging/logging-service.test.ts:500`: `it.sequential('truncates long provider response text in file logs')` |
| Respect LOG_CATEGORIES filter | C7.5 | Filters categories while preserving all errors | Characterized & Tested | `source/services/logging/logging-service.test.ts:540`: `it.sequential('respects LOG_CATEGORIES filter while preserving errors')` |
| Unwritable logDir (ENOTDIR) | C7.1 | Construction and logger calls do not throw | Characterized & Tested | `source/services/logging/logging-service.test.ts:586`: `it.sequential('LoggingService handles unwritable logDir (ENOTDIR) during construction and logging without throwing synchronously')` |
| Schema validation fallback | C7.5 | Emits `log.contract_validation_failed` without throwing | Characterized & Tested | `source/services/logging/logging-service.test.ts:610`: `it.sequential('LoggingService.error handles schema-invalid metadata by falling back to log.contract_validation_failed without throwing')` |
| App log encrypted_content depth | C7.2 | Sanitizes ciphertext at set depth | **Decided 2026-08-16: single-level depth accepted** (replaces the former retained red) | Green: `it.sequential('characterizes nested encrypted_content persistence in app log payloads under LOG_VERBOSE_PAYLOADS=1 (President decision: single-level depth accepted)')` |
| Evaluator message sanitization | C7.2 | Sanitizes `evaluator.request.started` messages | **Decided 2026-08-16: evaluator lane exempt** (replaces the former retained red) | Green: `it.sequential('characterizes evaluator.request.started payload persistence in app logs (President decision: evaluator lane unsanitized)')` |
| RuntimeLogSchema required fields | C7.5 | Validates canonical required fields | Characterized & Tested | `source/services/logging/logging-contract.test.ts:13`: `it('buildRuntimeLogRecord produces canonical required fields')` |
| RuntimeLogSchema omit sentinel | C7.5 | Omits sentinel-valued optional fields | Characterized & Tested | `source/services/logging/logging-contract.test.ts:34`: `it('buildRuntimeLogRecord omits sentinel-valued fields')` |
| RuntimeLogSchema null context | C7.5 | Drops null optional context fields | Characterized & Tested | `source/services/logging/logging-contract.test.ts:53`: `it('buildRuntimeLogRecord removes null optional context instead of emitting an invalid record')` |
| RuntimeLogSchema valid context | C7.5 | Preserves provider, model, session, trace | Characterized & Tested | `source/services/logging/logging-contract.test.ts:73`: `it('buildRuntimeLogRecord preserves valid provider/model/session/trace')` |
| Parse category filter | C7.5 | Parses comma-separated category string | Characterized & Tested | `source/services/logging/logging-contract.test.ts:92`: `it('parseCategoryFilter parses valid comma-separated categories')` |
| Category filter preserves errors | C7.5 | Never drops warn or error level logs | Characterized & Tested | `source/services/logging/logging-contract.test.ts:100`: `it('shouldLogForCategory always keeps warn/error logs')` |
| Verbose payload retention | C7.5 | Keeps payload only for errors unless verbose | Characterized & Tested | `source/services/logging/logging-contract.test.ts:107`: `it('shouldIncludeVerbosePayload keeps payload only for error unless verbose')` |
| Sample rate preserves errors | C7.5 | Never drops error records during sampling | Characterized & Tested | `source/services/logging/logging-contract.test.ts:113`: `it('shouldSampleLog respects sample rate but never drops errors')` |
| Infer log category prefix | C7.5 | Infers category from event type prefix | Characterized & Tested | `source/services/logging/logging-contract.test.ts:119`: `it('resolveLogCategory infers category from event type prefix')` |
| Invalid tool call diagnostic | C7.5 | Generates complete diagnostic packet | Characterized & Tested | `source/services/logging/logging-contract.test.ts:126`: `it('createInvalidToolCallDiagnostic returns a complete packet')` |
| Truncate sent instructions | C7.3 | Truncates `instructions` > 100 chars in artifacts | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:21`: `it('sanitizeSentTrafficBody truncates instruction-like fields and preserves user/tool content')` |
| Summarize tools input | C7.3 | Summarizes Responses Lite additional_tools | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:50`: `it('sanitizeSentTrafficBody summarizes Responses Lite additional_tools input items')` |
| Truncate developer instructions | C7.3 | Truncates developer `input_text` > 100 chars | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:83`: `it('sanitizeSentTrafficBody truncates Responses Lite developer input_text instructions')` |
| Truncate system messages only | C7.3 | Truncates system/developer, preserves user content | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:103`: `it('sanitizeSentTrafficBody truncates system and developer messages in messages-style bodies only')` |
| Truncate content array system | C7.3 | Truncates system message with content array | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:127`: `it('sanitizeSentTrafficBody truncates system message with content array')` |
| Truncate Anthropic system | C7.3 | Truncates Anthropic system prompt string/array | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:147`: `it('sanitizeSentTrafficBody truncates anthropic message api system prompt (string or content array)')` |
| Redact reasoning ciphertext | C7.2 | Strips `reasoning.encrypted` from messages | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:172`: `it('sanitizeSentTrafficBody removes encrypted reasoning payload data from messages')` |
| Redact encrypted_content items | C7.2 | Redacts `encrypted_content` in Responses items | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:203`: `it('sanitizeSentTrafficBody redacts encrypted_content on Responses-API input items (reasoning and provider_opaque/compaction)')` |
| Summarize Responses SSE stream | C7.1 | Merges reasoning and tool call arguments | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:226`: `it('summarizeReceivedTraffic merges OpenAI Responses SSE text reasoning and tool arguments')` |
| Summarize Chat Completions SSE | C7.1 | Merges deltas and retains malformed frames | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:272`: `it('summarizeReceivedTraffic merges chat completions deltas and retains malformed and unknown frames')` |
| Recognize assistant role chunks | C7.1 | Ignores cost-only trailers and role init | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:312`: `it('summarizeReceivedTraffic recognizes assistant role-only chunks and ignores cost-only trailers')` |
| Summarize non-stream JSON | C7.1 | Handles standard JSON and unknown JSON | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:336`: `it('summarizeReceivedTraffic handles non-stream JSON and falls back safely for unknown JSON')` |
| Redact output encrypted_content | C7.2 | Strips `encrypted_content` from output items | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:374`: `it('summarizeReceivedTraffic redacts encrypted_content from reasoning and compaction output items')` |
| Sniff SSE content type | C7.1 | Sniffs SSE when content-type header missing | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:403`: `it('summarizeReceivedTraffic sniffs SSE body when content-type is missing')` |
| Sniff JSON content type | C7.1 | Sniffs JSON when content-type header missing | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:423`: `it('summarizeReceivedTraffic sniffs JSON body when content-type is missing')` |
| Lifecycle content_part frame | C7.1 | Recognizes `content_part.added` without error | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:435`: `it('summarizeReceivedTraffic recognizes response.content_part.added as a lifecycle frame')` |
| Lifecycle frame recognition | C7.1 | Prevents lifecycle frames in unknownFrames | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:456`: `it('summarizeReceivedTraffic recognizes Responses API lifecycle frames without adding to unknownFrames')` |
| Function call tool registration| C7.1 | Registers tool name from output_item.added | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:483`: `it('summarizeReceivedTraffic registers tool name from response.output_item.added function_call frame')` |
| Deduplicate done frame text | C7.1 | Prevents duplicate text from output_text.done | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:511`: `it('summarizeReceivedTraffic does not duplicate content from output_text.done after delta events')` |
| Artifact layout and daily index| C7.1 | Writes per-day session files and index.jsonl | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:536`: `it('ProviderTrafficArtifactStore writes per-day per-session request files and daily index')` |
| Index ordering and session dirs | C7.1 | Upserts newest-first index, records failures | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:594`: `it('ProviderTrafficArtifactStore appends received line, upserts newest-first index, records failures, and allows later-day session folders')` |
| Evaluator prefix layout | C7.1 | Places evaluator traffic with evaluator_ prefix | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:700`: `it('ProviderTrafficArtifactStore places evaluator requests with evaluator_ filename prefix')` |
| Path map cleanup on complete | C7.1 | Clears completed path from memory map | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:746`: `it('recordRequestComplete removes completed request path from map so a second completion without a fresh start gets a new path')` |
| Plain object response redaction| C7.2 | Strips `encrypted_content` on plain objects | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:809`: `it('ProviderTraffic.recordResponseReceived redacts encrypted_content from a plain-object response payload')` |
| Consumer closed stream metadata| C7.1 | Records closed outcome without false failure | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:851`: `it('ProviderTraffic records consumer-closed streams as metadata without fabricating a provider failure')` |
| Aborted stream transcript | C7.1 | Writes transcript to artifact, not app log | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:891`: `it("ProviderTraffic writes an aborted stream's transcript to the artifact and keeps it out of the app log")` |
| WebSocket receive timing success| C7.1 | Retains frame counts and timing budgets | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:952`: `it('ProviderTraffic retains the receive timing of a successful websocket response')` |
| WebSocket receive timing failure| C7.1 | Retains timing budgets on WebSocket failure | Characterized & Tested | `source/services/logging/provider-traffic.test.ts:996`: `it('ProviderTraffic retains the receive timing of a failed websocket request')` |
| Request start store throw | C7.1 | `recordRequestStart` must not throw on I/O error | **Product defect (retained expected failure)** | `source/services/logging/provider-traffic.test.ts:1052`: `it.fails('ProviderTraffic.recordRequestStart does not throw when artifact store fails')` |
| Response received store reject | C7.1 | `recordResponseReceived` must not reject on I/O | **Product defect (retained expected failure)** | `source/services/logging/provider-traffic.test.ts:1082`: `it.fails('ProviderTraffic.recordResponseReceived does not reject when artifact store fails')` |
| Response closed store throw | C7.1 | `recordResponseClosed` must not throw on I/O | **Product defect (retained expected failure)** | `source/services/logging/provider-traffic.test.ts:1113`: `it.fails('ProviderTraffic.recordResponseClosed does not throw when artifact store fails')` |
| Request failed store throw | C7.1 | `recordRequestFailed` must not double-fault | **Product defect (retained expected failure)** | `source/services/logging/provider-traffic.test.ts:1144`: `it.fails('ProviderTraffic.recordRequestFailed does not throw when artifact store fails')` |
| Corrupted daily index fault | C7.1 | Store ignores corrupt JSONL without crashing | **Product defect (retained expected failure)** | `source/services/logging/provider-traffic.test.ts:1174`: `it.fails('ProviderTrafficArtifactStore ignores malformed lines in daily index.jsonl without crashing')` |
| Fetch error masking fault | C7.1 | Preserves original provider network error | **Product defect (retained expected failure)** | `source/providers/fetch/composer.test.ts:842`: `it.fails('createLoggingMiddleware preserves original provider error when recordRequestFailed throws')` |
| Fetch request start dispatch | C7.1 | Does not abort network dispatch on log error | **Product defect (retained expected failure)** | `source/providers/fetch/composer.test.ts:876`: `it.fails('createLoggingMiddleware does not abort network dispatch when recordRequestStart throws')` |

## 9. Verification commands

- **Focused Contract Verification:**
  ```bash
  NODE_ENV=test pnpm test source/services/logging/logging-service.test.ts source/services/logging/provider-traffic.test.ts source/services/logging/logging-contract.test.ts source/providers/fetch/composer.test.ts
  ```
  *Result (2026-08-15):* 4 test files, 89 tests (80 passing, 9 expected failures) in 557ms (Exit 0).
- **Provider Black-Box Suite (Mandatory per provider-testing skill):**
  ```bash
  pnpm test:provider-black-box
  ```
  *Result (2026-08-15):* 19 test files, 166 passing, 1 skipped in 50.95s (Exit 0).
- **All Logging Subsystem Tests:**
  ```bash
  NODE_ENV=test pnpm test source/services/logging/
  ```
  *Result (2026-08-15):* 8 test files, 108 tests (101 passing, 7 expected failures) in 1.68s (Exit 0).
- **Broader Full-Suite Verification:**
  ```bash
  NODE_ENV=test pnpm test
  ```
  *Result (2026-08-15):* 485 test files, 6,249 tests (483 files passed / 6,237 tests passed, 9 expected failures, 2 skipped, 1 unrelated baseline failure in `source/services/settings/settings-schema.test.ts` testing default `maxModelRequestDurationMs` setting).
- **TypeScript Typecheck:**
  ```bash
  pnpm typecheck
  ```
  *Result (2026-08-15):* Exited 0 (`tsc --noEmit` clean).

## 10. Known gaps and Bug-to-Invariant analysis

### Defect Class 1: Unhandled Synchronous Filesystem I/O in Diagnostic Provider Traffic Artifact Store
- **Level 1 — Bug:** Diagnostic provider-traffic artifact write failure (e.g. disk full `ENOSPC`, permission denied `EACCES`, read-only filesystem `EROFS`) throws synchronously into the caller, aborting active LLM generation requests before they reach the provider or crashing the response processing stream loop.
- **Level 2 — Root Cause:** `ProviderTrafficArtifactStore.recordRequestStart`, `recordRequestComplete`, `writeTrafficEnvelope`, `#touchDailyIndex`, and `#upsertDailyIndex` (`source/services/logging/provider-traffic.ts:188-191, 702-765, 801-805`) perform synchronous `fs.mkdirSync` and `fs.writeFileSync` calls without `try/catch` error boundaries. In fetch middleware (`source/providers/fetch/logging-middleware.ts:122`), `recordRequestStart` is executed synchronously on the active LLM request path.
- **Level 3 — System Weakness / Detection Gap:**
  1. *Representability:* `IProviderTraffic.recordRequestStart` returns `void` synchronously, masking throwing I/O operations as a simple in-memory call.
  2. *Boundary Contract:* Missing fail-open contract guard between diagnostic artifact capture and primary LLM request execution.
  3. *Detection Gap:* Unit tests only exercised temporary directories with full write permissions; no test simulated read-only disks, full filesystems, or failing directory creation during model requests.
  4. *Sibling Inconsistency:* `LoggingService.log()` caught logger dispatch exceptions, but `ProviderTraffic` did not wrap its store calls.
- **Sibling Paths:** `ProviderTraffic.recordRequestStart`, `recordResponseReceived`, `recordResponseClosed`, `recordRequestFailed`.
- **Structural Hardening (Phase 2 Repair):** Wrap `store.recordRequestStart` and `store.recordRequestComplete` invocations in `ProviderTraffic` in `try/catch` blocks, emitting a warning via `this.loggingService.warn('Provider traffic artifact write failed', { eventType: 'provider.traffic.artifact_write_failed', ... })` on I/O errors while allowing the primary turn and network requests to proceed unimpeded.

### Defect Class 2: Daily Index JSON Parse Crash on Corrupted Line
- **Level 1 — Bug:** If an unclean shutdown, disk full condition, or process crash leaves a partial or malformed line in `<logDir>/provider-traffic/<date>/index.jsonl`, subsequent calls to `recordRequestStart` throw an unhandled `SyntaxError: Unexpected token` during `#readDailyIndex`, permanently breaking all provider traffic operations for that day.
- **Level 2 — Root Cause:** `ProviderTrafficArtifactStore.#readDailyIndex` (`source/services/logging/provider-traffic.ts:791-799`) iterates lines with `.map(line => JSON.parse(line))` without wrapping individual line parses in `try/catch` or filtering invalid lines.
- **Level 3 — System Weakness / Detection Gap:**
  1. *Representability:* `index.jsonl` lines are deserialized as untyped JSON without defensive schema validation.
  2. *Detection Gap:* Tests only read clean index files written by previous test steps; no test seeded an incomplete or corrupt JSON line.
- **Structural Hardening (Phase 2 Repair):** Use a safe JSON parser (`tryParseJson`) to ignore malformed index lines gracefully, retain surviving entries, and rewrite valid index state.

### Defect Class 3: Security-Relevant Redaction Leaks in Winston Application Logs
- **Level 1 — Bug:** While `ProviderTraffic` sanitizes sent and received artifacts, `LoggingService.log` leaks `encrypted_content` in nested message payloads when `LOG_VERBOSE_PAYLOADS=1`, and fails to sanitize `evaluator.request.started` messages entirely (leaving base64 image data and system prompts unredacted).
- **Level 2 — Root Cause:** `LoggingService.log` (`source/services/logging/logging-service.ts:342`) conditionally calls `sanitizeLogMetadata` *only* when `metadata.eventType === 'provider.request.started'`, omitting `evaluator.request.started`. Furthermore, `sanitizeLogMetadata` (`source/utils/output/log-truncation.ts:144`) strips top-level `reasoning` and `reasoning_content` keys but does not recursively redact `encrypted_content` inside message arrays or compaction items.
- **Level 3 — System Weakness / Detection Gap:**
  1. *Boundary Contract:* Redaction was applied ad-hoc in the artifact serialization path rather than as a uniform pre-log sanitization pipeline.
  2. *Detection Gap:* Tests only verified `provider.request.started` with default `verbosePayloads: false`.
- **Structural Hardening (Phase 2 Repair):** Apply recursive `redactEncryptedContent` in `sanitizeLogMetadata` and expand event-type gating to include `evaluator.request.started`.

### Defect Class 4: Double-Fault Error Masking in Fetch Middleware
- **Level 1 — Bug:** When an upstream provider request fails (e.g. 504 Gateway Timeout or network abort), if diagnostic `recordRequestFailed` throws during error recording, the diagnostic error replaces and masks the original provider error.
- **Level 2 — Root Cause:** `createLoggingMiddleware` (`source/providers/fetch/logging-middleware.ts:134-140`) executes `providerTraffic.recordRequestFailed` inside its `catch (error)` block; at the time of writing `ProviderTraffic` threw on store errors, so the original error was replaced.
- **Structural Hardening (Phase 2 Repair): landed for the store write.** Every artifact-store call in `ProviderTraffic` now goes through `#runArtifactStoreOperation` (`provider-traffic.ts:1103-1121`), which swallows store errors behind a warning, so a store write can no longer mask the provider error. The residual exposure is narrower: the winston `loggingService.error`/`info` call that follows each store write is still unguarded.

### Codex Stream Consumer Direct Gaps (Unresolved Seam Defect)
- In `source/providers/codex-responses-model.ts`:
  - `#logTrafficReceived` path (:1079): `this.providerTraffic.recordResponseReceived(...)` is invoked without `await` or `.catch()`. If the returned promise rejects, Node.js emits an unhandled promise rejection that terminates the process under `--unhandled-rejections=strict`.
  - `#logTrafficFailed` path (:1101): `this.providerTraffic.recordRequestFailed(...)` is invoked synchronously on WebSocket failure. If it throws, the diagnostic failure replaces and masks the real WebSocket provider error.
  - `#logTrafficClosed` path (:1121): `this.providerTraffic.recordResponseClosed(...)` is invoked synchronously in the stream loop `finally` block. If it throws, the synchronous exception displaces the primary stream return value or upstream abort error.
  - Scope note: store-write errors alone no longer reach these call sites, because every artifact-store call is wrapped in `#runArtifactStoreOperation` (`provider-traffic.ts:1103-1121`). The unguarded winston logging call in each record method remains.
  - *Recommendation for Phase 2:* Ensure `IProviderTraffic` methods never throw or reject.

### Residual Hypotheses / Unresolved Decisions (Awaiting Owner Review)
1. **In-Memory `#requestPaths` Leak on Unsettled Requests:**
   - `ProviderTrafficArtifactStore.#requestPaths` retains `requestId -> requestPath` until `recordRequestComplete` is called. If a request is abandoned or process crashes before completion, the map entry is never pruned. Under long-running sessions with abandoned streams, this is an unbounded in-memory leak.
   - *Decision required:* Add TTL-based eviction or session-scoped cleanup to `#requestPaths`.
2. **`traceId` UUID Shape Fallback & Override Behavior:**
   - `buildRuntimeLogRecord` checks `looksLikeUuid(rawTraceId)`. If `meta.traceId` is non-UUID, but ambient `correlationId` is a UUID, `buildRuntimeLogRecord` overwrites `meta.traceId` with `correlationId`. A non-UUID correlationId is still emitted as `traceId` if no UUID exists.
   - *Decision required:* Retain current UUID-preference override or strictly preserve explicit caller `meta.traceId` regardless of format.
3. **`RuntimeLogSchema` Passthrough Mode:**
   - `RuntimeLogSchema.passthrough()` permits arbitrary unstructured properties to cross into Winston logs.
   - *Decision required:* Retain flexible passthrough for diagnostics or enforce closed metadata schema?
