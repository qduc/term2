**Implementation Plan**

Implement `/handoff` as an internal workflow, not as simulated `/copy`, `/clear`, or `/model` commands. The workflow will capture the last assistant response from in-memory messages, clear the current conversation, optionally open the existing model selector, then send a new prompt.

**Files To Edit**

1. [source/hooks/use-app-commands.ts](source/hooks/use-app-commands.ts)
  - Symbols:
    - `UseAppCommandsProps`
    - `getLastFinalAssistantText`
    - `useAppCommands`
    - new helper likely `createHandoffSlashCommand`
  - Purpose:
    - Add/clean `/handoff` command.
    - Capture last assistant text directly from `messages`.
    - Start the handoff workflow through `onHandoff(capturedText)`.
    - Do not call `/copy`.
    - Do not touch clipboard.

2. [source/app.tsx](source/app.tsx)
  - Symbols:
    - `HandoffStage`
    - `HandoffState`
    - `handleHandoff`
    - `handleSubmit`
    - model-selection completion/cancel handling
    - `clearConversationAndRefreshBanner`
  - Purpose:
    - Own the workflow state machine because `App` owns conversation clearing, model selection mode, runtime settings, and message submission.
    - Clear conversation once at handoff start.
    - Ask user whether to change model.
    - If yes, open existing `model_selection`.
    - After model selection, send `Implement this:\n\n${capturedText}`.
    - If no, send immediately.

3. [source/hooks/use-app-commands.test.ts](source/hooks/use-app-commands.test.ts)
  - Purpose:
    - Update/add tests for slash command behavior.
    - Verify `/handoff` captures assistant text internally and does not use clipboard.
    - Verify no assistant message produces a system message and does not clear.

4. Add or update an App-level test if an existing test harness supports it.
  - Candidate files to inspect during execution:
    - [source/app.tsx](source/app.tsx)
    - existing app tests if present, located via `rg -n "render\\(<App|handleSubmit|handoff" source test`
  - Purpose:
    - Cover workflow behavior that `use-app-commands.test.ts` cannot observe: confirmation, model-selection continuation, and final submitted prompt.

**Interface Changes**

1. `UseAppCommandsProps`
  - Keep or add:

```ts
onHandoff?: (capturedText: string) => void;
```

- No clipboard dependency should be added.
- No slash command dispatch API should be introduced.

2. `SlashCommand`
  - No type change needed.
  - `/handoff` does not need `expectsArgs` or `completion`.

3. `HandoffState`
  - Prefer explicit workflow state:

```ts
type HandoffStage = 'confirm_model' | 'selecting_model';

interface HandoffState {
  capturedText: string;
  stage: HandoffStage;
}
```

- Use `capturedText`, not `copiedText`, because clipboard is not part of the flow.

4. Optional model selection completion abstraction
  - If the existing model selector remains command-backed, no public interface change is required.
  - If adding a cleaner internal helper, keep it local to `App`:

```ts
const openHandoffModelSelection = () => {
  setInput('/model ');
  setMode('model_selection');
  setTriggerIndex(MODEL_CMD_TRIGGER.length);
};
```

**Data Flow**

1. User enters `/handoff`.
2. `useAppCommands` resolves the command and runs its action.
3. `/handoff` calls `getLastFinalAssistantText(messages)`.
4. If no assistant text exists:
  - Add system message: `No assistant response available to hand off.`
  - Return `true`.
  - Do not clear conversation.
  - Do not start workflow.
5. If assistant text exists:
  - Call `onHandoff(capturedText)`.
  - Return `true`.
6. `App.handleHandoff(capturedText)`:
  - Call `clearConversationAndRefreshBanner()`.
  - Store `handoffRef.current = { capturedText, stage: 'confirm_model' }`.
  - Add system message asking: `Change model before handoff? (y/N)`.
7. User response is intercepted in `handleSubmit` while `handoffRef.current` exists.
8. If stage is `confirm_model`:
  - `y` or `yes`: set stage to `selecting_model`, open existing model selector with `/model ` trigger.
  - `n`, `no`, empty, or any non-yes response: clear handoff state and call `sendUserMessage({ text: composeHandoffPrompt(capturedText) })`.
9. If stage is `selecting_model`:
  - Model selector submits text like `model-id --provider=provider-id`.
  - Parse with `parseModelProviderArg`.
  - Validate provider if needed using `getProvider(provider)`.
  - Apply settings:
    - `settingsService.set('agent.model', modelId)`
    - `applyRuntimeSetting('agent.model', modelId)`
    - if provider exists:
      - `settingsService.set('agent.provider', provider)`
      - `applyRuntimeSetting('agent.provider', provider)`
  - Clear handoff state.
  - Send `Implement this:\n\n${capturedText}`.
10. Final message is sent as a normal user message in a new conversation/session.

**Implementation Steps**

1. Baseline before edits after exiting Plan Mode:
  - Run `git status --short`.
  - Note existing dirty files.
  - Run focused baseline tests:

```bash
npm run test:verbose -- source/hooks/use-app-commands.test.ts
```

- If App/InputBox workflow tests are changed, also baseline:

```bash
npm run test:verbose -- source/components/InputBox.test.tsx
npm run test:verbose -- source/hooks/use-model-selection.test.tsx
```

2. In [source/hooks/use-app-commands.ts](source/hooks/use-app-commands.ts):
  - Add or clean a dedicated `createHandoffSlashCommand`.
  - Use `getLastFinalAssistantText(messages)` directly.
  - Remove any clipboard/copy behavior from `/handoff`.
  - Do not call the `/copy` command.
  - Prefer not to call `clearConversation()` inside `useAppCommands`; let `App.handleHandoff` own clearing so the workflow is centralized.
  - Command behavior:

```ts
const text = getLastFinalAssistantText(messages);
if (!text) {
  addSystemMessage('No assistant response available to hand off.');
  return true;
}

onHandoff?.(text);
return true;
```

3. In [source/app.tsx](source/app.tsx):
  - Rename handoff state field from `copiedText` to `capturedText`.
  - Move conversation clearing into `handleHandoff`.
  - In `handleHandoff`:
    - call `clearConversationAndRefreshBanner()`;
    - set `handoffRef.current`;
    - add system prompt asking whether to change model.
  - Add a local helper:

```ts
const composeHandoffPrompt = (capturedText: string) => `Implement this:\n\n${capturedText}`;
```

- Add a local helper for sending and clearing:

```ts
const sendHandoffPrompt = async (capturedText: string) => {
  handoffRef.current = null;
  setInput('');
  await sendUserMessage({ text: composeHandoffPrompt(capturedText) });
};
```

- Update `handleSubmit` interception:
  - Ignore approval/rejection paths first as currently done.
  - If `handoffRef.current?.stage === 'confirm_model'`, interpret answer.
  - If yes, set `handoff.stage = 'selecting_model'` and open model selector.
  - If no/anything else, send handoff prompt.
  - If `selecting_model`, parse selected model string, apply runtime settings, then send handoff prompt.
- Keep the model selection implementation using the existing `/model ` trigger unless a cleaner callback API is introduced.

4. Handle model selector cancel/escape deliberately.
  - Current dirty code appears to auto-send when `mode` returns to `text`.
  - Decide and encode one behavior. Recommended default:
    - Escape/cancel means “skip model change and continue handoff.”
  - Guard against accidental sends:
    - Only auto-send on `selecting_model -> text` if `handoffRef.current` is still present and the input is empty or still `/model `.
    - Avoid double-send by clearing `handoffRef.current` before calling `sendUserMessage`.

5. Provider validation.
  - If the submitted model selection includes a provider, validate `getProvider(provider)`.
  - If invalid:
    - Add system message: `Error: Unknown provider '${provider}'`.
    - Keep handoff state in `selecting_model` or abort. Recommended default: keep state and reopen model selector, because the handoff is not complete.
  - If no `modelId` is parsed:
    - Treat as cancel/skip and send with current model, or keep selector open.
    - Recommended default: if the user submitted no model from selector, skip model change and continue.

6. Tests in [source/hooks/use-app-commands.test.ts](source/hooks/use-app-commands.test.ts):
  - Add/update tests:
    - `/handoff` with no assistant response adds `No assistant response available to hand off.`
    - `/handoff` with assistant response calls `onHandoff` with the exact text.
    - `/handoff` does not call `clearConversation` directly if clearing is moved to `App`.
    - `/handoff` returns `true`.
    - contiguous bot message behavior is inherited from `getLastFinalAssistantText`.

7. App-level tests:
  - Add tests only if there is an existing practical harness.
  - Scenarios to cover:
    - `/handoff` starts workflow, clears conversation, and asks model question.
    - Answer `no` sends `Implement this:\n\n...`.
    - Answer `yes` opens model selector.
    - Selecting model applies `agent.model`/`agent.provider` and sends prompt.
    - Escape from model selector skips model change and sends prompt once.
  - If App-level testing is too heavy, cover pure pieces and InputBox/model-selection behavior with existing focused tests, and document the manual gap.

8. Run validation after edits:
  - Always rerun the baseline command:

```bash
npm run test:verbose -- source/hooks/use-app-commands.test.ts
```

- If `App` or model selection flow changed, run:

```bash
npm run test:verbose -- source/hooks/use-model-selection.test.tsx
npm run test:verbose -- source/components/InputBox.test.tsx
```

- If broad input-mode behavior changed, run:

```bash
npm run test:verbose -- source/hooks/use-slash-commands.test.ts
```

- Run formatting on changed files:

```bash
npx prettier --write source/hooks/use-app-commands.ts source/hooks/use-app-commands.test.ts source/app.tsx
```

**Edge Cases**

1. No assistant response:
  - Do not clear.
  - Do not start workflow.
  - Show system message.

2. Assistant response is split across contiguous bot messages:
  - Use existing `getLastFinalAssistantText` behavior.

3. Clipboard unavailable:
  - Irrelevant. `/handoff` never touches clipboard.

4. User answers `yes`, `y`, `YES`, or padded whitespace:
  - Treat as yes.

5. User answers `no`, `n`, empty, or anything else:
  - Treat as no and continue with current model.

6. User cancels model selection with Escape:
  - Recommended: skip model change and send handoff prompt once.

7. User selects model with provider:
  - Apply both model and provider.

8. Invalid provider:
  - Show error and do not send until resolved, or skip provider. Recommended: show error and keep handoff pending.

9. `sendUserMessage` fails:
  - Existing conversation error handling should handle this.
  - Ensure handoff state is cleared before or after send consistently. Recommended: clear before send to avoid duplicate submissions on retries/renders.

10. User starts `/handoff` while processing or waiting for approval:
- Current input handling likely prevents normal command execution during approval/processing. Do not add special behavior unless tests show a gap.

**Acceptance Criteria**

1. `/handoff` captures the latest assistant response from app state, not the clipboard.
2. `/handoff` does not call or simulate `/copy`, `/clear`, or `/model`.
3. The previous conversation is saved/reset through the same clear path used by `/clear`.
4. The user is asked whether to change model before the handoff prompt is sent.
5. Choosing no sends exactly:

```text
Implement this:

[captured assistant text]
```

6. Choosing yes opens the existing model selector.
7. Selecting a model updates runtime model settings and then sends the handoff prompt.
8. Canceling model selection has deterministic behavior and does not double-send.
9. Focused tests pass.
10. Existing `/copy`, `/clear`, and `/model` behavior remains unchanged.

**Assumptions**

1. `/handoff` should not overwrite the system clipboard.
2. The handoff prompt should be sent as a normal user message in a new conversation.
3. If the user does not explicitly say yes to changing model, the current model is used.
4. Escape from model selection means “continue without changing model,” not “abort handoff.”
5. The existing model selector can be reused through `setInput('/model ')`, `setMode('model_selection')`, and `setTriggerIndex(MODEL_CMD_TRIGGER.length)` for the first implementation.
