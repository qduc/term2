# Bug: Automatic local compaction triggers well below the configured token ceiling (on the scale the user sees) and re-attempts on every request boundary when it cannot proceed

**Status:** resolved (`bfae6d47`, merged to main).
- Root Cause A addressed: `estimateContext` strips internal bookkeeping properties (`providerItem`, `providerMetadata`, `providerData`, `rawItem`) and duplicate opaque reasoning, aligning byte-derived estimates within 4–5% of real wire prompt tokens. `compactAtBoundary` and `ApplicationRunLoop` also carry forward `lastCompletedInputTokens`.
- Root Cause B addressed: blocked automatic compaction calculates `rearmAtTokens` and enforces hysteresis in `AgentClient.#boundaryCompaction` so subsequent request boundaries within the same user turn defer rather than re-triggering and re-logging.
**Severity:** medium — no data loss or corruption, but the configured `compactThresholdTokens` ceiling is enforced against an uncalibrated byte-derived estimate, so compaction fires when the provider-counted context is only ~2/3 of the configured value; and when a triggered compaction is blocked it re-triggers on every subsequent request boundary instead of backing off, producing repeated attempts, repeated warn logs, and a full re-serialization of a ~300k-estimate history per boundary.
**Component:** local (application-owned) context compaction trigger path —
`source/services/agent-runtime/context-compaction/index.ts` (`estimateContext`, `resolveCompactionThreshold`, `shouldDeferAutomaticCompaction`, `planLocalCompaction`),
`source/services/agent-runtime/context-compaction/local-context-compactor.ts` (`compactAtBoundary`, lines 205–240),
`source/lib/agent-client.ts` (`#boundaryCompaction`, lines 260–390),
`source/services/agent-runtime/application-run-loop.ts` (boundary invocation, lines 933–960).
**Observed:** 2026-09-06, interactive runs on DeepSeek `deepseek-v4-flash` with
`agent.contextCompaction` = `{ enabled: true, mode: "auto", compactThreshold: 0.8, compactThresholdTokens: 300000 }`
(`~/.local/state/term2-nodejs/settings.json`). Log evidence in `~/.local/state/term2-nodejs/logs/term2-2026-09-06.log.1` (00:56:58–00:58:22, correlation `c7b990f5`) and `term2-2026-09-06.log.14` (successful compactions 22:23:14 and 22:55:23).

## Symptom (user report)

"I saw compact trigger much sooner than the token threshold in setting." On a long-running DeepSeek session, local context compaction activity began while the context readout the user sees (the status-bar gauge, which shows provider-reported `prompt_tokens` of the last request — `source/components/layout/StatusBar.tsx:315–321`) was far below the configured 300,000-token ceiling, and it repeated at nearly every turn boundary instead of firing once.

## Root cause A — the ceiling is enforced against a byte estimate that runs ~1.5× ahead of real tokens

The automatic trigger compares the app's own estimate, not the model's token count:

```ts
// index.ts:82–96 (estimateContext)
renderedInputTokens = Math.ceil(renderedBytes / 4)   // JSON bytes ÷ 4
// local-context-compactor.ts:216 (compactAtBoundary)
if (!input.manual && estimate.renderedInputTokens < threshold.effectiveThreshold) return not_needed;
```

`renderedBytes` is `Buffer.byteLength(JSON.stringify(projectModelRequestHistory(history)))` — the whole serialized provider-input history, JSON envelope included (quotes, key names, commas, `\n` escapes, per-item application fields such as `callId`/`toolName`/`status`/`providerItem` nesting, and provider-opaque reasoning blobs), counted at a prose-calibrated 4 bytes/token. The wire request the provider tokenizes is a *projection* of that history, and a real tokenizer groups structure differently than raw byte length ÷ 4. On JSON-heavy agent transcripts the estimate systematically overshoots the provider count.

Measured on 2026-09-06 (`term2-2026-09-06.log.1`), the same minute that automatic compaction began:

| time | record | app estimate (`renderedInputTokens`) | provider `prompt_tokens` |
| --- | --- | --- | --- |
| 00:56:58 | blocked-compaction warn (corr `c7b990f5`) | 303,182 | — |
| 00:56:58 | streaming-usage record (nearest same-minute sample) | — | 202,996 |

Ratio ≈ 1.5× (303k est vs ~203k counted). Caveat: the usage record carries a different log `correlationId` (`3a530b62`) than the compaction warn, so the pairing is directional, not a controlled same-request measurement; the structural inflation is independently clear from the code above. Earlier same-window samples trend the same way (160,742 at 00:51:13; 168,917 at 00:51:56; provider count climbing toward the estimate at ~1.5–1.9× behind).

Why this reads as "fires sooner than the setting": the setting UI text describes the ceiling in tokens, the plan contract calls it "an optional raw estimated-token ceiling" (`docs/plans/provider-neutral-context-compaction.md`), but the number the user compares against — the gauge, and any mental model of "tokens the model actually sees" — is the provider count. The app fires at 300k *estimate* ≈ 200k *real* tokens.

The plan for the OpenAI native lane already lists exactly this calibration as future work: "estimator calibration at zero cost. Recorded traffic carries real usage" (`docs/plans/openai-context-compaction.md:788`). The local lane has the same uncalibrated estimator and no calibration work was done for it.

## Root cause B — a blocked automatic trigger does not re-arm, so it re-fires on every request boundary

The hysteresis mechanism only works after a *successful* compaction:

```ts
// index.ts:174–186
rearmAtTokens = post + max(8000, ceil(effectiveThreshold * 0.10))   // written into the checkpoint
shouldDeferAutomaticCompaction: defers when checkpoint.rearmAtEstimatedTokens exists and estimate < rearmAt
```

The `rearmAt` value lives on the context-summary checkpoint, which is created **only** in the `compacted` outcome (`local-context-compactor.ts:277–297`). When automatic compaction triggers but `planLocalCompaction` blocks — on this history with `no_complete_cold_turn` (fewer than three genuine user turns / no older completed turn to cut; `index.ts:126–140`) — no checkpoint is written, no rearm exists, and `automaticCompactionsThisRun` is only incremented on `compacted` (`application-run-loop.ts:951`). The run loop evaluates the boundary compactor before *every* next model request within and across turns (`application-run-loop.ts:933–935`), so the next boundary re-crosses the threshold and tries again.

Evidence — fourteen consecutive attempts in 90 seconds, all blocked, all above the ceiling, estimate climbing each time (`term2-2026-09-06.log.1`, corr `c7b990f5`, model `deepseek-v4-flash`):

```
00:56:58  renderedInputTokens=303182  reason=no_complete_cold_turn
00:57:13  renderedInputTokens=304249  reason=no_complete_cold_turn
00:57:20  renderedInputTokens=304600  reason=no_complete_cold_turn
00:57:33  renderedInputTokens=305330  reason=no_complete_cold_turn
00:57:36  renderedInputTokens=306186  reason=no_complete_cold_turn
00:57:53  renderedInputTokens=307597  reason=no_complete_cold_turn
00:57:57  renderedInputTokens=310336  reason=no_complete_cold_turn
00:58:01  renderedInputTokens=310988  reason=no_complete_cold_turn
00:58:05  renderedInputTokens=312583  reason=no_complete_cold_turn
00:58:19  renderedInputTokens=314748  reason=no_complete_cold_turn
00:58:22  renderedInputTokens=315085  reason=no_complete_cold_turn
```

(Full set: 28 `"Local context compaction blocked; continuing with uncompacted history"` warn records for this model in `log.1` alone.) The warn is emitted per attempt (`agent-client.ts:362–367`); the human-facing notice text for `no_complete_cold_turn` is deduped per run (`compactionNotice`, `application-run-loop.ts:965–966`), but the repeated attempts are otherwise visible as repeated compaction activity. Each attempt also re-serializes the full ~300k-estimate history for the estimate and plan (`compactAtBoundary` → `estimateContext` + `planLocalCompaction`), which is pure overhead at every request boundary once the ceiling is crossed on an un-compactable history. Note: `hasCompleteNewUserTurn` is hard-coded `true` in the boundary caller (`agent-client.ts:340`), so the hysteresis branch that waits for a genuinely new user turn is inert on this path.

## What was ruled out

- **The ratio gate beating the token ceiling (`effectiveThreshold = min(0.8 × window, tokens)`; `index.ts:48–57`).** Not the cause here: the catalog lists `deepseek/deepseek-v4-flash` with `contextWindow: 1024000` (`source/providers/model-catalog/catalog.generated.ts:832–838`), so `0.8 × 1,024,000 = 819,200 > 300,000` and the token setting is the binding gate. The `min(...)` can silently cap a token ceiling only on models with `contextWindow ≤ tokens / compactThreshold` (≤ 375k for a 300k ceiling at 0.8) — worth stating in the report because it is the other way a ceiling "fires early," but it is not what happened in the observed run.
- **Native/provider-side compaction.** DeepSeek has no inline `context_management` capability; mode `auto` falls through to the local compactor (`agent-client.ts:275–306`). The observed events are all the local lane.
- **Instructions/tool schemas inflating the estimate.** The boundary path calls `compactAtBoundary` without `instructions`/`tools` (`agent-client.ts:326–346`), so `estimateContext` measures history only — the inflation comes from the history serialization itself, not from the system prompt or tool definitions.
- **`context_compaction_hard_fit` refusal.** None of the observed attempts failed with a hard-fit error; they blocked at planning time before any summarizer call, which is why they cost CPU/serialization but no model spend.
- **Per-run cap.** `shouldDeferAutomaticCompaction` caps at one automatic compaction per *run*, and the counter increments only on success, so it provides no protection across the successive boundaries that each re-trigger here.

## Impact

- **Misleading threshold semantics.** `compactThresholdTokens` is presented (and read by users) as a token ceiling, but it is enforced against an estimate that runs ~1.5× hot on real transcripts. Compaction — and its summarization cost — begins when the conversation is only ~2/3 of the configured size by the provider's own count, and the status gauge the user watches disagrees with the trigger by the same factor.
- **Repeat-trigger loop on un-compactable histories.** Long-running sessions whose shape cannot be compacted (few complete user turns — typical of long autonomous/background work) re-trigger and re-warn at every request boundary after crossing the ceiling, with a full-history re-serialization per boundary.
- **Compaction quality/cost.** Early compaction discards cold context sooner than the user configured, at a summarizer call per successful attempt.

## Suggested fix directions (not implemented; each needs its own worktree + regression test per repo convention)

1. **Calibrate `estimateContext` against real usage** (fixes root cause A). Recorded provider traffic carries exact `prompt_tokens`; fit a per-lane bytes→tokens factor (or use a real tokenizer where available) so the trigger and the gauge agree. The OpenAI-native plan doc already scopes this as future work (`openai-context-compaction.md:788`); the local lane should inherit it. Minimal regression test: given a fixture history whose provider-counted usage is known (from provider-traffic capture), assert `estimateContext(...).renderedInputTokens` is within a small tolerance of the recorded usage — today it is ~1.5× high.
2. **Rearm on blocked automatic attempts** (fixes root cause B). When automatic compaction triggers but planning blocks, write a transient back-off so the next boundaries defer — e.g. reuse the rearm formula (`rearmAtTokens` ≈ estimate + max(8k, 10% of effectiveThreshold)) and/or require a new complete user turn (the `hasCompleteNewUserTurn` hysteresis the boundary caller currently hard-codes to `true`). Regression test: a history that yields `no_complete_cold_turn` must produce exactly one trigger/block per N boundaries instead of one per boundary.
3. **Log/notice hygiene.** The blocked warn is per-attempt (`agent-client.ts:362–367`); once re-arm exists, attempts collapse naturally, but the warn could also carry the next-retry estimate to make the back-off legible.

## Reproduction sketch (unit-level, no live provider needed)

1. `resolveCompactionThreshold({ contextWindow: 1_024_000, compactThreshold: 0.8, compactThresholdTokens: 300_000 })` → `effectiveThreshold: 300_000`, source `tokens` (ratio gate ruled out).
2. Build a long `ProviderInputItem[]` history that is un-compactable (`planLocalCompaction` → `no_complete_cold_turn`, e.g. one long multi-round turn with < 3 genuine user messages) and whose serialized bytes ÷ 4 exceed 300k. `compactAtBoundary` with the settings above returns `blocked`/notice — and a second call over the same history with `automaticCompactionsThisRun: 0` triggers again (no re-arm). See the log sequence in Root cause B for the live shape of that loop.
3. Provider-counted comparison: the same history re-serialized as the lane's actual wire messages and tokenized (or matched to recorded usage) counts ~1.5× fewer tokens than the estimate.
