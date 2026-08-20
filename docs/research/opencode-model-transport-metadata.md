# OpenCode model transport metadata

**Checked:** 2026-08-20  
**Question:** Can a client safely choose Responses, Chat Completions, or Anthropic Messages from OpenCode's model metadata?

## Finding

`GET https://opencode.ai/zen/v1/models` does **not** declare a transport or
protocol capability. The live response is an OpenAI-style list whose model
objects contain only `id`, `object`, `created`, and `owned_by`; there is no
`endpoint`, `shape`, SDK package, or Anthropic/Responses/Chat discriminator.
See the [live Zen models response](https://opencode.ai/zen/v1/models).

OpenCode does publish route metadata elsewhere:

- The [official Zen endpoint table](https://opencode.ai/docs/zen#endpoints)
  maps GPT/Grok/Muse models to `/responses`, Claude/Qwen to `/messages`, and
  DeepSeek/MiniMax/GLM/Kimi (and other compatible models) to
  `/chat/completions`, and names the corresponding AI SDK package.
- OpenCode's first-party [models.dev OpenCode provider catalog](https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/provider.toml)
  records the provider base URL and links this endpoint map. Individual model
  entries carry the route's SDK choice, for example
  [GPT 5.6 Luna](https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/gpt-5.6-luna.toml)
  uses `@ai-sdk/openai`, while
  [Qwen3.6 Plus](https://raw.githubusercontent.com/anomalyco/models.dev/dev/providers/opencode/models/qwen3.6-plus.toml)
  uses `@ai-sdk/anthropic`.
- OpenCode's [provider implementation](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/provider/provider.ts#L1158-L1202)
  resolves a model's SDK from that catalog metadata (`model.provider.npm`),
  and its model schema carries `api.id`, `api.url`, and `api.npm`
  ([schema](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/provider/provider.ts#L985-L1000)).

The proposed [v2 provider/model spec](https://github.com/anomalyco/opencode/blob/dev/specs/v2/provider-model.md#provider-schema)
also defines a typed `endpoint` union (`openai/responses`,
`openai/completions`, `anthropic/messages`, `aisdk`), but this is a source/spec
surface, not an additional field in the public Zen `/v1/models` response.

## Routing recommendation

For safe runtime routing, do not infer protocol from model-name fragments and
do not treat `/v1/models` as a capability manifest. Prefer the OpenCode
catalog/endpoint table (or an application-pinned equivalent) keyed by
`(base URL, model id)`, fail closed when an entry is absent, and refresh the
catalog deliberately. A wire probe is unnecessary when this first-party route
metadata is available; if a future deployment exposes only `/v1/models`, its
current shape provides no authoritative route signal and should not silently
select a transport.
