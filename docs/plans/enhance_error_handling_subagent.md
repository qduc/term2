**Implementation Plan**

1. Add shared retry metadata helper
   In [conversation-retry-policy.ts](source/services/conversation-retry-policy.ts:1), extract the reusable part of `decideRetry()` into something like:
   ```ts
   decideRecoverableModelRetry(error, attemptCount)
   ```
   It should return retry metadata only: `message`, `toolName`, `retryType`, `attempt`, `maxRetries`, or `no_retry`.

2. Preserve existing main-agent behavior
   Rewrite `decideRetry()` to call the new helper, then add the parent-specific fields it already returns today:
  - `hadStream`
  - `shouldInjectErrorContext`
  - `errorContextMessage`
  - `nextRunOptions`

   Existing `conversation-retry-policy.test.ts` should still pass unchanged.

3. Add focused policy tests first
   Extend [conversation-retry-policy.test.ts](source/services/conversation-retry-policy.test.ts:1) with tests for the new helper:
  - hallucinated tool extracts `bash`
  - parsing errors classify as `parsing_error`
  - behavior errors classify as `behavior`
  - max attempts returns `no_retry`
  - non-recoverable error returns `no_retry`

4. Add subagent retry tests first
   In [subagent-manager.test.ts](source/services/subagents/subagent-manager.test.ts:1), add mock providers for:
  - recoverable `ModelBehaviorError('Tool bash not found in agent Explorer.')`, then success
  - recoverable error repeated through max retries, returning failed result
  - non-recoverable `ModelBehaviorError`, no retry
  - abort error, no retry and status `cancelled`
  - transient upstream error, retry via shared upstream retry executor

5. Add subagent corrective retry prompt
   In [subagent-manager.ts](source/services/subagents/subagent-manager.ts:443), add a small helper:
   ```ts
   buildSubagentRetryTask(originalTask, errorMessage, toolNames)
   ```
   It should append a system-style instruction to the task:
  - previous attempt failed with the error
  - retry without using unavailable tools
  - available tools are: `read_file`, `grep`, etc.
  - preserve the original task

6. Wrap subagent model behavior errors
   Around the `runWithProvider()` call in `#runSubagent()`:
  - keep `toolDefinitions` and `tools` built once
  - track `modelRetryCount`
  - on recoverable model error, emit existing `retry` event with `retryType`
  - log `eventType: 'retry.subagent_model_error'`
  - retry with `buildSubagentRetryTask(...)`
  - after max retries, let the error bubble to `SubagentManager.run()` so it returns the existing failed `SubagentResult`

7. Reuse upstream retry executor
   Replace the direct subagent `runWithProvider()` call with:
   ```ts
   executeWithRetry({
     operation: () => runWithProvider(...),
     retryAttempts: settings.get('agent.retryAttempts') ?? 2,
     provider: providerId,
     model: definition.model,
     traceId: logger.getCorrelationId(),
     logger,
   })
   ```
   This reuses retry-after parsing, jitter, logging, and retry classification from [retry-executor.ts](source/lib/retry-executor.ts:7).

8. Avoid unsafe retries after side effects
   For worker subagents, only let automatic retries happen for errors thrown by the agent/provider run. Do not add retries around individual tool execution failures. Keep existing `filesChanged` tracking, and consider not retrying recoverable model errors if `filesChanged.length > 0`, to avoid duplicated edits after a partial worker run.

9. Run focused tests
   Run:
   ```bash
   npm run test:verbose -- source/services/conversation-retry-policy.test.ts
   npm run test:verbose -- source/services/subagents/subagent-manager.test.ts
   ```

10. Run broader validation if needed
    If the refactor touches exported types or shared retry behavior broadly, also run:
   ```bash
   npm test
   ```
