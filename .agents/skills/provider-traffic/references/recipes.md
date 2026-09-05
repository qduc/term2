# Provider traffic recipes

Set `D` to the traffic root, `DAY` to a date, and `S` to a session directory.
Set `F` to one request envelope after locating it through `index.jsonl`.
Every request recipe below parses the whole `.json` object.

## Timeline

Use a shape-neutral first pass. It tells you which branch to use next:

```bash
while IFS= read -r -d '' REQUEST; do
  jq -rc '[(.sent.timestamp // "?"),(.sent.model // "?"),
    (.received.summary.transport // "?"),
    (.received.summary.wireShape // "websocket-chat-or-unknown"),
    ((.received.summary.status // "?")|tostring),
    ((.received.summary.errorFrames // [])|length|tostring),
    (.sent.requestId // "?"),input_filename] | @tsv' "$REQUEST"
done < <(find "$D/$DAY/$S" -maxdepth 1 -type f -name '*.json' -print0) | sort -k1,1
```

The `find -print0` form also handles an empty directory and filenames with
spaces. A request directory should contain only request envelopes and optional
evaluator artifacts; inspect evaluator files separately.

## Shape-specific response fields

```bash
# WebSocket or chat_completions
jq -c '.received.summary.payload.choices[0]
  | {finish_reason,
     contentPreview:(.delta.content // "" | .[0:240]),
     reasoningChars:(.delta.reasoning // "" | length),
     toolCount:(.delta.tool_calls // [] | length),
     toolIds:(.delta.tool_calls // [] | map(.id)),
     toolNames:(.delta.tool_calls // [] | map(.function.name))}' "$F"

# Responses wire shape
jq -c '.received.summary.payload
  | {status,itemCount:(.output // [] | length),
     items:(.output // [] | map({type,id,call_id,name,
       textChars:(if .type == "message" then
         ([.content[]?.text] | join("") | length) else null end),
       argumentsChars:(if .type == "function_call" then
         (.arguments // "" | length) else null end)}))}' "$F"
```

`choices` is absent on Responses artifacts. `wireShape` is absent on the
WebSocket summary, so use `transport` plus the payload keys for that lane.
Completed normalized summaries assemble stream chunks; individual chunks are
not retained there. Aborted or failed recordings can contain only a partial
summary, or no payload, so use status, error/malformed/unknown fields and the
app log before treating missing text or calls as evidence of absence.

## Errors and usage

```bash
jq -c '.received | {error:(.error // null),summary:(.summary // {})
  | {transport,status,
     providerErrorCount:(.errorFrames // [] | length),
     providerErrorSignatures:(.errorFrames // []
       | map((.code // .type // .detail // .message // .error.message // "unknown" | tostring)[0:160])[:8]),
     malformedCount:(.malformedFrames // [] | length),
     unknownCount:(.unknownFrames // [] | length),
     unknownSignatures:(.unknownFrames // []
       | map((.signature // "unknown" | tostring)[0:160])[:8])}}' "$F"

# Keep usage scalar; attribution.items may be huge.
jq -c '.received.summary.payload.usage
  | {input:(.input_tokens // .prompt_tokens // null),
     output:(.output_tokens // .completion_tokens // null),
     cached:(.input_tokens_details.cached_tokens //
             .prompt_tokens_details.cached_tokens // null),
     cache_write:(.input_tokens_details.cache_write_tokens // null),
     total:(.total_tokens // null)}' "$F"
```

Do not equate a 200 status with a useful response: check provider errors,
malformed/unknown frames, payload presence, and the next application action.
Do not infer billing from a local rendered-input estimate; use the scalar wire
usage fields and state which request they describe.

Expand one selected error frame only after the bounded scan:

```bash
FRAME_INDEX=0
jq -c --argjson index "$FRAME_INDEX" \
  '.received.summary.errorFrames[$index] // null' "$F"
```

## Tool calls across one session

Choose the path from the shape first. For chat/WebSocket:

```bash
while IFS= read -r -d '' REQUEST; do
  jq -rc '.received.summary.payload.choices[0].delta.tool_calls // [] | .[]
    | {request:(input_filename|split("/")|.[-1]),id,
       name:.function.name,argumentsChars:(.function.arguments // "" | length)}' "$REQUEST"
done < <(find "$D/$DAY/$S" -maxdepth 1 -type f -name '*.json' -print0)
```

For Responses:

```bash
while IFS= read -r -d '' REQUEST; do
  jq -rc '.received.summary.payload.output // [] | .[]
    | select(.type == "function_call")
    | {request:(input_filename|split("/")|.[-1]),id,call_id,name,
       argumentsChars:(.arguments // "" | length)}' "$REQUEST"
done < <(find "$D/$DAY/$S" -maxdepth 1 -type f -name '*.json' -print0)
```

Count request envelopes or assembled call IDs once. The daily index and app
logs are corroborating indexes, not extra provider calls.

Expand one selected call only after the bounded scan:

```bash
CALL_ID="<call-id>"
jq -rc --arg id "$CALL_ID" \
  '.received.summary.payload.choices[0].delta.tool_calls // [] | .[]
   | select(.id == $id) | {id,name:.function.name,arguments:.function.arguments}' "$F"
```

For a Responses `function_call`, select `.call_id == $id` under
`.received.summary.payload.output[]` instead.

## Compaction reuse

First inspect the trigger's session, timestamp, and status:

```bash
TRIGGER=/path/to/compaction-trigger.json
SESSION_ID=$(jq -r '.sent.sessionId' "$TRIGGER")
TRIGGER_AT=$(jq -r '.sent.timestamp' "$TRIGGER")
ARTIFACT_ID=$(jq -r '[.received.summary.payload.compaction_id?,
  (.received.summary.payload.output[]? | select(.type == "compaction") | .id?)]
  | map(select(type == "string" and length > 0)) | first // empty' "$TRIGGER")
jq -c --arg artifact "$ARTIFACT_ID" '.received.summary | {transport,status,wireShape,
  usage:(.payload.usage | {input_tokens,output_tokens,total_tokens}),
  artifactId:($artifact // null)}' "$TRIGGER"
```

If `ARTIFACT_ID` is populated, match it. Otherwise the same-session search is
only an unlinked lifecycle signal and cannot identify this trigger:

```bash
SESSION_DIR=/path/to/session
MATCHES=0
if [ -n "$ARTIFACT_ID" ]; then
  while IFS= read -r -d '' REQUEST; do
    jq -e --arg after "$TRIGGER_AT" --arg session "$SESSION_ID" --arg artifact "$ARTIFACT_ID" \
      '(.sent.sessionId == $session and .sent.timestamp > $after)
       and any(.sent.body.input[]?; .type == "compaction" and .id == $artifact)' "$REQUEST" >/dev/null \
      && { MATCHES=$((MATCHES + 1)); printf '%s\n' "$REQUEST"; jq -c '.received.summary | {status,usage:(.payload.usage | {input_tokens,output_tokens,total_tokens,input_tokens_details})}' "$REQUEST"; }
  done < <(find "$SESSION_DIR" -maxdepth 1 -type f -name '*.json' -print0)
else
  printf '%s\n' 'artifact linkage unavailable; matching same-session compaction items only' >&2
  while IFS= read -r -d '' REQUEST; do
    jq -e --arg after "$TRIGGER_AT" --arg session "$SESSION_ID" \
      '(.sent.sessionId == $session and .sent.timestamp > $after)
       and any(.sent.body.input[]?; .type == "compaction")' "$REQUEST" >/dev/null \
      && { MATCHES=$((MATCHES + 1)); printf '%s\n' "$REQUEST"; jq -c '.received.summary | {status,usage:(.payload.usage | {input_tokens,output_tokens,total_tokens,input_tokens_details})}' "$REQUEST"; }
  done < <(find "$SESSION_DIR" -maxdepth 1 -type f -name '*.json' -print0)
fi
test "$MATCHES" -gt 0
```

The matching opaque item can contain `<redacted>` encrypted content. Reuse is
wire/lifecycle evidence; it does not reveal which facts survived.

## Sent-body limits

Sent message text, instructions/system strings, and tool definitions are
sanitized/truncated. Received assembled content and function arguments are the
useful fields for tool-call diagnosis. Full runtime prompt text or individual
stream ordering may be unavailable. App logs may retain some request or abort
evidence; the source logging service describes policy but cannot recover dropped
content or frames.
