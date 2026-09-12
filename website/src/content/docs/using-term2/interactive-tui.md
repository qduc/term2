---
title: Interactive TUI
description: Using the terminal user interface, prompt composer, queueing, and steering.
---

term2's interactive interface combines an input composer with real-time streaming, collapsible tool calls, and unified diff previews.

## The Prompt Composer

The composer supports multiline input, path completion, and command triggers:

- **Multiline text**: Press `Enter` to submit. In multi-line mode, paste or insert newlines as needed.
- **File & Path completion (`@`)**: Type `@` anywhere in the composer to open the interactive path completion menu. Search for files in the repository and press `Enter` to insert the path into your prompt.
- **Direct Shell Execution (`!`)**: When the composer is empty, type `!` to enter direct shell mode. The prompt turns red (`! `). The command executes directly in your shell and its output is captured into the conversation. To exit shell mode, press `Backspace` on an empty line or press `Escape`.
- **Slash Commands (`/`)**: Type `/` to open the slash commands menu with autocompletion.

## Mid-Turn Prompt Queueing & Steering

While the agent is actively executing a turn (generating responses or executing tools):

- **Steering (`Enter`)**: Type an instruction and press `Enter`. This delivers a real-time steering message at the next request boundary, redirecting the agent without restarting the turn.
- **Queueing Follow-Up Prompts (`Alt+Enter` / `Esc+Enter`)**: Press `Alt+Enter` (or `Esc` followed by `Enter`) to queue instructions to run after the active turn finishes.
- **Queue Editing**: When prompts are queued:
  - Press `Up` arrow while the input is empty to navigate queued items.
  - Press `e` or `Enter` to pull a queued item back into the editor for revision.
  - Press `d` to delete / retract a queued item.
  - Press `Escape` to cancel queue inspection.

## Interrupting In-Flight Generation

To safely interrupt a turn:
- Press `Escape` twice (**Double Escape**) while the composer is empty.
- The first Escape arms the interrupt and displays a confirmation hint; the second Escape within 2 seconds cancels generation and stops any running foreground commands.
- If the composer contains uncommitted text, the first Escape clears the composer buffer instead.

## Tool Approvals & Diffs

When the agent attempts to modify a file or run a command:
- **Diff Previews**: File changes show standard unified diff previews with added and removed lines.
- **One-Key Decisions**: Press `y` to approve, `n` to reject.
- **Rejection Reasons**: Pressing `n` prompts for an optional rejection reason (`Why? `), allowing you to explain why the action was rejected so the agent can adapt.
