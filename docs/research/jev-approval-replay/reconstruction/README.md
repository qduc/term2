# Frozen production approval-shadow reconstruction

## Cohort

This reconstruction is limited to the first 184
`approval.decision_shadow.compared` app-log events. The cutoff is
`2026-09-19 14:06:25` at
`msg-1789801585760-jfs4b6`; all later comparisons are deliberately excluded.
There were eight later comparisons at the initial inspection; the log is live,
so that observation is not a fixed upper bound on later appended events.
The app log renders in UTC+07:00, while the millisecond epoch embedded in each
message ID is UTC. Evaluator traffic timestamps are UTC.

## Method

1. Read app-log comparison events only through the cutoff and retain their
   logged reviewer and Jev labels/derived decisions as the authoritative
   comparison result.
2. Split app events into 136 batches when `requestIndex` resets to zero.
3. Read evaluator traffic through the frozen last received timestamp
   (`2026-09-19T07:06:24.211Z`). Parse the exact reviewer prompt sections,
   command/request ordering, and structured reviewer response; never retain
   request headers.
4. Join each app batch to the nearest *unused* evaluator batch that completed
   before the UTC message-ID time and has the same batch size and complete
   ordered reviewer `(riskLevel, authorization, confidence)` vector. This is
   a high-confidence vector/timing join, not an `exact` metadata join: older
   log events do not carry evaluator request/session IDs.
5. Do not force traffic-file order. Concurrent calls can be persisted in
   completion/app order opposite sent-file order. The report records the two
   observed reorders (app batches 14 and 65). One parseable evaluator batch is
   extraneous to the 136 one-to-one joins and is listed in `join-report.json`.
6. For each joined evaluator session, replay persisted conversation events up
   to the evaluator request. The fuller context contains `user_message` text,
   `assistant_journal_item.item` records with `type: "assistant_text"`, and
   `tool_started` request arguments. The exact compact reviewer context is
   preserved separately from the evaluator prompt.

All copied text is passed through a local secret-pattern redactor; raw headers
and provider credentials are not written to the dataset.

## Aggregate result

The frozen log verifies: risk-label matches **140**, authorization-label
matches **31**, both-label `classificationAgreement` **25**, final
approve/deny eligibility agreement **93**, reviewer approvals **180**, and
Jev `weak`/`unknown` authorization labels **95**.

The earlier `93/184` figure is only final eligibility agreement, not label
agreement: just 25 rows agree on both risk and authorization labels.

**Replayability determination:** the reported 95 is a Jev weak/unknown-label
count, not a count of final false denials. There are **91** actual false
denials (`reviewer=approve`, `Jev=deny`), and all 91 have high-confidence
replay inputs. Therefore it is not accurate to say that all “95 false denials”
are replayable; the correctly defined, replayable false-denial cohort is 91.

## Commands used

```sh
python3 docs/research/jev-approval-replay/reconstruction/reconstruct.py
python3 /home/qduc/term2/docs/research/jev-approval-replay/reconstruction/verify.py
```

`verify.py` performs no network calls. It checks JSONL syntax, stable unique
case IDs, required fields, source-path existence, frozen aggregate cross-tabs,
and the embedded dataset, traffic, and artifact digests.

## Known gaps and assumptions

- The high-confidence join is based on unique one-to-one ordered label vectors
  plus timing, not a shared evaluator request ID in every app-log comparison.
- “Fuller conversation” means all recoverable persisted human/assistant/tool
  events before the evaluator request; it cannot recreate events that were
  never persisted or provider system state outside that transcript.
- The source app log is live. Its digest is calculated over the frozen 184
  comparison-event records rather than the mutable whole file.
