# Assignment: reconstruct production approval-shadow cases

Run ID: `jev-auth-replay-20260919`
Task ID: `reconstruct-184`
Worker: `reconstruct-terra`
Return-only sink: your own Herdr pane; finish with the exact marker `TASK_COMPLETE reconstruct-184` or `TASK_BLOCKED reconstruct-184`.

## Goal

Reconstruct the 184 production approval-shadow comparisons from local application logs, provider-traffic records, and persisted conversation events. Produce a machine-readable dataset suitable for a controlled replay that can distinguish context loss from rubric interpretation and genuine ambiguity.

## Ownership and authority

- You own only `/home/qduc/term2/docs/research/jev-approval-replay/reconstruction/`.
- Do not modify source, settings, tests, existing Jev experiment artifacts, or any other directory.
- Read local logs and conversation events, but never print, copy, or persist secrets/API keys.
- This is research. Do not send provider/model requests.

## Required evidence and deliverables

Create:

1. `dataset.jsonl`: one row per uniquely joined comparison, preserving at minimum:
   - stable case ID and source references;
   - command and ordered batch position;
   - reviewer risk/auth labels and decision;
   - Jev risk/auth labels, confidence, and decision;
   - exact compact task context sent to the reviewer;
   - reconstructed fuller conversation context ending at the command request;
   - latest user request and prior-human-decision evidence when recoverable;
   - join confidence (`exact`, `high`, `ambiguous`, `unmatched`) plus reasons.
2. `join-report.json`: counts, cross-tabs, uniqueness diagnostics, excluded/ambiguous rows, and hashes of source inputs and dataset.
3. `README.md`: method, assumptions, known gaps, exact commands used, and a concise determination of whether all 95 reported false denials are replayable.
4. `receipt.json`: run/task/worker, artifact paths and SHA-256 digests, verification argv copied exactly, declared children (must be `[]`), unresolved risks.

Use the code-defined labels and verify the reported aggregate rather than assuming it. Preserve evidence that reveals whether the earlier `93/184` number was label agreement or only final approve/deny agreement.

## Joining guidance

Relevant roots:

- app log: `/home/qduc/.local/state/term2-nodejs/logs/term2-2026-09-19.log`
- traffic: `/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-19/`
- conversations: `/home/qduc/.local/share/term2-nodejs/conversations/`
- evaluator: `/home/qduc/term2/source/services/approval/shell-auto-approval-evaluator.ts`
- shadow rubric: `/home/qduc/term2/source/services/approval/decision-shadow.ts`
- reviewer rubric: `/home/qduc/term2/source/prompts/shell-auto-approval.ts`

Treat joins as exact only when session/request metadata and ordered commands uniquely identify the batch. High-confidence timestamp/vector joins must state why they are unique. Never silently force ambiguous joins.

## Verification

Coordinator-supplied verification argv (copy exactly into `receipt.json`):

`["python3","/home/qduc/term2/docs/research/jev-approval-replay/reconstruction/verify.py"]`

Create `verify.py` to validate JSONL syntax, stable unique IDs, count consistency, required fields, source-path existence, aggregate cross-tabs, and embedded file digests. It must perform no network calls.

## Completion report

State artifact paths, SHA-256 digests, verification command/result, exact/high/ambiguous/unmatched counts, replayable false-denial count, declared children, and unresolved risks; then emit the exact completion marker.
