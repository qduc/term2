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
