# Provider anchor outcome reconstruction (2026-09-07)

## Scope and disposition vocabulary

This is a bounded reconstruction of the nine records not reconstructed in the
T1 compaction-debt report: I1-I6 and T2-T4.  It joins provider-traffic JSON,
app records, and persisted conversation events by UTC timestamp, session ID,
request ID, and the `x-client-request-id` worker header.  App log timestamps
are local UTC+07:00; provider-traffic and conversation timestamps below are
UTC.  No credentials, encrypted payloads, tool arguments, or provider call
IDs are reproduced.

The dispositions mean:

* **Anchor-less provider recovery observed (bounded):** the concrete
  replacement request is identified, was sent without the stale anchor, and
  received HTTP 200.  This establishes the observed provider acceptance and
  subsequent recorded progress.  It does **not** prove that recovery was safe,
  that an external/file effect was not replayed, or that the end-user task
  succeeded.  The repeat-effect statement below is only an observation from
  joined canonical events, not an independent side-effect receipt or replay
  oracle.
* **Known worker failure; recovery admission unknown:** the failed request and
  worker's failed terminal event are concrete, but the retained artifacts do
  not contain a joinable recovery admission or replacement.  The missing
  artifact is named precisely; this is not an unknown total worker outcome.
* No record in this nine-record set meets the evidence bar for a reproducible
  new production defect.  I2's worker failure is known; its recovery-admission
  outcome remains unresolved, which is not a new defect claim.

## Executive result

Eight of the nine records have a concrete anchor-less replacement request in
the same session/worker context.  Those replacements were accepted and their
canonical next provider tool results are visible; this is observed provider
recovery, not proof that no external effect was replayed.  I2 is the
exception: the worker request failed, app logs recorded the chaining
downgrade, the worker was marked failed, and no subsequent provider request
carrying that worker header exists in the retained session directory.  Thus
I2's worker outcome is known; recovery admission/replacement is unknown.

The exact T1 trigger sequence remains specific to T1 and is verified by the
compaction-debt report:

1. A prior tool call and output were accepted.
2. A native `compaction_trigger` request returned HTTP 200.
3. The next request sent the opaque `compaction` item **and the old server
   anchor**, and received the missing-server-tool-output 400.
4. Existing recovery sent the checkpoint without `previous_response_id` and
   received HTTP 200.

For T2-T4, the failed request similarly contains a `compaction` item and a
non-empty anchor, but no preceding trigger request is joinable to the same
worker in the retained provider directory.  Therefore this pass does not
claim that all three were caused by the same native-compaction race.  The
missing join is the trigger request (request ID plus worker context) that
produced each opaque checkpoint, not a later successful 200.

## Outcome ledger

The ledger reports counts of canonical `function_call` and
`function_call_output` items in the accepted replacement input.  For the five
full-history rebuilds (I1, I3, I4, I5, and I6), a direct normalized join also
matched each recorded call ID exactly once to its corresponding output, with
the expected `function_call`/`function_call_output` types.  That proves the
replacement input preserved the recorded call/output pairs.  It does not prove
that a tool was executed again, that an external effect was not replayed, or
that the two records are semantically equivalent.

| Record | Failed wire request and identity | Concrete replacement | Canonical outcome after replacement | Disposition |
|---|---|---|---|---|
| **I1** | `2026-09-06T02:51:10.983Z`; request `f632391b-f4d7-43a6-98f2-df32be8a49fa`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; root header `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T02:51:12.590Z`; request `1099e10f-eb6a-4a03-8e4b-7c9343e004a7`; same session/root header; anchor absent; `function_call:43` + `function_call_output:43` + 41 messages + 10 reasoning items; HTTP 200. | Replacement response emitted no tool call in the recorded normalized summary. The root conversation then continued with accepted requests, including `ask_mentor` at `02:52:48.983Z`. No repeated pre-error tool call is visible in the joined canonical sequence; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded).** Full-history rebuild ran and the provider accepted it; task/effect success is not claimed. |
| **I2** | `2026-09-06T03:14:43.242Z`; request `b0e22a3e-ba2a-418d-b6e0-328edb3a6351`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `d27dc356-4eda-4882-9c38-80d8aa46cdbd:subagent:ember-hedge-938`; Luna Responses-Lite; anchor present; one function output; HTTP 400 invalid previous ID. | **No same-worker replacement artifact.** The next provider request with the `ember-hedge-938` header is absent; the worker failed at canonical conversation sequence 5061 (`03:14:44.420Z`). The app separately recorded `conversation.chaining_broken` at local `10:14:44` with `sessionId: subagent-ember-hedge-938`, but that event has no request ID or recovery-admission snapshot. | The failed input proves a local function output was present, but neither anchor-less replay nor a rebuild can be shown. No repeat tool effect can be established. The exact missing join is the recovery request (or a terminal recovery-admission record) after `b0e22a3e`; settlement booleans, replay counters, and physical-attempt/deadline state are also absent. The worker's total outcome is known (`failed`); what remains unknown is whether recovery was admitted or emitted a replacement. | **Known worker failure; recovery admission/replacement unknown.** The later diagnosis report explains the missing admission evidence; it does not turn this field record into observed anchor-less recovery. |
| **I3** | `2026-09-06T03:46:11.115Z`; request `bb385013-f3cd-4ebb-89d2-d0adc047b00e`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; root header; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T03:46:12.862Z`; request `58b29504-214e-47e6-80c8-1ff5ac4b7e29`; same session/root header; anchor absent; `function_call:90` + `function_call_output:90` + 69 messages + 19 reasoning items; HTTP 200. | The accepted replacement emitted `shell`. Subsequent root requests include the corresponding tool result and continued accepted requests. No repeated pre-error tool call is visible in the joined conversation/provider timeline; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded).** Full-history rebuild ran; the continuation's task/result semantics are not certified. |
| **I4** | `2026-09-06T04:01:11.134Z`; request `e70687e0-ba88-4459-b25a-e8f093e1a863`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; root header; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T04:01:12.689Z`; request `653ae67a-838b-43f5-9fca-644a6550b075`; same session/root header; anchor absent; `function_call:95` + `function_call_output:95` + 81 messages + 23 reasoning items; HTTP 200. | The accepted replacement emitted `run_code`. A later native compaction-trigger request at `04:01:24.030Z` also returned HTTP 200. No repeat pre-error tool call is visible in the joined record set; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded).** Both rebuild acceptance and subsequent progress are concrete; they are not proof of the requested task's success. |
| **I5** | `2026-09-06T10:01:57.930Z`; request `1d6f28cd-9b80-4252-b445-14a7ecfc02f1`; session `4595031d-adb6-4c05-84f0-fee400081058`; root header; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T10:01:59.927Z`; request `70f3c73b-4662-4d1a-af6d-81a79aa233a4`; same session/root header; anchor absent; `function_call:45` + `function_call_output:45` + 66 messages + 5 reasoning items; HTTP 200. | The accepted replacement emitted `shell`. Persisted events show subsequent shell results and a final assistant turn at `10:03:56.637Z` reporting implementation, merge, full-suite/provider-suite/typecheck results, and cleanup. Those claims are self-report text, not independent validation receipts, so this report does not use them as proof of task-level success. No repeated pre-error tool call is visible in the joined record set; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded); task result not independently validated.** The 400 itself is not counted as task failure. |
| **I6** | `2026-09-06T12:30:47.001Z`; request `629f0e8c-e672-46f5-9d55-3ba79e5ecfac`; session `b42bf6ab-194d-4628-83a3-dfa488ea6e15`; root header; Sol; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T12:30:48.723Z`; request `7cbf1274-1076-4bb2-b83c-2586a1c16045`; same session/root header; anchor absent; `function_call:7` + `function_call_output:7` + 3 messages + 1 reasoning item; HTTP 200. | The accepted replacement emitted `run_code` and `shell`; persisted command results continue through `13:02:57.733Z`, when `session_rollover` completed. There is no terminal assistant/task-result turn before that rollover in the retained conversation. No repeat pre-error tool call is visible in the joined record set; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded), task outcome unresolved.** The replacement and canonical tool results are real; the missing artifact is a terminal task/effect result before rollover, not another provider 400. |
| **T2** | `2026-09-06T03:59:11.753Z`; request `db5dc333-4b76-4f04-b2cb-9f992f15a8f0`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `...:subagent:shady-oat-638`; Luna Responses-Lite; anchor present; one `compaction` plus two messages; HTTP 400 missing server tool output. | `2026-09-06T03:59:13.270Z`; request `ee3b30ef-c21e-464a-9cf9-a066d548ba86`; same session/worker; anchor absent; `additional_tools` + one `compaction` + three messages; HTTP 200. | The recovery response emitted `read_file`. The worker later completed at conversation sequence 6853 (`04:08:12.345Z`) with a review result and no file changes; the review requested changes. No repeat pre-error tool call is visible in the joined tool/result sequence; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded); review completed with requested changes.** The requested changes are a negative review artifact verdict, not evidence that review execution failed. |
| **T3** | `2026-09-06T04:11:28.323Z`; request `722845c0-120f-40fb-b8e7-10f8d91b85d8`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `...:subagent:valiant-topaz-204`; Luna Responses-Lite; anchor present; one `compaction`; HTTP 400 missing server tool output. | `2026-09-06T04:11:29.517Z`; request `0366257b-1220-4d95-b127-ad6a55c32448`; same session/worker; anchor absent; `additional_tools` + one `compaction` + one message; HTTP 200. | The recovery response emitted `shell`. The worker completed at sequence 7016 (`04:16:27.856Z`) with eight files changed and a diagnosis/regression characterization; its field timeline does not show a repeated pre-error tool effect. The worker's regression test is not substituted for field-task success. | **Anchor-less provider recovery observed (bounded).** Provider recovery and worker result are both recorded; semantic task success remains bounded to the reported diagnosis/commit, not inferred from HTTP 200. |
| **T4** | `2026-09-06T04:25:51.292Z`; request `75179f96-2829-4032-8993-2383d2a2546c`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `...:subagent:tan-fir-228`; Luna Responses-Lite; anchor present; one `compaction`; HTTP 400 missing server tool output. | `2026-09-06T04:25:52.404Z`; request `4202354f-3df4-469b-a354-5520887303e8`; same session/worker; anchor absent; `additional_tools` + one `compaction` + one message; HTTP 200. | The recovery response emitted `read_file`. The worker completed at sequence 7525 (`04:44:48.967Z`) with the diagnostic-gap fix and twelve files changed. No repeat pre-error tool call is visible in the joined tool/result sequence; this does not independently rule out an external effect replay. | **Anchor-less provider recovery observed (bounded).** The field replacement is concrete and accepted; the worker's diagnostic result is separately recorded. |

## Source artifacts and canonical joins

The original envelopes were re-opened at these retained provider-traffic
artifacts.  In every listed replacement, the envelope's `sent.requestId` and
`received.requestId` match the request ID in the ledger, the worker/session
identity matches the row, `sent.body.previous_response_id` is absent, and the
received summary is HTTP 200.  These checks are the source for the observed
anchor-less replacements; they are not inferred from a later assistant
completion.

| Record | Failed envelope | Accepted replacement envelope | Canonical conversation join |
|---|---|---|---|
| I1 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/02-51-10.983Z_f6323.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/02-51-12.590Z_1099e.json` | `~/.local/share/term2-nodejs/conversations/d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`, joined by the root session plus the failed/replacement request IDs and UTC timestamps. |
| I2 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/03-14-43.242Z_b0e22.json` | **No artifact** | Same `d27dc...jsonl`; canonical sequence **5061** is the `ember-hedge-938` worker's failed terminal event. The `conversation.chaining_broken` record is a separate app event without a recovery request ID. |
| I3 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/03-46-11.115Z_bb385.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/03-46-12.862Z_58b29.json` | `~/.local/share/term2-nodejs/conversations/d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`, joined by session, request IDs, and UTC timestamps. |
| I4 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/04-01-11.134Z_e7068.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/04-01-12.689Z_653ae.json` | `~/.local/share/term2-nodejs/conversations/d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`, joined by session, request IDs, and UTC timestamps; the later trigger is also at `04:01:24.030Z`. |
| I5 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/09-10-26_45950/10-01-57.930Z_1d6f2.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/09-10-26_45950/10-01-59.927Z_70f3c.json` | `~/.local/share/term2-nodejs/conversations/4595031d-adb6-4c05-84f0-fee400081058.jsonl`, joined by session, request IDs, and UTC timestamps. The assistant's later completion text is self-report, not an independent validation receipt. |
| I6 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/12-19-05_b42bf/12-30-47.001Z_629f0.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/12-19-05_b42bf/12-30-48.723Z_7cbf1.json` | `~/.local/share/term2-nodejs/conversations/b42bf6ab-194d-4628-83a3-dfa488ea6e15.jsonl`, joined by session, request IDs, and UTC timestamps; persisted tool results continue until the rollover at `13:02:57.733Z`. |
| T2 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/03-59-11.753Z_db5dc.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/03-59-13.270Z_ee3b3.json` | `~/.local/share/term2-nodejs/conversations/d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`; worker completion is canonical sequence **6853**. |
| T3 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/04-11-28.323Z_72284.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/04-11-29.517Z_03662.json` | `~/.local/share/term2-nodejs/conversations/d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`; worker completion is canonical sequence **7016**. |
| T4 | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/04-25-51.292Z_75179.json` | `~/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/04-25-52.404Z_42023.json` | `~/.local/share/term2-nodejs/conversations/d27dc356-4eda-4882-9c38-80d8aa46cdbd.jsonl`; worker completion is canonical sequence **7525**. |

For I1, I3, I4, I5, and I6, the normalized full-history inputs were checked
for one-to-one, type-correct call/output joins.  The resulting counts are the
`function_call:N`/`function_call_output:N` values in the ledger; no raw call
IDs are reproduced.  This proves preservation of the recorded pairs in those
five request bodies, not execution, non-replay of an external effect, or task
success.  T2-T4 are checkpoint continuations rather than full-history
rebuilds, so their accepted inputs have no such replayed function pair.

## Cross-source identity and ordering checks

* Every failed request above has a provider-traffic `sent.requestId`, matching
  `received.requestId`, a session ID, and an app `provider.request.started`
  / `provider.response.failed` pair.  The two root records I5/I6 use their
  own provider-traffic session directories rather than being assigned to the
  d27 root session by correlation alone.
* The worker headers distinguish the d27 root from `ember-hedge-938`,
  `shady-oat-638`, `valiant-topaz-204`, and `tan-fir-228`.  I2's failure is
  therefore not joined to the root's later successful requests.
* For each accepted replacement, the replacement's **sent** timestamp is later
  than the failed request's sent timestamp, and its request ID is distinct.
  The provider body has `previous_response_id` absent; it is not merely a later
  chained 200.  The T2-T4 replacements also retain the opaque `compaction`
  input.  The report does not infer a fixed delay from the failed request's
  received timestamp.
* The d27 persisted conversation corroborates the worker outcome ordering:
  I2's worker failure is sequence 5061; the T2, T3, and T4 worker completions
  are sequences 6853, 7016, and 7525 respectively.  Those sequence records
  are canonical event joins for worker outcome classification only; provider
  request identity comes from the retained provider envelopes and app logs.

## Trigger, debt, and repeat-effect boundary

The T1 report's native-compaction trigger is causally established only for
T1.  T2-T4 each show a compaction checkpoint combined with an old anchor, and
each is followed immediately by an anchor-less checkpoint request, but the
retained d27 provider artifacts do not include a same-worker
`compaction_trigger` request before the corresponding failure.  A later 200
cannot supply that missing causal link.

For I1, I3, I4, I5, and I6 the normalized call-ID/type joins demonstrate that
the local full-history rebuild carried each recorded tool/result pair in its
request body.  For T2-T4 the accepted checkpoint request contains no replayed
function call/output pair; the next provider response starts a new tool
continuation.  Across all nine, no joined canonical event shows the exact
pre-error tool call being executed a second time.  This is an observation of
the retained provider/conversation sequence, not an independent effect
receipt, replay detector, or proof that arbitrary external effects would be
idempotent.

I2 is the only record where the anchor-less retry/rebuild itself cannot be
answered from retained evidence.  App logs preserve the downgrade notice but
not the recovery request, recovery-admission counters, settlement evidence,
or a terminal effect result.  The worker's `failed` completion at canonical
conversation sequence 5061 and the absence of an `ember-hedge-938` provider
request after `03:14:43.242Z` are the bounded facts; later root/other-worker
200s must not close the missing recovery-admission join.  I2's worker outcome
is not unknown; only its post-failure recovery admission/replacement is.

## Final accounting

All nine requested records are accounted for: eight have source-backed
anchor-less replacements and bounded canonical outcomes; I2 has a concrete
failed request, a worker-specific failed completion, and an exact missing
recovery-admission join.  The evidence supports observed anchor-less provider
acceptance/progress for I1, I3-I6, and T2-T4.  It does not establish safe
non-replay of external effects, universal task success, or a new production
defect claim.  I2's worker outcome is known, but it should not be closed as
recovered until a recovery-admission or replacement-request identity is
retained.
