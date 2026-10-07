# Jev failure-triage pilot: retained-log review

Reviewed 2026-10-06. **Initial retrospective review complete; promotion evidence remains pending.** Keep the failure-triage pilot observational. This snapshot supports basic classification of five explicit failure signatures, but does not establish improved retry outcomes or added value over a deterministic classifier.

[Case evidence and source hashes](review.json) retain the 20 observations, source line references, predictions, review labels, recovery markers, and bounded persisted-conversation activity. No provider requests, settings changes, or production code changes were made for this review.

## Cohort and method

Every retained `term2-*.log*` file in `/home/qduc/.local/state/term2-nodejs/logs/` was parsed as JSONL, including rotations. Only structured `decision_shadow.*` events were counted. There are 20 starts and 20 failure-triage settlements, dated September 29 through October 4, with no recorded failed or skipped pilot observations. This is the retained-log cohort, not the complete historical population; log retention can remove earlier observations.

All observations use `failure-triage-v2-runtime-evidence`, request `~typesafe/jev-latest`, and resolve to `typesafe/jev-1.13-20260917`. Nineteen originate from Codex failures and one from DeepSeek. Eighteen session IDs are recoverable; the DeepSeek failure lacks a session ID, and one Codex session appears twice.

Starts and settlements were paired by file order, pilot request ID, prompt version, requested model, and an eleven-second window. Every start has exactly one settlement and each settlement is used once. Pilot request IDs are local counters and were not treated as globally unique. Correlation IDs sometimes change between admission and settlement, so correlation alone is not a prediction join.

Underlying failures were joined using the admission correlation and local timestamp. Nineteen have a provider request/session record; the DeepSeek case has a same-second agent failure immediately after admission. Duplicate provider/agent error records have identical messages and count as one case. Local timestamps were converted from UTC+7 when inspecting persisted UTC events. The exact historical Decisions input bodies are not retained here; the failure records support contextual reconstruction, not a byte-identical payload replay.

Labels were assigned retrospectively after predictions had been viewed. **They are evidence-supported review judgments, not blind independent ground truth.** The shipped rubric in `evaluateFailureTriage` asks whether the *same* provider request could succeed without changing credentials, policy, or request shape. That question differs from whether Term2 can recover by rebuilding history.

## Results

| Failure signature | Cases | Jev category / retry | Retrospective assessment |
| --- | ---: | --- | --- |
| Invalid `previous_response_id` (HTTP 400) | 14 | `INVALID_REQUEST` / `DO_NOT_RETRY` | Supported for repeating the unchanged request; rebuilding history is a different request. |
| WebSocket close, code 1012 | 2 | `TRANSIENT_PROVIDER` / `RETRY` | Supported transport-recovery advice; unchanged-request success not measured. |
| Insufficient balance (HTTP 402) | 1 | `AUTH_CONFIGURATION` / `DO_NOT_RETRY` | Supported: funds/entitlement must change. |
| Server overload with `NO_MORE_RETRY` | 2 | `TRANSIENT_PROVIDER` / `DO_NOT_RETRY` | Category supported; retry interpretation unresolved. |
| WebSocket first-frame timeout | 1 | `TRANSIENT_PROVIDER` / `RETRY` | Supported temporary-transport interpretation; confidence only 0.33. |

All 20 category predictions fit their explicit error signatures. Retry judgments support 18 predictions and leave two unresolved. Neither number is a validated accuracy estimate. Fourteen cases share the same continuity error; a post-hoc five-signature mapping reproduces the category judgments, so this cohort demonstrates no added semantic value over simple rules. No frozen baseline comparison was run.

Runtime retry-flag agreement is 19/20. The disagreement, **JFT-09** (September 29, 20:18:27), is particularly useful: its provider failure record says `errorKind=network`, `retryable=true`, while the later agent failure and pilot comparison say `unknown`, `false`. Jev recommends `RETRY`. The comparison flag is therefore not reliable ground truth for this case. This review does not determine where the error lost classification information or change runtime recovery.

The overload cases **JFT-08** and **JFT-19** both contain a temporary-overload message asking the caller to try later and a `NO_MORE_RETRY` header. Whether that header describes the exhausted current attempt or prohibits a later application retry cannot be established from these observations. Jev's non-retry advice could reflect header precedence; the logs do not prove that repeating later would fail or require changing request shape. Preserve these as disputed cases rather than declaring them correct from runtime agreement.

## Recovery and operational measurements

Thirteen of the fourteen continuity cases have same-second `retry.conversation_state` records documenting a rebuild from full history. Eighteen cases have available persisted conversations; sixteen show root assistant activity within five minutes, before the next user message. These markers establish subsequent activity, not task completion, unchanged-payload retry success, or a causal benefit from Jev. The pilot does not control recovery.

Median pilot latency is **1,078 ms**, nearest-rank p95 **1,394 ms**, and maximum **2,263 ms**. Provider-reported cost totals **643 USD micros ($0.000643)**. These are pilot request measurements; they do not measure foreground snapshot overhead or billing independently. All retained starts settled, but that does not resolve the documented shutdown-drain limitation for other runs.

## What still needs data

1. Collect broader, independently labelled failures: rate limits, credential rejection, malformed requests other than continuity, sparse/ambiguous diagnostics, and tool/policy cases where the observation boundary admits them. Keep repeated signatures visible rather than treating them as independent coverage.
2. Resolve the retry contract for overload metadata and distinguish unchanged-request retry, history rebuild, delayed retry, and changes to funds/configuration. Preserve both provider-layer and run-loop classification in evaluation evidence.
3. Freeze a simple deterministic baseline and compare on unseen cases. Measure useful disagreements, not agreement with runtime flags alone.
4. Link predictions to actual recovery actions and outcomes, including payload changes, replay eligibility, subsequent failures, latency, and cost. Existing assistant activity is insufficient to certify recovery or task success.

The synthetic 20-task study remains complete. This review closes the first inspection of collected failure-triage data; representative model-quality validation and any change to runtime authority remain pending.

## Verification and evidence limits

The extraction asserted one-to-one start/settlement joins, checked duplicated failure messages, and recomputed totals from structured records. A separate read-back checked case counts, source hashes, source line references, category/retry aggregates, and operational totals. No repository source-test gate was triggered by these research artifacts. No new capability was introduced; this is an inspection of an already-running user workflow.

The JSON stores only selected failure evidence and metadata, excluding full prompts, command arguments, credentials, conversation text, and stack traces. Full-log and available conversation hashes identify the inspected snapshots; future rotation or continued conversation writes may prevent those source hashes from matching. The preserved case projections remain available for this review.
