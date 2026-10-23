# Runtime Logging Contract

## Canonical JSON schema

All runtime logs are JSON records with required fields:

- `timestamp`
- `level`
- `eventType`
- `traceId`
- `sessionId`
- `messageId`
- `provider`
- `model`
- `phase`

Optional fields:

- `toolName`
- `toolCallId`
- `retryType`
- `retryAttempt`
- `errorCode`
- `errorMessage`
- `payloadRef`

## Event taxonomy

- `provider.request.started`: provider request boundary
- `provider.response.failed`: provider failure boundary
- `stream.started`: conversation stream begin
- `stream.failed`: conversation stream failure
- `stream.aborted`: stream aborted by user
- `approval.required`: tool call requires approval
- `approval.granted`: approval accepted
- `approval.rejected`: approval denied
- `approval.aborted`: approval aborted during run
- `tool_call.execution_started`: tool call execution begin
- `tool_call.parse_failed`: invalid tool-call payload diagnostic packet
- `retry.hallucination`: model hallucinated tool call retry
- `retry.upstream`: upstream provider retry

## Phases

- `request_start`
- `provider_response`
- `normalization`
- `validation`
- `approval`
- `execution`
- `retry`
- `abort`
- `runtime`

## Noise controls

Environment variables:

- `LOG_LEVEL`: minimum level
- `LOG_CATEGORIES`: comma-separated categories (`provider,tool,stream,approval,retry,general`)
- `LOG_VERBOSE_PAYLOADS`: `true|false`
- `LOG_SAMPLE_RATE`: `0.0..1.0`

Defaults:

- compact single-line JSON output
- payload bodies hidden unless `LOG_VERBOSE_PAYLOADS=true` or log level is `error`

## Invalid tool-call diagnostic packet example

```json
{
  "eventType": "tool_call.parse_failed",
  "errorCode": "INVALID_TOOL_CALL_FORMAT",
  "toolName": "shell",
  "toolCallId": "call_abc",
  "rawPayloadSnippet": "{\"command\":",
  "normalizedToolCall": {
    "toolName": "shell",
    "toolCallId": "call_abc"
  },
  "validationErrors": ["arguments must be valid JSON"],
  "traceId": "e1f9c8d0-75f0-4da2-b9ae-8fc7f2b3ebd8",
  "retryContext": {
    "sessionId": "default"
  }
}
```
