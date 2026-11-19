---
title: Interactive TUI
description: Using the terminal user interface, prompt composer, queueing, and steering.
---

The terminal shows replies as they arrive. You can expand tool calls and view file changes as unified diffs. If a live reply overflows the viewport, `Page Up` / `Ctrl+↑` snapshots it while you read; `Page Down` / `Ctrl+↓` or `Escape` returns to live output.

## Terminal Status

On terminals that speak the OSC 7501 program-status protocol (Ghostty/libghostty, Rex, hc), term2 reports `idle`, `working` and `blocked` (waiting for a question or approval) so the terminal can show its state without screen scraping. Reports are sent only after the terminal answers the startup probe, so terminals without support see no extra bytes. Headless runs probe only when both stdin and stdout are terminals; piped or redirected runs send no escape sequences. An interactive exit clears the status, while a headless exit leaves `done` and a fatal error leaves `error`.

## The Prompt Composer

- **Multiline text**: Press `Enter` to submit. Use `Shift+Enter` to insert a newline in terminals that send a supported newline sequence, or paste multiline text.
- **File & Path completion (`@`)**: Type `@` anywhere in the composer to open the interactive path completion menu. Search for files in the repository and press `Enter` to insert the path into your prompt.
- **Direct Shell Execution (`!`)**: When the composer is empty, type `!` to enter direct shell mode. The prompt turns red (`! `). The command executes directly in your shell and its output is captured into the conversation. To exit shell mode, press `Backspace` on an empty line or press `Escape`.
- **Slash Commands (`/`)**: Type `/` to open the slash commands menu with autocompletion.

## Mid-Turn Prompt Queueing & Steering

- **Steering (`Enter`)**: Press `Enter` to send an instruction with the next model request in the current turn.
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
- If the composer contains uncommitted text, the first Escape shows a hint; the second clears the composer buffer instead.
- `Ctrl+C` clears a non-empty draft, or interrupts the active turn when the draft is empty. Press it again within 2 seconds to exit. `Ctrl+\\` exits immediately.

## Tool Approvals & Diffs

When the agent attempts to modify a file or run a command:
- **Diff Previews**: File changes show standard unified diff previews with added and removed lines.
- **Approval Choices**: Use the labelled choices shown in the prompt. Number keys can allow once or deny, but cannot grant persistent permission. Docker host-control approvals use `y` / `n` instead.
- **Rejection Reasons**: When a rejection reason prompt appears, explain why the action was rejected so the agent can adapt.
