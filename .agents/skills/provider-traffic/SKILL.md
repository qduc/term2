---
name: provider-traffic
description: Read provider traffic logs (the JSONL artifacts under provider-traffic/) efficiently with jq to debug LLM requests, errors, tool calls, and model responses. Use when the user is debugging a provider/model issue, an API error, wrong tool-call arguments, a streaming/transport problem, malformed SSE frames, or wants to inspect what was sent to / received from a provider. Use to find the right session and request fast without dumping huge files.
---

# Provider Traffic Log Reading

The provider/traffic log is the single source of truth for *what was actually sent to and received from a model provider*. Use it to debug HTTP errors, malformed streaming, wrong/missing tool calls, transport mismatches, and finish-reason surprises — instead of guessing from app logs.

## Rule 0 — never dump the whole file

Traffic files are large. **Always select specific fields with `jq`.** Never `cat` a request `.json` file. Target the one field you need, then expand only if it is insufficient.

## Layout

Log root by platform:

- **Linux**: `~/.local/state/term2-nodejs/logs/provider-traffic/`
- **macOS**: `~/Library/Logs/term2-nodejs/logs/provider-traffic/`

Structure:

```
`<root>/<YYYY-MM-DD>/index.jsonl                                  # daily index (ONE object per line — genuine JSONL)
<root>/<YYYY-MM-DD>/<HH-MM-SS_ssid>/                            # one dir per session (no per-session index)
<root>/<YYYY-MM-DD>/<HH-MM-SS_ssid>/<HH-MM-SS.mmmZ_rid>.json      # one request envelope per file
```

- A **request envelope file** (`.json`) holds a *single JSON object*, pretty-printed (2-space indent). It is **not** line-oriented. Parse the whole file: `jq '.sent' <file>`. Do **not** iterate lines. The extension is `.json` (single JSON value), **not** `.jsonl` — only `<day>/index.jsonl` is genuine JSON Lines.
- `index.jsonl` **is** true JSONL — one `DailySessionIndexEntry` per line.

### Critical parsing note

Per-request `.json` files are pretty-printed JSON objects. `jq -c '.field' file` works because jq parses the entire file as one value. They are **not** streamable line-by-line. If you see `jq: parse error: Unfinished JSON term at EOF at line 2`, you (or a tool) tried to parse one line — instead pipe the whole file to `jq`.

## Envelope schema

Each request file is `{ "sent": {...}, "received": {...} }`.

### `sent` (request sent to provider)

| field | meaning |
|---|---|
| `direction` | `"sent"` |
| `requestId` | full request UUID (filename suffix is its first 5 chars) |
| `timestamp` | ISO `2026-06-18T12:40:12.528Z` |
| `provider` / `model` | provider name + model |
| `modelClass?` / `modelWrapperClass?` | present only when classified |
| `sessionId` | conversation session; the session directory name is `<time>_<first 5 of sessionId>` |
| `mode` | e.g. `shell`, `default`; defaults to `unknown` |
| `headers?` | present only when captured |
| `body` | **sanitized** copy of the request body (see Limitations) |

### `received` (response summary recorded on completion)

| field | meaning |
|---|---|
| `direction` | `"received"` |
| `requestId`, `timestamp`, `provider`, `model`, `sessionId`, `mode` | mirror `sent` |
| `summary?` | parsed transport summary (absent only if logging failed) |
| `error?` | present when an unrecoverable logging/runtime error occurred |

### `received.summary`

| field | meaning |
|---|---|
| `transport` | `"json"` \| `"sse"` \| `"websocket"` \| `"text"` \| `"unknown"` — how the response was parsed |
| `status` | HTTP status code |
| `errorFrames[]` | provider error objects embedded in the stream/body |
| `malformedFrames[]` | `{raw,error}` — frames that failed to parse as JSON |
| `unknownFrames[]` | `{signature,count,firstRaw,lastRaw}` — SSE frames the parser didn't recognize |
| `payload?` | **normalized** representation of the assembled response (see below); absent when nothing was extracted |
| `fallbackBody?` | raw body when extraction produced nothing parseable (text transport, etc.) |

### `received.summary.payload` — the normalized response

The logger reassembles streaming chunks into one OpenAI-style object so JSON and SSE look identical:

```jsonc
{
  "id": "resp_…",                 // optional, assembled from the stream
  "usage": { … },                 // optional, from the last usage frame
  "choices": [{
    "finish_reason": "tool_calls", // optional: tool_calls | stop | length | …
    "delta": {
      "content": "assembled text",
      "reasoning": "assembled reasoning",
      "tool_calls": [ { "id": "call_…", "type": "function",
                        "function": { "name": "shell", "arguments": "<full args string>" } } ]
    }
  }]
}
```

Tool-call `function.arguments` is the **fully reassembled** argument string (chunks concatenated) — read the assembled value here, not individual SSE lines.

### `DailySessionIndexEntry` (one per line in `<day>/index.jsonl`)

```jsonc
{
  "sessionId": "…",
  "sessionDir": "12-39-39_e3e68",     // ← the directory name under the date folder
  "firstRequestAt": "…", "lastRequestAt": "…",
  "requestCount": 6,
  "firstUserMessagePreview": "…",    // ≤160 chars of the first user turn — great for locating a session
  "latestProvider": "…", "latestModel": "…", "latestMode": "…",
  "providersSeen": […], "modelsSeen": […], "modesSeen": […]
}
```

## Workflow — find the right request fast

1. **Locate the session.** The day is usually today. Find by first user message:
   ```bash
   jq -c 'select(.firstUserMessagePreview | test("keyword")) | {sessionDir,requestCount,latestModel,firstUserMessagePreview}' \
     ~/.local/state/term2-nodejs/logs/provider-traffic/2026-06-18/index.jsonl
   ```
   At minimum grab the date dir and the `sessionDir`.

2. **List that session's requests** (newest last). Just sizes to see how big each is:
   ```bash
   ls -la ~/.local/state/term2-nodejs/logs/provider-traffic/2026-06-18/<sessionDir>/
   ```
   Filenames are `<HH-MM-SS.mmmZ>_<first5-of-requestId>.json`. `evaluator_*` files come from the auto-approval/evaluator path.

3. **Scan all requests in the session for trouble** in one shot:
   ```bash
   for f in ~/.local/state/term2-nodejs/logs/provider-traffic/2026-06-18/<sessionDir>/*.json; do
     jq -rc '
       "\(.sent.timestamp) \(.sent.model) status=\(.received.summary.status)
        finish=\(.received.summary.payload.choices[0].finish_reason // "-")
        errs=\(.received.summary.errorFrames|length)
        tools=\((.received.summary.payload.choices[0].delta.tool_calls // [])|map(.function.name)|join(","))"' \
       "$f"
   done
   ```
   This prints one compact line per request — read the timeline, then zoom in.

## Common jq recipes

Set `F` to one request file, `D` to the date dir, `S` to the session dir.

```bash
F=~/.local/state/term2-nodejs/logs/provider-traffic/2026-06-18/12-39-39_e3e68/12-40-12.528Z_c1089.json

# What model/provider/mode for this request
jq -c '{provider,model,mode,modelClass,modelWrapperClass}' <<< "$(jq -c '.sent' "$F")"

# HTTP status + transport + finish reason
jq -c '.received.summary | {transport,status,finish:(.payload.choices[0].finish_reason // null)}' "$F"

# Provider error frames (non-empty ⇒ provider returned an error object)
jq -c '.received.summary.errorFrames' "$F"

# Malformed / unknown stream frames (non-empty ⇒ transport parsing problem)
jq -c '.received.summary | {malformed: .malformedFrames, unknown: .unknownFrames}' "$F"

# Assembled text content the model produced
jq -rc '.received.summary.payload.choices[0].delta.content // ""' "$F"

# Reasoning/thinking the model produced
jq -rc '.received.summary.payload.choices[0].delta.reasoning // ""' "$F"

# Tool calls the model requested (name + full arguments)
jq -rc '.received.summary.payload.choices[0].delta.tool_calls // []
       | map({name:.function.name, args:.function.arguments})' "$F"

# Token usage from the final frame
jq -c '.received.summary.payload.usage' "$F"

# Sent body shape: roles + tool names + presence of instructions/system/tools
jq -c '{hasInstructions: (.sent.body.instructions!=null), hasSystem: (.sent.body.system!=null),
        msgs:(.sent.body.messages // .sent.body.input // [])|map(.role),
        tools:(.sent.body.tools // [])|map(.function.name)}' "$F"

# Unrecoverable logging error for this request
jq -c '.received.error' "$F"

# What was the request timestamp / requestId (for correlating with app logs)
jq -c '{requestId:.sent.requestId, sentAt:.sent.timestamp, recvAt:.received.timestamp}' "$F"
```

### Cross-session searches

```bash
D=~/.local/state/term2-nodejs/logs/provider-traffic

# Every erroring request today: file -> status + error count
for f in $D/2026-06-18/*/*.json; do
  jq -rc 'select((.received.summary.errorFrames|length>0) or (.received.error!=null) or (.received.summary.status>=400))
          | "\(.sent.requestId) status=\(.received.summary.status) errs=\(.received.summary.errorFrames|length)"' \
          "$f" 2>/dev/null
done

# All tool calls of a given name across a session (find where the model did the wrong thing)
for f in $D/2026-06-18/<sessionDir>/*.json; do
  jq -rc --arg n "shell" \
    '(.received.summary.payload.choices[0].delta.tool_calls // []) | .[] | select(.function.name==$n)
     | "\(.id) \(.function.arguments)"' "$f"
done

# Search the daily index by provider/model/mode
jq -c 'select(.latestProvider=="codex") | {sessionDir,requestCount,latestModel,firstUserMessagePreview}' \
  $D/2026-06-18/index.jsonl
```

## Limitations — what this log will NOT give you

The sent body is **sanitized/truncated** (`sanitizeSentTrafficBody`), so do not use traffic logs as a verbatim record of prompt or tool content:

- Text parts in messages are truncated to `TRAFFIC_TEXT_LIMIT` (**100 chars**, with `[omitted N chars]`).
- `instructions` / `system` string values are truncated to 100 chars.
- Tool *definitions* (the schema sent to the model) are truncated.

Consequences for debugging:

- **Wrong/missing/empty tool-call arguments:** read them from `received.summary.payload.choices[0].delta.tool_calls[].function.arguments` — that is the **assembled, full** argument string (not truncated). Good for debugging arg-parsing or wrong-command bugs.
- **Full prompt / system prompt content:** NOT here. For verbatim prompt content, read the app log or the prompt-construction code path, not the traffic log.
- **Streaming ordering / individual chunks:** the log reassembles chunks; if you need exact SSE framing order, the raw stream is not retained — inspect `unknownFrames`/`malformedFrames` for parsing issues instead.
- **The model's text is stored assembled** under `.received.summary.payload.choices[0].delta.content` (truncation does not apply to received content — only sent text is truncated).

When the traffic log lacks the detail you need, say so explicitly and point to the app log (JSONL under `logs/`) or the relevant service (`source/services/logging/provider-traffic.ts` for the schema, `source/scripts/extract-provider-traffic.ts` for a batch extractor).

## When to use this skill

Reach for the traffic log when the bug is about *the model/provider exchange itself*: HTTP errors, `errorFrames`, malformed/unknown frames, finish reason `length`/`null`, missing or malformed tool calls, wrong transport classification, or "what did we actually send / get back". For app-logic bugs not involving the provider exchange, prefer app logs or code paths over this log.
