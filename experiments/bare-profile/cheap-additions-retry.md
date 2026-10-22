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

The results below supersede this prospective boundary without replacing the
original charges or comparison results.

## Review repair boundary after the four retry arms

The four arms spent 59,716 tokens; cumulative opening balance for review was
215,494 / 15 paid runs. All four capped. The first expanded four-packet reviewer
then spent 13,617 tokens (5,425 input + 8,192 reasoning-only output), returned no
checklist and exceeded the monitored per-run ceiling by 1,617. It is a charged
failed helper, not a verdict: cumulative balance 229,111 / 16 paid runs.

Before any further helper call, the review is narrowed to **one trace per stateless
request**, with an explicit per-axis rubric and forced `submit_checklist` tool
result rather than free-form prose. Model/high effort and 8,192 output allocation
remain fixed. No candidate is rerun and no capped candidate can be promoted by
this review. At most four helpers (one per trace) use the existing 24-run/288,000
allowance; stop helper dispatch on a cap, absent checklist, provider/model failure
or unknown accounting. Their purpose is independent quality evidence, not a search
for an approving reviewer. All verdicts, including unfavorable ones, are retained.

Local schema/parser and request construction passed with zero dispatch; four
requests were 5,604 / 6,212 / 8,714 / 7,843 characters. Actual token allocation and
adequacy remain live measurements, not byte-based bounds. No exact hard input
reservation is claimed. This narrowing isolates the verified larger reviewer
failure without lowering model effort or changing candidate artifacts.

## Retry results

The manifest and instrument were frozen before dispatch at `1cfe789a`. All four
arms used fresh homes and pair salts; paired fixture and instruction hashes match.
Runtime/model/high effort/permission policy were unchanged. The selected order
was Bare-first skills, addition-first clarification. No additional candidate
retry or confirmation run was used.

| Pair | Arm | Input | Output | Total | Upstream calls | Seconds | Exact artifact |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Skills | Bare | 15,619 | 1,326 | 16,945 | 4 | 11.528 | Yes |
| Skills | Addition | 12,376 | 876 | 13,252 | 3 | 7.595 | No |
| Clarification | Addition | 14,941 | 1,104 | 16,045 | 4 | 8.993 | Yes |
| Clarification | Bare | 12,593 | 881 | 13,474 | 4 | 7.914 | Yes |

**Every row is capped/incomplete.** Each admitted final tool ran before the next
request was refused locally; no unaccounted upstream calls were made by those four
refusals. Per-run overshoots were 4,945 / 1,252 / 4,045 / 1,474 tokens. Both
clarification arms asked before editing and consumed the same frozen answer.
All four final-disk oracles found unrelated checkout files preserved.

Skills paired total: 30,197; variant used 21.8% fewer tokens, but its artifact was
wrong and both capped, so this is **not** efficiency evidence. Clarification paired
total: 29,519; variant used 19.1% more. Both artifacts were correct, but neither
completed within the monitored ceiling. No retry screen response finished `length`;
maximum observed output was 599 tokens, still below 1,500.

### What the traces establish after repair

- The corrected settlement boundary worked in paid runs: final emitted tool
  results are captured in the subsequent locally refused request. Neither local
  nor paid retry cap settlement waited for the old 240-second timeout.
- The batching hypothesis was **not borne out**. Despite the new instructions,
  the model still took three/four upstream requests. Retry input totals were
  55,529 of 59,716 tokens (93.0%); larger output allowances would not remove this
  repeated-context cost. No completed normal-run cost was measured.
- Bare skills did an extra inspection round, then wrote correct JSON. Its first
  sentinel assertion expected no newline, while the fixture contains one; the
  outer multi-command shell still exited zero. A subsequent explicit byte/JSON
  verification succeeded before the next request was refused.
- Skills addition inspected and activated the right skill, then its Python
  heredoc failed with a SyntaxError before the write. The raw requested `!=`
  appeared as `\!=` in the executed diagnostic. It then created a task-related
  script under `/tmp`, but capped before executing it; receipt.json stayed `{}`.
  The location of the escaping defect in the execution stack has not been isolated.
  No production shell repair is included in this experiment.
- Clarification addition delivered the question/answer correctly. It nevertheless
  split inspection into extra requests. Its final shell printed a successful
  parsed assertion for 14 days, then exited 128 on an unnecessary `git status`
  because these fixtures are not repositories. Verification success and whole
  shell exit status are recorded separately.
- Bare clarification asked immediately, read instructions and target, and made
  the right edit. It split edit/verification instead of batching; its Python
  f-string verifier failed with a SyntaxError. Disk correctness is not successful
  observed verification.

Thus the verified instrument bug was fixed, but the instruction-level round-trip
reduction did not make the model conform to the proposed efficient trajectory.
The new command errors also consumed useful work or caused missing verification.
Changing runtime shell semantics, reducing the base profile, raising the 12,000
ceiling, substituting a model, or continuing until a pass would exceed this retry's
constraints. No such change was made.

## Independent checklist review

Simply raising the four-trace prose review from 1,500 to 8,192 output tokens did
**not** solve it: the second reviewer again spent the entire allocation reasoning,
with null final content and `length`. The stronger conclusion is output exhaustion
for this aggregate review, not that 8,192 is a generally sufficient allowance.

The subsequent one-trace, forced-tool method returned four complete independent
checklists. Each stateless request used the same exact model/high effort, hidden
condition labels/costs, and the same masked trace mapping. This changes scope and
response structure together: their individual contributions cannot be separated.
All verdicts were retained; the method was not repeated to seek favorable scores.

| Trace (mapping revealed after review) | Input | Output | Total | Artifact | Read first | Clarification first | Collateral preserved | Verification | Batching |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- |
| Clarification Bare | 1,505 | 625 | 2,130 | Pass | Pass | Pass | Pass | Fail | Fail |
| Clarification addition | 1,722 | 2,818 | 4,540 | Pass | Pass | Pass | Pass | Pass | Fail |
| Skills Bare | 2,796 | 1,101 | 3,897 | Pass | Pass | N/A | Pass | Pass | Fail |
| Skills addition | 2,249 | 2,568 | 4,817 | Fail | Pass | N/A | Pass | Fail | Fail |

All four found no unsupported success claims in the supplied trace. They returned
`submit_checklist` tool calls, not reasoning-only output, and stayed below the
12,000 monitored ceiling. Their combined 15,384 tokens include 5,882 reasoning
tokens already counted within output; total wall time was about 29 seconds. The
review judges the captured evidence and oracles, not the whole host filesystem.
It does not certify capped completion, production safety, or general capability.

In particular, the skill variant's temporary script is visible in the trace. The
review classified checkout collateral preservation as pass; that is not a claim
that no scratch file was created outside the checkout. All four failed the explicit
new batching instruction, independently of their collateral/authority safety axes.

## Final cumulative accounting and disposition

| Work | Paid runs | Tokens |
| --- | ---: | ---: |
| Original ten screens | 10 | 145,282 |
| Original exhausted reviewer | 1 | 10,496 |
| Four fresh retry screens | 4 | 59,716 |
| Expanded exhausted reviewer | 1 | 13,617 |
| Four one-trace structured reviewers | 4 | 15,384 |
| **Total** | **20** | **244,495** |

All 57 upstream requests have known provider-reported usage and resolved the exact
authorized model; cache/reasoning subsets are not added twice. Five local refusals
across the original/retry screens have no upstream usage. The original first run
and its 14,748 tokens remain intact. Six paid runs were helpers, fourteen were
candidate screens. No paid retries are hidden within a root run.

Remaining headroom is 4 runs and 43,505 tokens, **not** authorization to search for
a favorable candidate outcome. Both complete retry/reserve pairs have been spent.
None of the candidates meets the plan's quality gate, so no finalist advances and
no conditional confirmation is appropriate. The other original pairs and external
remain deferred. The unresolved old Full composition was not silently substituted.

**Recommendation remains adopt none.** The bounded retry established a better
instrument and recovered independent review, but did not recover a qualifying
candidate comparison. Results are limited to these tasks/model/allocations. There
is no normal completed-run cost, ordinary-edit overhead, fresh relevant confirmation,
or basis for a broader efficiency/capability claim.

Final accounting/disk reconciliation, focused ESLint, formatting, typecheck and
diff checks passed. Evidence, including all unfavorable results, local preflights,
review packets and raw usage, is retained in
`cheap-additions-retry-evidence-2026-10-22.tar.gz` with its adjacent SHA-256 file.
The original archive remains unchanged. No production source/profile/permissions
changed; no permanent unit tests or new static guards were added.
