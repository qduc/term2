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

* **Safe recovery proven (bounded):** the concrete replacement request is
  identified, was sent without the stale anchor, and received HTTP 200.  This
  proves transport/lifecycle recovery and the observed canonical next tool
  result; it does **not** prove that the end-user task succeeded or that an
  external/file effect was semantically correct.
* **Unresolved trigger/outcome:** the failed request is concrete, but the
  retained artifacts do not contain a joinable replacement or the terminal
  task/effect result.  The missing artifact is named precisely.
* No record in this nine-record set meets the evidence bar for a reproducible
  new production defect.  I2 remains an unresolved field outcome, not a new
  defect claim, because recovery-admission state was not retained.

## Executive result

Eight of the nine records have a concrete anchor-less replacement request in
the same session/worker context.  Those replacements were accepted and their
canonical next provider tool results are visible.  I2 is the exception: the
worker request failed, app logs recorded the chaining downgrade, the worker
was marked failed, and no subsequent provider request carrying that worker
header exists in the retained session directory.

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

The `replay` column reports counts of canonical `function_call` and
`function_call_output` items in the accepted replacement input.  Equal counts
show that the full-history rebuild carried the recorded tool/result pairs; the
counts are not a claim that executing a tool again would be idempotent.

| Record | Failed wire request and identity | Concrete replacement | Canonical outcome after replacement | Disposition |
|---|---|---|---|---|
| **I1** | `2026-09-06T02:51:10.983Z`; request `f632391b-f4d7-43a6-98f2-df32be8a49fa`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; root header `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T02:51:12.590Z`; request `1099e10f-eb6a-4a03-8e4b-7c9343e004a7`; same session/root header; anchor absent; `function_call:43` + `function_call_output:43` + 41 messages + 10 reasoning items; HTTP 200. | Replacement response emitted no tool call in the recorded normalized summary. The root conversation then continued with accepted requests, including `ask_mentor` at `02:52:48.983Z`. No repeated tool effect is visible in the joined events. | **Safe recovery proven (bounded).** Full-history rebuild ran and the provider accepted it; task/effect success is not claimed. |
| **I2** | `2026-09-06T03:14:43.242Z`; request `b0e22a3e-ba2a-418d-b6e0-328edb3a6351`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `d27dc356-4eda-4882-9c38-80d8aa46cdbd:subagent:ember-hedge-938`; Luna Responses-Lite; anchor present; one function output; HTTP 400 invalid previous ID. | **No same-worker replacement artifact.** The next provider request with the `ember-hedge-938` header is absent; the worker ended at conversation sequence 5061 (`03:14:44.420Z`) with status `failed`. The app separately recorded `conversation.chaining_broken` at local `10:14:44` with `sessionId: subagent-ember-hedge-938`, but that event has no request ID or recovery-admission snapshot. | The failed input proves a local function output was present, but neither anchor-less replay nor a rebuild can be shown. No repeat tool effect can be established. The exact missing join is the recovery request (or a terminal recovery-admission record) after `b0e22a3e`; settlement booleans, replay counters, and physical-attempt/deadline state are also absent. | **Unresolved trigger/outcome.** The later diagnosis report explains the missing admission evidence; it does not turn this field record into a proven safe recovery. |
| **I3** | `2026-09-06T03:46:11.115Z`; request `bb385013-f3cd-4ebb-89d2-d0adc047b00e`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; root header; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T03:46:12.862Z`; request `58b29504-214e-47e6-80c8-1ff5ac4b7e29`; same session/root header; anchor absent; `function_call:90` + `function_call_output:90` + 69 messages + 19 reasoning items; HTTP 200. | The accepted replacement emitted `shell`. Subsequent root requests include the corresponding tool result and continued accepted requests. No repeated pre-error tool effect is visible in the joined conversation/provider timeline. | **Safe recovery proven (bounded).** Full-history rebuild ran; the continuation's task/result semantics are not certified. |
| **I4** | `2026-09-06T04:01:11.134Z`; request `e70687e0-ba88-4459-b25a-e8f093e1a863`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; root header; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T04:01:12.689Z`; request `653ae67a-838b-43f5-9fca-644a6550b075`; same session/root header; anchor absent; `function_call:95` + `function_call_output:95` + 81 messages + 23 reasoning items; HTTP 200. | The accepted replacement emitted `run_code`. A later native compaction-trigger request at `04:01:24.030Z` also returned HTTP 200. No repeat tool effect is visible in the joined record set. | **Safe recovery proven (bounded).** Both rebuild acceptance and subsequent progress are concrete; they are not proof of the requested task's success. |
| **I5** | `2026-09-06T10:01:57.930Z`; request `1d6f28cd-9b80-4252-b445-14a7ecfc02f1`; session `4595031d-adb6-4c05-84f0-fee400081058`; root header; Astra; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T10:01:59.927Z`; request `70f3c73b-4662-4d1a-af6d-81a79aa233a4`; same session/root header; anchor absent; `function_call:45` + `function_call_output:45` + 66 messages + 5 reasoning items; HTTP 200. | The accepted replacement emitted `shell`. Persisted events show subsequent shell results, a final assistant turn at `10:03:56.637Z` reporting the implementation, merge, full-suite/provider-suite/typecheck results, and a later cleanup confirmation. This is task-level result evidence for that session, while not proving every semantic effect beyond the recorded validations. | **Safe recovery proven (bounded).** Recovery and a later task result are both observed; the 400 itself is not counted as task failure. |
| **I6** | `2026-09-06T12:30:47.001Z`; request `629f0e8c-e672-46f5-9d55-3ba79e5ecfac`; session `b42bf6ab-194d-4628-83a3-dfa488ea6e15`; root header; Sol; anchor present; one message; HTTP 400 invalid previous ID. | `2026-09-06T12:30:48.723Z`; request `7cbf1274-1076-4bb2-b83c-2586a1c16045`; same session/root header; anchor absent; `function_call:7` + `function_call_output:7` + 3 messages + 1 reasoning item; HTTP 200. | The accepted replacement emitted `run_code` and `shell`; persisted command results continue through `13:02:57.733Z`, when `session_rollover` completed. There is no terminal assistant/task-result turn before that rollover in the retained conversation. | **Safe recovery proven (bounded), task outcome unresolved.** The replacement and canonical tool results are real; the missing artifact is a terminal task/effect result before rollover, not another provider 400. |
| **T2** | `2026-09-06T03:59:11.753Z`; request `db5dc333-4b76-4f04-b2cb-9f992f15a8f0`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `...:subagent:shady-oat-638`; Luna Responses-Lite; anchor present; one `compaction` plus two messages; HTTP 400 missing server tool output. | `2026-09-06T03:59:13.270Z`; request `ee3b30ef-c21e-464a-9cf9-a066d548ba86`; same session/worker; anchor absent; `additional_tools` + one `compaction` + three messages; HTTP 200. | The recovery response emitted `read_file`. The worker later completed at conversation sequence 6853 (`04:08:12.345Z`) with a review result and no file changes; the review requested changes. No repeat tool effect is visible in the joined tool/result sequence. | **Safe recovery proven (bounded), review task not successful.** The recovery request ran and accepted the checkpoint; the worker's own review result is a concrete negative outcome, not a success claim. |
| **T3** | `2026-09-06T04:11:28.323Z`; request `722845c0-120f-40fb-b8e7-10f8d91b85d8`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `...:subagent:valiant-topaz-204`; Luna Responses-Lite; anchor present; one `compaction`; HTTP 400 missing server tool output. | `2026-09-06T04:11:29.517Z`; request `0366257b-1220-4d95-b127-ad6a55c32448`; same session/worker; anchor absent; `additional_tools` + one `compaction` + one message; HTTP 200. | The recovery response emitted `shell`. The worker completed at sequence 7016 (`04:16:27.856Z`) with eight files changed and a diagnosis/regression characterization; its field timeline does not show a repeated pre-error tool effect. The worker's regression test is not substituted for field-task success. | **Safe recovery proven (bounded).** Provider recovery and worker result are both recorded; semantic task success remains bounded to the reported diagnosis/commit, not inferred from HTTP 200. |
| **T4** | `2026-09-06T04:25:51.292Z`; request `75179f96-2829-4032-8993-2383d2a2546c`; session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; worker header `...:subagent:tan-fir-228`; Luna Responses-Lite; anchor present; one `compaction`; HTTP 400 missing server tool output. | `2026-09-06T04:25:52.404Z`; request `4202354f-3df4-469b-a354-5520887303e8`; same session/worker; anchor absent; `additional_tools` + one `compaction` + one message; HTTP 200. | The recovery response emitted `read_file`. The worker completed at sequence 7525 (`04:44:48.967Z`) with the diagnostic-gap fix and twelve files changed. No repeat tool effect is visible in the joined tool/result sequence; later task output is not used to assert that the original requested outcome was universally successful. | **Safe recovery proven (bounded).** The field replacement is concrete and accepted; the worker's diagnostic result is separately recorded. |

## Cross-source identity and ordering checks

* Every failed request above has a provider-traffic `sent.requestId`, matching
  `received.requestId`, a session ID, and an app `provider.request.started`
  / `provider.response.failed` pair.  The two root records I5/I6 use their
  own provider-traffic session directories rather than being assigned to the
  d27 root session by correlation alone.
* The worker headers distinguish the d27 root from `ember-hedge-938`,
  `shady-oat-638`, `valiant-topaz-204`, and `tan-fir-228`.  I2's failure is
  therefore not joined to the root's later successful requests.
* For each accepted replacement, the replacement timestamp is later than the
  failure by 1.1-1.6 seconds and its request ID is distinct.  The provider
  body has `previous_response_id` absent; it is not merely a later chained
  200.  The T2-T4 replacements also retain the opaque `compaction` input.
* The d27 persisted conversation corroborates the worker outcome ordering:
  I2's worker failure is sequence 5061; the T2, T3, and T4 worker completions
  are sequences 6853, 7016, and 7525 respectively.  Those sequence records
  are used for task-result classification only; provider request identity
  comes from provider traffic and app logs.

## Trigger, debt, and repeat-effect boundary

The T1 report's native-compaction trigger is causally established only for
T1.  T2-T4 each show a compaction checkpoint combined with an old anchor, and
each is followed immediately by an anchor-less checkpoint request, but the
retained d27 provider artifacts do not include a same-worker
`compaction_trigger` request before the corresponding failure.  A later 200
cannot supply that missing causal link.

For I1, I3, I4, I5, and I6 the replacement's equal function-call/result
counts demonstrate that the local full-history rebuild carried the recorded
tool results.  For T2-T4 the accepted checkpoint request contains no replayed
function call/output pair; the next provider response starts a new tool
continuation.  Across all nine, no joined canonical event shows the exact
pre-error tool call being executed a second time.  This is an observation,
not a proof that arbitrary external effects would be idempotent.

I2 is the only record where the anchor-less retry/rebuild itself cannot be
answered from retained evidence.  App logs preserve the downgrade notice but
not the recovery request, recovery-admission counters, settlement evidence,
or a terminal effect result.  The worker's `failed` completion and the absence
of an `ember-hedge-938` provider request after `03:14:43.242Z` are the bounded
outcome; later root/other-worker 200s must not close it.

## Final accounting

All nine requested records are accounted for: eight have source-backed
anchor-less replacements and bounded canonical outcomes; I2 has a concrete
failed request, a worker-specific failed completion, and an exact missing
recovery join.  The evidence supports safe recovery at the provider
transport/lifecycle boundary for I1, I3-I6, and T2-T4.  It supports neither a
universal task-success claim nor a new production defect claim.  I2 remains
an unresolved trigger/outcome and should not be closed as "covered" until a
recovery-admission or replacement-request identity is retained.
