# Context-lifecycle economics (retained local evidence)

Window: **2026-08-31 through 2026-09-05** (inclusive).

## Method and boundaries

The standalone `analyze.py` reads provider-traffic JSON one file at a time, app JSONL rotations, and persisted conversation JSONL. Requests are deduplicated by the `(sent.requestId, sent.sessionId)` identity; index files are not counted. No prompts, previews, tool arguments, headers, response text, or ciphertext are emitted. Wire timestamps are UTC; app timestamps are local wall-clock labels. These are observations, not causal savings or policy thresholds.

Wire/source contract checked: `source/services/logging/provider-traffic.ts` writes `sent.mode`, model class metadata, and the sanitized `sent.body`; `source/providers/codex-responses-model.ts` appends `input[*].type=compaction_trigger` for native compaction; `source/providers/codex.provider.ts` detects that exact final input item and records `request_kind=compaction`. This analyzer follows those paths and does not infer mechanism from prompt text or arbitrary nested `type` values.

## Coverage

| date | files | complete | usage | cache field | recorded cost | parse errors | duplicate request IDs |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-31 | 1340 | 1301 | 1301 / 39 missing | 1301 / 39 missing | 234 | 0 | 0 |
| 2026-09-01 | 4310 | 4251 | 4251 / 59 missing | 4251 / 59 missing | 609 | 0 | 0 |
| 2026-09-02 | 6399 | 6359 | 6358 / 41 missing | 6358 / 41 missing | 368 | 0 | 0 |
| 2026-09-03 | 3819 | 3702 | 3702 / 13 missing | 3702 / 13 missing | 2203 | 0 | 0 |
| 2026-09-04 | 2346 | 2308 | 2307 / 39 missing | 2278 / 68 missing | 17 | 0 | 0 |
| 2026-09-05 | 4671 | 4442 | 4441 / 230 missing | 4441 / 230 missing | 518 | 0 | 0 |

Deduplicated traffic requests: **22781**. Wire shapes: `{"chat_completions": 9392, "responses": 1184, "text": 3, "unknown": 312, "websocket": 11787}`. Mechanism classification: `{"native_compaction_replay": 1, "native_compaction_trigger": 214, "ordinary": 22566}`. Independent HTTP/error outcomes: `{"error": 75, "http_error": 284, "incomplete": 59, "success": 22363}`; mechanism/outcome cross-tab: `{"native_compaction_replay/success": 1, "native_compaction_trigger/error": 7, "native_compaction_trigger/http_error": 206, "native_compaction_trigger/success": 1, "ordinary/error": 68, "ordinary/http_error": 78, "ordinary/incomplete": 59, "ordinary/success": 22361}`. The Codex markers are recognized only at `sent.body.input[*].type`: `compaction_trigger` means trigger and `compaction` means replay marker. Guessed `body.compaction`, `body.summarizer`, and `body.operation` fields are not classified.

Coverage by provider/model/date (all deduplicated files; `usage_missing` and `cache_field_missing` are fields, not zeroes):

| date/provider/model | files | complete | incomplete/error | usage missing | cache missing | cost present |
|---|---:|---:|---:|---:|---:|---:|
| `2026-08-31/DeepSeek/deepseek-v4-flash` | 223 | 223 | 0 | 0 | 0 | 0 |
| `2026-08-31/Neuralwatt/kimi-k3-flex` | 1 | 1 | 0 | 0 | 0 | 0 |
| `2026-08-31/Neuralwatt/qwen-3.8-27b` | 21 | 19 | 2 | 2 | 2 | 0 |
| `2026-08-31/Neuralwatt/qwen3.6-35b-fast` | 4 | 4 | 0 | 0 | 0 | 0 |
| `2026-08-31/codex/gpt-5.6-luna` | 365 | 363 | 2 | 2 | 2 | 0 |
| `2026-08-31/codex/gpt-5.6-sol` | 482 | 457 | 25 | 25 | 25 | 0 |
| `2026-08-31/openrouter/deepseek/deepseek-v4-flash` | 35 | 33 | 2 | 2 | 2 | 33 |
| `2026-08-31/openrouter/deepseek/deepseek-v4-flash-0731` | 49 | 47 | 2 | 2 | 2 | 47 |
| `2026-08-31/openrouter/meta/muse-spark-1.2-contributor` | 5 | 3 | 2 | 2 | 2 | 3 |
| `2026-08-31/openrouter/z-ai/glm-5.3` | 2 | 2 | 0 | 0 | 0 | 2 |
| `2026-08-31/openrouter/z-ai/glm-5.3-flash` | 153 | 149 | 4 | 4 | 4 | 149 |
| `2026-09-01/DeepSeek/deepseek-v4-flash` | 466 | 465 | 1 | 1 | 1 | 0 |
| `2026-09-01/Neuralwatt/kimi-k3-flex` | 2 | 2 | 0 | 0 | 0 | 0 |
| `2026-09-01/Neuralwatt/qwen3.6-35b-fast` | 24 | 24 | 0 | 0 | 0 | 0 |
| `2026-09-01/codex/gpt-5.6-luna` | 2451 | 2423 | 28 | 28 | 28 | 0 |
| `2026-09-01/codex/gpt-5.6-sol` | 748 | 728 | 20 | 20 | 20 | 0 |
| `2026-09-01/openrouter/deepseek/deepseek-v4-flash-0731` | 233 | 233 | 0 | 0 | 0 | 233 |
| `2026-09-01/openrouter/meta/muse-spark-1.2-contributor` | 27 | 27 | 0 | 0 | 0 | 27 |
| `2026-09-01/openrouter/z-ai/glm-5.3` | 2 | 2 | 0 | 0 | 0 | 2 |
| `2026-09-01/openrouter/z-ai/glm-5.3-flash` | 239 | 239 | 0 | 0 | 0 | 239 |
| `2026-09-01/openrouter/~deepseek/deepseek-v4-flash-latest` | 118 | 108 | 10 | 10 | 10 | 108 |
| `2026-09-02/DeepSeek/deepseek-v4-flash` | 1149 | 1149 | 0 | 0 | 0 | 0 |
| `2026-09-02/DeepSeek/deepseek-v4-flash-vision-exp` | 337 | 337 | 0 | 0 | 0 | 0 |
| `2026-09-02/Neuralwatt/kimi-k3-flex` | 2 | 2 | 0 | 0 | 0 | 0 |
| `2026-09-02/Neuralwatt/qwen3.6-35b-fast` | 126 | 115 | 11 | 11 | 11 | 0 |
| `2026-09-02/codex/gpt-5.6-luna` | 3987 | 3964 | 23 | 23 | 23 | 0 |
| `2026-09-02/codex/gpt-5.6-sol` | 429 | 423 | 6 | 6 | 6 | 0 |
| `2026-09-02/grok/grok-4.6` | 94 | 94 | 0 | 1 | 1 | 93 |
| `2026-09-02/openrouter/deepseek/deepseek-v4-flash-0731` | 20 | 20 | 0 | 0 | 0 | 20 |
| `2026-09-02/openrouter/z-ai/glm-5.3` | 2 | 2 | 0 | 0 | 0 | 2 |
| `2026-09-02/openrouter/z-ai/glm-5.3-flash` | 50 | 50 | 0 | 0 | 0 | 50 |
| `2026-09-02/openrouter/z-ai/glm-5.3-flash:nitro` | 152 | 152 | 0 | 0 | 0 | 152 |
| `2026-09-02/openrouter/~deepseek/deepseek-v4-flash-latest` | 51 | 51 | 0 | 0 | 0 | 51 |
| `2026-09-03/DeepSeek/deepseek-v4-flash` | 76 | 76 | 0 | 0 | 0 | 0 |
| `2026-09-03/Neuralwatt/kimi-k3-flex` | 2 | 2 | 0 | 0 | 0 | 0 |
| `2026-09-03/Neuralwatt/qwen3.6-35b-fast` | 18 | 18 | 0 | 0 | 0 | 0 |
| `2026-09-03/codex/gpt-5.6-luna` | 775 | 768 | 7 | 7 | 7 | 0 |
| `2026-09-03/codex/gpt-5.6-sol` | 79 | 76 | 3 | 3 | 3 | 0 |
| `2026-09-03/opencode/muse-spark-1.3-contributor` | 123 | 123 | 0 | 0 | 0 | 0 |
| `2026-09-03/openrouter/google/gemini-3.8-flash` | 105 | 105 | 0 | 0 | 0 | 105 |
| `2026-09-03/openrouter/meta/muse-spark-1.3-contributor` | 2098 | 2096 | 2 | 2 | 2 | 2096 |
| `2026-09-03/openrouter/z-ai/glm-5.3` | 2 | 2 | 0 | 0 | 0 | 2 |
| `2026-09-03/zai/glm-5.3-flash` | 436 | 436 | 0 | 0 | 0 | 0 |
| `2026-09-03/zai/openai/gpt-5.6-luna` | 1 | 0 | 1 | 1 | 1 | 0 |
| `2026-09-04/DeepSeek/deepseek-v4-flash` | 127 | 127 | 0 | 0 | 0 | 0 |
| `2026-09-04/Neuralwatt/qwen3.6-35b-fast` | 24 | 24 | 0 | 0 | 0 | 0 |
| `2026-09-04/codex/gpt-5.3-codex` | 1 | 0 | 1 | 1 | 1 | 0 |
| `2026-09-04/codex/gpt-5.6-luna` | 381 | 380 | 1 | 1 | 1 | 0 |
| `2026-09-04/opencode/deepseek-v4-flash` | 411 | 408 | 3 | 4 | 24 | 0 |
| `2026-09-04/opencode/glm-5.3-flash` | 408 | 406 | 2 | 2 | 11 | 0 |
| `2026-09-04/opencode/gpt-5.6-luna` | 2 | 2 | 0 | 0 | 0 | 0 |
| `2026-09-04/opencode/muse-spark-1.3-contributor` | 396 | 367 | 29 | 29 | 29 | 0 |
| `2026-09-04/openrouter/anthropic/claude-sonnet-5` | 17 | 17 | 0 | 0 | 0 | 17 |
| `2026-09-04/zai/glm-5.3-flash` | 579 | 577 | 2 | 2 | 2 | 0 |
| `2026-09-05/DeepSeek/deepseek-v4-flash` | 797 | 797 | 0 | 0 | 0 | 0 |
| `2026-09-05/Neuralwatt/kimi-k3-flex` | 3 | 3 | 0 | 0 | 0 | 0 |
| `2026-09-05/Neuralwatt/qwen3.6-35b-fast` | 27 | 27 | 0 | 0 | 0 | 0 |
| `2026-09-05/codex/gpt-5.6-luna` | 2028 | 1803 | 225 | 225 | 225 | 0 |
| `2026-09-05/codex/gpt-5.6-sol` | 3 | 3 | 0 | 0 | 0 | 0 |
| `2026-09-05/codex/gpt-6-astra` | 402 | 400 | 2 | 2 | 2 | 0 |
| `2026-09-05/grok/grok-4.6` | 441 | 441 | 0 | 1 | 1 | 440 |
| `2026-09-05/opencode/gpt-5.6-luna` | 46 | 46 | 0 | 0 | 0 | 0 |
| `2026-09-05/opencode/muse-spark-1.3-contributor` | 110 | 110 | 0 | 0 | 0 | 0 |
| `2026-09-05/openrouter/anthropic/claude-opus-5` | 12 | 11 | 1 | 1 | 1 | 11 |
| `2026-09-05/openrouter/meta/muse-spark-1.3-contributor` | 64 | 64 | 0 | 0 | 0 | 64 |
| `2026-09-05/openrouter/z-ai/glm-5.3` | 3 | 3 | 0 | 0 | 0 | 3 |
| `2026-09-05/zai/glm-5.3-flash` | 735 | 734 | 1 | 1 | 1 | 0 |

## Token and cache economics

Only scalar provider-recorded usage is used. `cached_tokens: 0` is observed zero; absent cache fields remain missing. Cost sums stay separated by the provider's recorded field (`cost` versus `cost_in_usd_ticks`); neither is converted or priced here. Weighted ratios use the input-token denominator from requests where a cache field was present.

| provider/model | ordinary requests | input | cache-observed input | cached | output | weighted cache ratio | mean per-request ratio | recorded cost fields (count/sum by field) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `DeepSeek/deepseek-v4-flash` | 2838 | 330581691 | 330581691 | 319200640 | 2758280 | 0.9656 | 0.9541 | — |
| `DeepSeek/deepseek-v4-flash-vision-exp` | 337 | 35586123 | 35586123 | 34254976 | 264276 | 0.9626 | 0.9610 | — |
| `Neuralwatt/kimi-k3-flex` | 10 | 53617 | 53617 | 0 | 61279 | 0.0000 | 0.0000 | — |
| `Neuralwatt/qwen-3.8-27b` | 21 | 849341 | 849341 | 391200 | 9498 | 0.4606 | 0.4522 | — |
| `Neuralwatt/qwen3.6-35b-fast` | 223 | 528503 | 528503 | 10560 | 36543 | 0.0200 | 0.0232 | — |
| `codex/gpt-5.3-codex` | 1 | 0 | 0 | 0 | 0 | — | — | — |
| `codex/gpt-5.6-luna` | 9774 | 826145077 | 826145077 | 796511232 | 2696360 | 0.9641 | 0.9279 | — |
| `codex/gpt-5.6-sol` | 1739 | 211622912 | 211622912 | 204713472 | 564789 | 0.9674 | 0.9410 | — |
| `codex/gpt-6-astra` | 402 | 35887854 | 35887854 | 34362880 | 123393 | 0.9575 | 0.9244 | — |
| `grok/grok-4.6` | 535 | 76547807 | 76547807 | 71695232 | 426819 | 0.9366 | 0.8990 | cost_in_usd_ticks:533/106517651400 |
| `opencode/deepseek-v4-flash` | 411 | 26323411 | 25985241 | 25441280 | 380252 | 0.9791 | 0.9668 | — |
| `opencode/glm-5.3-flash` | 408 | 13264502 | 13089388 | 11921728 | 152705 | 0.9108 | 0.8574 | — |
| `opencode/gpt-5.6-luna` | 48 | 3322779 | 3322779 | 3128043 | 11804 | 0.9414 | 0.9002 | — |
| `opencode/muse-spark-1.3-contributor` | 629 | 40993074 | 40993074 | 39253244 | 281064 | 0.9576 | 0.9162 | — |
| `openrouter/anthropic/claude-opus-5` | 12 | 422867 | 422867 | 363831 | 4363 | 0.8604 | 0.8349 | cost:11/0.65333862 |
| `openrouter/anthropic/claude-sonnet-5` | 17 | 477477 | 477477 | 420711 | 3744 | 0.8811 | 0.8927 | cost:17/0.260845398 |
| `openrouter/deepseek/deepseek-v4-flash` | 35 | 1102906 | 1102906 | 632064 | 12225 | 0.5731 | 0.5020 | cost:33/0.04990378297489201 |
| `openrouter/deepseek/deepseek-v4-flash-0731` | 302 | 27404473 | 27404473 | 26015268 | 273615 | 0.9493 | 0.9013 | cost:300/0.03254600646 |
| `openrouter/google/gemini-3.8-flash` | 105 | 9087007 | 9087007 | 8612064 | 16906 | 0.9477 | 0.9221 | cost:105/0.5274272272500001 |
| `openrouter/meta/muse-spark-1.2-contributor` | 32 | 1525782 | 1525782 | 1065590 | 34796 | 0.6984 | 0.6461 | cost:30/0.05455848419999999 |
| `openrouter/meta/muse-spark-1.3-contributor` | 2162 | 325778034 | 325778034 | 290463070 | 1497194 | 0.8916 | 0.8690 | cost:2160/4.367742726600001 |
| `openrouter/z-ai/glm-5.3` | 11 | 60958 | 60958 | 0 | 115294 | 0.0000 | 0.0000 | cost:11/0.5064174423000001 |
| `openrouter/z-ai/glm-5.3-flash` | 442 | 32621830 | 32621830 | 30538304 | 358633 | 0.9361 | 0.8968 | cost:438/1.1308982624428499 |
| `openrouter/z-ai/glm-5.3-flash:nitro` | 152 | 15391935 | 15391935 | 14837248 | 72014 | 0.9640 | 0.9526 | cost:152/0.55867571607276 |
| `openrouter/~deepseek/deepseek-v4-flash-latest` | 169 | 11751134 | 11751134 | 11150516 | 177249 | 0.9489 | 0.9238 | cost:159/0.02368924074 |
| `zai/glm-5.3-flash` | 1750 | 141410824 | 141410824 | 135613120 | 1466071 | 0.9590 | 0.9227 | — |
| `zai/openai/gpt-5.6-luna` | 1 | 0 | 0 | 0 | 0 | — | — | — |

Input-size buckets (ordinary requests):

| bucket | requests | input | cache-observed input | cached | weighted ratio | mean per-request ratio |
|---|---:|---:|---:|---:|---:|---:|
| <8k | 275 | 913630 | 913630 | 159793 | 0.1749 | 0.0981 |
| 8-32k | 3431 | 73120739 | 72607455 | 58173251 | 0.8012 | 0.7736 |
| 32-64k | 4661 | 225977551 | 225977551 | 209282736 | 0.9261 | 0.9236 |
| 64-128k | 7705 | 716500395 | 716500395 | 686883929 | 0.9587 | 0.9576 |
| 128k+ | 6286 | 1152229603 | 1152229603 | 1106096564 | 0.9600 | 0.9619 |

### Relative input-price sensitivity

Ordinary input totals: **2168741918** tokens; cache-observed denominator: **2168228634** across 22329 requests; cache-field-missing input: **513284**. Ratios below use only the cache-observed denominator, never treating missing cache as zero. The counterfactual relative cost at cached/uncached price ratios is `{"0": 0.049640687938631856, "0.1": 0.14467661914476868, "0.25": 0.28723051595397386, "0.5": 0.524820343969316, "1": 1.0}`. Formula: `relative input cost = uncached_fraction + cached_fraction * (cached_price / uncached_price); counterfactual only`. This is a history-size sensitivity, not a provider bill or evidence that compaction caused savings. Reducing uncached history can reduce input cost even when cached and uncached unit prices are equal; no provider price schedule is available here.

## Session growth and boundary flags

Sessions with traffic: **332**. Edges with >6-hour gap: **1**; model-switch edges: **1267**. Session IDs are pooled identifiers, not root-model context identities. The 8b49 session's **3,023 requests over 2.44h** include multiple providers/models and lanes; adjacent requests are not interpreted as one model context. These flags mark confounding boundaries rather than imputing continuity. Top sessions by request count:

- `8b49b1ea-9cbe-4615-8b7f-71a0422e1f26`: 3023 pooled requests (2026-09-02:3023), input 227040917 tokens, models `deepseek-v4-flash, gpt-5.6-luna, qwen3.6-35b-fast`, lanes `DeepSeek/deepseek-v4-flash/standard/unattributed=277, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=2661, codex/gpt-5.6-luna/standard/unattributed=4, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=81`, first `2026-09-02T16:52:39.054Z`, last `2026-09-02T19:19:13.085Z`, request IDs `ba70d770-129a-4803-b879-dc678d0d4ccd, 31a684bb-55a8-4236-9d5c-61a227f78095, 95636939-88f5-443b-9db8-f2b6e17be729`
- `39c81dd0-a6c5-4e13-9a21-e3cd18e005b0`: 790 pooled requests (2026-09-03:790), input 151324804 tokens, models `meta/muse-spark-1.3-contributor, qwen3.6-35b-fast`, lanes `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed=789, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=1`, first `2026-09-03T00:53:55.604Z`, last `2026-09-03T06:41:10.722Z`, request IDs `23aca168-382b-4a20-b71e-2ac049da9fd4, 2dca8036-87ae-40e3-a686-1d120040dac7, b63aeff9-a717-4f98-8f60-51cb67f73c79`
- `6760346e-a877-4c90-a00a-d7ae32eeee83`: 619 pooled requests (2026-09-01:619), input 65499430 tokens, models `gpt-5.6-sol, gpt-5.6-luna, z-ai/glm-5.3, kimi-k3-flex, qwen3.6-35b-fast`, lanes `codex/gpt-5.6-sol/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=94, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=520, openrouter/z-ai/glm-5.3/standard/unattributed=1, Neuralwatt/kimi-k3-flex/standard/unattributed=1, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=3`, first `2026-09-01T01:57:07.805Z`, last `2026-09-01T02:55:00.012Z`, request IDs `0a9b63da-8796-4f1f-917c-5c9d61727f45, 37689b63-ae36-49b8-9e55-d401ee5a80f1, 8cc033f8-1ca2-43b6-a971-637171eed3c8`
- `4e386624-6ea0-420f-afce-51c56c2c99c6`: 481 pooled requests (2026-09-05:481), input 60626588 tokens, models `gpt-6-astra, gpt-5.6-luna, gpt-5.6-sol, z-ai/glm-5.3, kimi-k3-flex`, lanes `codex/gpt-6-astra/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=75, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=357, codex/gpt-5.6-luna/standard/unattributed=46, codex/gpt-5.6-sol/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=1, openrouter/z-ai/glm-5.3/standard/unattributed=1`, first `2026-09-05T06:39:48.340Z`, last `2026-09-05T07:08:13.154Z`, request IDs `ae298edc-6612-45ff-ba7f-61895eb97329, 66013879-c9e6-4c2b-8593-28bb277072bc, 24347461-9bef-48c6-bbd6-56aa60a1ea90`
- `d07eda2f-582d-4703-88d9-e6cfbc43377d`: 391 pooled requests (2026-09-05:391), input 52552829 tokens, models `deepseek-v4-flash, gpt-5.6-luna`, lanes `DeepSeek/deepseek-v4-flash/standard/unattributed=356, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=35`, first `2026-09-05T08:08:23.820Z`, last `2026-09-05T11:11:29.841Z`, request IDs `f89fce4e-5d3d-47f4-aa1d-b34bbc63b30a, d6492926-6318-4ee7-ab2b-6b2b7b5a3eb4, 46f8e9a0-6e0c-439f-a61b-5302571eccf5`
- `b5ac6f97-66f5-4e89-9511-aa097b4f6250`: 371 pooled requests (2026-09-03:371), input 59148987 tokens, models `meta/muse-spark-1.3-contributor, qwen3.6-35b-fast, gpt-5.6-luna`, lanes `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed=358, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=4, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=9`, first `2026-09-03T09:23:52.321Z`, last `2026-09-03T10:41:34.965Z`, request IDs `879f6aef-283d-4cea-929e-0997236f69dd, b09394b2-ded5-4aa4-9ad8-20d941807678, 7325153b-db70-4480-87c0-d799ddaf8fa5`
- `1f5d382f-7d6f-4b40-a3bb-07bbf597ec62`: 332 pooled requests (2026-09-01:332), input 28700404 tokens, models `gpt-5.6-sol, gpt-5.6-luna, qwen3.6-35b-fast`, lanes `codex/gpt-5.6-sol/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=103, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=228, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=1`, first `2026-09-01T02:55:48.291Z`, last `2026-09-01T04:05:55.217Z`, request IDs `71d8a711-6b90-483c-81f5-fa1ced9110eb, 681ff0bb-bde4-4d15-addc-ab91dbb9d147, 7df2e51b-e456-4737-bd9e-9a2978515718`
- `ccf9f945-6123-4e4a-9fb1-6375927f1780`: 325 pooled requests (2026-09-01:325), input 25065811 tokens, models `gpt-5.6-sol, gpt-5.6-luna, qwen3.6-35b-fast`, lanes `codex/gpt-5.6-sol/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=103, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=221, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=1`, first `2026-09-01T06:14:26.543Z`, last `2026-09-01T07:24:17.921Z`, request IDs `34e2fea9-5eef-46c3-9468-b839d1eb014c, a83f4613-3b15-434b-8632-9dddcd0d72ce, e0dc174f-0f38-405b-8263-8ea6551a3062`
- `841dc37d-3873-4e04-832a-fd21a30d2458`: 314 pooled requests (2026-09-05:314), input 39240626 tokens, models `deepseek-v4-flash`, lanes `DeepSeek/deepseek-v4-flash/standard/unattributed=314`, first `2026-09-05T17:42:38.176Z`, last `2026-09-05T18:59:23.816Z`, request IDs `9379e983-aef4-47ae-9001-8c79eb2fc742, 11095743-b2c1-4ad6-a185-955760f5f4fb, dd47b348-eb19-47d4-9325-4ab21a89a8dc`
- `860f4aed-9dcd-4bed-b908-afa5c95690c9`: 307 pooled requests (2026-08-31:307), input 32936904 tokens, models `gpt-5.6-sol, gpt-5.6-luna`, lanes `codex/gpt-5.6-sol/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=147, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=136, codex/gpt-5.6-sol/standard/unattributed=24`, first `2026-08-31T01:24:40.743Z`, last `2026-08-31T02:21:30.556Z`, request IDs `ba9b68af-2e92-477e-b255-92ef983fb7ec, 10d64007-b3be-4e54-9466-a169e5897c71, ef0ef5b8-5fb5-4706-a534-c85c0bff1d69`
- `f925c980-05be-4675-922a-17503360bc9b`: 307 pooled requests (2026-09-02:231, 2026-09-03:76), input 39749118 tokens, models `deepseek-v4-flash, qwen3.6-35b-fast`, lanes `DeepSeek/deepseek-v4-flash/standard/unattributed=302, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=5`, first `2026-09-02T21:46:40.935Z`, last `2026-09-03T00:34:54.811Z`, request IDs `4bf1866d-7dbd-424d-9f70-0ec7505adb6d, f073986a-68e6-4941-a848-800660cc5196, dfa1b929-a959-4612-bb92-74ee92daf1c8`
- `2f8e4589-1f15-4dd9-824d-9efd75c91fb8`: 295 pooled requests (2026-09-03:295), input 20450715 tokens, models `gpt-5.6-luna, qwen3.6-35b-fast`, lanes `codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=294, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=1`, first `2026-09-03T09:10:49.827Z`, last `2026-09-03T09:37:29.847Z`, request IDs `15376232-de8d-4f1a-9c88-691a55918b0b, eb846815-acc5-4749-ac89-213cfaa1f5b8, 817558d6-2cd5-4dd2-a931-515c8c6e440e`
- `c2455dcf-0721-4656-bd36-50be3d7be0d7`: 285 pooled requests (2026-09-02:285), input 40083190 tokens, models `gpt-5.6-luna, qwen3.6-35b-fast`, lanes `codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=269, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=16`, first `2026-09-02T13:31:52.296Z`, last `2026-09-02T14:18:36.400Z`, request IDs `5a88d9d4-6e65-4c29-964b-a506665d4ea9, 3a4cb414-7184-4125-ab29-9e6bf9fab625, 81939780-062f-4409-ac49-21ff6014c864`
- `72a7c0c2-23fc-478b-9470-58d48345454a`: 283 pooled requests (2026-09-01:283), input 16754986 tokens, models `deepseek-v4-flash, gpt-5.6-luna, qwen3.6-35b-fast`, lanes `DeepSeek/deepseek-v4-flash/orchestrator/unattributed=53, codex/gpt-5.6-luna/orchestrator/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=227, Neuralwatt/qwen3.6-35b-fast/orchestrator/unattributed=3`, first `2026-09-01T18:05:05.106Z`, last `2026-09-01T19:08:44.245Z`, request IDs `12c82b8d-805f-47f6-baca-d2eed8655a5e, c7da9b63-a298-4aca-b6e0-9b95ae833227, 12c2edf9-fbee-4334-b778-c6b0cb779f21`
- `9bff1663-d877-4adc-b910-6353980a40f5`: 280 pooled requests (2026-09-01:280), input 28168701 tokens, models `gpt-5.6-sol, gpt-5.6-luna, qwen3.6-35b-fast`, lanes `codex/gpt-5.6-sol/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=106, codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn=172, Neuralwatt/qwen3.6-35b-fast/standard/unattributed=2`, first `2026-09-01T07:29:05.095Z`, last `2026-09-01T08:10:23.704Z`, request IDs `0e808d12-653d-4bf6-95d3-c8eec027fea5, dfdc593d-25e3-4cfe-9f56-0e655e5547e1, e42ade66-520a-4ecc-8d5d-cda502dc143c`

## Compaction and rollover evidence

App structured messages: `{"local_compaction_blocked": 135, "local_compaction_drop": 14, "native_compaction_failed": 245}`. Persisted structured compaction event types: `{}`. Local summary success: **unavailable** (successful count is not inferred). Native wire triggers: **214 retained examples** of **214**; native replay markers: **1**. Trigger and replay are distinct mechanisms; HTTP/error outcome is tabulated independently. In particular, request `90343fc6-604d-4e99-864d-88aa40ef6e6b` is a `compaction_trigger` with input 206582, not ordinary traffic. Verified completed rollover predecessor→successor links: **14**.

Native replay-marker artifact/request IDs and downstream reuse:
- session `d34982b2-2bd2-47a3-9b36-2972d435d49c`, request `c9a09af6-97b4-4761-b0c8-64598c714906`, replay marker `cmp_0c7a0c5bbaa88f5b016a99953f541487d0b5c129bbe184253f`, model `gpt-5.6-sol`, timestamp `2026-09-03T15:42:46.325Z`, previous request `f9a1d80b-6853-4e19-a68c-66a68d40bfab` input=62252 cached=61184; peak prior `dd4be413-b6ca-4b63-bcaa-90e9c6a6c6a7` input=225396 cached=224896; prior high-input requests `dd4be413-b6ca-4b63-bcaa-90e9c6a6c6a7`=225396, `982a4555-eff6-43fe-80cb-b993c53cbfac`=225066, `fcda8bc8-ec14-4996-a4f6-4f7c9df93d96`=218149, `90343fc6-604d-4e99-864d-88aa40ef6e6b`=206582; replay input=23255 cached=17536 (reduction from peak=202141), later same-session wire requests: 27

| rollover phase | event time | predecessor | successor | successor session_init verified | predecessor/ successor wire requests | first/subsequent usage | before→after flags |
|---|---|---|---|---|---:|---|---|
| requested | 2026-09-05T12:31:56.419Z | `12b65fe1-a3e3-4be7-b527-9a2e8fed4135` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T11:25:53.985Z | `655d8419-3f63-41de-b9f0-3ae3172ae746` | `2ace5d82-9d5f-4cc3-b065-3c8f7aded01b` | True | 149 / 147 | 21135/0 (meta/muse-spark-1.3-contributor) + 146 subsequent | gap=17.653s, model_switch=False; before `bd08af02-18f9-40b5-8bc4-329c318914b7` → after `ce46725b-911e-4b46-9925-d986331801ae` |
| requested | 2026-09-03T12:19:32.692Z | `2ace5d82-9d5f-4cc3-b065-3c8f7aded01b` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T12:19:32.799Z | `2ace5d82-9d5f-4cc3-b065-3c8f7aded01b` | `5af2f53b-5e86-4182-bbf6-7b663a897fee` | True | 147 / 72 | 21191/0 (meta/muse-spark-1.3-contributor) + 71 subsequent | gap=35.014s, model_switch=False; before `f1df9c73-386f-41a6-b627-9f60964580dd` → after `e2ec5309-f1d3-4df7-b605-109b958fb4ed` |
| requested | 2026-09-03T07:57:59.015Z | `61cf6806-0406-4299-bad3-cd236a71aad0` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T20:54:16.664Z | `75fbce8c-b725-4f5e-9443-ba04aeb8f291` | `62b1a56a-555c-48df-8edc-31f1905e0eb2` | True | 165 / 257 | 21633/3072 (deepseek-v4-flash) + 255 subsequent | gap=7.174s, model_switch=False; before `e69ef603-e680-4133-ab60-d492ac91ee0b` → after `00db174b-6b74-4657-8453-707d13b63b1c` |
| requested | 2026-09-02T21:46:40.797Z | `62b1a56a-555c-48df-8edc-31f1905e0eb2` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-05T12:31:56.494Z | `12b65fe1-a3e3-4be7-b527-9a2e8fed4135` | `64982f3b-100d-4b86-a7d0-55851f3b873f` | True | 158 / 130 | 17809/128 (grok-4.6) + 69 subsequent | gap=15.092s, model_switch=False; before `44996046-47c8-4e07-9b9e-c5486e8c72af` → after `f3919f0f-fbdd-4cc5-9122-bea4a755d3e2` |
| requested | 2026-09-05T13:03:36.263Z | `64982f3b-100d-4b86-a7d0-55851f3b873f` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T11:02:13.842Z | `958e41ad-903f-4602-b4ef-35a86e178163` | `655d8419-3f63-41de-b9f0-3ae3172ae746` | True | 143 / 149 | 21165/0 (meta/muse-spark-1.3-contributor) + 146 subsequent | gap=33.633s, model_switch=False; before `ab535d0d-0004-4aae-a49b-fd1d927d74b0` → after `488b6d41-7c05-44b0-9076-3e5918b62bd3` |
| requested | 2026-09-03T11:25:53.926Z | `655d8419-3f63-41de-b9f0-3ae3172ae746` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T20:06:15.277Z | `7cb809c6-e2d6-4920-83c8-7722ecae4b4a` | `75fbce8c-b725-4f5e-9443-ba04aeb8f291` | True | 176 / 165 | 21717/3072 (deepseek-v4-flash) + 163 subsequent | gap=7.857s, model_switch=False; before `f26d98c0-9455-4793-86fc-90f26a1a6ddc` → after `5ca55be6-fbd6-4a74-ba23-d637f5472db4` |
| requested | 2026-09-02T20:54:16.559Z | `75fbce8c-b725-4f5e-9443-ba04aeb8f291` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T19:19:23.434Z | `8b49b1ea-9cbe-4615-8b7f-71a0422e1f26` | `7cb809c6-e2d6-4920-83c8-7722ecae4b4a` | True | 3023 / 176 | 21839/3072 (deepseek-v4-flash) + 108 subsequent | gap=10.385s, model_switch=False; before `16277ad3-c26a-4e68-b20a-e938ea7d4a57` → after `61930fae-7602-4618-89f0-8c1f37de50a2` |
| requested | 2026-09-02T20:06:15.217Z | `7cb809c6-e2d6-4920-83c8-7722ecae4b4a` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| requested | 2026-09-02T19:19:23.369Z | `8b49b1ea-9cbe-4615-8b7f-71a0422e1f26` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T10:41:58.112Z | `b5ac6f97-66f5-4e89-9511-aa097b4f6250` | `958e41ad-903f-4602-b4ef-35a86e178163` | True | 371 / 143 | 21076/0 (meta/muse-spark-1.3-contributor) + 141 subsequent | gap=23.178s, model_switch=False; before `df38ff70-3f6f-453b-abeb-9095f001850e` → after `7184539d-cc19-4ad9-9207-07e31931dfa6` |
| requested | 2026-09-03T11:02:13.784Z | `958e41ad-903f-4602-b4ef-35a86e178163` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| requested | 2026-09-02T15:05:39.580Z | `9b13aae5-b595-4a0f-bd22-06771dd3b2d4` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T15:05:39.658Z | `9b13aae5-b595-4a0f-bd22-06771dd3b2d4` | `9e6e503d-e116-4719-b171-f22cfed23632` | True | 101 / 73 | 18049/0 (gpt-5.6-luna) + 72 subsequent | gap=11.388s, model_switch=False; before `807c1f36-5e4f-46b6-98b3-e4cfd749b1bd` → after `fd16fd28-cc36-4b27-9333-f2b17796078e` |
| completed | 2026-09-03T09:23:52.284Z | `b8cdcd45-57fc-4960-9a16-b5d98fa92803` | `b5ac6f97-66f5-4e89-9511-aa097b4f6250` | True | 236 / 371 | 21102/0 (meta/muse-spark-1.3-contributor) + 357 subsequent | gap=17.25s, model_switch=False; before `9299b727-62eb-4fa7-ab47-60c4a5a11c1f` → after `879f6aef-283d-4cea-929e-0997236f69dd` |
| requested | 2026-09-03T10:41:58.049Z | `b5ac6f97-66f5-4e89-9511-aa097b4f6250` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T07:57:59.072Z | `61cf6806-0406-4299-bad3-cd236a71aad0` | `b8cdcd45-57fc-4960-9a16-b5d98fa92803` | True | 197 / 236 | 20845/0 (meta/muse-spark-1.3-contributor) + 232 subsequent | gap=10.048s, model_switch=False; before `6527a66b-5eba-4abb-9226-755c4015bb63` → after `ca0e393b-4b12-48b4-b910-88cb0a1b4fdc` |
| requested | 2026-09-03T09:23:52.225Z | `b8cdcd45-57fc-4960-9a16-b5d98fa92803` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-05T18:32:56.684Z | `f2575c89-2316-47c8-93a7-d7259667e11b` | `b9111722-8cd2-4cb1-9e9f-d7478c1fc0c8` | True | 253 / 162 | 16498/0 (glm-5.3-flash) + 161 subsequent | gap=21.608s, model_switch=False; before `6ae0c9e8-da4f-454d-b424-4f6320f0e389` → after `6170a7ab-7ae5-44d0-a5e8-986a14703762` |
| completed | 2026-09-05T13:03:36.360Z | `64982f3b-100d-4b86-a7d0-55851f3b873f` | `f214410a-23de-4eaf-a052-24fed7782288` | True | 130 / 80 | 17768/128 (grok-4.6) + 79 subsequent | gap=16.339s, model_switch=False; before `4b892c1f-2c51-49c7-adca-366c063cbcb0` → after `910e1b14-6b62-420f-ba51-cef09b74de0a` |
| requested | 2026-09-05T18:32:56.470Z | `f2575c89-2316-47c8-93a7-d7259667e11b` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T21:46:40.874Z | `62b1a56a-555c-48df-8edc-31f1905e0eb2` | `f925c980-05be-4675-922a-17503360bc9b` | True | 257 / 307 | 22030/3072 (deepseek-v4-flash) + 301 subsequent | gap=8.745s, model_switch=False; before `627ed5d7-6005-49ff-8bea-cc72b5dc9763` → after `4bf1866d-7dbd-424d-9f70-0ec7505adb6d` |

## Linked rollover size sensitivity

The current rerun verifies **14** completed links using conversation `session_init.rolloverFrom` plus traffic IDs. Historical material reported 23 accepted links; that count is not a comparable denominator here because its corpus window and metadata coverage are not retained. The current method uses same-lane predecessor/ successor records; where model class, wrapper, or request-kind metadata is absent, the lane is explicitly unattributed rather than guessed.

Usable linked size pairs: **14**; cache-observed first successors: **14**. Sum predecessor input=2961357; sum first-successor input=283857; reset-cost proxy=283857; observed size-delta proxy=2677500; cold-start delta (first successor input minus cached input)=271313. Handoff and rework cost are unknown, so these are not savings.

Relative horizon sensitivity (not a compaction break-even or policy recommendation):

Formula: `n > reset_cost / (cached_price * removed_context)`. reset_cost_proxy is the first same-lane successor input, priced at one uncached-input unit; handoff and rework costs are not logged. removed_context_proxy is max(predecessor input minus first successor input, 0); this is a size delta, not causal context removal.

| cached/uncached price ratio | usable pairs | aggregate strict horizon n | mean per-link strict horizon n |
|---:|---:|---:|---:|
| 0.01 | 14 | 10.6016 | 10.9722 |
| 0.1 | 14 | 1.0602 | 1.0972 |
| 0.25 | 14 | 0.4241 | 0.4389 |

Per-link evidence (same-lane predecessor input and first five successor requests; root identity is not established by lane matching alone; `cached=—` means usage missing):
- rollover `1c0f7619-d949-41f5-938a-55bfc7a239f7` lane `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed`: predecessor `bd08af02-18f9-40b5-8bc4-329c318914b7` input=201263 → ce46725b-911e-4b46-9925-d986331801ae input=21135 cached=0; 8848637e-18ec-46a7-bbe9-1af40da460e1 input=21391 cached=21105; 40b0ba06-5705-4aa4-9755-c6000be8cdcf input=25414 cached=21361; a843c62e-b3b8-467a-838b-2aeab33691e2 input=26518 cached=25393; 3c316f42-0715-46f6-8e20-3013d678e26f input=28671 cached=26481
- rollover `db16fb9d-0c37-4f30-a5ac-f7e24e1fb13b` lane `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed`: predecessor `f1df9c73-386f-41a6-b627-9f60964580dd` input=202158 → e2ec5309-f1d3-4df7-b605-109b958fb4ed input=21191 cached=0; ece3cf88-8533-4f16-b0cd-73c00b90417f input=21444 cached=0; 95d1ac31-a67c-4150-a7be-0682677808d3 input=26335 cached=21425; 34e27d08-de88-4f32-a90b-0044192a7f26 input=27457 cached=26289; c619250b-ee38-43fd-b07c-021d28b73679 input=30226 cached=27441
- rollover `d1bdf3a7-e00e-4575-a39d-8cf3e67b6743` lane `DeepSeek/deepseek-v4-flash/standard/unattributed`: predecessor `e69ef603-e680-4133-ab60-d492ac91ee0b` input=230787 → 00db174b-6b74-4657-8453-707d13b63b1c input=21633 cached=3072; 706b888a-44ae-4ae6-9895-fee0a480bb24 input=22182 cached=21760; 0d9f832e-07bb-4fb1-8ce6-82c9eb9eb2ad input=23842 cached=22272; 3d8ada46-6667-45d4-aab4-4adfbb29cc98 input=24288 cached=24064; fd13bddd-fb06-40ba-bb27-516f2fde8052 input=27006 cached=24448
- rollover `a8a8e06c-1e0b-48f4-911b-c55ec3dc3796` lane `grok/grok-4.6/standard/unattributed`: predecessor `44996046-47c8-4e07-9b9e-c5486e8c72af` input=254974 → f3919f0f-fbdd-4cc5-9122-bea4a755d3e2 input=17809 cached=128; fde7ef99-61b8-4dd1-bf76-7de0b222800a input=18071 cached=17792; 3e1d75b8-9b53-4bca-be2e-3835b571be0c input=27817 cached=18048; 5f70e194-fce1-4b4d-b518-263c88ed970d input=41652 cached=27776; c3e5dc3a-1d7a-4968-9ea5-90eb50ffa0ea input=49201 cached=41600
- rollover `124d762e-d43a-4fe8-8bce-433e297c8193` lane `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed`: predecessor `ab535d0d-0004-4aae-a49b-fd1d927d74b0` input=202073 → 488b6d41-7c05-44b0-9076-3e5918b62bd3 input=21165 cached=0; 10ff512d-4a8a-4886-a9c7-97eb94e616e7 input=21455 cached=0; eb5e57cd-1d37-47e4-8616-5b41735548d6 input=27611 cached=21105; 25ba0091-1ded-483a-9497-37008e1055d6 input=28858 cached=21425; 04a11993-94bf-421d-8a63-d720cd94b019 input=31256 cached=28849
- rollover `cd501606-f325-4cdf-a80b-fca4f015d0d5` lane `DeepSeek/deepseek-v4-flash/standard/unattributed`: predecessor `f26d98c0-9455-4793-86fc-90f26a1a6ddc` input=142894 → 5ca55be6-fbd6-4a74-ba23-d637f5472db4 input=21717 cached=3072; a6fa2b70-5f8b-4c47-8f7b-bf5d14af913b input=23284 cached=21888; a2eb64fd-ae56-4934-997c-443fce7ff0a1 input=24722 cached=23552; 0ef3f9a8-b0fb-4803-ad88-b51e35d1ab11 input=26734 cached=24832; 19e6a4c5-f946-4a60-b335-b8986d677554 input=27175 cached=26880
- rollover `1c613706-397e-44e3-a1d4-2d1fce6affba` lane `DeepSeek/deepseek-v4-flash/standard/unattributed`: predecessor `16277ad3-c26a-4e68-b20a-e938ea7d4a57` input=205566 → 61930fae-7602-4618-89f0-8c1f37de50a2 input=21839 cached=3072; 9596b20c-a8e8-4144-a0ca-3319876d9d4f input=22656 cached=22272; b9a470b2-8887-4104-b686-26d71d4bd117 input=23057 cached=22912; f09eb822-b313-48ea-abac-ce811110a000 input=27146 cached=23040; 7af99dc3-ab89-4b1c-9f9d-c078ea8f0811 input=30001 cached=29568
- rollover `ac6f3a3d-25a1-403e-a790-9754aa400bad` lane `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed`: predecessor `df38ff70-3f6f-453b-abeb-9095f001850e` input=300869 → 7184539d-cc19-4ad9-9207-07e31931dfa6 input=21076 cached=0; 87ae162d-2bbf-4105-9a09-57415d27ce89 input=21287 cached=0; f7c3d1ae-62ce-4a74-be01-8c152974ab15 input=24481 cached=21233; b0653342-66ef-4dd5-bafa-3b5f6fe72b1e input=28985 cached=24433; aa82b503-bbed-472a-a63f-b792f2d80de6 input=31258 cached=28977
- rollover `1009a68c-53b5-449d-91bd-5a2499715a75` lane `codex/gpt-5.6-luna/standard/OpenAIResponsesWSModel/CodexResponsesWSModel/turn`: predecessor `807c1f36-5e4f-46b6-98b3-e4cfd749b1bd` input=201590 → fd16fd28-cc36-4b27-9333-f2b17796078e input=18049 cached=0; f140c742-4363-439d-8942-f314dacab8aa input=18375 cached=17152; 7dab1da6-407e-4a84-a38b-c8d5fd2801ff input=18679 cached=18176; 117b8fd7-3b02-4d6b-9e29-a8856c8ca7fa input=18756 cached=0; 4fd7ceb3-d1f4-41cc-9489-041ecdced414 input=18995 cached=18176
- rollover `35490884-da6f-4063-9266-d759217f5637` lane `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed`: predecessor `9299b727-62eb-4fa7-ab47-60c4a5a11c1f` input=200489 → 879f6aef-283d-4cea-929e-0997236f69dd input=21102 cached=0; b09394b2-ded5-4aa4-9ad8-20d941807678 input=21420 cached=0; 7325153b-db70-4480-87c0-d799ddaf8fa5 input=21515 cached=21361; eb1b68e9-c6b1-48b3-9e28-a1c5f35ddb91 input=26133 cached=21489; ed9bdace-25f4-4533-8c2a-6279044f0f6a input=26379 cached=26097
- rollover `c34dcabe-8bf8-4f70-b7d9-7301cf7fa110` lane `openrouter/meta/muse-spark-1.3-contributor/standard/unattributed`: predecessor `6527a66b-5eba-4abb-9226-755c4015bb63` input=200975 → ca0e393b-4b12-48b4-b910-88cb0a1b4fdc input=20845 cached=0; f1a22936-490b-4ffc-94a3-d3a4f12e714d input=21131 cached=0; 22237139-6c1f-41d0-bc1f-e50d69d16651 input=21295 cached=0; e02aa737-a24f-4e07-8910-0064627fa103 input=21619 cached=21233; facb43a9-c78f-4f86-aa94-5c641acd6079 input=21863 cached=21617
- rollover `bb538098-2cc4-4aa6-945e-8b406d7d8e7c` lane `zai/glm-5.3-flash/standard/unattributed`: predecessor `6ae0c9e8-da4f-454d-b424-4f6320f0e389` input=202921 → 6170a7ab-7ae5-44d0-a5e8-986a14703762 input=16498 cached=0; 7cec8f88-c982-4fed-bbfa-52d774d9c597 input=18677 cached=7168; ceccda9b-867b-4904-abd1-847d3d1f15b0 input=19055 cached=18624; 5d7f8d9d-710c-43a0-925f-cc9f1c9d670b input=19192 cached=19008; e7d196de-3292-4d19-9527-9e0f885c31c7 input=20089 cached=19136
- rollover `3adb0a20-6ddd-4007-9438-1c5ba989492d` lane `grok/grok-4.6/standard/unattributed`: predecessor `4b892c1f-2c51-49c7-adca-366c063cbcb0` input=207474 → 910e1b14-6b62-420f-ba51-cef09b74de0a input=17768 cached=128; ce98fc98-cee0-4493-a5fc-1c5ade69fe25 input=24226 cached=17664; 55beeb88-3c43-4682-8789-90c881a5f041 input=30795 cached=24192; 860e66f0-af71-499c-9c65-7d65f0cdf32d input=35698 cached=30720; 1aa65eb2-a4d1-44e0-a910-a018a4df1f86 input=38911 cached=35584
- rollover `3aab0420-0c2c-4d08-b2d4-12a2a0e52d5a` lane `DeepSeek/deepseek-v4-flash/standard/unattributed`: predecessor `627ed5d7-6005-49ff-8bea-cc72b5dc9763` input=207324 → 4bf1866d-7dbd-424d-9f70-0ec7505adb6d input=22030 cached=3072; f073986a-68e6-4941-a848-800660cc5196 input=22507 cached=22272; dfa1b929-a959-4612-bb92-74ee92daf1c8 input=24644 cached=22528; 2a03f77c-39af-45c3-b533-4c9ca6bdb133 input=26034 cached=25216; f3fc5777-b371-40c9-8a8b-1732b36139f6 input=26524 cached=26112

## Limitations

The date-labelled app-log selection uses local wall-clock dates, while persisted and provider records use UTC. Rotations and retained corpus availability are reported by the table, not assumed. Sanitized traffic cannot recover prompt semantics, server billing rules, or omitted usage; recorded `cost` values are summed only when scalar fields exist and are never extrapolated. Same-session reuse after a replay marker is transport evidence, not proof of semantic summary fidelity. Local summary success is unavailable from retained logs, not zero. Session IDs pool root, child, and auxiliary calls; only exact retained lane metadata is used for before/after links. Rollover requests without IDs or successor `session_init.rolloverFrom` remain unresolved. Handoff/rework cost, quality, latency, workload mix, provider routing, and concurrent sessions are unknown or confounded.

Reproduce with:

```sh
python3 docs/research/context-lifecycle-economics/analyze.py --start 2026-08-31 --end 2026-09-05 --output docs/research/context-lifecycle-economics/evidence.json --report docs/research/context-lifecycle-economics.md
```
