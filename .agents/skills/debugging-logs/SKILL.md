---
name: debugging-logs
description: Where this app writes its app logs and provider traffic logs on each platform, and how to query them without reading whole files. Use when inspecting a real run's behavior, debugging provider streaming or wire frames, or when asked what the app logged.
---

# Log Files

App logs are JSONL. Provider-traffic request files are single pretty-printed
JSON objects (`.json`); only `<day>/index.jsonl` is line-oriented. Both can be
large. Log roots by platform:

| | App logs | Provider traffic |
| --- | --- | --- |
| Linux | `~/.local/state/term2-nodejs/logs/` | `~/.local/state/term2-nodejs/logs/provider-traffic/` |
| macOS | `~/Library/Logs/term2-nodejs/logs/` | `~/Library/Logs/term2-nodejs/logs/provider-traffic/` |

For provider traffic, always query with `jq` for the fields you need rather than
reading whole files. Each request file is one object with two top-level keys,
`sent` and `received`, so every path starts from one of those:

```bash
jq '.received.summary.unknownFrames' <file.json>
jq '.received.summary.payload' <file.json>
```

The `provider-traffic` skill covers finding the right session and request fast.

## Reading a received summary

Check `summary.transport` first — it decides whether `wireShape` exists at all:

- `websocket` — `wireShape` is **not set**. `summarizeWebsocketResponse` never
  assigns it. The payload is `{choices, id, usage}`.
- `sse` — `wireShape` is set (`provider-traffic.ts:693`).
- `json` (non-streaming body) — `wireShape` is set (`provider-traffic.ts:411`).

This matters because the websocket lane is the busy one. Over 3,000 recent
artifacts: 1,531 `websocket` with no `wireShape` (all Codex), 1,430 `sse`
carrying `chat_completions`, 25 `json`. An agent that reaches for `wireShape`
first gets `null` on the majority of real files.

Where `wireShape` is set, the assembled `summary.payload` is rendered in that
shape:

- `chat_completions` — payload has `choices[0].delta`.
- `responses` — payload has `output: [...]` with `reasoning`, `message`, and
  `function_call` items, mirroring the Responses API. There is no `choices` key,
  so `choices`-shaped paths return `null` here.

Look before writing a path, or you will silently get `null` — a `jq` miss exits
0, so a wrong path reads as "the field is absent" rather than as an error:

```bash
jq '{transport: .received.summary.transport, wireShape: .received.summary.wireShape}' <file.json>

# Responses shape: did encrypted reasoning come back?
jq '.received.summary.payload.output[]? | select(.type == "reasoning")' <file.json>

# chat_completions and websocket shapes:
jq '.received.summary.payload.choices[0]' <file.json>
```

## Encrypted reasoning is redacted in provider traffic

Every `encrypted_content` value (and the Chat Completions
`reasoning_details[].data` equivalent) is replaced with the literal string
`<redacted>` before anything is written to the **provider-traffic** log
(`provider-traffic.ts:140`, `:208-225`).

`<redacted>` means the field *was* present and carried encrypted reasoning.
A missing field means it was never there. Do not read a redacted value as
evidence that reasoning failed to round-trip — that distinction is the whole
reason the marker is not an empty string.

**The app debug log is not covered by that redaction.** `agent-client.ts:820`
records the request `messages` verbatim under `provider.request.started`, and
the sanitizer on that path (`log-truncation.ts:80`) has no `encrypted_content`
branch. In practice this surfaces on the full-history rebuild after a chain
recovery, where reasoning items travel in the request array rather than as a
server-side reference. Treat app debug logs as containing raw ciphertext.
