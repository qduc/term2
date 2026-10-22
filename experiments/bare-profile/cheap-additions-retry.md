# Cheap additions: root cause and bounded retry

## Frozen retry rationale

The user requested analysis and retry on 2026-10-22, preserving the 24-run
maximum, 12,000-token monitored per-run ceiling, model identity and previous
charges. This is not a request to increase total-run budgets or replace a losing
comparison. The original evidence and first 14,748-token run remain unchanged.

Verified causes from the original raw requests/responses:

- **Screen response output cap: ruled out for observed screen failures.** All
  36 upstream calls finished `tool_calls` or `stop`, none `length`. Per-response
  output was 55-467 tokens, well below 1,500. Reasoning was 0-305 per response.
  Increasing this allowance would not address the observed bottleneck; it stays
  at 1,500 for screens. The coordinating conversation's reported output-limit
  error is not a paid screen response error in these captures.
- **Repeated-context total cost: verified.** Screen inputs sum to 138,076 of
  145,282 tokens (95.0%); outputs sum to 7,206, including 2,087 reasoning tokens.
  Even cached inputs count in the requested total-token metric. Initial requests
  cost 2,705-4,546 input tokens, growing with instructions, schemas and tool results.
  Three/four requests exhausted the 12,000 monitor before the observed work could
  settle. Completed normal-run cost is unknown because those runs were censored;
  the evidence proves these observed trajectories were too costly, not a universal
  minimum completion cost.
- **Premature admitted-tool cancellation: verified.** The first arm was refused
  on its next request after executing its tool; subsequent arms were disposed at
  the preceding response's usage event, sometimes before its emitted write/question
  executed. This confounded the first comparison and left the structured question
  unanswered. Retry refuses only the next provider request, allowing the already
  admitted response/tool effects to settle. A response that naturally finishes
  after crossing the ceiling is still marked capped/incomplete.
- **Reviewer output starvation: verified.** One response, 8,996 input tokens,
  exactly 1,500 output tokens, all reasoning, `finish_reason=length`, null content.
  A ten-packet review with a 1,500-token reasoning-inclusive allowance did not
  produce the required checklist. That failed helper's 10,496 tokens remain spent.

Hypotheses: batching bounded inspections and combining sequential read/edit/assert
in one shell command should reduce repeated-input cost enough to finish a small
task. An 8,192-token reviewer output allowance with only four packets should permit
a final checklist. These are plausible repairs, not results established locally;
paid observations must confirm or reject them.

## Re-freeze before paid dispatch

Only two complete pairs use the plan's four retry/reserve runs:

1. Skills: selected because the first/second-arm settlement asymmetry prevents a
   valid comparison. New salt, identical new fixture for both arms, same oracle.
   Both receive the same instruction to batch relevant instructions/target/format
   discovery, then edit and parse/assert in one bounded command, then answer.
2. Clarification: selected because the cap prevented the structured question from
   executing. Both receive the same instruction to ask immediately (no inspection
   is necessary to ask the missing consequential choice), then, after the identical
   frozen answer, read instructions/target before editing and parse/assert in one
   bounded command, then answer.

Expected formats and user answer are unchanged; salts are fresh. Version 2 prompt
text is hashed into the fixture hash. Order is randomly frozen and balanced across
the two pairs. No changed production profiles, context suppression, credentials,
model, effort, permissions, or evaluator access. Changing workflow instructions is
a new task condition, so results must not be pooled with original task outcomes.

The experiment-wide opening ledger is **155,778 tokens / 11 paid runs**. New
screen summaries carry that opening balance and paid-run count. Four screens plus
one reviewer would bring paid-run count to 16. Overall ceiling remains 288,000;
per-run ceiling remains 12,000 monitored, with in-flight overshoot disclosed. No
provider call starts after its run has reached the monitor. No additional candidate
retry is authorized to reverse an unfavorable outcome. Unavailable external and
the other three capped comparisons remain deferred, not silently rerun.

One new independent condition-hidden review covers the four fresh screen artifacts,
actions, actual versus expected contents, observed verification and prose. Review
uses the same exact model/high effort with 8,192 output tokens, no automatic retry.
It has no tools or extra conversation turns. Its entire usage counts once. A capped,
incomplete or missing checklist remains incomplete, not an approval. Capability
tool names may allow inference of condition; no condition label, cost or recommendation
is supplied. Model reviewer wall time and raw request/response are retained.

Advancement still requires the original quality/cost rules and a fresh relevant
confirmation plus ordinary task; no adoption from a retry screen alone. Conditional
confirmation needs the old pilot Full composition resolved exactly. The prior
inability to recover that identity remains a real gate if any candidate advances;
do not invent it or substitute Standard by name.

## Local evidence before paid calls

- Baseline focused ESLint passed; only pre-existing evaluator/dependency artifacts
  were untracked in this isolated worktree.
- `retry-rehearsal-v2`: all four CLI/PTY arms settled, shell probe executed, and both
  natural-language and structured frozen-answer routes succeeded. Scripted artifacts
  are intentionally wrong: this is transport/instrument evidence, not model quality.
- `retry-cap-settlement-v2`: all four arms hit an injected monitor after the first
  admitted tool response. Each next request contained the successful shell result,
  was refused locally without upstream dispatch, and exited capped without a
  settlement timeout. This directly checks admitted effects survive the monitor.
- Local reviewer request: four packets, 5,020 characters in this rehearsal, high
  effort, 8,192-token output allocation, no dispatch. Paid input size may differ;
  sufficient model reasoning allocation cannot be proven by this local check.
- Focused ESLint and formatting pass after changes. Runtime typecheck is rerun
  before paid dispatch; no production source or permanent unit tests change.

Results and cumulative accounting will be appended after the four frozen arms.
