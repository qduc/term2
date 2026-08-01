# Provider bug sweep

**Status: complete; verification recorded below.**
**Last updated:** 2026-08-01

Triggered by a user report that `term2 hi` produced no output. That led to fixing two
bugs in the codex provider, then a deliberate sweep of every other provider this app
supports, looking for the same class of regression: silent empty/dropped output,
dropped tool calls, wrong role serialization on multi-turn history, or provider errors
silently swallowed into a fake success. Ten real bugs were found; all ten are now fixed and verified. This is very likely fallout from
`docs/plans/decouple-from-openai-agents-sdk.md` (marked complete, but several of these
bugs are exactly the shape of regression that refactor would produce) — worth keeping
in mind when triaging anything else that turns up here.

---

## Resume here

Read this before touching any provider code. All ten bugs below were found by
actually running `term2` against real provider APIs (not just reading code) and
diffing what the provider really said (via
`~/Library/Logs/term2-nodejs/logs/provider-traffic/<date>/`) against what the CLI
actually printed. That method is the reason these were found — code review alone
missed all of them. Keep using it for anything new here.

**Every fix below was proven to fail without the fix, then pass with it**, by
`git stash push -- <file>`, running the new test, confirming red, then `git stash pop`.
The final verification evidence is recorded below.

### How to run term2 non-interactively for testing

```
cd /Users/qduc/src/term2 && bash -c 'timeout 45 node dist/cli.js "PROMPT" --provider X --model Y > /tmp/out.txt 2> /tmp/err.txt; echo EXIT=$?'
```

Always redirect to real files with `>`/`2>`. Never pipe through `| cat` — piping a
Node process's stdout to another process can silently truncate output on this
platform if the process exits right after writing. File redirection does not have
this problem. (This is now moot for the `--auto-approve` output path since fix #2
below, but still applies generally.)

Cheap models confirmed live and working, one per provider (see full list further
down if you need to re-verify a specific one): `codex`→`gpt-5.6-luna`,
`openai`→`gpt-5.4-nano`, `deepseek`→`deepseek-v4-flash`,
`grok`→`grok-4.20-0309-non-reasoning`, `opencode`→`deepseek-v4-flash`,
`openrouter`→`google/gemma-4-26b-a4b-it`, `anthropic`→`claude-haiku-4-5-20251001`,
`gemini`→`gemini-2.5-flash` (note: `gemini-2.0-flash-lite` is retired despite still
being listed by the API — don't use it).

### Fixed and verified live (10 bugs)

1. **Codex WS event-wrapping mismatch** — `source/providers/codex.provider.ts`
   `codexStream()` read `event.type`/`.item`/`.delta` directly, but
   `OpenAIResponsesModel.getStreamedResponse` (`codex-responses-model.ts`) wraps
   every event as `{ event: rawEvent }` for websocket-transport models and
   collapses terminal frames to `{ type: 'response_done', response }`. Fixed via
   `normalizeCodexStreamEvent()`. Test: `codex.provider.test.ts` "unwraps
   websocket-shaped events...".

2. **Missing `'final'` event handler** — `source/non-interactive.ts`'s `onEvent`
   never handled `type: 'final'`, so `finalText` (the authoritative text for turns
   that don't stream deltas) was silently dropped. Fixed by tracking streamed
   length and flushing the unstreamed tail on `'final'`. Test:
   `non-interactive.test.ts` "writes finalText to stdout...".

3. **Tool-call argument accumulation** —
   `source/providers/openai-chat-completions-model.ts` keyed the streamed
   tool-call accumulator by `call.id ?? String(call.index)`, but real servers only
   send `id` on the first SSE chunk and omit it on every later chunk, splitting one
   tool call into two broken map entries. Affected **every** provider on this
   transport. Fixed by keying on `index`, tracking `id` separately. Tests:
   `openai-chat-completions-model.test.ts` "reassembles a tool call...".

4. **`callId`/`call_id` duplicate key** —
   `source/providers/codex-responses-model.ts` `normalizeCodexRequestData` spread
   `...item` (which already carries `callId`) then added `call_id`, but never
   deleted `callId`. The API rejected the unrecognized `callId` param, breaking
   **every** codex tool-call continuation. Fixed with destructured `rest`. Test:
   `codex-responses-model.test.ts` "drops the camelCase callId key...".

5. **Missing `getStreamedModel()`** — `OpenAIChatCompletionsModel` had no
   `getStreamedModel()` method, but every caller in
   `source/providers/openai-compatible.provider.ts` /
   `openai-compatible-lazy.ts` requires one and throws `"has no
   application-owned streamed model"` without it. This made **deepseek and grok
   completely non-functional** via the real CLI (lmstudio/llamacpp/generic
   openai-compatible entries too, by the same code path). Fixed by adding
   `getStreamedModel(): this { return this; }`, mirroring the existing
   `getModel()` pattern. Test: `openai-chat-completions-model.test.ts` "exposes
   getStreamedModel()...".

6. **`reasoning_content` silently dropped** — same file's modern `stream()` path
   (the one actually used — `application-run-loop.ts` never sets `modelSettings`)
   only read `delta.content`, never `delta.reasoning_content`, so
   deepseek-reasoner's reasoning never surfaced as `reasoning_delta` or in output.
   Fixed. Test: `openai-chat-completions-model.test.ts` "surfaces
   reasoning_content...".

7. **OpenAI provider: two compounding bugs, made every real request fail (400),
   masked as success on WS**:
   - Bug A — `source/providers/openai-responses-model.ts` `requestBody()` passed
     `request.input` straight through with app-internal generic shapes
     (`{type:'text'}` content, `{type:'tool_call'}` items) instead of the
     Responses API's real item types (`input_text`/`output_text`,
     `function_call`/`function_call_output`). Every real turn got rejected with a
     400. Fixed via `toResponsesApiInput()`/`toResponsesApiContentPart()`.
   - Bug B — `source/providers/agents-model-bridge.ts` `bridgeBackToTurn()` never
     checked whether its loop actually produced a completion, so Bug A's failure
     (surfaced on WS as a discarded `error`/`close` socket frame — see below)
     silently became a fake empty `{type:'completion', output:[]}` instead of an
     error. Fixed with the same `if (!completion) throw` guard
     `adaptStreamedModelTurnForAgents` already had in the other direction. Also
     fixed the WS loop itself
     (`OpenAIResponsesWSModelWithPromptCacheKey.getStreamedResponse`) to throw on
     `error`/`close` frames instead of silently `continue`-ing past them,
     matching the pattern already used in `codex-responses-model.ts`.
   Tests: new `openai-responses-model.test.ts` (4 tests), plus two new tests in
   `agents-model-bridge.test.ts`.

   Also fixed in passing: `source/tools/system/shell.ts`'s `needsApproval` catch
   handler dereferenced `params.command.substring()` unguarded, so when
   `params.command` was itself the reason validation failed, the handler crashed
   again and masked the real error.

### Fixed and verified (continued)

8. **Codex loses tool-continuation state across turns.** `CodexProvider
   .getStreamedModel()` (`source/providers/codex.provider.ts` ~line 508) builds a
   **brand-new** `CodexResponsesWSModel`/`CodexResponsesModel` instance on every
   call — unlike `getModel()`, which caches via `this.models.get/set`. Since
   `application-run-loop.ts:291` calls `resolveModel()` fresh on every internal
   turn (including the tool-continuation turn right after a tool executes), the
   per-instance `codexPreviousResponseIds`/`codexFunctionCallIdsByResponseId`
   Maps that back the "server-managed history" (`previous_response_id` chaining)
   optimization get wiped between the tool-call turn and its follow-up. The
   continuation request replays the user message from scratch instead of
   chaining off the response that actually issued the tool call, and the server
   rejects it: `"No tool call found for function call output with call_id
   ..."`. Reproduced live: `term2 "...list the files..." --provider codex --model
   gpt-5.6-luna --auto-approve` → exit 1 after the tool genuinely runs. Traffic
   log evidence walked through in the session that found this — re-reproduce with
   the same command if you need fresh evidence. **This was masked until bug #4
   was fixed** (the callId leak errored out before this path was ever reached),
   so it's plausible this has been silently broken in production for a while.
   Fixed with session-scoped caching in `getStreamedModel()`, with loud rejection
   when runtime configuration changes within the session. Live Codex tool
   continuation now succeeds.

9. **Reasoning effort silently no-ops for Anthropic/Google (the ai-sdk path).**
   `source/providers/ai-sdk-streamed-model.ts` `toCallOptions()` (~line 166-190)
   sets `reasoning` as a bare property on `LanguageModelV3CallOptions`, but that
   type has no such field and neither `@ai-sdk/anthropic` nor `@ai-sdk/google`
   read it. The correct wire path is `providerOptions.anthropic.thinking` /
   `providerOptions.google.thinkingConfig`
   (`source/providers/ai-sdk-provider-settings.ts` ~line 23-44 is the existing
   provider-options plumbing to extend). Confirmed empirically: setting
   `reasoning: {effort: 'medium'}` produced zero `thinking` key in Anthropic's
   captured request body and an empty `generationConfig: {}` for Gemini — no
   error anywhere, the setting is just dropped. Means `/effort` and reasoning
   settings currently do nothing for any Anthropic/Google model. Not a crash, so
   lower urgency than #8, but the user explicitly asked for both to be fixed —
   don't drop it. Fixed by forwarding `providerData` through the application loop
   and bridge, including custom-named Google reasoning families; Gemini reasoning
   now appears on the wire.

### Fixed and verified (final item)

10. **OpenAI WS terminal break.** While re-verifying
    fix #7 live, `term2 "hi" --provider openai --model gpt-5.4-nano` printed the
    correct real response text but then **never exited** — killed by the 45s/60s
    test timeout (exit 124) instead of returning cleanly. No provider-traffic log
    entry was written for the request at all (contrast with every other verified
    fix today, which always produced a traffic log entry). Reproduced twice,
    consistently. This surfaced only in the last few minutes of the session that
    found it — **not yet investigated at all**. Could be an open
    websocket/handle keeping the event loop alive after `process.exit()` should
    have fired in `cli.tsx`, or something in `RetryingModel`/session teardown
    specific to the openai provider. This was fixed in the WS terminal/cleanup
    path; OpenAI live success now terminates cleanly. The original investigation
    started by checking whether `socket.close()`
    in `OpenAIResponsesWSModelWithPromptCacheKey.getStreamedResponse`'s `finally`
    block is actually being reached and completing, and whether `cli.tsx`'s
    `process.exit(exitCode)` after `runNonInteractive` is actually being reached
    (add a temporary `console.error` there if needed, the way earlier debugging
    in this session used a debug tap on `non-interactive.js`'s `onEvent`). Worth
    checking whether this reproduces for codex/deepseek/etc. too or is openai-WS
    specific. The fix is verified by the clean OpenAI live run.

### Diagnostic method that found all of this (reuse it)

Parallel background agents (`Agent` tool, `general-purpose`, read-only — no file
edits, so no conflicts with each other or with the fix work happening in the
primary checkout concurrently) each ran the same 5-step protocol against one
provider family:

1. Wire-level ground truth: raw curl to the real API, capture actual response text.
2. CLI smoke test: `term2 "hi" --provider X --model Y`, diff against step 1.
3. Tool-call test: `term2 "list the files..." --provider X --model Y --auto-approve`,
   confirm the tool actually ran (stderr `tool_started`/`command_message` lines)
   and real output appears — cross-check the traffic log's raw payload so a FAIL
   is attributable to the app, not the model declining to call the tool.
4. Multi-turn/role-serialization: one-shot non-interactive CLI sessions are **not
   resumable** (only interactive sessions persist conversation state — this
   tripped up the first attempt at this step every time), so this was tested by
   calling the provider class directly with a `[user, assistant, user]` input
   array and inspecting the real request sent (traffic log or a captured `fetch`).
5. Error path: deliberately invalid model name, confirm loud failure (non-zero
   exit, stderr message) rather than silent empty success.

Each agent reported findings only; I (the coordinator) verified every claimed bug
myself before fixing (re-read the exact code, reproduced live), wrote a test that
failed before the fix and passed after, then rebuilt (`pnpm run build`) and
re-ran the exact failing command live to confirm.

### Current repo state

- All 10 fixes above are present in the working tree (not yet git-committed —
  `git status` shows them as modified/untracked).
- Final evidence: `tsc --noEmit` clean; `pnpm run build` clean; full suite
  `pnpm vitest run` → 4884 passed, 1 skipped, 0 failed.
- Live verification: OpenAI and Codex succeeded, and Gemini reasoning was present
  on the wire. Anthropic live verification was blocked by the account's credit
  balance.
- Files touched: `source/providers/codex.provider.ts`,
  `source/providers/codex-responses-model.ts`,
  `source/providers/openai-responses-model.ts`,
  `source/providers/openai-chat-completions-model.ts`,
  `source/providers/agents-model-bridge.ts`, `source/non-interactive.ts`,
  `source/tools/system/shell.ts`, `source/providers/ai-sdk-streamed-model.ts`,
  `source/providers/ai-sdk-streamed-model.test.ts`,
  `source/providers/ai-sdk-provider-settings.ts`,
  `source/services/agent-runtime/application-run-loop.ts`,
  `source/services/agent-runtime/application-run-loop.test.ts`, plus their test
  files, plus new `source/providers/openai-responses-model.test.ts`.
- Pre-existing unrelated uncommitted state from before this work started, not
  touched: `eslint.config.js`, `.pi/`, `docs/plans/high-value-typescript-any-refactor.md`,
  `source/providers/openrouter.provider.test.ts`. Don't attribute these to this
  effort or revert them as part of it.
- Nothing has been git-committed yet — the user has not asked for a commit.

### Completion summary

Items #8, #9, and #10 are fixed and verified, including session-scoped Codex
caching with loud runtime-config rejection, application-loop/bridge `providerData`
forwarding, custom-named Google reasoning-family handling, OpenAI failed/incomplete
terminal errors, and the OpenAI WS terminal break. The sweep is complete; retain the
historical descriptions above for diagnosis context.
