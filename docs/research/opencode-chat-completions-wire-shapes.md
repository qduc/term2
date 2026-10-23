# opencode chat-completions wire shapes

A live survey of what opencode's models actually stream, taken because a real
defect (reasoning silently dropped for a whole family of models) had hidden
behind the assumption that "OpenAI-compatible" meant one shape.

Surveyed 2026-08-09 against `https://opencode.ai/zen/go/v1` by streaming two
probes per model — one plain-text, one tool-calling — straight from `fetch`,
deliberately **not** through `OpenAIChatCompletionsModel`, so the record shows
what the server sends rather than what our adapter makes of it.

`selectOpencodeModelTransport()` (`source/providers/opencode-routing.ts`) routes
25 opencode models three ways: `gpt`/`grok` to Responses, `minimax`/`qwen` to
Anthropic Messages, and **everything else** — 15 models — to chat completions.
Only that third group is covered here.

## The two families

The models split cleanly by how they spell streamed reasoning. Nothing else
about them varies in a way the adapter has to care about.

| Family | Models | Reasoning field | Also sends |
| --- | --- | --- | --- |
| `reasoning_content` | `kimi-k2.7-code`, `kimi-k2.6`, `kimi-k2.5`, `glm-5.2`, `glm-5.1`, `glm-5`, `deepseek-v4-pro`, `deepseek-v4-flash` | `delta.reasoning_content` | — |
| `reasoning` | `mimo-v2.5-pro`, `mimo-v2.5`, `hy3` | `delta.reasoning` | `delta.reasoning_details` |

The second family is the one that broke. The adapter read only
`reasoning_content`, so every reasoning token from `mimo-*` and `hy3` was
discarded — no `reasoning_delta` events, no reasoning item on the completion.
Fixed by reading `delta.reasoning_content ?? delta.reasoning`.

Four models could not be surveyed; all four fail upstream, not in our code:

| Model | Upstream response |
| --- | --- |
| `kimi-k3` | `Upstream request failed: Endpoint is unavailable.` |
| `hy3-preview` | `Upstream request failed: Model is unavailable.` |
| `mimo-v2-pro` | `[404] This model has been deprecated. It is recommended to migrate to xiaomi/mimo-v2.5-pro` |
| `mimo-v2-omni` | `[404] This model has been deprecated. It is recommended to migrate to xiaomi/mimo-v2.5` |

## `reasoning_details` is redundant here, and deliberately ignored

The `reasoning` family streams `delta.reasoning_details` alongside
`delta.reasoning`. Every entry observed was:

```json
{ "type": "reasoning.text", "text": "This", "format": "unknown", "index": 0 }
```

Same text, chunked identically to `delta.reasoning`, `format: "unknown"`, and
only ever `type: "reasoning.text"` — no signature and no encrypted payload.

**The adapter must keep ignoring it.** Reading both fields would duplicate every
reasoning token. This is worth stating because `reasoning_details` looks like
missing support: `openai-compatible-middleware.ts` and
`ai-sdk-message-normalizer.ts` both already handle the field on other paths.

If a future model emits `type: "reasoning.encrypted"` or a signature-bearing
entry, that changes — such a payload is not recoverable from `delta.reasoning`
and would need to be captured and replayed. Re-run the survey before assuming
the plain-text shape still holds.

## Everything else the adapter already handles

Verified against the streams, so a future reader does not have to re-derive it:

- **Tool calls** are uniform across all 11 working models:
  `{ index, id, type, function: { name, arguments } }`, with `id`/`name` on the
  first chunk for an index and argument fragments after. Keying the accumulator
  by `index` (not `id`) is required, and is what the adapter does.
- **`finish_reason` arrives twice** in the `reasoning` family — two terminal
  frames both carrying `stop`/`tool_calls`. Harmless: the adapter overwrites.
- **Usage placement differs.** `kimi`/`glm` send it on a dedicated
  `choices: []` frame; `deepseek` puts it on the finish frame; the `reasoning`
  family sends it on a later frame. All three land in the adapter's
  `if (chunk.usage)` branch.
- **Usage field names differ** — `prompt_tokens_details.cached_tokens`
  (everywhere), `prompt_tokens_details.cache_write_tokens` (`reasoning` family),
  `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` (`deepseek` only).
  `normalizeChatUsage()` covers all of them. The deepseek-only cache fields are
  not read, but its `prompt_tokens_details.cached_tokens` is, and carries the
  same number — unverified under an actual cache hit.
- **The cost trailer is always its own frame**, `{ "choices": [], "cost": "0" }`,
  separate from any usage frame, so `isCostOnlyTrailer()` catches it without
  swallowing usage.

## Re-running this survey

There is no committed script; it was a throwaway against the live endpoint. To
redo it, stream `POST {baseUrl}/chat/completions` per model with
`stream_options: { include_usage: true }` and tally, per frame: `delta` key
names, `choices[].finish_reason`, `usage` placement and keys, `tool_calls[]`
key shape, and any `choices: []` trailer frames. Compare against the tables
above; a new spelling in the `delta` keys is the signal that matters.
