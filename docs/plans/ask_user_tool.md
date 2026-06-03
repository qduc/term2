# Implementation Plan - Design a new 'ask_user' tool

Introduce an `ask_user` tool that allows the agent to ask clarifying questions when user requests are ambiguous or blockers are encountered. The CLI UI will display the question along with pre-defined multiple-choice options (the first being the agent's recommended choice), a "Type custom answer..." option, and a "Decline to answer" option.

`ask_user` is available in all modes, including lite, mentor, plan, and orchestrator. It does not mutate workspace or system state; it only pauses execution to collect clarification from the user.

## Design Decision: Re-purpose the Approval Flow

> [!IMPORTANT]
> The implementation leverages the SDK's built-in tool approval flow (`needsApproval: () => true`) to pause execution. Instead of traditional "Approve/Reject" options, a custom UI is presented showing the clarifying question and choices. Selecting a choice immediately continues the execution with the chosen response injected into the tool's execution result.
>
> **For `ask_user`, the approval answer is always `'y'`** — even for "Decline to answer." The user's response text is carried through an approval-continuation side channel. The model receives the response as a normal tool result, not as a tool failure.
>
> "Decline to answer" returns the literal tool result text `User decline to answer`.

## Proposed Changes

### Tool Definitions

#### [NEW] `source/tools/ask-user.ts`
- Create the Zod schema:
  ```typescript
  const askUserSchema = z.object({
    question: z.string().min(1).describe('The clarifying question to ask the user.'),
    options: z.array(z.string().min(1)).max(8).optional().describe('Optional list of predefined choices for the user to choose from. The first option should be the recommended one.'),
  });
  ```
- Implement `createAskUserToolDefinition(getAskUserAnswer: (callId?: string) => string | undefined)`.
- Set `needsApproval: () => true`.
- Implement `execute` to consume the answer from the injected getter, passing the tool call ID if the SDK exposes it to tool execution details/context.
  - **Fallback:** If `getAskUserAnswer(callId)` returns `undefined`, return `"User did not provide an answer."`.
  - If the user selected "Decline to answer", return exactly `User decline to answer`.
- Implement `formatAskUserCommandMessage` to display the question and the user's selected answer in the chat history.

#### [NEW] `source/tools/ask-user.test.ts`
- Add unit tests for tool definition validation, custom message formatting, and `execute()` resolution (including the undefined fallback).

#### [MODIFY] `source/tools/tool-names.ts`
- Export constant `export const TOOL_NAME_ASK_USER = 'ask_user';`.

### Agent Registration

#### [MODIFY] `source/agent.ts`
- Import `createAskUserToolDefinition` and `TOOL_NAME_ASK_USER`.
- Add `getAskUserAnswer?: (callId?: string) => string | undefined` to the dependency interface of `getAgentDefinition`.
- If the `getAskUserAnswer` dependency is provided, push `createAskUserToolDefinition(getAskUserAnswer)` to every agent tools registry:
  - Standard/full mode tools.
  - Lite mode tools.
  - Mentor and plan mode tool sets, through the existing mode-aware standard/lite branches.
  - Orchestrator mode tools.
- Register `formatAskUserCommandMessage` via the existing `registerToolFormatters(tools)` flow in each branch.

### Prompt Guidance

#### [MODIFY] `source/prompts/*` / prompt construction
- Add explicit tool-use guidance to the base prompt or a shared fragment:
  - Use `ask_user` only when a missing user decision blocks correct progress or when proceeding would require guessing a materially important requirement.
  - Prefer continuing with stated assumptions for low-risk ambiguity; do not ask needless questions.
  - Provide concise options when possible; the first option must be the recommended/default choice.
  - Include "Decline to answer" only through the UI; do not add it to the tool `options` array.
  - If the tool result is `User decline to answer`, proceed using the safest reasonable default and state the assumption in the final response.
- Ensure this guidance applies in all modes, including lite, plan, mentor, and orchestrator.

### SDK Client & Session Integration

#### [MODIFY] `source/lib/openai-agent-client.ts`
- Define private storage scoped by tool call ID, not a single loose string:
  ```typescript
  #askUserAnswersByCallId = new Map<string, string>();
  ```
- Expose methods:
  ```typescript
  setAskUserAnswer(callId: string, answer: string): void;
  consumeAskUserAnswer(callId?: string): string | undefined;
  clearAskUserAnswers(): void;
  ```
- Pass a getter into `getAgentDefinition` that consumes by call ID from the execution context/details if available. If the SDK does not expose call ID to `execute`, fall back to consuming only when exactly one pending answer exists; otherwise return `undefined` to avoid leaking a stale answer into the wrong tool call.
- Clear pending ask-user answers in `abort()`, `clearConversations()`, provider/model refresh paths, and any reset-like path already used to discard pending run state.

#### [MODIFY] `source/services/conversation-session.ts`
- At the top of the `['continue']` method (before `this.approvalFlow.prepareContinuation(answer, rejectionReason)`), check if the pending tool is `ask_user`.
- If so, extract the pending tool call ID from `this.approvalFlow.getPendingInterruption()` / `getCallIdFromObject(...)`.
- Normalize the selected answer:
  - Predefined option or typed custom answer: use the selected/typed text.
  - Decline option: use exactly `User decline to answer`.
- Call `this.agentClient.setAskUserAnswer(callId, normalizedAnswer)` so the tool's `execute()` can consume it.
- Clear the scoped answer in a `finally` block after continuation completes or fails. This prevents a failed/aborted approval continuation from leaking an answer into a later `ask_user` call.
- **The `answer` for `ask_user` is always `'y'`.** Do not use `'n'`; that would record an aborted approval and present the model with a failure message instead of the user's response.
- Add session tests covering:
  - A selected option reaches the `ask_user` tool result as a normal successful result.
  - A custom typed answer reaches the tool result.
  - Decline reaches the tool result exactly as `User decline to answer`.
  - An aborted or failed continuation does not leave a stale answer for a subsequent `ask_user` call.

### UI & Component Layout

#### [MODIFY] `source/components/ApprovalPrompt.tsx`
- Change `onApprove` prop type to `onApprove: (answer?: string) => void`.
- Update `BottomAreaProps.onApprove` to the same `(answer?: string) => void` signature so selected option text is not dropped at the component boundary.
- Support rendering a custom layout for `TOOL_NAME_ASK_USER`.
- Parse arguments for `question` and `options`.
- Render options list:
  - If `options` array exists, display them, followed by "Type custom answer..." and "Decline to answer".
  - If `options` array does not exist, display "Type answer..." and "Decline to answer".
- **Keyboard navigation for `ask_user`:**
  - Up/Down arrows navigate across **all** options.
  - Enter selects the highlighted option and calls `onApprove(optionText)`.
  - **`y` and `n` shortcuts must be suppressed** when the pending tool is `ask_user` (they only make sense for binary Approve/Reject).
- If a predefined option is selected:
  - Call `onApprove(optionText)`.
- If "Decline to answer" is selected:
  - Call `onApprove('User decline to answer')`.
- If "Type answer..." or "Type custom answer..." is selected:
  - Call `onTypeAnswer()`.

#### [MODIFY] `source/components/BottomArea.tsx`
- Add `waitingForAskUserAnswer?: boolean` prop.
- Add `onTypeAnswer?: () => void` prop.
- Update `showApprovalPrompt` to include `&& !waitingForAskUserAnswer` so the approval prompt is hidden while the user is typing a custom answer.
- Update `showInput` to include `waitingForAskUserAnswer`:
  ```typescript
  const showInput = !showHandoffConfirm && !showLargeUncachedPrompt &&
    ((!isProcessing && !waitingForApproval) || waitingForRejectionReason || waitingForAskUserAnswer);
  ```
- Pass `promptLabel="Answer: "` to `InputBox` when `waitingForAskUserAnswer` is true.
- Forward `onTypeAnswer` to `ApprovalPrompt`.

#### [MODIFY] `source/hooks/use-conversation.ts`
- Add `waitingForAskUserAnswer` state (default `false`) and `setWaitingForAskUserAnswer` setter.
- Expose `onTypeAnswer` handler that sets `waitingForAskUserAnswer = true`.
- Ensure `waitingForAskUserAnswer` is reset to `false` in:
  - `applyServiceResult` when an `approval_required` event arrives (so a fresh prompt starts in option mode).
  - `handleApprovalDecision` (beginning and error paths).
  - `stopProcessing`.
  - `clearConversation`.
  - `undoToUserMessage`.

#### [MODIFY] `source/app.tsx`
- Update `handleApprove` to accept an optional answer and forward it:
  ```typescript
  const handleApprove = useCallback(async (answer?: string) => {
    await handleApprovalDecision('y', answer);
  }, [handleApprovalDecision]);
  ```
- In the `handleSubmit` function, add a branch **before** the `waitingForRejectionReason` check:
  ```typescript
  if (waitingForAskUserAnswer) {
    setWaitingForAskUserAnswer(false);
    setInput('');
    await handleApprovalDecision('y', value);
    return;
  }
  ```
  This branch must run before the `hasUserTurnContent` early return so an empty custom answer does not leave the UI stuck. If empty custom answers should be disallowed instead, enforce that explicitly in `InputBox` while `waitingForAskUserAnswer` is true.
- In the Escape-key `useInput` handler, add:
  ```typescript
  if (key.escape && waitingForAskUserAnswer) {
    setWaitingForAskUserAnswer(false);
    setInput('');
    return;
  }
  ```
  This lets the user cancel typed-answer mode and return to the option list.
- Pass `waitingForAskUserAnswer` and `onTypeAnswer` through to `BottomArea`.

### Message Formatting

#### [MODIFY] `source/tools/ask-user.ts` (continued)
- Register `formatAskUserCommandMessage` in the tool definition so the execution result renders properly in the message list.

## Verification Plan

### Automated Tests
- Run `npm run test:verbose -- source/tools/ask-user.test.ts` to verify validation, parsing, and fallback behavior.
- Run `npm run test:verbose -- dist/components/ApprovalPrompt.ask-user.test.js` (or equivalent) to cover:
  - Option list rendering with and without `options`.
  - Up/Down navigation across N options.
  - Enter selection calls `onApprove` with the correct text.
  - "Decline to answer" calls `onApprove('User decline to answer')`.
  - "Type custom answer..." triggers `onTypeAnswer`.
  - `y`/`n` keys are ignored for `ask_user`.
- Run focused `conversation-session` / `openai-agent-client` tests to cover the scoped answer bridge from `handleApprovalDecision('y', answer)` through SDK continuation into the successful `ask_user` tool result, including stale-answer cleanup after abort/error.
- Run prompt-constructor or agent-definition tests to verify `ask_user` is registered in standard, lite, plan, mentor, and orchestrator modes and that prompt guidance is included.
- Run `npm test` to ensure no regressions in other tools, services, or components.

### Manual Verification
- Run a CLI session (`npm run dev`), prompt the agent to ask a clarifying question.
- Verify options rendering, navigation, custom text input, Escape-to-cancel, and that the agent receives the answer as a normal tool result.
