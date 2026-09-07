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

* Eight records (I1–I4 and T1–T4) belong to session
  `d27dc356-4eda-4882-9c38-80d8aa46cdbd`, but the session ID pools the root
  coordinator and several live workers.  The persisted session shows an
  ordinary user discussion, followed by the user instruction to work toward
  the goal autonomously.  The error-time requests were made while workers were
  implementing, reviewing, or diagnosing that work.  This is **live
  investigation/implementation traffic**.  The records do not prove that any
  provider error was deliberately induced; no controlled-probe classification
  is established here.
* The 17:01:59 record is an app-generated successor session carrying a
  continuation briefing.  It is **production-like rollover evidence**; whether
  it was a user session or a worker exercise is not recoverable from the
  bounded fields retained here.
* The 19:30:48 record is a normal model-menu task preview with no probe marker.
  It is **production-like live traffic**, although the logs do not identify a
  human versus an unattended agent.

The provider rejection itself is real for every listed request.  It is not
evidence that the subsequent recovery failed, and a later 200 is not evidence
that recovery or the requested task succeeded.  The app contains recovery
seams and tests for known error classes, but those tests do not establish the
cause of these field records or their task/effect outcome.  The trigger and
whether the eight d27 records were naturally encountered or deliberately
induced remain unresolved.  The retained records show later successful
provider responses in some runs, but not successful recovery, filesystem
effect, or semantic/task completion.

### Provenance reconstruction for the eight d27 records

The positive provenance evidence is the surrounding live work, not merely the
absence of a test marker.  In persisted conversation
`d27dc356-4eda-4882-9c38-80d8aa46cdbd`, event sequence 5 records the ordinary
question about compaction, sequences 9 and 12 record the balanced-approach and
codebase-foundation discussion, and sequence 3680 records the user instruction
`Work toward that goal autonomously`.  The same session then records these
worker assignments before or around the failures:

* `swift-rose-779` (sequence 2808) was reviewing the live rollover
  implementation when T1 occurred;
* `ember-hedge-938` (sequence 4638) was replacing the unsafe rollover transfer
  implementation when I2 occurred;
* `shady-oat-638` (sequence 6144) was performing rollover acceptance review
  when T2 occurred;
* `valiant-topaz-204` (sequence 6416) was assigned the invalid-chain diagnosis
  **after** I2, with the explicit task to diagnose the observed request, when
  T3 occurred; and
* `tan-fir-228` (sequence 6855) was completing rollover acceptance fixes when
  T4 occurred.

The provider-traffic headers independently identify those worker suffixes.  In
particular, the `invalid-chain-diagnosis` worktree/task was created after the
03:14:43Z I2 failure, so its existence cannot be evidence that I2 was injected
by that investigation.  The wire bodies are ordinary application requests
(root messages or worker compaction/tool-result continuations), not a recorded
fault-injection command.  That establishes live investigation context, but
not user or worker intent; deliberate induction is **unknown**, not disproved.

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
encrypted reasoning are reproduced here.  The missing-output requests carried
live compaction-shaped inputs: T1, T3, and T4 had one `compaction` input, while
T2 had a `compaction` input followed by two messages.  This is wire evidence of
the request shape, not proof that a missing output was deliberately injected.

## Incident ledger: six invalid previous-response IDs

| # | Local time | Session / model | Request identity | Evidence and classification | Disposition |
|---|---|---|---|---|---|
| I1 | 2026-09-06 09:51:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-6-astra` | `f632391b-f4d7-43a6-98f2-df32be8a49fa` | Provider-traffic request had a non-empty previous anchor, one message input, HTTP 400, zero frames. The root coordinator was supervising live implementation/review work in this session. **Live investigation traffic; deliberate induction unknown.** | Concrete stale-anchor rejection. No recovery attempt, task effect, or incident cause is established by the bounded records; existing known-path tests do not close this field observation. |
| I2 | 2026-09-06 10:14:44 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `b0e22a3e-ba2a-418d-b6e0-328edb3a6351` | Provider-traffic request had a non-empty previous anchor and one `function_call_output`, HTTP 400, zero frames. Its header identifies live worker `ember-hedge-938`, which was implementing rollover; the invalid-chain diagnosis task had not yet been assigned. **Live investigation/implementation traffic; deliberate induction unknown.** | Concrete stale-anchor rejection during a live worker continuation. No replacement request or requested effect is proven; the known chain-recovery test is not evidence that this worker recovered. |
| I3 | 2026-09-06 10:46:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-6-astra` | `bb385013-f3cd-4ebb-89d2-d0adc047b00e` | Provider-traffic request had a non-empty previous anchor, one message input, HTTP 400, zero frames. The root coordinator was supervising live follow-up work. **Live investigation traffic; deliberate induction unknown.** | Concrete stale-anchor rejection. Later provider progress does not establish recovery, task effect, or why this anchor was sent. |
| I4 | 2026-09-06 11:01:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-6-astra` | `e70687e0-ba88-4459-b25a-e8f093e1a863` | Provider-traffic request had a non-empty previous anchor, one message input, HTTP 400, zero frames. Same root coordinator session; subsequent provider activity is present. **Live investigation traffic; deliberate induction unknown.** | Concrete stale-anchor rejection. Subsequent 200s establish provider progress only; recovery and task outcome remain unknown. |
| I5 | 2026-09-06 17:01:59 | `4595031d-adb6-4c05-84f0-fee400081058`; `gpt-6-astra` | `1d6f28cd-9b80-4252-b445-14a7ecfc02f1`; correlation `7d882c22-7d9c-46f6-93f6-dbc57a28ad6a` | App error is HTTP 400 invalid previous ID. The session's first-user preview is an app-generated continuation briefing from prior session `501344fc-7bb0-4025-b98c-58c697c07486`; later requests in the successor receive HTTP 200 responses. **Production-like rollover evidence.** | This is a stale-anchor observation at a rollover boundary. The current rollover worker-retention fix (`d67fbb1b`) is unrelated to stale-anchor validity or recovery; it neither explains nor remediates this 400. Later 200s are monitoring data, not proof of recovery or task success. |
| I6 | 2026-09-06 19:30:48 | `b42bf6ab-194d-4628-83a3-dfa488ea6e15`; `gpt-5.6-sol` | `629f0e8c-e672-46f5-9d55-3ba79e5ecfac`; correlation `bc14c3ea-96a3-44b7-9811-b3aa5d13f498` | App error is HTTP 400 invalid previous ID. The first-user preview is the ordinary provider/model-menu task, with no controlled-probe or continuation marker. **Production-like live traffic.** | Known stale-anchor recovery is relevant follow-up context, but this record does not prove that recovery ran or that the task succeeded. The bounded projection does not prove the task's final effect; retain as a live-friction sample, not as evidence for a new code change. |

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
| T1 | 2026-09-06 09:48:39 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `f96a3d4b-412e-4d24-be33-8e1e4ca83d20` | HTTP 400: no server tool output for a provider call ID (redacted). The request had two observed stream frames and no tool-call frame in the bounded diagnostics. Its header identifies `swift-rose-779`, a live rollover-review worker. **Live investigation/review traffic; deliberate induction unknown.** | Concrete missing-output rejection during a live review request. No task effect or recovery is established; the known missing-output test path does not close this field observation. |
| T2 | 2026-09-06 10:59:12 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `db5dc333-4b76-4f04-b2cb-9f992f15a8f0` | HTTP 400 with the same missing-server-output signature. Its header identifies `shady-oat-638`, a live rollover-acceptance-review worker. **Live investigation/review traffic; deliberate induction unknown.** | Concrete missing-output rejection. No task effect or recovery is established; the known chain-debt test path does not close this field observation. |
| T3 | 2026-09-06 11:11:29 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `722845c0-120f-40fb-b8e7-10f8d91b85d8` | HTTP 400 with the same missing-server-output signature. Its header identifies `valiant-topaz-204`, whose invalid-chain diagnosis was assigned after the earlier I2 failure. **Live investigation/diagnosis traffic; deliberate induction unknown.** | Concrete missing-output rejection while diagnosing the existing field record. No task effect or recovery is established, and the diagnosis task does not make this a controlled probe. |
| T4 | 2026-09-06 11:25:51 | `d27dc356-4eda-4882-9c38-80d8aa46cdbd`; `gpt-5.6-luna` | `75179f96-2829-4032-8993-2383d2a2546c` | HTTP 400 with the same missing-server-output signature. Its header identifies `tan-fir-228`, a live rollover-acceptance worker. **Live investigation/implementation traffic; deliberate induction unknown.** | Concrete missing-output rejection. No task effect or recovery is established; later progress, if any, is not proof that this request recovered. |

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
refresh).  The rollover-retention change is unrelated to stale-anchor validity
or recovery.  These changes improve attribution/lifetime handling; they do not
claim to eliminate a provider's first 400 response for an expired anchor.

## Unknowns and follow-up boundary

1. App logs do not provide a stable parent-turn/recovery-attempt join for all
   ten records.  The four early invalid-ID requests have wire artifacts, but
   the two later requests were not safely joined to an artifact in this
   bounded pass.  Their error classification and app identities are still
   concrete.
2. Later HTTP 200 responses establish provider progress, not task success,
   filesystem effect, or semantic fidelity.  Persisted conversation and tool
   settlement records would be required for that claim.
3. The d27 records are positively identified as live investigation/
   implementation traffic by the user instruction, worker assignments, and
   worker-specific headers.  That context does not prove deliberate error
   induction; the causal trigger and intent remain unknown.  The records must
   not be used as a production failure-rate estimate.
4. The two null-identity companion errors should motivate a future logging
   join improvement, but they are not actionable evidence of extra provider
   failures without a request/session link.

**Disposition:** account for the ten concrete provider rejections as eight live
investigation/implementation records in d27, one production-like rollover
record, and one ordinary production-like live record.  No controlled probe is
established by this sample.  The stale-anchor/missing-output trigger, deliberate
induction status, recovery outcome, and task/effect outcome remain unresolved.
Existing recovery/settlement tests cover known paths only; they are a regression
gate, not evidence that this field incident is solved.  No production code
change is justified solely by this sample, but the eight d27 records must not
be closed as "covered" or used as a production-rate estimate.
