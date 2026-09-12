---
title: Sessions & Resumption
description: Resuming, rewinding, forking, and inspecting conversation history.
---

term2 persists every session using append-only event streams. This ensures work is never lost across terminal closes, network disconnects, or crashes.

## Resuming Sessions

### Resuming the Latest Session

To pick up exactly where you left off in the current project directory:

```bash
term2 --resume
# or shorthand:
term2 -R
```

In the interactive TUI, run `/resume` to open the interactive session selector.

### Listing Past Sessions

To list saved sessions for the current workspace with timestamps, turn counts, and summaries:

```bash
term2 --resume ls
```

### Resuming a Specific Session

```bash
term2 --resume <conversation-id>
```

## Forking a Session (`--fork`)

Forking creates an independent branch of an existing conversation. Changes and new turns in the forked session will not affect the original session:

```bash
term2 --resume <conversation-id> --fork
```

Or fork the most recent session:

```bash
term2 --resume --fork
```

## Time-Travel Rewind (`/rewind`, `/undo`, `/retry`)

term2 provides granular control over conversation history:

- **Interactive Rewind Picker (`/rewind`)**: Opens a menu detailing previous turns and modified files so you can inspect discards before confirming.
- **Undo (`/undo`)**: An alias for `/rewind edit`. Discards subsequent turns and places the selected user prompt back into the input composer for editing.
- **Retry Turn (`/retry`)**: An alias for `/rewind resend`. Discards subsequent turns and immediately re-submits the last prompt to the model.
- **Retry Failed Turn (`/retry-turn`)**: Retries only the last turn that the provider failed to complete (for example, after a network error or rate limit).
- **Retry Tool (`/retry-tool`)**: Re-runs the last failed or timed-out tool call without discarding any conversation context.

## Handoff (`/handoff`)

To pass the assistant's final response into a new session or switch to another model:
- Run `/handoff` to capture and pass the latest assistant response directly to the handoff flow.
