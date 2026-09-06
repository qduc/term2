# Real-world log audit: run_code, session rollover, and compaction

Date: 2026-09-05. Read-only implementation investigation; no source changes or live experiments. Current checkout inspected at `181c9f9b`. Times below are UTC unless explicitly marked local (UTC+7).

## Assessment

The concern is justified, but the three features have different problems:

- **Compaction has the strongest demonstrated runtime defect:** repeated rejected Codex compaction requests consume time without reducing history. Today's merged request-shape fix addresses the observed 400s; the surrounding retry/fallback policy still permits repeated failures. Local compaction also cannot help a long task before enough genuine user turns exist.
- **run_code has demonstrated interaction overhead:** script quoting, output handling, and batch failure add repair turns. Execution itself is usually fast. Filtered, bounded batching works well; indiscriminate batching and embedding patches inside JavaScript perform poorly in several real tasks.
- **Rollover's lifecycle is comparatively healthy:** every accepted request in the persisted sample has a successor. Its weaknesses are briefing construction and transferring references to session-owned resources, rather than substantial rotation latency. These logs do not establish lossless knowledge transfer or whole-task quality parity.

## Evidence and scope

Parsed structured events in 77 application-log files and rotations for September 1–5 under `/home/qduc/.local/state/term2-nodejs/logs/`. Matched persisted conversation events under `/home/qduc/.local/share/term2-nodejs/conversations/`, then inspected selected provider envelopes using `jq`.

Counts are emitted events, not raw text mentions of tool names inside prompts, source listings, or previous transcripts. Persisted `tool_started` events are counted once; their copies in assistant journals and settled turns are not counted again. Application timestamps are local; persisted conversation and wire timestamps are UTC.

| Evidence set | Observed coverage | Interpretation |
| --- | --- | --- |
| Application run_code lifecycle | 860 finished executions; 750 `ok:true`, 110 `ok:false` | Mixed real work and deliberate experiments; **not** a production failure-rate estimate |
| Persisted run_code conversations | 170 calls in 13 coding/review/coordinator conversations | Detailed naturalistic sample, heavily concentrated in nested-approval work and multiple worktrees/builds |
| Persisted rollover attempts | 29 attempts in 26 source sessions | 23 accepted, 4 background-work refusals, 2 schema refusals |
| Codex trigger wire artifacts | 214 requests | 206 HTTP 400, 1 HTTP 200, 7 network/cancellation outcomes; legacy 404 endpoint calls are separate |
| Local compaction warnings | 135 `no_complete_cold_turn` events | 4 correlation groups mapped to 3 conversations; warnings are not successful summarizations |

Non-interactive does not mean benchmark: several non-interactive sessions were genuine implementation workers. Conversely, experimental shell/tool arms materially contaminate the aggregate run_code count. The detailed persisted cohort and case studies are the basis for behavioral conclusions.

These are observational logs, without matched direct-tool/no-compaction controls or blind outcome grading. Extra requests and failed attempts are observable; the net effect on accuracy, total cost, or solve rate is not measured here. No paid replay or test suite was run for this report.

## 1. run_code: fast execution, avoidable repair work

In the 170-call persisted sample:

- **17 calls (10.0%) returned `Script failed`:** 7 JavaScript syntax failures, 5 underlying grep failures, 2 output/JSON-safety failures, 1 approval refusal, 1 invalid nested-tool schema, and 1 unsupported dynamic import.
- **9 additional calls returned explicit nested errors** inside `Result:`: 8 patch errors and one batch of missing-file results. Thus **26/170 (15.3%) had an explicit failure/error outcome**, spread across 10 conversations. This is a lower bound on semantic problems, not a claim that the other 144 accomplished their intended task.
- **24/170 (14.1%) outputs ended at the 30,000-character truncation limit**, across 7 conversations.
- Median tool-start-to-persisted-result time was **42 ms**; maximum **10.083 s**. These timings exclude model generation and some preparation, and are not a host-only benchmark.
- 87 outputs reported exactly one nested call. Scripting often adds an authoring layer without batching; a one-call script can still provide useful filtering.

### A. Patch-in-JavaScript quoting is a repeated failure mechanism

In the M2b fix worker, a 10,983-character script put an entire patch inside a JavaScript template literal. The patch itself contained:

```js
const providerId = `m2b-scripted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
```

Those unescaped backticks terminated the outer string. The tool returned `Unexpected identifier 'm2b'` with **no nested tool calls**. The agent regenerated the patch and retried approximately **63 seconds later**. This is a concrete scripting-layer failure, before apply_patch could execute. See [call and script](/home/qduc/.local/share/term2-nodejs/conversations/3a2c5052-a9b3-4b3c-8767-fcb39bb78d1f.jsonl:116) and [failure](/home/qduc/.local/share/term2-nodejs/conversations/3a2c5052-a9b3-4b3c-8767-fcb39bb78d1f.jsonl:118).

The initial M2b implementation worker repeated the same pattern with nested `` `outer-1:${id}` `` strings: failure at 10:17:45, retry at 10:18:22. [Evidence](/home/qduc/.local/share/term2-nodejs/conversations/0f97d929-d71a-46f1-8acc-15a892142c63.jsonl:384).

The UI fix worker had **5 script failures plus 6 nested patch errors among 40 calls**. One JSX template literal broke the outer script at 07:17:09; the next attempted model output subsequently hit the 100,000-character streamed argument guard, and the user sent `continue`. The task eventually reported a commit, so this is friction followed by recovery, not evidence of total task failure. The runaway's full cause is not established by this trace. [Syntax failure](/home/qduc/.local/share/term2-nodejs/conversations/3f9e2929-6572-4761-942d-31c180fd6a58.jsonl:72), [guard and continuation](/home/qduc/.local/share/term2-nodejs/conversations/3f9e2929-6572-4761-942d-31c180fd6a58.jsonl:76), [final report](/home/qduc/.local/share/term2-nodejs/conversations/3f9e2929-6572-4761-942d-31c180fd6a58.jsonl:392).

**Implication:** for literal patches, the extra JavaScript string layer has a demonstrated cost. Favor the existing direct patch path when available; reserve scripting for transformations or orchestration that justify that layer. These observations do not justify removing run_code.

### B. Large batches discard useful output after doing the reads

The approval-metadata audit read 19 files, then failed to return the batch: `Script output must be JSON-safe and within the configured size limit`. It retried with 8 files; that output was then clipped at 30,000 characters. A later 7-file batch was clipped too. The first failure occurred after all 19 nested reads, so the loss was in delivering their combined result, not opening the files. [Original batch](/home/qduc/.local/share/term2-nodejs/conversations/a1ec5d19-25ca-4af0-a738-c00695440a2a.jsonl:72), [clipped retry](/home/qduc/.local/share/term2-nodejs/conversations/a1ec5d19-25ca-4af0-a738-c00695440a2a.jsonl:80).

The current renderer clips the combined result with a generic marker. That marker does not itself provide a retrievable full-result handle. [Renderer](/home/qduc/term2/source/tools/system/run-code/run-code.ts:223). A raw fan-out can therefore cause repeated reading or conceal later files. The logs establish truncation and retries, not that a particular omitted fact caused an incorrect review.

**Positive counterexample:** the BIND worker used glob plus 17 reads, returned each log's metadata and last 400 characters, and delivered 10,380 characters in 50 ms. This is useful batching with bounded output. [Evidence](/home/qduc/.local/share/term2-nodejs/conversations/041530b0-4a7a-44c7-a80f-7f81e7390039.jsonl:366).

**Implication:** improve bounded-output examples and recoverability before raising caps. Measure whether agents filter/summarize before returning and whether truncated results require rereads.

### C. One bad nested call can waste a batch

The merged-review agent sent a three-grep `Promise.all` batch containing an unescaped regex parenthesis; the whole script failed. The same conversation had another missing-path batch failure and another regex failure. These are underlying grep argument mistakes, not evidence that the VM cannot execute JavaScript. Scripting amplifies their effect when successful sibling results are not returned. [Evidence](/home/qduc/.local/share/term2-nodejs/conversations/90248d5a-503d-4ed8-8797-8cd6d18e5f31.jsonl:37).

**Implication:** show per-item error preservation for independent reads, such as `Promise.allSettled`. Keep schema discovery easy, particularly for returned fields and optional values.

### D. Completion telemetry is not success telemetry

All 170 persisted command messages have lifecycle status `completed`, including failures. Application run_code completion logs have a separate `ok` boolean; the current formatter also derives presentation success from failure prefixes. A monitoring query that treats `completed` as success will miss failures. Conversely, `Result: Error: ...` is not covered by the top-level failure-prefix check. [Formatter](/home/qduc/term2/source/tools/system/run-code/run-code.ts:250).

This report distinguishes lifecycle completion, script success, nested-tool success, and task success. They should remain separate in evaluation dashboards too.

## 2. Session rollover: healthy rotation, imperfect handoffs

The 29 persisted attempts comprise **23 accepted requests, 4 intentional background-work refusals, and 2 invalid oversized briefs**. All 23 accepted requests have a matching successor's first continuation message. **22 successors contain a settled assistant turn**; the remaining successor has recorded tool activity but no settled turn in the available file. Do not call that last task complete.

For the 11 newer rollovers with persisted completion telemetry, settlement latency is **137–374 ms, median 164 ms**. Rotation time is not the main performance concern in this sample.

### A. Oversized briefs waste substantial generation time

In the profile-design conversation, the agent submitted a 9,524-character brief at 18:13:08, then an 8,148-character brief at 18:17:57. Both exceeded the 8,000-character schema limit. Its 7,706-character attempt at 18:23:00 then encountered an active subagent. It eventually succeeded at 19:08:54 with 4,466 characters.

There were **almost 10 minutes between the first oversized attempt and the first schema-valid one**. The later wait included genuine background work and must not all be charged to rollover overhead. [Attempts](/home/qduc/.local/share/term2-nodejs/conversations/72a7c0c2-23fc-478b-9470-58d48345454a.jsonl:327), [successful request](/home/qduc/.local/share/term2-nodejs/conversations/72a7c0c2-23fc-478b-9470-58d48345454a.jsonl:661).

**Implication:** guide agents toward much shorter deltas plus durable artifact pointers. This case supports better briefing construction, not removing the size bound or the background-work guard.

### B. Session-local handles are poor handoff references

A profile-slice briefing said background shell job `7fd60097` would persist across rollover. The successor immediately queried it and received `Job 7fd60097 not found.` It recovered by inspecting the worktree and installed dependencies, then continued the correct slice. [Predecessor's claim](/home/qduc/.local/share/term2-nodejs/conversations/ec9914b9-aed3-47f4-9986-1ad7b34c9432.jsonl:254), [successor lookup/result](/home/qduc/.local/share/term2-nodejs/conversations/8cea3578-9c57-4a33-99b3-51391047bdbb.jsonl:8).

This proves the handle was not retrievable in the successor. It does **not** prove running work was killed: it may have settled before rotation. The extra reconstruction is still real.

**Implication:** hand off durable results, paths, commits, and unfinished decisions; label old session-owned job/subagent handles as historical rather than promising they remain queryable.

### C. Successors generally resume the right work

Observed successor actions include loading the named profile memory, entering the specified worktree, validating branch state, and launching the next slice. The Slice 8 successor's first settled answer accurately restated the supplied completed-work state within about 8 seconds; it waited for the user's later merge instruction. [Evidence](/home/qduc/.local/share/term2-nodejs/conversations/9e6e503d-e116-4719-b171-f22cfed23632.jsonl:6).

Repeated rollovers during longer implementation chains are not by themselves evidence of forgetting. Some successors naturally reread current source to validate a handoff. A matched comparison is needed to distinguish prudent verification from avoidable reconstruction. I found no basis here for disabling rollover or declaring it universally lossless.

## 3. Compaction: repeated rejection and a long-turn coverage gap

### A. Codex repeatedly attempts an incompatible request

The application logs contain **221 explicit compact-endpoint failure warnings**: 202 rejected `parallel_tool_calls:true`, 4 required `reasoning.context:all_turns`, 14 legacy endpoint 404s, and 1 aborted request. These are actual warning events, not transcript matches.

The trigger-request wire artifacts independently confirm **202 HTTP 400s on September 5 across five real implementation/review sessions**. The three non-interactive sessions here are actual M2a workers, not synthetic test cells.

| Session | Task | September 5 HTTP 400s |
| --- | --- | ---: |
| `non-interactive-8c4de948…` | M2a implementation | 67 |
| `non-interactive-a2d829fb…` | M2a fix | 42 |
| `non-interactive-c7d2c86d…` | M2a second fix | 32 |
| `4e386624…` | M2a rereview | 44 |
| `0f97d929…` | M2b implementation | 17 |

The first worker's 67 rejected requests accumulated **97.356 seconds of recorded request duration**. The M2b worker's 17 accumulated **26.390 seconds**. These are direct failed-request costs, excluding subsequent uncompacted generation, and not an estimate of whole-task slowdown. [First worker wire example](/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-05/02-20-47_non-i/02-43-29.325Z_1ad1b.json), [late failure warning](/home/qduc/.local/state/term2-nodejs/logs/term2-2026-09-05.log.3:3091).

**Already fixed in source:** `89874f6b` merged at **17:51:37 local on September 5**. Current compact requests disable parallel calls for Responses-Lite and include its required reasoning context. The last observed relevant 400 was before that merge; **this sample contains no post-merge Lite compaction success proving the fix live**. [Current request builder](/home/qduc/term2/source/providers/codex-responses-model.ts:126).

**Still present in the surrounding policy:** a failed compaction returns `failed`; only a successful compaction increments the per-run compaction count. A later eligible boundary can try again. In `auto` mode, the Codex branch returns the native compaction outcome directly, without falling through to local summarization on failure. This explains why the same deterministic 400 recurred. [Failure path](/home/qduc/term2/source/lib/agent-client.ts:239), [Codex routing](/home/qduc/term2/source/lib/agent-client.ts:275), [success-only accounting](/home/qduc/term2/source/services/agent-runtime/application-run-loop.ts:924).

**Implication:** verify the merged fix in a fresh live process when appropriate, and separately prevent repeated unchanged deterministic rejections. Distinguish incompatibility from transient transport failures; choose explicit fallback or one actionable notice rather than silently attempting the same rejected request at every eligible boundary.

### B. Local compaction cannot shrink a long initial task

There are **135 `no_complete_cold_turn` warnings**. In coordinator session `d07eda2f…`, 81 occurred while working from its initial user instruction. Estimated rendered input grew from **300,373 to 408,212 tokens** during the warning interval. The final corresponding provider request actually reported **242,979 prompt tokens**, of which 242,560 were cached. These numbers must not be conflated: the larger number is the local estimator, not provider usage. [First warning](/home/qduc/.local/state/term2-nodejs/logs/term2-2026-09-05.log.3:595), [last warning](/home/qduc/.local/state/term2-nodejs/logs/term2-2026-09-05.log.3:1714), [wire usage](/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-05/08-06-50_d07ed/08-37-57.116Z_5571b.json).

The code protects the newest two genuine user turns and requires at least three to find a cold prefix. Tool continuations and background activity do not create those user turns. Consequently a large, autonomous first task can repeatedly qualify by size while never qualify for a safe cut. [Planner](/home/qduc/term2/source/services/agent-runtime/context-compaction/index.ts:102).

This is a real coverage gap, not necessarily a broken safety check. The observed task continued and returned a coherent coordination summary; the logs do not prove a quality regression or context-overflow failure. The high cache hit also prevents treating all growing input as newly billed input.

**Implication:** make the limitation visible and avoid treating threshold crossing as a promise of compaction. A safe within-task cut requires separate design and evidence; meanwhile rollover at a settled boundary remains a possible alternative when no live work blocks it.

### C. Successful compaction exists; success needs downstream verification

One retained September 3 Sol trigger request returned HTTP 200 in **4.957 seconds**. A subsequent normal request used a `compaction` input item and returned HTTP 200 with **23,255 input tokens**. That proves the artifact was actually reused, beyond a merely successful endpoint response. [Trigger](/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-03/13-56-17_d3498/15-41-43.960Z_90343.json), [reuse](/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-03/13-56-17_d3498/15-42-46.325Z_c9a09.json).

The compaction request itself reported 206,582 input tokens. This is not directly comparable to the immediately preceding chained request, which had a different input representation. No cost-saving percentage is inferred. The opaque artifact does not permit a textual audit of which facts survived; successful reuse alone does not prove semantic fidelity.

## Recommended order

1. **Compaction:** validate today's merged Lite request fix with post-fix live evidence, then address repeated deterministic failures and explicit fallback behavior. This has the clearest directly measured wasted time.
2. **run_code:** prioritize direct literal-patch usage, bounded-result examples, per-item batch error preservation, and recoverable oversized output. Measure repair turns and rereads, not just `ok` or adoption.
3. **Rollover:** keep the feature; tighten brief construction and the semantics of historical job handles. Require successor evidence when evaluating completion.
4. **Local compaction:** treat long single-task coverage as an explicit design gap. Do not loosen protected-history rules merely to eliminate warnings.

For a subsequent controlled evaluation, compare the same task/model under direct tools versus bounded run_code, and measure end-to-end completion, repair requests, truncated/unrecoverable output, latency, and independently checked correctness. For rollover/compaction, compare resumed work against an unchanged-context control with important constraints withheld from the grader until scoring. The present logs justify those experiments and the narrow priorities above, not a wholesale rollback.
