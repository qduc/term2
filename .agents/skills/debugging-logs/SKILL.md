---
name: debugging-logs
description: Where this app writes its JSONL app logs and provider traffic logs on each platform, and how to query them without reading whole files. Use when inspecting a real run's behavior, debugging provider streaming or wire frames, or when asked what the app logged.
---

# Log Files

App logs and traffic logs are JSONL and can be large. Log roots by platform:

| | App logs | Provider traffic |
| --- | --- | --- |
| Linux | `~/.local/state/term2-nodejs/logs/` | `~/.local/state/term2-nodejs/logs/provider-traffic/` |
| macOS | `~/Library/Logs/term2-nodejs/logs/` | `~/Library/Logs/term2-nodejs/logs/provider-traffic/` |

For provider traffic, always query with `jq` for the fields you need rather than reading whole files:

```bash
jq '.summary.unknownFrames' <file.jsonl>
jq 'select(.direction == "received") | .summary.payload' <file.jsonl>
```

## Reading a received summary

`summary.wireShape` tells you which API the response actually came from, and
the assembled `summary.payload` is rendered in that same shape:

- `responses` — payload has `output: [...]` with `reasoning`, `message`, and
  `function_call` items, mirroring the Responses API.
- `chat_completions` — payload has `choices[0].delta`.

Check the shape before writing a `jq` path, or you will silently get `null`:

```bash
jq 'select(.direction == "received") | {wireShape: .summary.wireShape, payload: .summary.payload}' <file.jsonl>

# Did encrypted reasoning come back on the Responses lane?
jq 'select(.direction == "received") | .summary.payload.output[]? | select(.type == "reasoning")' <file.jsonl>
```

## Encrypted reasoning is redacted, not absent

Every `encrypted_content` value (and the Chat Completions
`reasoning_details[].data` equivalent) is replaced with the literal string
`<redacted>` before anything is written to disk or to the debug log. The
ciphertext is never logged.

`<redacted>` means the field *was* present and carried encrypted reasoning.
A missing field means it was never there. Do not read a redacted value as
evidence that reasoning failed to round-trip — that distinction is the whole
reason the marker is not an empty string.
