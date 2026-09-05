# App and persisted event recipes

Use these only after selecting the relevant rotated file or conversation. Keep
the projection narrow because app records can contain prompts and tool data.

## App lifecycle

The app JSONL uses top-level fields such as `eventType`, `message`,
`timestamp`, `correlationId`, `traceId`, and optional `sessionId`/`requestId`.
Some `log.message` records have no session ID even when the correlation is
useful. This query shows provider boundaries without counting text mentions:

```bash
APP=~/.local/state/term2-nodejs/logs/term2-2026-09-05.log.3
jq -c 'select(.eventType == "provider.request.started" or
  .eventType == "provider.response.received")
  | {timestamp,eventType,correlationId,traceId,sessionId,requestId,
     provider,model,mode,status,toolCount:(.toolCalls|length? // 0)}' "$APP"
```

`run_code` has a start record and a separate `message == "run_code execution
finished"` record. Read `ok` on the finish record:

```bash
jq -c 'select(.message == "run_code execution finished")
  | {timestamp,correlationId,traceId,ok}' "$APP"
```

The retained September 5 sample contains both `ok: true` and `ok: false`; an
aggregate must filter finished records and report its sampling scope. Do not
call `command_message.status == "completed"` success: persisted command
messages use that status for failures too.

Do not classify a run as a benchmark from `mode` or an interactive/non-
interactive label alone. Some non-interactive sessions are genuine workers,
while experiments can appear in the same aggregate. Use the user preview,
project/worktree, session identity, and task evidence, and state the cohort
when reporting counts.

## Persisted conversations

Conversation files are JSONL records with envelope keys `v`, `seq`, `ts`, and
`event`. Inspect event kinds first:

```bash
CONV=~/.local/share/term2-nodejs/conversations/"<session-id>".jsonl
jq -r '.event.type? // empty' "$CONV" | sort | uniq -c | sort -nr
jq -c 'select(.event.type == "tool_started")
  | {seq,ts,toolCallId:.event.toolCallId,toolName:.event.toolName,
     turnId:.event.turnId}' "$CONV"
```

For a run_code call, inspect its matching `command_message` by call ID and
project only settlement fields:

```bash
CALL="<tool-call-id>"
jq -c --arg call "$CALL" \
  'select(.event.type == "command_message" and
    .event.message.callId == $call)
  | {seq,ts,status:.event.message.status,
     approvalRejection:.event.message.isApprovalRejection,
     output:(.event.message.output // "" | .[0:240])}' "$CONV"
```

Do not count `assistant_journal_item` or `assistant_turn` copies as additional
tool calls. Conversely, a persisted `tool_started` is not proof of effect
success; inspect the settled result and the owning effect when that distinction
matters.

## Correlation and time

Use `sessionId` and `requestId` as primary joins. `correlationId`/`traceId` can
cover a chain of model and client activities and some log records omit session
fields. Persisted `ts` and provider-traffic timestamps are UTC ISO strings;
app timestamps are local wall time in the retained Linux logs. Compare converted
timestamps and verify the exact request envelope before attributing a call.

For rollover, inspect nullable lifecycle fields rather than assuming every
event is complete:

```bash
jq -c 'select(.event.type == "session_rollover")
  | {seq,ts,phase:(.event.phase // "legacy"),reason:(.event.reason // null),
     rolloverId:(.event.rolloverId // null),
     sourceSessionId:(.event.sourceSessionId // null),
     successorSessionId:(.event.successorSessionId // null),
     settlementLatencyMs:(.event.settlementLatencyMs // null)}' "$CONV"
```

Older `requested` records can omit source/successor IDs and are intent only. For
a completed event with IDs, verify the successor conversation's
`session_init.rolloverFrom` points back to the source, then inspect successor
activity. A completed rollover is a lifecycle fact; successor linkage and task
completion are separate claims.

```bash
SOURCE_ID="<source-session-id>"
SUCCESSOR_ID="<successor-session-id>"
SUCCESSOR=~/.local/share/term2-nodejs/conversations/"<successor-session-id>".jsonl
jq -e --arg source "$SOURCE_ID" --arg successor "$SUCCESSOR_ID" \
  'select(.event.type == "session_init" and .event.id == $successor
    and .event.rolloverFrom == $source)' "$SUCCESSOR" >/dev/null
```

An exit status of 0 proves the recorded successor points to that source. If
the event was legacy/requested and IDs are unavailable, this linkage check
cannot identify a successor and must remain unresolved.
