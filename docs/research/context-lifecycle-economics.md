# Context-lifecycle economics (retained local evidence)

Window: **2026-08-31 through 2026-09-05** (inclusive).

## Method and boundaries

The standalone `analyze.py` reads provider-traffic JSON one file at a time, app JSONL rotations, and persisted conversation JSONL. Requests are deduplicated by the `(sent.requestId, sent.sessionId)` identity; index files are not counted. No prompts, previews, tool arguments, headers, response text, or ciphertext are emitted. Wire timestamps are UTC; app timestamps are local wall-clock labels. These are observations, not causal savings or policy thresholds.

## Coverage

| date | files | complete | usage | cache field | recorded cost | parse errors | duplicate request IDs |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-08-31 | 1340 | 1301 | 1301 / 39 missing | 1301 / 39 missing | 234 | 0 | 0 |
| 2026-09-01 | 4310 | 4251 | 4251 / 59 missing | 4251 / 59 missing | 609 | 0 | 0 |
| 2026-09-02 | 6399 | 6359 | 6358 / 41 missing | 6358 / 41 missing | 368 | 0 | 0 |
| 2026-09-03 | 3819 | 3702 | 3702 / 13 missing | 3702 / 13 missing | 2203 | 0 | 0 |
| 2026-09-04 | 2346 | 2308 | 2307 / 39 missing | 2278 / 68 missing | 17 | 0 | 0 |
| 2026-09-05 | 4671 | 4442 | 4441 / 230 missing | 4441 / 230 missing | 518 | 0 | 0 |

Deduplicated traffic requests: **22781**. Wire shapes: `{"chat_completions": 9392, "responses": 1184, "text": 3, "unknown": 312, "websocket": 11787}`. Structural traffic classification: `{"incomplete_or_error": 418, "native_compaction_reset": 1, "ordinary": 22362}` (the `summarizer_request` count is therefore explicit, including zero). App compaction-trigger records are reported separately below; their text is not used as a traffic request classification.

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
| `DeepSeek/deepseek-v4-flash` | 2837 | 330581691 | 330581691 | 319200640 | 2758280 | 0.9656 | 0.9541 | — |
| `DeepSeek/deepseek-v4-flash-vision-exp` | 337 | 35586123 | 35586123 | 34254976 | 264276 | 0.9626 | 0.9610 | — |
| `Neuralwatt/kimi-k3-flex` | 10 | 53617 | 53617 | 0 | 61279 | 0.0000 | 0.0000 | — |
| `Neuralwatt/qwen-3.8-27b` | 19 | 849341 | 849341 | 391200 | 9498 | 0.4606 | 0.4522 | — |
| `Neuralwatt/qwen3.6-35b-fast` | 212 | 528503 | 528503 | 10560 | 36543 | 0.0200 | 0.0232 | — |
| `codex/gpt-5.6-luna` | 9701 | 826145077 | 826145077 | 796511232 | 2696360 | 0.9641 | 0.9279 | — |
| `codex/gpt-5.6-sol` | 1686 | 211829494 | 211829494 | 204713472 | 567798 | 0.9664 | 0.9404 | — |
| `codex/gpt-6-astra` | 400 | 35887854 | 35887854 | 34362880 | 123393 | 0.9575 | 0.9244 | — |
| `grok/grok-4.6` | 535 | 76547807 | 76547807 | 71695232 | 426819 | 0.9366 | 0.8990 | cost_in_usd_ticks:533/106517651400 |
| `opencode/deepseek-v4-flash` | 408 | 26323411 | 25985241 | 25441280 | 380252 | 0.9791 | 0.9668 | — |
| `opencode/glm-5.3-flash` | 406 | 13264502 | 13089388 | 11921728 | 152705 | 0.9108 | 0.8574 | — |
| `opencode/gpt-5.6-luna` | 48 | 3322779 | 3322779 | 3128043 | 11804 | 0.9414 | 0.9002 | — |
| `opencode/muse-spark-1.3-contributor` | 600 | 40993074 | 40993074 | 39253244 | 281064 | 0.9576 | 0.9162 | — |
| `openrouter/anthropic/claude-opus-5` | 11 | 422867 | 422867 | 363831 | 4363 | 0.8604 | 0.8349 | cost:11/0.65333862 |
| `openrouter/anthropic/claude-sonnet-5` | 17 | 477477 | 477477 | 420711 | 3744 | 0.8811 | 0.8927 | cost:17/0.260845398 |
| `openrouter/deepseek/deepseek-v4-flash` | 33 | 1102906 | 1102906 | 632064 | 12225 | 0.5731 | 0.5020 | cost:33/0.04990378297489201 |
| `openrouter/deepseek/deepseek-v4-flash-0731` | 300 | 27404473 | 27404473 | 26015268 | 273615 | 0.9493 | 0.9013 | cost:300/0.03254600646 |
| `openrouter/google/gemini-3.8-flash` | 105 | 9087007 | 9087007 | 8612064 | 16906 | 0.9477 | 0.9221 | cost:105/0.5274272272500001 |
| `openrouter/meta/muse-spark-1.2-contributor` | 30 | 1525782 | 1525782 | 1065590 | 34796 | 0.6984 | 0.6461 | cost:30/0.05455848419999999 |
| `openrouter/meta/muse-spark-1.3-contributor` | 2160 | 325778034 | 325778034 | 290463070 | 1497194 | 0.8916 | 0.8690 | cost:2160/4.367742726600001 |
| `openrouter/z-ai/glm-5.3` | 11 | 60958 | 60958 | 0 | 115294 | 0.0000 | 0.0000 | cost:11/0.5064174423000001 |
| `openrouter/z-ai/glm-5.3-flash` | 438 | 32621830 | 32621830 | 30538304 | 358633 | 0.9361 | 0.8968 | cost:438/1.1308982624428499 |
| `openrouter/z-ai/glm-5.3-flash:nitro` | 152 | 15391935 | 15391935 | 14837248 | 72014 | 0.9640 | 0.9526 | cost:152/0.55867571607276 |
| `openrouter/~deepseek/deepseek-v4-flash-latest` | 159 | 11751134 | 11751134 | 11150516 | 177249 | 0.9489 | 0.9238 | cost:159/0.02368924074 |
| `zai/glm-5.3-flash` | 1747 | 141410824 | 141410824 | 135613120 | 1466071 | 0.9590 | 0.9227 | — |

Input-size buckets (ordinary requests):

| bucket | requests | input | cache-observed input | cached | weighted ratio | mean per-request ratio |
|---|---:|---:|---:|---:|---:|---:|
| <8k | 275 | 913630 | 913630 | 159793 | 0.1749 | 0.0981 |
| 8-32k | 3431 | 73120739 | 72607455 | 58173251 | 0.8012 | 0.7736 |
| 32-64k | 4661 | 225977551 | 225977551 | 209282736 | 0.9261 | 0.9236 |
| 64-128k | 7705 | 716500395 | 716500395 | 686883929 | 0.9587 | 0.9576 |
| 128k+ | 6287 | 1152436185 | 1152436185 | 1106096564 | 0.9598 | 0.9617 |

### Relative input-price sensitivity

Ordinary input totals: **2168948500** tokens; cache-observed denominator: **2168435216** across 22330 requests; cache-field-missing input: **513284**. Ratios below use only the cache-observed denominator, never treating missing cache as zero. The counterfactual relative cost at cached/uncached price ratios is `{"0": 0.04973122655650508, "0.1": 0.14475810390085458, "0.25": 0.2872984199173788, "0.5": 0.5248656132782525, "1": 1.0}`. Formula: `relative input cost = uncached_fraction + cached_fraction * (cached_price / uncached_price); counterfactual only`. This is not a provider bill, does not establish that compaction caused savings, and does not assume cached tokens are free: at ratio 0.1 they still contribute 10% of uncached unit price; at ratio 1 there is no input-cost difference. Any positive reduction requires cached unit price < uncached unit price; there is no break-even monetary price in this corpus without a complete provider price schedule.

## Session growth and boundary flags

Sessions with traffic: **332**. Edges with >6-hour gap: **1**; model-switch edges: **1267**. These flags mark confounding boundaries rather than imputing continuity. Top sessions by request count:

- `8b49b1ea-9cbe-4615-8b7f-71a0422e1f26`: 3023 requests (2026-09-02:3023), input 227040917 tokens, models `deepseek-v4-flash, gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-02T16:52:39.054Z`, last `2026-09-02T19:19:13.085Z`, request IDs `ba70d770-129a-4803-b879-dc678d0d4ccd, 31a684bb-55a8-4236-9d5c-61a227f78095, 95636939-88f5-443b-9db8-f2b6e17be729`
- `39c81dd0-a6c5-4e13-9a21-e3cd18e005b0`: 790 requests (2026-09-03:790), input 151324804 tokens, models `meta/muse-spark-1.3-contributor, qwen3.6-35b-fast`, first `2026-09-03T00:53:55.604Z`, last `2026-09-03T06:41:10.722Z`, request IDs `23aca168-382b-4a20-b71e-2ac049da9fd4, 2dca8036-87ae-40e3-a686-1d120040dac7, b63aeff9-a717-4f98-8f60-51cb67f73c79`
- `6760346e-a877-4c90-a00a-d7ae32eeee83`: 619 requests (2026-09-01:619), input 65499430 tokens, models `gpt-5.6-sol, gpt-5.6-luna, z-ai/glm-5.3, kimi-k3-flex, qwen3.6-35b-fast`, first `2026-09-01T01:57:07.805Z`, last `2026-09-01T02:55:00.012Z`, request IDs `0a9b63da-8796-4f1f-917c-5c9d61727f45, 37689b63-ae36-49b8-9e55-d401ee5a80f1, 8cc033f8-1ca2-43b6-a971-637171eed3c8`
- `4e386624-6ea0-420f-afce-51c56c2c99c6`: 481 requests (2026-09-05:481), input 60626588 tokens, models `gpt-6-astra, gpt-5.6-luna, gpt-5.6-sol, z-ai/glm-5.3, kimi-k3-flex`, first `2026-09-05T06:39:48.340Z`, last `2026-09-05T07:08:13.154Z`, request IDs `ae298edc-6612-45ff-ba7f-61895eb97329, 66013879-c9e6-4c2b-8593-28bb277072bc, 24347461-9bef-48c6-bbd6-56aa60a1ea90`
- `d07eda2f-582d-4703-88d9-e6cfbc43377d`: 391 requests (2026-09-05:391), input 52552829 tokens, models `deepseek-v4-flash, gpt-5.6-luna`, first `2026-09-05T08:08:23.820Z`, last `2026-09-05T11:11:29.841Z`, request IDs `f89fce4e-5d3d-47f4-aa1d-b34bbc63b30a, d6492926-6318-4ee7-ab2b-6b2b7b5a3eb4, 46f8e9a0-6e0c-439f-a61b-5302571eccf5`
- `b5ac6f97-66f5-4e89-9511-aa097b4f6250`: 371 requests (2026-09-03:371), input 59148987 tokens, models `meta/muse-spark-1.3-contributor, qwen3.6-35b-fast, gpt-5.6-luna`, first `2026-09-03T09:23:52.321Z`, last `2026-09-03T10:41:34.965Z`, request IDs `879f6aef-283d-4cea-929e-0997236f69dd, b09394b2-ded5-4aa4-9ad8-20d941807678, 7325153b-db70-4480-87c0-d799ddaf8fa5`
- `1f5d382f-7d6f-4b40-a3bb-07bbf597ec62`: 332 requests (2026-09-01:332), input 28700404 tokens, models `gpt-5.6-sol, gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-01T02:55:48.291Z`, last `2026-09-01T04:05:55.217Z`, request IDs `71d8a711-6b90-483c-81f5-fa1ced9110eb, 681ff0bb-bde4-4d15-addc-ab91dbb9d147, 7df2e51b-e456-4737-bd9e-9a2978515718`
- `ccf9f945-6123-4e4a-9fb1-6375927f1780`: 325 requests (2026-09-01:325), input 25065811 tokens, models `gpt-5.6-sol, gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-01T06:14:26.543Z`, last `2026-09-01T07:24:17.921Z`, request IDs `34e2fea9-5eef-46c3-9468-b839d1eb014c, a83f4613-3b15-434b-8632-9dddcd0d72ce, e0dc174f-0f38-405b-8263-8ea6551a3062`
- `841dc37d-3873-4e04-832a-fd21a30d2458`: 314 requests (2026-09-05:314), input 39240626 tokens, models `deepseek-v4-flash`, first `2026-09-05T17:42:38.176Z`, last `2026-09-05T18:59:23.816Z`, request IDs `9379e983-aef4-47ae-9001-8c79eb2fc742, 11095743-b2c1-4ad6-a185-955760f5f4fb, dd47b348-eb19-47d4-9325-4ab21a89a8dc`
- `860f4aed-9dcd-4bed-b908-afa5c95690c9`: 307 requests (2026-08-31:307), input 32936904 tokens, models `gpt-5.6-sol, gpt-5.6-luna`, first `2026-08-31T01:24:40.743Z`, last `2026-08-31T02:21:30.556Z`, request IDs `ba9b68af-2e92-477e-b255-92ef983fb7ec, 10d64007-b3be-4e54-9466-a169e5897c71, ef0ef5b8-5fb5-4706-a534-c85c0bff1d69`
- `f925c980-05be-4675-922a-17503360bc9b`: 307 requests (2026-09-02:231, 2026-09-03:76), input 39749118 tokens, models `deepseek-v4-flash, qwen3.6-35b-fast`, first `2026-09-02T21:46:40.935Z`, last `2026-09-03T00:34:54.811Z`, request IDs `4bf1866d-7dbd-424d-9f70-0ec7505adb6d, f073986a-68e6-4941-a848-800660cc5196, dfa1b929-a959-4612-bb92-74ee92daf1c8`
- `2f8e4589-1f15-4dd9-824d-9efd75c91fb8`: 295 requests (2026-09-03:295), input 20450715 tokens, models `gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-03T09:10:49.827Z`, last `2026-09-03T09:37:29.847Z`, request IDs `15376232-de8d-4f1a-9c88-691a55918b0b, eb846815-acc5-4749-ac89-213cfaa1f5b8, 817558d6-2cd5-4dd2-a931-515c8c6e440e`
- `c2455dcf-0721-4656-bd36-50be3d7be0d7`: 285 requests (2026-09-02:285), input 40083190 tokens, models `gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-02T13:31:52.296Z`, last `2026-09-02T14:18:36.400Z`, request IDs `5a88d9d4-6e65-4c29-964b-a506665d4ea9, 3a4cb414-7184-4125-ab29-9e6bf9fab625, 81939780-062f-4409-ac49-21ff6014c864`
- `72a7c0c2-23fc-478b-9470-58d48345454a`: 283 requests (2026-09-01:283), input 16754986 tokens, models `deepseek-v4-flash, gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-01T18:05:05.106Z`, last `2026-09-01T19:08:44.245Z`, request IDs `12c82b8d-805f-47f6-baca-d2eed8655a5e, c7da9b63-a298-4aca-b6e0-9b95ae833227, 12c2edf9-fbee-4334-b778-c6b0cb779f21`
- `9bff1663-d877-4adc-b910-6353980a40f5`: 280 requests (2026-09-01:280), input 28168701 tokens, models `gpt-5.6-sol, gpt-5.6-luna, qwen3.6-35b-fast`, first `2026-09-01T07:29:05.095Z`, last `2026-09-01T08:10:23.704Z`, request IDs `0e808d12-653d-4bf6-95d3-c8eec027fea5, dfdc593d-25e3-4cfe-9f56-0e655e5547e1, e42ade66-520a-4ecc-8d5d-cda502dc143c`

## Compaction and rollover evidence

App structured messages: `{"local_compaction_drop": 14, "native_compaction_failed": 245}`. Persisted structured compaction event types: `{}`. A failed native compact endpoint is not a reset. Native wire reset items: **1**; each is linked to later same-session wire requests only when the request envelope contained a structural `type: compaction` item. Verified completed rollover predecessor→successor links: **14**.

Native reset artifact/request IDs and downstream reuse:
- session `d34982b2-2bd2-47a3-9b36-2972d435d49c`, request `c9a09af6-97b4-4761-b0c8-64598c714906`, compaction item `cmp_0c7a0c5bbaa88f5b016a99953f541487d0b5c129bbe184253f`, model `gpt-5.6-sol`, timestamp `2026-09-03T15:42:46.325Z`, previous request `f9a1d80b-6853-4e19-a68c-66a68d40bfab` input=62252 cached=61184; peak prior `dd4be413-b6ca-4b63-bcaa-90e9c6a6c6a7` input=225396 cached=224896; prior high-input requests `dd4be413-b6ca-4b63-bcaa-90e9c6a6c6a7`=225396, `982a4555-eff6-43fe-80cb-b993c53cbfac`=225066, `fcda8bc8-ec14-4996-a4f6-4f7c9df93d96`=218149, `90343fc6-604d-4e99-864d-88aa40ef6e6b`=206582; reset input=23255 cached=17536 (reduction from peak=202141), later same-session wire requests: 27

| rollover phase | event time | predecessor | successor | successor session_init verified | predecessor/ successor wire requests | first/subsequent usage | before→after flags |
|---|---|---|---|---|---:|---|---|
| requested | 2026-09-05T12:31:56.419Z | `12b65fe1-a3e3-4be7-b527-9a2e8fed4135` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T11:25:53.985Z | `655d8419-3f63-41de-b9f0-3ae3172ae746` | `2ace5d82-9d5f-4cc3-b065-3c8f7aded01b` | True | 149 / 147 | 21135/0 (meta/muse-spark-1.3-contributor) + 146 subsequent | gap=17.653s, model_switch=False; before `bd08af02-18f9-40b5-8bc4-329c318914b7` → after `ce46725b-911e-4b46-9925-d986331801ae` |
| requested | 2026-09-03T12:19:32.692Z | `2ace5d82-9d5f-4cc3-b065-3c8f7aded01b` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T12:19:32.799Z | `2ace5d82-9d5f-4cc3-b065-3c8f7aded01b` | `5af2f53b-5e86-4182-bbf6-7b663a897fee` | True | 147 / 72 | 21191/0 (meta/muse-spark-1.3-contributor) + 71 subsequent | gap=35.014s, model_switch=False; before `f1df9c73-386f-41a6-b627-9f60964580dd` → after `e2ec5309-f1d3-4df7-b605-109b958fb4ed` |
| requested | 2026-09-03T07:57:59.015Z | `61cf6806-0406-4299-bad3-cd236a71aad0` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T20:54:16.664Z | `75fbce8c-b725-4f5e-9443-ba04aeb8f291` | `62b1a56a-555c-48df-8edc-31f1905e0eb2` | True | 165 / 257 | 21633/3072 (deepseek-v4-flash) + 256 subsequent | gap=7.174s, model_switch=False; before `e69ef603-e680-4133-ab60-d492ac91ee0b` → after `00db174b-6b74-4657-8453-707d13b63b1c` |
| requested | 2026-09-02T21:46:40.797Z | `62b1a56a-555c-48df-8edc-31f1905e0eb2` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-05T12:31:56.494Z | `12b65fe1-a3e3-4be7-b527-9a2e8fed4135` | `64982f3b-100d-4b86-a7d0-55851f3b873f` | True | 158 / 130 | 17809/128 (grok-4.6) + 129 subsequent | gap=15.092s, model_switch=False; before `44996046-47c8-4e07-9b9e-c5486e8c72af` → after `f3919f0f-fbdd-4cc5-9122-bea4a755d3e2` |
| requested | 2026-09-05T13:03:36.263Z | `64982f3b-100d-4b86-a7d0-55851f3b873f` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T11:02:13.842Z | `958e41ad-903f-4602-b4ef-35a86e178163` | `655d8419-3f63-41de-b9f0-3ae3172ae746` | True | 143 / 149 | 21165/0 (meta/muse-spark-1.3-contributor) + 148 subsequent | gap=33.633s, model_switch=False; before `ab535d0d-0004-4aae-a49b-fd1d927d74b0` → after `488b6d41-7c05-44b0-9076-3e5918b62bd3` |
| requested | 2026-09-03T11:25:53.926Z | `655d8419-3f63-41de-b9f0-3ae3172ae746` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T20:06:15.277Z | `7cb809c6-e2d6-4920-83c8-7722ecae4b4a` | `75fbce8c-b725-4f5e-9443-ba04aeb8f291` | True | 176 / 165 | 21717/3072 (deepseek-v4-flash) + 164 subsequent | gap=7.857s, model_switch=False; before `f26d98c0-9455-4793-86fc-90f26a1a6ddc` → after `5ca55be6-fbd6-4a74-ba23-d637f5472db4` |
| requested | 2026-09-02T20:54:16.559Z | `75fbce8c-b725-4f5e-9443-ba04aeb8f291` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T19:19:23.434Z | `8b49b1ea-9cbe-4615-8b7f-71a0422e1f26` | `7cb809c6-e2d6-4920-83c8-7722ecae4b4a` | True | 3023 / 176 | 21839/3072 (deepseek-v4-flash) + 175 subsequent | gap=10.385s, model_switch=False; before `16277ad3-c26a-4e68-b20a-e938ea7d4a57` → after `61930fae-7602-4618-89f0-8c1f37de50a2` |
| requested | 2026-09-02T20:06:15.217Z | `7cb809c6-e2d6-4920-83c8-7722ecae4b4a` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| requested | 2026-09-02T19:19:23.369Z | `8b49b1ea-9cbe-4615-8b7f-71a0422e1f26` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T10:41:58.112Z | `b5ac6f97-66f5-4e89-9511-aa097b4f6250` | `958e41ad-903f-4602-b4ef-35a86e178163` | True | 371 / 143 | 21076/0 (meta/muse-spark-1.3-contributor) + 142 subsequent | gap=23.178s, model_switch=False; before `df38ff70-3f6f-453b-abeb-9095f001850e` → after `7184539d-cc19-4ad9-9207-07e31931dfa6` |
| requested | 2026-09-03T11:02:13.784Z | `958e41ad-903f-4602-b4ef-35a86e178163` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| requested | 2026-09-02T15:05:39.580Z | `9b13aae5-b595-4a0f-bd22-06771dd3b2d4` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T15:05:39.658Z | `9b13aae5-b595-4a0f-bd22-06771dd3b2d4` | `9e6e503d-e116-4719-b171-f22cfed23632` | True | 101 / 73 | 18049/0 (gpt-5.6-luna) + 72 subsequent | gap=11.388s, model_switch=False; before `807c1f36-5e4f-46b6-98b3-e4cfd749b1bd` → after `fd16fd28-cc36-4b27-9333-f2b17796078e` |
| completed | 2026-09-03T09:23:52.284Z | `b8cdcd45-57fc-4960-9a16-b5d98fa92803` | `b5ac6f97-66f5-4e89-9511-aa097b4f6250` | True | 236 / 371 | 21102/0 (meta/muse-spark-1.3-contributor) + 370 subsequent | gap=17.25s, model_switch=False; before `9299b727-62eb-4fa7-ab47-60c4a5a11c1f` → after `879f6aef-283d-4cea-929e-0997236f69dd` |
| requested | 2026-09-03T10:41:58.049Z | `b5ac6f97-66f5-4e89-9511-aa097b4f6250` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-03T07:57:59.072Z | `61cf6806-0406-4299-bad3-cd236a71aad0` | `b8cdcd45-57fc-4960-9a16-b5d98fa92803` | True | 197 / 236 | 20845/0 (meta/muse-spark-1.3-contributor) + 235 subsequent | gap=10.048s, model_switch=False; before `6527a66b-5eba-4abb-9226-755c4015bb63` → after `ca0e393b-4b12-48b4-b910-88cb0a1b4fdc` |
| requested | 2026-09-03T09:23:52.225Z | `b8cdcd45-57fc-4960-9a16-b5d98fa92803` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-05T18:32:56.684Z | `f2575c89-2316-47c8-93a7-d7259667e11b` | `b9111722-8cd2-4cb1-9e9f-d7478c1fc0c8` | True | 253 / 162 | 16498/0 (glm-5.3-flash) + 161 subsequent | gap=21.608s, model_switch=False; before `6ae0c9e8-da4f-454d-b424-4f6320f0e389` → after `6170a7ab-7ae5-44d0-a5e8-986a14703762` |
| completed | 2026-09-05T13:03:36.360Z | `64982f3b-100d-4b86-a7d0-55851f3b873f` | `f214410a-23de-4eaf-a052-24fed7782288` | True | 130 / 80 | 17768/128 (grok-4.6) + 79 subsequent | gap=16.339s, model_switch=False; before `4b892c1f-2c51-49c7-adca-366c063cbcb0` → after `910e1b14-6b62-420f-ba51-cef09b74de0a` |
| requested | 2026-09-05T18:32:56.470Z | `f2575c89-2316-47c8-93a7-d7259667e11b` | `None` | False | 0 / 0 | no wire request | gap=—s, model_switch=False; before `—` → after `—` |
| completed | 2026-09-02T21:46:40.874Z | `62b1a56a-555c-48df-8edc-31f1905e0eb2` | `f925c980-05be-4675-922a-17503360bc9b` | True | 257 / 307 | 22030/3072 (deepseek-v4-flash) + 306 subsequent | gap=8.745s, model_switch=False; before `627ed5d7-6005-49ff-8bea-cc72b5dc9763` → after `4bf1866d-7dbd-424d-9f70-0ec7505adb6d` |

## Limitations

The date-labelled app-log selection uses local wall-clock dates, while persisted and provider records use UTC. Rotations and retained corpus availability are reported by the table, not assumed. Sanitized traffic cannot recover prompt semantics, server billing rules, or omitted usage; recorded `cost` values are summed only when scalar fields exist and are never extrapolated. Same-session reuse after a reset is transport evidence, not proof of semantic summary fidelity. Rollover requests without IDs or successor `session_init.rolloverFrom` remain unresolved. Gap/model-switch flags, workload mix, provider routing, and concurrent sessions confound any before/after interpretation.

Reproduce with:

```sh
python3 docs/research/context-lifecycle-economics/analyze.py --start 2026-08-31 --end 2026-09-05 --output docs/research/context-lifecycle-economics/evidence.json --report docs/research/context-lifecycle-economics.md
```
