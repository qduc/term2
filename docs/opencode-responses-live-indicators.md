# Opencode gpt models: live thinking / tool-call indicators missing

**Status**: Fixed in `opencode/responses-live-indicators`.

## Symptom

With the `opencode` provider and a gpt model (e.g. `gpt-5.6-luna`), the live
"Thinking…" and "Calling `<tool>` (N chars)" indicators never appear. The turn
still completes correctly (tool calls execute, text streams), only the live
streaming indicators are absent. Other providers/routes are unaffected.

## Root cause

1. **Routing.** Commit `72b9d14b` ("Route Opencode GPT models through Responses
   API") switched gpt models on the opencode provider from the Chat Completions
   adapter (`OpenAIChatCompletionsModel`) to the Responses adapter
   (`OpenAIResponsesModelWithPromptCacheKey`). That routing change was itself a
   fix: before it, gpt + opencode errored with `OpenAI-compatible streamed
   response ended without a finish reason` (see `term2-2026-08-03.log`).

2. **Event vocabulary mismatch.** `normalizeResponseEvent` in
   `source/providers/openai-responses-model.ts` only maps reasoning from
   `response.reasoning_summary_text.delta`. It returns `null` for the event
   shapes opencode's `/v1/responses` gateway actually emits:
   - `response.reasoning_summary_part.added` / `.delta` / `.done` (text is in
     `part.text`, not a top-level `delta`), and
   - `response.reasoning_text.delta` (the newer Reasoning-API event name).

   No `reasoning_delta` therefore reaches the UI, so the "Thinking…" indicator
   never fires.

3. **Tool-call streaming has the same fragility.** `tool_call_streaming_delta`
   is only produced from `response.function_call_arguments.delta` /
   `response.output_item.added` / `response.output_item.delta`. When opencode
   delivers a completed function call only on `response.output_item.done` /
   terminal `response.completed`, the call still renders as a command message
   but no "Calling `<tool>` (N chars)" progress is shown.

4. **Secondary loss point.** Even terminal reasoning from opencode is dropped in
   `source/services/agent-runtime/application-run-loop.ts` (`appendNativeReasoning`),
   which only retains reasoning carrying `providerMetadata.codex` or
   `providerMetadata.openai`. Opencode's plaintext reasoning summary has
   neither, so it never surfaces at turn end either.

## Evidence (recorded provider traffic)

- Opencode gpt-5.6-luna session
  `~/Library/Logs/term2-nodejs/logs/provider-traffic/2026-08-03/13-56-40_85d22`:
  every reasoning-bearing turn records an **unknown** frame
  `{"type":"response.reasoning_summary_part.added", ..., "part":{"type":"summary_text","text":""}}`
  plus a `{"type":"ping","cost":"0"}` trailer.
- Codex gpt-5.6-luna session
  `~/Library/Logs/term2-nodejs/logs/provider-traffic/2026-08-03/14-45-00_d2f16`
  (works): no unknown frames.

Direct check of `normalizeResponseEvent`:

```
"response.reasoning_summary_part.added"  => null   # not handled
"response.reasoning_summary_text.delta"  => {"type":"reasoning_delta", ...}
```

## Fix

- `normalizeResponseEvent` now handles the `response.reasoning_summary_part.*`
  family (reading text from `part.text`) and `response.reasoning_text.delta`,
  mapping them to `reasoning_delta`. Incremental summary-part deltas are
  forwarded while a repeated terminal summary is suppressed.
- Function arguments delivered only on a `.done` event now produce a final
  `tool_call_streaming_delta`, including calls represented by
  `response.output_item.done`. Repeated counts are suppressed.
- Provider-neutral reasoning remains display-only in
  `appendNativeReasoning`: it is safe to show live, but cannot be replayed as
  native reasoning without provider-specific metadata.

These are provider changes and must run
`pnpm test:provider-black-box` (see the `provider-testing` skill).
