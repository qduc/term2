# Upstream Codex compact endpoint

Research date: 2026-09-01. Upstream: `openai/codex` `main` at commit [`82099786163f3c05facf09078136679e18b64279`](https://github.com/openai/codex/tree/82099786163f3c05facf09078136679e18b64279).

## Legacy `responses/compact` wire contract

The dedicated client is [`codex-rs/codex-api/src/endpoint/compact.rs`](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/codex-api/src/endpoint/compact.rs#L18-L88):

- Method/path: `POST responses/compact`, relative to the configured provider base URL. The client sends a JSON body as a unary request, applies the configured request timeout, and optionally records the response’s `x-codex-turn-state` header ([lines 35-68](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/endpoint/compact.rs#L35-L68)).
- Request JSON: `model` and `input` are required; `instructions` is omitted when empty. Optional fields are `tools`, `reasoning`, `service_tier`, `prompt_cache_key`, `text`, and `access_programs`; `parallel_tool_calls` is always serialized ([`common.rs` lines 46-66](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/common.rs#L46-L66)). `input` is a serialized array of `ResponseItem` values.
- Response JSON: the client deserializes an object containing `output`, where `output` is `Vec<ResponseItem>`, and returns that array ([`compact.rs` lines 85-88](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/endpoint/compact.rs#L85-L88)). The integration fixtures use the shape `{"output": [...]}` ([app-server compaction test lines 125-145](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/app-server/tests/suite/v2/compaction.rs#L125-L145)).

The core builds this payload from the normal Responses request, retaining model, resolved instructions, prepared input, tools, parallel-tool setting, reasoning, service tier, prompt-cache key, text controls, and auth-derived access programs ([`core/src/client.rs` lines 643-678](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/core/src/client.rs#L643-L678)). Legacy compaction then installs the returned normalized items as replacement history; it does not preserve the original harness metadata or a compaction response ID ([`compact_remote.rs` lines 280-304](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/core/src/compact_remote.rs#L280-L304)).

## Base URL and authentication assumptions

`EndpointSession` obtains the URL and default headers from `Provider`, appends the relative path after trimming slashes, merges endpoint-specific headers, and applies auth immediately before transport execution ([`codex-api/src/endpoint/session.rs` lines 48-60 and 80-113](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/endpoint/session.rs#L48-L113); [`codex-api/src/provider.rs` lines 52-85](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/provider.rs#L52-L85)). Therefore, typical full URLs are:

- ChatGPT-authenticated mode: `https://chatgpt.com/backend-api/codex/responses/compact`.
- API-key mode: `https://api.openai.com/v1/responses/compact`.

Those defaults and the `base_url` override are selected in [`model-provider-info/src/lib.rs` lines 292-321](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/model-provider-info/src/lib.rs#L292-L321). Auth is provider-specific and is not encoded in the compact client; the shared auth provider adds credentials to the request ([`model-provider/src/provider.rs` lines 225-251](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/model-provider/src/provider.rs#L225-L251)).

## Current compaction split and model caveats

The dedicated endpoint is now the legacy path. Upstream’s stable `RemoteCompactionV2` feature is enabled by default ([`features/src/lib.rs` lines 1655-1660](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/features/src/lib.rs#L1655-L1660)) and, when enabled for a provider with remote-compaction capability, uses the normal `/responses` stream with a `compaction_trigger` input item ([`core/src/tasks/compact.rs` lines 41-78](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/src/tasks/compact.rs#L41-L78); [`compact_remote_v2.rs` lines 370-483](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/src/compact_remote_v2.rs#L370-L483)). The legacy endpoint is exercised when V2 is disabled, as in the upstream legacy tests ([`core/tests/suite/compact_remote.rs` lines 222-227](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/tests/suite/compact_remote.rs#L222-L227)).

Relevant caveats:

- Remote-compaction capability is provider-level: built-in OpenAI and Azure-shaped providers advertise V2, as does the specialized Amazon Bedrock provider; other configured providers default to unsupported and use local compaction ([`model-provider/src/provider.rs` lines 44-75 and 348-366](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/model-provider/src/provider.rs#L44-L75), [`amazon_bedrock/mod.rs` lines 193-206](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/model-provider/src/amazon_bedrock/mod.rs#L193-L206)).
- Responses-Lite is model metadata, not a different compact path. The legacy compact test uses a Responses-Lite model and verifies the `x-openai-internal-codex-responses-lite: true` header, `reasoning.context: "all_turns"`, and `parallel_tool_calls: false` ([`core/tests/suite/responses_lite.rs` lines 546-597](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/tests/suite/responses_lite.rs#L546-L597)).
- The compact payload uses the active model selected by core; there is no separate compact-model field or fixed compact model in the request builder ([`core/src/client.rs` lines 651-678](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/src/client.rs#L651-L678)). Remote paths can retry model-specific failures with a current/fallback turn context when one exists ([`compact_model_fallback.rs` lines 8-20](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/src/compact_model_fallback.rs#L8-L20); legacy path [lines 224-263](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/src/compact_remote.rs#L224-L263)).
- V2 requires exactly one `compaction` output item and a completed response; legacy parsing only requires the response object’s `output` array ([`compact_remote_v2.rs` lines 421-483](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679e18b64279/codex-rs/core/src/compact_remote_v2.rs#L421-L483), [`codex-api/src/endpoint/compact.rs` lines 66-88](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/endpoint/compact.rs#L66-L88)).

## Tests found upstream

- The endpoint module has a focused path unit test, `path_is_responses_compact`, but its dummy transport deliberately does not execute a request ([`codex-api/src/endpoint/compact.rs` lines 90-114](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/codex-api/src/endpoint/compact.rs#L90-L114)).
- Core integration tests exercise the real legacy route, auth/session headers, request-body shape, replacement history, turn-state propagation, retries, trimming, and failure behavior; for example, [`core/tests/suite/compact_remote.rs` lines 832-1059](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/core/tests/suite/compact_remote.rs#L832-L1059) and lines 4340-4477 for turn state.
- The app-server test mounts `responses/compact`, asserts `/v1/responses/compact`, and verifies compaction lifecycle metadata ([`app-server/tests/suite/v2/compaction.rs` lines 106-244](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/app-server/tests/suite/v2/compaction.rs#L106-L244)). V2 tests instead assert `/v1/responses`, one `compaction_trigger`, exactly one compaction output, and retained-history behavior ([`core/tests/suite/compact_remote.rs` lines 463-530 and 1892-2045](https://github.com/openai/codex/blob/82099786163f3c05facf09078136679/codex-rs/core/tests/suite/compact_remote.rs#L463-L530)).
- `codex-api/tests/clients.rs` currently covers the shared Responses client, auth, retry, and Azure behavior; it does not instantiate `CompactClient` (the only direct compact-client test is the path test above).

## Comparison and implementation implication

This repo’s [`source/providers/codex-responses-model.ts` lines 97-114](/home/qduc/term2/source/providers/codex-responses-model.ts#L97-L114) calls the SDK’s `responses.compact` with `{ model, input, instructions? }`, then maps `response.output` into provider history and marks `type: "compaction"` items opaque. Its focused test verifies that narrow body and the mapping ([`codex-responses-model.test.ts` lines 460-487](/home/qduc/term2/source/providers/codex-responses-model.test.ts#L460-L487)).

Implication: the local shape is conceptually compatible with upstream legacy compaction, but intentionally omits upstream-supported optional controls (`tools`, `parallel_tool_calls`, reasoning, service tier, prompt-cache key, text, and access programs). Any future parity work should first decide whether the SDK/client supplies those fields and the Responses-Lite header, and should keep the legacy endpoint distinct from V2’s `/responses` + `compaction_trigger` protocol.

## Independent live-tested V2 implementation

The [algal/pi-openai-server-compaction](https://github.com/algal/pi-openai-server-compaction)
package reports live tests for both direct OpenAI and the ChatGPT Codex backend. Its
current implementation uses the V2 route rather than the legacy endpoint:

- Codex URL: `POST https://chatgpt.com/backend-api/codex/responses`.
- Body: the normal Responses request shape, with a trailing
  `{ "type": "compaction_trigger" }`, `stream: true`, `store: false`, and
  `include: ["reasoning.encrypted_content"]`.
- Codex headers include `x-codex-beta-features: remote_compaction_v2`, session/window
  identity, and `OpenAI-Beta: responses=experimental`.
- Response: SSE; require one `response.output_item.done` event whose item is
  `type: "compaction"`, followed by `response.completed`.

This distinction explains the observed live behavior: the authenticated legacy
`/responses/compact` request returned JSON 404, while a minimal V2 request to
`/responses` returned HTTP 200 and exactly one compaction item. The Codex adapter
now follows this V2 contract.
