# Logging System Improvement Plan

## Goal

Make debugging model and tool behavior fast by producing traceable, low-noise logs and giving the log viewer first-class debugging workflows.

## Plan

1. Define a logging contract first

- Create a canonical JSON schema for all runtime logs.
- Required fields: `timestamp`, `level`, `eventType`, `traceId`, `sessionId`, `messageId`, `provider`, `model`, `phase`.
- Optional fields: `toolName`, `toolCallId`, `retryType`, `retryAttempt`, `errorCode`, `errorMessage`, `payloadRef`.
- Add `docs/logging.md` with event taxonomy and examples.

2. Add correlation and event taxonomy in code paths

- Generate and propagate `traceId` at request start through conversation, session, and tool execution.
- Instrument key boundaries: provider raw response, normalization, validation, approval, execution, retry, and abort.
- Use stable `eventType` names (for example: `tool_call.parse_failed`, `tool_call.validation_failed`, `retry.hallucination`, `retry.upstream`).

3. Implement noise controls (debug without chaos)

- Add channel-based debug categories: `provider`, `tool`, `stream`, `approval`, `retry`.
- Add env/settings filters: `LOG_LEVEL`, `LOG_CATEGORIES`, `LOG_VERBOSE_PAYLOADS`, `LOG_SAMPLE_RATE`.
- Default behavior: compact one-line structured summaries; detailed payloads only on error or explicit verbose flag.

4. Add failure packets for hard issues

- For invalid tool call format, emit one diagnostic packet containing:
- `rawPayloadSnippet`, `normalizedToolCall`, `validationErrors`, `traceId`, `retryContext`.
- Ensure packet is emitted once per failure, with clear `errorCode`.

5. Improve log viewer for debugging workflows

- Add structured filters in `tools/log_viewer/public`: `traceId`, `sessionId`, `eventType`, `toolName`, `provider`, `model`.
- Add focus presets: `Errors only`, `Tool calls`, `Invalid tool format`, `Retries`.
- Keep local row cache and filter client-side; debounce search.
- Add row action: "Filter by this traceId".
- Mark malformed JSON lines explicitly (parse error badge).

6. Add incremental streaming support in viewer backend

- Extend `tools/log_viewer/src/server.js` with an append-read endpoint (offset-based tail) to avoid full reload per change.
- Keep SSE for change notification, but append only new lines client-side.

7. Testing strategy (TDD-first)

- Unit tests for schema validation and required fields.
- Unit tests for category and verbosity filtering behavior.
- Unit tests for invalid-tool-call diagnostic packet emission.
- Viewer tests for filter logic and focus presets.
- Integration test covering one full failing tool-call trace end-to-end.

8. Rollout in phases

- Phase 1: schema, trace propagation, and key events.
- Phase 2: noise controls and failure packet.
- Phase 3: viewer filters/presets and trace drill-down.
- Phase 4: incremental append and polish.
- Phase 5: docs, migration notes, and default settings tuning.

## Acceptance Criteria

- Any failure can be traced with one `traceId` from request start to abort.
- `debug` logs are usable via category filters without scanning raw noise.
- Invalid tool call root cause is visible in one diagnostic block.
- Viewer can isolate problematic traces in under 10 seconds.
