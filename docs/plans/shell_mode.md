Plan: Direct Shell Input Mode

Summary

Add a transient direct-shell input mode available from every operating mode. A leading `!` switches the
composer into shell mode, where the prefix is removed and the next submitted command runs directly. Shell
commands and outputs are shown in the conversation and recorded as context for the agent.

Key Behaviors

- A leading `!`: Enter shell mode and remove the prefix from the composer
- Shell mode: Input executed directly as shell commands via child_process.exec()
- After a command completes: Show the command and output, record shell context, and return to normal input
- Empty shell input: Escape or Backspace returns to normal input
- Context injection: Shell history is auto-injected into conversation context (no confirmation)
- Visual: Prompt changes from `❯` (normal) to a red `!` (Shell)

Relevant Files

The existing shell execution and conversation-message utilities are reused; the
input, shell-session, and application wiring provide the transient mode.

2. source/app.tsx

- Use transient shell state and enter/exit callbacks from the shell interaction session
- Route shell submissions directly in every operating mode
- Exit shell mode and flush context after each completed command
- Pass shell state and callbacks only to the input surface

3. source/components/InputBox.tsx

- Accept `isShellMode` plus shell enter/exit callbacks
- Recognize a leading `!`, remove it from the composer, and enter shell mode
- Use a red `!` prompt while in shell mode; Escape or Backspace exits on empty input

4. source/components/Banner.tsx

- Keep shell mode out of the operating-mode pill

5. source/components/StatusBar.tsx

- Keep shell mode out of the operating-mode status

6. source/components/BottomArea.tsx

- Pass shell state and callbacks through to InputBox

7. source/hooks/use-conversation.ts

- Add addShellMessage(command, output, exitCode) function
- Shell messages use existing CommandMessage type with sender: 'command'

8. source/services/conversation-store.ts

- Add method addShellContext(historyText: string) to inject shell history as user message

Data Flow

Shell Command Execution

User types command → handleSubmit → executeShellCommand()
→ Add to shellHistory → addShellMessage() → Display in MessageList

Shell Completion

Command completion → isShellMode = false → Format shellHistory as text
→ conversationStore.addShellContext() → Clear shellHistory

Context Format

[Previous Shell Session]
$ ls -la
total 48
drwxr-xr-x 10 user staff ...
Exit: 0

$ git status
On branch main
Exit: 0

Validation

Cover prefix recognition, prompt rendering, empty-input exit, direct execution
across operating modes, context recording, and return to normal mode after
completion with colocated tests.

Visual Summary

| Mode         | Prompt    | Banner         | StatusBar |
| ------------ | --------- | -------------- | --------- |
| Normal input | ❯ (blue)  | Current mode   | Current mode |
| Shell input  | ! (red)   | Current mode   | Current mode |
