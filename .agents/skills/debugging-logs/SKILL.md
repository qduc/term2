---
name: debugging-logs
description: Inspect Term2 app logs and persisted conversation events when debugging a real run, provider lifecycle, tool execution, rollover, or compaction. Use structured JSON queries and the provider-traffic skill for wire artifacts.
---

# Debugging logs

Use logs to establish what happened at each boundary. Query structured fields;
text mentions inside prompts, source listings, and prior transcripts are not
event counts.

## Locations and time

| | App logs | Provider traffic |
| --- | --- | --- |
| Linux | `~/.local/state/term2-nodejs/logs/` | `~/.local/state/term2-nodejs/logs/provider-traffic/` |
| macOS | `~/Library/Logs/term2-nodejs/logs/` | `~/Library/Logs/term2-nodejs/logs/provider-traffic/` |

App logs rotate as `term2-YYYY-MM-DD.log`, `term2-YYYY-MM-DD.log.1`, and so on;
include the rotations for the time window. Their `timestamp` is local wall time
(the retained Linux sample is UTC+7). Persisted conversations under
`~/.local/share/term2-nodejs/conversations/` and provider-traffic timestamps are
ISO UTC. Convert before joining records; do not join by filename alone.

An app record is one JSON object per line. Start with a narrow projection:

```bash
APP=~/.local/state/term2-nodejs/logs/term2-2026-09-05.log.3
jq -c 'select(.eventType == "provider.request.started" or .eventType == "provider.response.received")
  | {timestamp,eventType,correlationId,traceId,sessionId,requestId,provider,model,status}' "$APP"
jq -c 'select(.message == "run_code execution finished")
  | {timestamp,correlationId,traceId,ok}' "$APP"
```

Persisted conversation files are JSONL with `event.type` values such as
`session_init`, `user_message`, `tool_started`, `command_message`,
`assistant_journal_item`, `assistant_turn`, and `session_rollover`. Count a
`tool_started` event once; its journal and settled-turn copies are evidence of
the same call, not more calls. The detailed event recipes are in
[`references/app-events.md`](references/app-events.md).

## Keep outcomes separate

`command_message.status == "completed"` means the lifecycle settled; it does
not mean the command or script succeeded. For `run_code`, inspect the separate
finish record's `ok` boolean, then inspect the returned result for nested errors,
truncation, and the next action. A script can finish successfully while a
nested call fails; a nested call can succeed while the requested task remains
unfinished. Treat effect and task success as an additional, independently
verified claim.

`correlationId` and `traceId` are useful pivots, but a correlation can cover
multiple model/client activities. Do not map one correlation blindly to one
session. Prefer matching provider `requestId` and `sessionId`, persisted
session IDs, event timestamps, and the actual request/response pair. The
provider-traffic skill has the envelope and wire-shape procedures.

Keep projections small: logs may contain prompts, tool arguments, and raw
ciphertext. Redaction in provider traffic does not imply equivalent redaction
in app debug logs.
