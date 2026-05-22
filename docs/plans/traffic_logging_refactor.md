# Per-Session Traffic Logging Refactor

## Summary

- Replace daily provider traffic files with a per-day, per-session layout under `provider-traffic`:
  - `<UTC-date>/index.jsonl`
  - `<UTC-date>/<session-start-datetime>_<session-id>/`
  - `<session-dir>/<request-datetime>_<request-id>.jsonl`
- Make each request artifact a two-line JSONL file:
  - Line 1: full sent request after targeted traffic sanitization.
  - Line 2: compact received response summary derived from JSON or SSE traffic.
- Capture all model-call traffic through the new structure, including foreground conversation turns, built-in OpenAI calls, compatible providers, subagents, mentor calls, and evaluator calls.
- Keep legacy daily traffic files untouched. Do not migrate or rewrite old logs.

## Key Changes

### Traffic Context And Capture

- Add a scoped traffic logging context around conversation sends and approval continuations so provider fetch logging can resolve:
  - `sessionId`
  - first known user-turn preview
  - active app mode
  - trace/correlation ID when available
- Use scoped context for nested model calls so subagent, mentor, and evaluator requests land under the owning session.
- Fix session ID plumbing before artifact writing:
  - Interactive CLI sessions must construct `ConversationService` with the real persisted session UUID, not the current default session ID.
  - Non-interactive sessions should use a unique session ID per invocation instead of the shared `non-interactive` ID.
- Generalize the current provider fetch logging wrapper into the canonical HTTP traffic capture boundary.
- Make built-in OpenAI use an explicit provider runner/client with the same logging fetch wrapper so raw HTTP request/response traffic is available there too.
- Ensure OpenAI subagent and mentor paths use the provider registry runner path instead of bypassing OpenAI traffic capture.

### Artifact Layout And Index

- Use UTC for date folders and filename timestamps.
- Use `.jsonl` request files with filesystem-safe timestamp names such as:
  - `2026-05-22/2026-05-22T09-14-31.125Z_<session-id>/2026-05-22T09-14-35.044Z_<request-id>.jsonl`
- Generate a local UUID `requestId` at the fetch boundary for every HTTP model request.
- Reuse the same `requestId` to pair the sent and received lines even if the provider response has its own response ID.
- Write the sent line immediately when the request starts.
- Append the received line when the response body clone is summarized.
- If fetch fails or response-body logging fails, append a received error record when possible.
- Accept that a process crash can leave a sent-only request artifact.

### Daily Index Contract

- Store `index.jsonl` as one JSON object per session line.
- Rewrite the daily index newest-first on session request activity, sorted by `lastRequestAt`.
- Upsert one line per date-local session folder.
- Use these index fields:
  - `sessionId`
  - `sessionDir`
  - `firstRequestAt`
  - `lastRequestAt`
  - `requestCount`
  - `firstUserMessagePreview`
  - `latestProvider`
  - `latestModel`
  - `providersSeen`
  - `modelsSeen`
  - `latestMode`
  - `modesSeen`
- Truncate `firstUserMessagePreview` to 160 normalized characters.
- For a resumed session on a later day, create a new date-local session folder and a new daily index entry with the same `sessionId`.

### Sent Request Shape

- Traffic artifacts must be written from the unsanitized request data before runtime-log truncation/sampling behavior is applied.
- Preserve main request content as-is:
  - user messages
  - tool outputs
  - previous turns/history
  - function/tool-call arguments already present in history
  - image/content payloads in the request body
- Apply only targeted sent-side reduction:
  - Truncate system/developer/instructions text to 1,000 characters with explicit omitted-length markers.
  - Reduce tool definitions to tool names only.
- Support both common request body families:
  - Responses-style bodies using `input`, `instructions`, and `tools`
  - Chat-completions / AI SDK bodies using `messages` and `tools`

### Received SSE Compaction

- Build a response summarizer that handles both JSON responses and SSE streams.
- SSE handling:
  - Parse frames from `event:` and `data:` blocks.
  - Ignore comments, heartbeat frames, and `[DONE]`.
  - Parse JSON frame payloads when possible.
- Use small shape extractors for the common response families:
  - OpenAI Responses events
  - Chat Completions / OpenRouter deltas
  - common AI SDK / Anthropic-style text, reasoning, and tool-input deltas where detectable
- Accumulate semantic output without truncating extracted values:
  - merged text output
  - merged reasoning output
  - tool calls grouped by call ID or stream index
  - streamed tool argument fragments merged into final argument strings
  - parsed tool argument JSON when valid
  - finish/status data
  - usage data when present
  - provider response IDs when present
- Preserve diagnostics without storing the full raw stream:
  - Keep full raw error-like frames.
  - Keep malformed or parse-failure frames.
  - Keep unknown non-error frames in grouped form with stable shape signature, count, first raw example, and last raw example.
- If a response has no recognized semantic fields, keep a fallback body/unknown-frame summary sufficient to show the unsupported provider shape.
- Do not store complete raw SSE streams in the request artifact.

### Runtime Logs And Legacy Behavior

- Keep normal Winston runtime logs and their existing noise controls separate from provider traffic artifacts.
- Stop using generic runtime `provider.request.started` logs as canonical request artifacts unless they carry fetch-boundary `requestId` traffic metadata.
- Treat fetch-boundary request/response records as the source of truth for the new traffic tree.
- Keep evaluator runtime logs for observability, but put evaluator model-call traffic in the same session/request artifact structure as other provider calls.
- Leave the legacy traffic extractor and legacy files intact unless a small docs clarification is needed.

## Interfaces And Types

- Extend the logging abstraction with a scoped traffic context API, preferably optional on `ILoggingService` so existing mocks can remain no-op compatible.
- Add internal traffic types for:
  - session traffic context
  - sent traffic record
  - received traffic summary
  - daily session index entry
- Add fetch-boundary traffic metadata including:
  - `requestId`
  - `sessionId`
  - `traceId`
  - `provider`
  - `model`
  - timestamp
  - request/response direction
- Keep provider response IDs separate from generated local `requestId`.

## Test Plan

- Write sent-request sanitizer tests first:
  - system/developer/instructions fields are truncated at the traffic limit
  - tool schemas collapse to tool names
  - user content, tool output, prior turns, and tool arguments stay intact
  - Responses-style and messages-style request bodies both work
- Write received summarizer tests first:
  - OpenAI Responses SSE merges text, reasoning, and function argument deltas
  - Chat Completions/OpenRouter SSE merges content, reasoning, and tool-call arguments
  - comments, heartbeats, duplicate envelope noise, and `[DONE]` are discarded
  - unknown/error/malformed frames are retained in the selected diagnostic form
  - non-stream JSON responses are summarized and unknown JSON falls back safely
- Write artifact writer tests:
  - request start creates date folder, session folder, sent line, and daily index entry
  - response appends the second received line into the same request file
  - fetch failure writes received error data
  - index lines are newest-first and upsert request counts/model/mode metadata
  - same session on another day gets another date-local session entry
  - existing legacy daily traffic files are not migrated
- Write provider integration tests:
  - wrapper emits the same generated `requestId` on sent and received records
  - built-in OpenAI runner is routed through logging fetch capture
  - nested model calls inherit owning session context
- Write CLI/session tests:
  - interactive conversation service receives the effective session UUID
  - non-interactive runs do not collapse into a shared daily session folder
- Run focused logging/provider/session tests first, then run the broader test suite if provider runner changes affect shared model execution paths.

## Assumptions

- `provider-traffic` remains the canonical traffic artifact root.
- New filenames and date partitions use UTC.
- Daily retention behavior should be preserved for new traffic date folders unless changed separately.
- Legacy daily traffic files remain readable and unconverted.
- Full raw SSE replay is intentionally out of scope; the received artifact is a semantic debugging summary plus retained unknown/error diagnostics.
