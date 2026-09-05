---
name: provider-traffic
description: Inspect provider-traffic JSON artifacts with jq when debugging provider/model requests, responses, errors, tool calls, streaming, usage, or compaction reuse. Use targeted projections and branch on the recorded transport shape.
---

# Provider traffic

Provider traffic is the record of the sanitized body sent to a provider and the
assembled response recorded by the logger. It is the right evidence for the
wire exchange, not for the full prompt or the application's later effect.

## Files and identity

Linux traffic is under `~/.local/state/term2-nodejs/logs/provider-traffic/`;
macOS uses `~/Library/Logs/term2-nodejs/logs/provider-traffic/`. Each day has
an `index.jsonl` and session directories:

```text
<root>/<YYYY-MM-DD>/index.jsonl
<root>/<YYYY-MM-DD>/<HH-MM-SS_first5-session-id>/<HH-MM-SS.mmmZ_first5-request-id>.json
```

`index.jsonl` is one index object per line. A request `.json` is one
pretty-printed `{sent,received}` object; parse the whole file with `jq`, never
line-by-line and never with `cat`. Find the session from
`firstUserMessagePreview`, then use the request's full `sent.requestId` and
`sent.sessionId` for correlation. The index is a locator, not a second copy of
each request to count.

```bash
D=~/.local/state/term2-nodejs/logs/provider-traffic
jq -c 'select(.firstUserMessagePreview | test("keyword"; "i"))
  | {sessionDir,requestCount,latestModel,firstUserMessagePreview}' \
  "$D/2026-09-05/index.jsonl"
F="$D/2026-09-05/<sessionDir>/<request-file>.json"
jq -c '{sent:(.sent|{requestId,sessionId,timestamp,provider,model,mode}),
  received:(.received|{requestId,sessionId,timestamp,summary:(.summary|{transport,status,wireShape})})}' "$F"
```

## Choose the payload shape first

Inspect `.received.summary.transport` and `.received.summary.wireShape` before
choosing a path. A missing `jq` path exits successfully and prints `null`.

- `transport: "websocket"` (the Codex lane) has no `wireShape`; its normalized
  payload uses Chat Completions-style `choices[0].delta`.
- `wireShape: "chat_completions"` uses `choices[0].delta`.
- `wireShape: "responses"` uses `output[]` items (`message`, `reasoning`, and
  `function_call`) and has no `choices` key.
- `transport: "json"` can carry either recorded wire shape; inspect it rather
  than assuming.

Use the assembled tool arguments and response text in the summary. Individual
chunks from a completed normalized summary are not retained there. Aborted or
failed recordings may contain only partial data or no payload. Shape-specific
timelines and bounded projections are in [`references/recipes.md`](references/recipes.md).

## Evidence boundaries

Inspect these fields for a bounded diagnosis:

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
jq -c '.received.summary.payload.usage
  | {input:(.input_tokens // .prompt_tokens // null),
     output:(.output_tokens // .completion_tokens // null),
     cached:(.input_tokens_details.cached_tokens // .prompt_tokens_details.cached_tokens // null),
     total:(.total_tokens // null)}' "$F"
```

Usage attribution can contain a very large per-item map. Select scalar totals
and cache fields; do not dump `.usage.attribution` unless one item is needed.
HTTP status, `errorFrames`, malformed/unknown frames, and a missing `.received`
summary are separate failure signals.

Traffic bodies are sanitized: sent text, instructions/system strings, and tool
definitions are truncated. Received assembled content and function arguments
are retained for this log's purpose. Full runtime prompt text or individual
stream ordering may be unavailable. App logs may retain some request or abort
evidence; source describes logging policy but cannot recover dropped content or
frames. Treat app debug logs as potentially containing raw encrypted reasoning.
Provider traffic replaces `encrypted_content` and Chat Completions
`reasoning_details[].data` with `<redacted>`; that marker proves the field was
present, while a missing field does not.

For compaction, an HTTP 200 trigger is insufficient evidence. Capture the
trigger request's session and timestamp, then verify a later request in the
same session sends a `type: "compaction"` input item. If an artifact ID is
recorded, match that ID; a same-session item without an ID link only proves
that some later compaction occurred. The item is opaque and commonly contains
`encrypted_content: "<redacted>"`; reuse proves transport/lifecycle, not
semantic fidelity. Local app timestamps and persisted/wire UTC still need
conversion when joining this evidence.

Do not infer one session from an app `correlationId`: it may span multiple
model/client activities. Join on request/session IDs and nearby converted
timestamps, then inspect the exact envelope. Do not turn snapshot counts from a
log audit into permanent constants.
