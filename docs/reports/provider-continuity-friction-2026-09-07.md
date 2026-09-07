# L5 provider-continuity evidence assessment (2026-09-07)

**Assessment window:** 2026-09-06 07:43:49 through 2026-09-07 07:43:49,
local time (UTC+07:00).  The app-log scan covered `term2-2026-09-06.log`,
rotations `.1` through `.15`, and the Sept 7 base log.  Provider-traffic
timestamps below are UTC.

**Scope:** evidence classification only.  No production source was changed.
The empty `/tmp/continuity-app.jsonl` (zero bytes) and the suspected workspace
file named `=` were not used as evidence; no such workspace file was present
when inspected.

## Executive disposition

The ten requested records are six concrete Codex requests rejected with
`Invalid \`previous_response_id\`.` and four concrete Codex requests rejected
with `No tool output found for function call ...`.  They are not ten independent
end-user incidents:

* The four missing-output records and the first four invalid-previous-ID
  records belong to session `d27dc356-4eda-4882-9c38-80d8aa46cdbd`, whose run was an investigation
  using the `invalid-chain-diagnosis` worktree and commands that inspected
  provider-traffic artifacts.  This is app/live transport evidence from a
  controlled probe, not evidence of ordinary production-user traffic.  The
  logs do not prove that the probe was a deterministic test-harness replay, so
  it is labelled **controlled investigation/probe, determinism unknown**.
* The 17:01:59 record is an app-generated successor session carrying a
  continuation briefing.  It is **production-like rollover evidence**; whether
  it was a user session or a worker exercise is not recoverable from the
  bounded fields retained here.
* The 19:30:48 record is a normal model-menu task preview with no probe marker.
  It is **production-like live traffic**, although the logs do not identify a
  human versus an unattended agent.

The provider rejection itself is real for every listed request.  It is not
evidence that the subsequent recovery failed.  The app already contains the
recovery seams and tests for these classes.  The rejection can still appear as
an expected first, failed attempt when a server-held anchor has expired or no
longer matches the local transcript.  The retained app records are sufficient
to show later successful provider responses in the probe and rollover runs,
but not sufficient to prove user-task/effect success.

## Counting and evidence method

Records were selected by structured JSON fields (`timestamp`, `eventType`,
`status`, `sessionId`, `requestId`, and the structured error message), not by
counting mentions in prompts or source listings.  The incident table counts a
provider failure only when it has a concrete request ID and session ID.  Two
additional app records at 09:51:12 and 10:14:44 have the same invalid-ID error
and timestamp but no request/session identity; they are retained below as
**unjoinable companion records**, not silently counted as incidents.

Provider-traffic bodies were inspected with bounded `jq` projections.  For
the first four invalid-ID records the artifacts show `previous_response_id`
present, no response payload, HTTP 400, and zero provider frames.  The 10:14
request carried a single `function_call_output`; the other three carried a
single message.  No response IDs, bearer credentials, prompt bodies, or raw
encrypted reasoning are reproduced here.

## Incident ledger: six invalid previous-response IDs

| # | Local time | Session / model | Request identity | Evidence and classification | Disposition |
|---|---|---|---|---|---|
| I1 | 2026-09-06 09:51:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-6-astra` | `f632391b-f4d7-43a6-98f2-df32be8a49fa` | Provider-traffic request had a non-empty previous anchor, one message input, HTTP 400, zero frames. Same session later continues with successful responses and artifact-inspection activity. **Controlled investigation/probe; determinism unknown.** | Already-covered stale-anchor recovery. The 400 is an observed failed attempt, not evidence that full-history recovery was absent. |
| I2 | 2026-09-06 10:14:44 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `b0e22a3e-ba2a-418d-b6e0-328edb3a6351` | Provider-traffic request had a non-empty previous anchor and one `function_call_output`, HTTP 400, zero frames. This is the same probe session. | Already-covered chain-rejection path. Because tool-output input is present, the adapter must not blindly replay only the delta without its anchor; retry/settlement owns the next action. |
| I3 | 2026-09-06 10:46:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-6-astra` | `bb385013-f3cd-4ebb-89d2-d0adc047b00e` | Provider-traffic request had a non-empty previous anchor, one message input, HTTP 400, zero frames. Same controlled session. | Already-covered stale-anchor recovery; no new production defect established. |
| I4 | 2026-09-06 11:01:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-6-astra` | `e70687e0-ba88-4459-b25a-e8f093e1a863` | Provider-traffic request had a non-empty previous anchor, one message input, HTTP 400, zero frames. Same controlled session; subsequent provider activity is present. | Already-covered stale-anchor recovery; no new production defect established. |
| I5 | 2026-09-06 17:01:59 | `4595031d-adb6-4c05-84f0-fee400081058`; `gpt-6-astra` | `1d6f28cd-9b80-4252-b445-14a7ecfc02f1`; correlation `7d882c22-7d9c-46f6-93f6-dbc57a28ad6a` | App error is HTTP 400 invalid previous ID. The session's first-user preview is an app-generated continuation briefing from prior session `501344fc-7bb0-4025-b98c-58c697c07486`; later requests in the successor receive HTTP 200 responses. **Production-like rollover evidence.** | The old run observed the failure before the current main rollover-survival merge. Current main (`d67fbb1b`) retains background owners through successor refresh; that does not remove provider 400s, so this record is a monitor/regression datum rather than proof of a current failure. |
| I6 | 2026-09-06 19:30:48 | `b42bf6ab-194d-4628-83a3-dfa488ea6e15`; `gpt-5.6-sol` | `629f0e8c-e672-46f5-9d55-3ba79e5ecfac`; correlation `bc14c3ea-96a3-44b7-9811-b3aa5d13f498` | App error is HTTP 400 invalid previous ID. The first-user preview is the ordinary provider/model-menu task, with no controlled-probe or continuation marker. **Production-like live traffic.** | Existing stale-anchor recovery applies. The bounded projection does not prove the task's final effect; retain as a live-friction sample, not as evidence for a new code change. |

### Unjoinable companion records

At 09:51:12 and 10:14:44 there is one additional app-level
`provider.response.failed` record per timestamp with the same invalid-ID
payload, but `sessionId` and `requestId` are null (only an internal trace is
present).  They cannot be safely joined to a wire request or declared to be
additional incidents.  They may be wrapper-level mirrors of I1/I2; the logs do
not establish that.  This is a logging joinability limitation, not evidence
of a seventh or eighth provider rejection.

## Incident ledger: four missing tool-output records

| # | Local time | Session / model | Request identity | Evidence and classification | Disposition |
|---|---|---|---|---|---|
| T1 | 2026-09-06 09:48:39 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `f96a3d4b-412e-4d24-be33-8e1e4ca83d20` | HTTP 400: no server tool output for a provider call ID (redacted). The request had two observed stream frames and no tool-call frame in the bounded diagnostics. Same controlled investigation session then moves to another successful provider request. | Controlled probe of unpaid/mismatched tool-chain state. Covered by missing-server-output classification and chain settlement; no production incident established. |
| T2 | 2026-09-06 10:59:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `db5dc333-4b76-4f04-b2cb-9f992f15a8f0` | HTTP 400 with the same missing-server-output signature. Same session and probe context. | Already-covered chain-debt recovery; no new production defect established. |
| T3 | 2026-09-06 11:11:29 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `722845c0-120f-40fb-b8e7-10f8d91b85d8` | HTTP 400 with the same missing-server-output signature. Same session and probe context. | Already-covered chain-debt recovery; no new production defect established. |
| T4 | 2026-09-06 11:25:51 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `75179f96-2829-4032-8993-2383d2a2546c` | HTTP 400 with the same missing-server-output signature. Same session and probe context. | Already-covered chain-debt recovery; no new production defect established. |

The four call IDs are provider-generated identifiers, not user secrets; they
are intentionally omitted because they add no joinability beyond the request
IDs.  A `command_message.status == completed` or a later HTTP 200 would not by
itself establish that the requested code change or external effect succeeded;
no such task-level claim is made here.

## Code seam and current-main comparison

The relevant behavior is split across these named seams:

* `CodexResponsesModel.#prepareCodexServerHistoryRequests()` prepares the
  server-history request; `#withoutCodexServerHistory()` removes the provider
  anchor for a safe full-history retry.
* `CodexResponsesModel.#shouldFallbackWithoutServerHistory()` deliberately
  refuses a blind anchor-less retry when the request contains tool-result
  input. This avoids pretending that a tool delta is a complete conversation.
  `#shouldForgetCodexServerHistory()` clears stale state for invalid anchors,
  missing server tool outputs, and eligible transport failures.
* `isPreviousResponseNotFoundError()` and
  `isMissingServerToolOutputError()` in
  `source/services/retry/retry-error-classification.ts` recognize the two
  provider error families. `ProviderContinuity` and
  `SessionContinuityReset` clear local anchor/tool-debt state at the session
  boundary.

The relevant fixes predate this evidence window and are ancestors of the
assessment worktree:

* `bd46f16e` — rebuild full history after an invalid chained
  `previous_response_id` where the request is safe to retry, with provider and
  run-loop tests.
* `5e668071` — settle unpaid tool-chain debt after a mid-stream failure and
  classify missing server tool output for recovery.
* `960c44b6` — stop broken previous-ID chains cleanly instead of repeatedly
  retrying the same turn.
* `9de2a086` — remove the serial `generate:false` warmup leg; it was not a
  reliable continuity repair and could double uncached prompt work.

The assessment branch is behind current `main` (`50196f02`), but its provider
files are unchanged relative to current main for this seam.  Current main also
contains post-window merges including `c2f3b914` (cancellation outcome
telemetry) and `d67fbb1b` (background-subagent retention across successor
refresh).  Those improve attribution/lifetime handling; they do not claim to
eliminate a provider's first 400 response for an expired anchor.

## Unknowns and follow-up boundary

1. App logs do not provide a stable parent-turn/recovery-attempt join for all
   ten records.  The four early invalid-ID requests have wire artifacts, but
   the two later requests were not safely joined to an artifact in this
   bounded pass.  Their error classification and app identities are still
   concrete.
2. Later HTTP 200 responses establish provider progress, not task success,
   filesystem effect, or semantic fidelity.  Persisted conversation and tool
   settlement records would be required for that claim.
3. The d27 run is strongly identified as an investigation by its worktree and
   artifact-inspection commands, but no test-runner marker proves replay
   determinism.  It must not be used as a production rate estimate.
4. The two null-identity companion errors should motivate a future logging
   join improvement, but they are not actionable evidence of extra provider
   failures without a request/session link.

**Disposition:** close the ten records as accounted-for evidence: four
controlled-probe tool-chain rejections, four controlled-probe stale-anchor
rejections, one rollover production-like stale-anchor rejection, and one
ordinary production-like stale-anchor rejection.  No production code change is
justified by this sample.  Keep I5/I6 as live monitoring examples and use the
existing recovery/settlement tests as the regression gate for this error class.
