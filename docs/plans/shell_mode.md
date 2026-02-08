Plan: Shell Mode Toggle for Lite Mode

Summary

Add a "Shell mode" toggle to Lite mode. Pressing Shift+Tab switches between "Ask" mode (AI chat) and
"Shell" mode (direct shell commands). Shell commands and outputs accumulate and are silently injected into
AI context when switching back to Ask mode.

Key Behaviors

- Shift+Tab in Lite mode: Toggle Ask ↔ Shell mode
- Shift+Tab outside Lite mode: Toggle Edit mode (existing behavior)
- Shell mode: Input executed directly as shell commands via child_process.exec()
- Context injection: When returning to Ask mode, shell history auto-injected into conversation context (no
  confirmation)
- Visual: Prompt changes from > (Ask) to $ (Shell); Banner/StatusBar show mode

Files to Modify

1. source/utils/execute-shell.ts (NEW)

Extract shell execution logic into reusable utility:
export interface ShellExecutionResult {
stdout: string;
stderr: string;
exitCode: number | null;
timedOut: boolean;
}
export async function executeShellCommand(command: string, options?: {...}): Promise<ShellExecutionResult>

2. source/app.tsx

- Add state: isShellMode (boolean), shellHistory (array of {command, output, exitCode})
- Modify Shift+Tab handler (lines 354-359):
- If liteMode: toggle isShellMode
- Else: toggle Edit mode (existing)
- Modify handleSubmit (line 361+):
- If isShellMode && liteMode: execute command directly, add to shellHistory, display result
- On mode switch to Ask: inject history into conversation store, clear history
- Pass isShellMode prop down to InputBox, Banner, StatusBar

3. source/components/InputBox.tsx

- Accept new prop isShellMode?: boolean
- Change prompt character based on mode:
  isShellMode ? <Text color="green">$ </Text> : <Text color="blue">{'\u276F'} </Text>

4. source/components/Banner.tsx

- Accept new prop isShellMode?: boolean
- Show mode pill:
- liteMode && isShellMode: "SHELL" pill (yellow #ca8a04)
- liteMode && !isShellMode: "LITE" pill (green, existing)

5. source/components/StatusBar.tsx

- Accept new prop isShellMode?: boolean
- Show "Shell" or "Ask" indicator when in lite mode

6. source/components/BottomArea.tsx

- Pass isShellMode prop through to InputBox and StatusBar

7. source/hooks/use-conversation.ts

- Add addShellMessage(command, output, exitCode) function
- Shell messages use existing CommandMessage type with sender: 'command'

8. source/services/conversation-store.ts

- Add method addShellContext(historyText: string) to inject shell history as user message

Data Flow

Shell Command Execution

User types command → handleSubmit → executeShellCommand()
→ Add to shellHistory → addShellMessage() → Display in MessageList

Mode Switch (Shell → Ask)

Shift+Tab → isShellMode = false → Format shellHistory as text
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

Implementation Order

1. Create execute-shell.ts - Extract execution logic from tools/shell.ts
2. Update app.tsx - Add state, modify handlers, mode toggle logic
3. Update InputBox.tsx - Prompt character change
4. Update Banner.tsx & StatusBar.tsx - Mode indicators
5. Update BottomArea.tsx - Pass props
6. Update use-conversation.ts - Shell message handling
7. Update conversation-store.ts - Context injection method
8. Write tests - Unit tests for execute-shell, integration tests for mode toggle

Visual Summary

| Mode         | Prompt    | Banner         | StatusBar |
| ------------ | --------- | -------------- | --------- |
| Ask (Lite)   | > (blue)  | LITE (green)   | Ask       |
| Shell (Lite) | $ (green) | SHELL (yellow) | Shell     |
