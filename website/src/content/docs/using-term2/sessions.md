---
title: Sessions & Resumption
description: Resuming, rewinding, forking, and inspecting conversation history.
---

term2 persists sessions using append-only event streams. Saved conversation history supports resumption after a terminal closes or a process crashes; a tool interrupted before its outcome was recorded must be verified before retrying. Git checkouts and their worktrees share project-scoped session history.

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
- **Regenerate Turn (`/retry-turn`)**: Regenerates the entire latest user turn from its original prompt, replacing the old turn in the transcript.
- **Retry Tool (`/retry-tool`)**: Retries the last tool call by rewinding conversation history to that call. Check for effects that already occurred before retrying.

## Restart the Built CLI

Use `/restart` in the interactive terminal to reload the built CLI in place and resume the same saved conversation. This reloads the installed build; it does not install an update or compile source changes. Durably queued text is recovered from storage rather than submitted again automatically. Unsaved composer and queue-edit drafts are not part of that durable handoff; submit or save them before restarting.

- Requires POSIX Node with `process.execve` support (Node 24 recommended) and a built `dist/cli.js` entry. The general Node 20+ installation requirement does not guarantee restart support.
- Windows, Node flags/loaders, and non-empty `NODE_OPTIONS` are not supported. Unsupported launch contexts are refused with a manual resume command.
- Finish a foreground shell command or pending input confirmation before restarting.
- Live background shells and agents block `/restart`. Use `/restart stop` only when you consent to stopping that work; running processes are not transferred to the replacement runtime.
- Active workspace leases reset to their home scope. Model/provider, reasoning, profile, approval/sandbox settings, SSH target, and control-socket attachment are carried into the resume context, but this is not a snapshot of every live attachment or UI state.
- Pending images, skills, or other non-durable queued input cannot be handed off by this restart path; submit, edit, or explicitly discard that input first. Do not assume unsent attachments are preserved just because text is recoverable.

If automatic restart is refused or fails during shutdown, inspect the error and the printed manual resume/recovery command before continuing. Restart does not undo tool effects from the interrupted turn.

## Durable Session Goals

Set an outcome with `--goal` at launch or `/goal set <outcome>` in chat; optional criteria use `--goal-criteria` at launch or `--criteria` with `/goal set`. `/goal` shows the current goal, `/goal achieved` closes it, and `/goal abandon` abandons it. Goals persist across resume and rollover, and `/clear` retains them.

While a goal is active, the agent reports a `goal_check` before ending a turn. A valid `achieved` check that ends the turn closes the goal; blocked, deferred, or incomplete checks keep it active. Reminders are bounded, so an unresolved stop-check notice does not mean the goal was completed.

## Handoff (`/handoff`)

To pass the assistant's final response into a new session or switch to another model:
- Run `/handoff` to capture and pass the latest assistant response directly to the handoff flow.

## Continue Without the Terminal UI

Add a follow-up prompt after a session ID, or use `last` for the most recent session:

```bash
term2 --resume <conversation-id> "Summarize our progress"
term2 --resume last --json "What should we do next?"
term2 --resume <conversation-id> --fork "Explore an alternative"
```

These commands restore the saved history and append a new headless turn. Resuming preserves the session ID; `--fork` writes to a new session instead. Tool execution remains disabled unless you pass `--auto-approve`. A missing session exits with an error rather than silently starting a new conversation.
