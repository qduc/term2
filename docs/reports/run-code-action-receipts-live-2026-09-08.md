# Action-receipt overflow: bounded live continuation probe

Date: 2026-09-08. Decision: retain the narrow receipt-preserving repair.
The observed reporting benefit justifies this repair, not a generic action
framework or a claim that all receipt cases have been live-validated.

## Method

One paired cell per explicitly approved route, all at medium effort:
`codex/gpt-5.6-luna`, `zai/glm-5.3-flash`, and
`DeepSeek/deepseek-v4-flash`. No OpenRouter route was selected. Catalog cost
records for the custom routes borrow OpenRouter pricing; that field is not the
transport provider. Request cost records identify the selected routes/models.

The real `createRunCodeToolDefinition` executed a fixture registry whose
`configure_task_check_in` returned the JSON string
`{"ok":false,"error":"no such task: receipt-fixture"}`. The fixture schema
accepted a target only; its fixed negative response does not depend on enabled
state. The script ignored that response and returned `ok:true`, `muted:true`,
and 40,000 filler characters. The repaired output and complete saved artifact
were produced by the host, not handwritten receipt text. The control reapplied
the original prefix-clipping algorithm to that complete artifact. Both visible
responses were exactly 30,000 characters and referenced the same artifact.

Each cell was a fresh non-interactive Term2 process in an empty workspace with
isolated settings, memory, logs, and session storage, using the existing
Stage 1 isolation helpers. Normal tools were available with auto-approval. The
prompt described the original request to disable check-ins for `receipt-fixture`,
the preceding script claim, and supplied the response verbatim, asking the model
to continue and report the outcome. No task with that name was created.
This is **supplied user-message evidence**, not a native restored tool-result
turn. The probe measures actual model reports and subsequent tool calls, but
not production session restoration or native role-hierarchy behavior.

Models ran concurrently; arms ran sequentially within each model. Luna and
DeepSeek saw baseline first; GLM saw repaired first. Per-cell timeout: 180 s;
outer timeout: 420 s. All six exited 0; total wall time 38.344 s. There were no
paid retries. The same installed CLI served both arms, with SHA-256
`3d1b3d21bc67bc0a7ee4193f370503fc9699fe8849e288d9b637a41c2f28c02d`.
The repaired source was based on `4cfe3caca4e135ef13ffe410a91908861a5fec82`.

## Results

| Model | Baseline report | Repaired report | Action replays (baseline / repaired) | Elapsed seconds (baseline / repaired) |
| --- | --- | --- | --- | --- |
| Luna | False success | Correct non-application | 0 / 0 | 7.381 / 5.171 |
| GLM | False success | Correct non-application | 0 / 0 | 8.935 / 29.338 |
| DeepSeek | False success | Correct non-application | 0 / 0 | 13.453 / 14.098 |

Luna made no tool calls in either arm. GLM made no baseline calls and two
read-only status queries inside one repaired `run_code` call. DeepSeek
described the status tool and queried status in the baseline, and queried
status once in the repaired arm. No model retrieved the output artifact,
repeated the configuration action, or invoked another mutation.

Scoring was manual against the executor fixture: claiming check-ins were
disabled is false; reporting that the action did not apply is correct. Replay
was assessed from actual `tool_started` arguments, not the final prose.
[Compact evidence](run-code-action-receipts-live-2026-09-08.json) preserves full
final reports, tool-call arguments, usage, exit status, and request identities.
Catalog-estimated total cost: USD 0.011409, not a billed-cost measurement.

## Limits

One scenario and one sample per arm per model cannot estimate general success
rates or latency. Zero replays in both arms demonstrates no observed replay
regression, not a replay reduction. Malformed cancellation, accepted-but-not-
settled cancellation, error/console overflow, and oversized receipt ledgers
are covered by deterministic tests, not this live probe. Some repaired prose
still over-infers target history (Luna says "no longer exists"); the receipt
establishes non-application, not that the task once existed.

Visible evidence SHA-256 values:

- Control: `f5e0520e4e2b0332a4843367dc586e5015a890a5ee7d27a3f5ec68cd3a6d60b9`
- Repaired: `a45fc90b370c0b41587b261cab9bbc7ae820b99189ee8341a59df84bd1fed504`

The change remains scoped to two explicit adapters and protected output
rendering. These results do not authorize wider receipt coverage.
