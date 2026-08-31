# Session retrieval tools — observed usage and outcome study

## Status

**Completed with no product tuning.** The 2026-08-31 study includes a
naturalistic baseline of seven verified sessions and 79 calls to
`session_list`, `session_search`, and `session_read`, plus six controlled
continuation cells across three rollover-versus-resume pairs. All six cells
passed their deterministic outcome oracle. The controlled evidence did not
show a repeatable quality failure or budget defect, so no session-tool API,
default, budget, or routing prompt changed.

The acceptance bar remains the one in
`docs/plans/session-rollover-handoff.md`: multiple task shapes, both rollover
and ordinary-resume flows, outcome evidence, and concrete failure cases before
any tuning proposal is accepted.

## Resume checklist ("audit the session tools again")

When asked to revisit this study, do not re-derive the method — extend it:

1. Add newly verified sessions (session tool calls since 2026-08-31) to
   `scripts/experiments/session-retrieval-baseline-sessions.json`, verified the
   same way as the existing seven: filename == `session_init.id`, a first
   persisted user message exists, and it matches the provider-traffic index's
   `firstUserMessagePreview`.
2. Rerun `scripts/experiments/session-retrieval-log-analysis.mjs` against the
   updated manifest and diff the aggregate stats (call-type mix, latency,
   result-size distribution) against the numbers in this file.
3. Check specifically whether any pattern from "What this baseline cannot
   establish" or "Insufficient or unstable retrieval" above now repeats across
   multiple independent sessions (not one-offs): mistyped self-IDs,
   stale/invalid cursors, redundant searches ahead of an exact-ID read, or
   broad low-value browsing.
4. Only if a pattern repeats: design one more controlled paired cell using
   `docs/research/session-retrieval-paired-protocol.md` as the template
   (fixed model/effort, rollover run before its resume pair, deterministic
   oracle, exact-ID verification). Do not propose an API/default/prompt change
   from naturalistic logs alone — that was the rule that closed this study
   without a change the first time.
5. If no repeated pattern turns up, update this Status section with the new
   sample count and date and leave the tools unchanged again.

## Method

`scripts/experiments/session-retrieval-log-analysis.mjs` scans the actual
persisted conversation JSONL and provider-traffic index. It does not assign a
session by wall-clock window. A session enters this corpus only when:

1. the conversation filename matches its `session_init.id`;
2. the first persisted `user_message` exists; and
3. the provider-traffic index entry for that exact session ID has a matching
   `firstUserMessagePreview`.

The analyzer records ordered tool calls and arguments from `tool_started`,
results from `command_message`, per-call execution time between those two
events, bounded result size and diagnostics, retrieval-bearing turn cost from
`assistant_turn.costRecords`, and whole-session provider elapsed time. The gap
between a provider response containing the tool call and the next provider
request is also recorded, but it is a continuation-gap proxy: it includes local
dispatch, other parallel tools, and application scheduling, so it is not
reported as session-tool execution latency.

The raw corpus is local user state and is intentionally not committed. Rebuild
it with:

```bash
node scripts/experiments/session-retrieval-log-analysis.mjs \
  --sessions scripts/experiments/session-retrieval-baseline-sessions.json \
  > /tmp/session-retrieval-corpus.json
```

The explicit session manifest freezes the seven-session naturalistic cohort.
Without it, the analyzer intentionally scans every session containing a session
tool call, including the later controlled rollover cells.

## Naturalistic baseline

All seven session IDs below were verified against their first user message.

| Flow | Session ID | First-user-message identity | Calls | Retrieval-bearing turn outcome |
| --- | --- | --- | ---: | --- |
| ordinary continuation | `10c85a17-d2e1-4622-be16-f284a1201244` | “what were we doing” | 1 list, 1 read | Correctly recovered the memory/session-browser implementation state in one turn; 14 s from first retrieval to answer, $0.0074 |
| rollover continuation | `3e3c61f8-d7a2-431e-a4cd-b929a85e3289` | WebSocket lifetime handoff | 2 searches across two turns | Hidden evaluator PASS 8/8 and blind-judge human parity; no list/read; whole continuation $0.0964 |
| ordinary continuation | `53c3d897-64b3-4ad7-93dd-921e0df31f2e` | find and continue model-effort step-down work | 12 searches, 3 reads, 1 list | Recovered the experiment, resumed it, and produced the later benchmark decisions; retrieval-bearing turn 526 s, $0.0245 |
| tool evaluation, excluded from natural outcome comparison | `6b120f67-cbe6-43de-9b3b-c910c13e3a55` | “use the session tools and give me feedback” | 7 searches, 9 reads, 2 lists | Deliberately exercised success/error/budget boundaries; useful for API diagnostics, not agent browsing efficiency |
| live-session recovery edge case | `bd841e1a-1cd0-49ef-8f28-d73e7b094793` | inspect/fix CI failure | 3 searches, 6 reads, 2 lists | Eventually recovered the correct CI state, but retried mistyped IDs and read its own changing session |
| ordinary continuation | `c18e441f-8f56-47e3-b392-a97c35284c32` | interrupted Librarian experiment | 11 searches, 9 reads | Retrieval was necessary and the continuation completed the experiment, but it took 1,609 s and $0.2312 in the retrieval-bearing turn |
| live-session review edge case | `ea6a8471-c360-4d95-af8b-9eaad2a73102` | mode-switching implementation | 8 searches, 2 reads | Used browsing to reconstruct earlier review claims; one self-read cursor went stale |

Aggregate across the seven sessions:

- 79 calls: 43 `session_search`, 30 `session_read`, 6 `session_list`.
- Tool execution time: p50 7 ms, p90 30 ms, maximum 9.86 s. The slow tail is
  real local scanning over a large transcript corpus, not provider latency.
- Serialized result size: p50 3,364 chars, p90 10,763, maximum 11,999. 22/79
  results were at least 8,000 chars and 7/79 were at least 11,000.
- Provider continuation-gap proxy: p50 7.8 s, p90 73.3 s. This is not pure
  tool latency and must not be used to tune the local implementation.

## What the observed agents actually did

### Efficient and necessary retrieval

The vague “what were we doing” continuation used the expected progressive
disclosure path: one 10-item `session_list`, then one 50-record
`session_read` of the identifiable previous session. It returned a correct
state report without a search or a second page. Here `session_list` changed the
outcome: the prompt contained no searchable task noun or session ID.

The interrupted Librarian continuation also needed old-session evidence: its
first prompt named only the role and a harness interruption. It ultimately
found the original experiment session and completed the implementation and
evaluation. Retrieval therefore changed correctness, but the path was costly:
20 calls, including repeated reads and searches over substantially overlapping
phrases.

### Unnecessary retrieval under a strong handoff

The rollover WebSocket task had a diagnosis-rich handoff. Its first search —
`responses-websocket-sessions _onError unhandled promise rejection idle
socket` with a 3,000-char budget — repeated facts already present in the
brief. It returned five matches but did not supply a missing load-bearing fact.
The later targeted search — `session lifetime worktree commits`, limit 3,
1,200 chars — was useful for recovering durable commit/worktree state. This is
a concrete mixed case: one likely redundant search and one useful targeted
search, still with no transcript paging.

### Insufficient or unstable retrieval

The naturalistic corpus contains concrete failures rather than only successful
examples:

- The CI recovery session attempted three mistyped variants of its own session
  ID before using the exact ID.
- Completed and live-session reads produced `invalid_cursor` and
  `stale_cursor` outcomes. Three such cursor failures occurred in the
  Librarian continuation alone; self-reading a session while it changes is a
  reproducible stale-cursor pattern.
- The model-effort continuation issued broad queries whose match counts reached
  hundreds or thousands, then used near-default maximum outputs. It recovered
  the work, but several searches were reformulations over the same experiment
  and one copied cursor was invalid.
- The explicit tool-evaluation session confirmed the bounded
  `output_budget_exceeded`, `not_found`, and stale-cursor errors. Those calls
  are excluded from natural efficiency rates because they were requested test
  cases.

### Budget behavior

Agents frequently selected `limit: 20–50` and `maxChars: 10,000–12,000` when a
brief did not identify one exact target. The output distribution confirms that
these were not inert maxima: 28% of observed results exceeded 8,000 chars.
That is evidence of broad browsing, but not yet evidence that the defaults are
wrong. The corpus lacks the counterfactual showing whether a smaller result
would preserve outcome quality.

## What this baseline cannot establish

The sessions differ in task, model, prompt quality, and amount of durable state.
Their retrieval-bearing turn cost includes all model and coding work in that
turn, not an isolated price for retrieval. Natural logs can identify useful,
redundant, and failed calls, but cannot prove whether a different API/default
would improve the same continuation. In particular, there is only one genuine
rollover task in the baseline.

Therefore this baseline is enough to choose the controlled experiment, not to
change the tools.

## Controlled paired phase

The protocol design, source boundaries, prompt content, fixture facts,
project-path caveat, and replay command are archived in
`docs/research/session-retrieval-paired-protocol.md`. The exact-ID manifest is
`scripts/experiments/session-retrieval-paired-runs.json`; the analyzer is
`scripts/experiments/session-retrieval-paired-analysis.mjs`.

All cells ran serially in real interactive term2/Herdr with
`codex/gpt-5.6-luna` at medium effort. Each pair held model, effort, and source
state fixed:

1. **Diagnosis-rich coding handoff** — old transcript mostly unnecessary;
   verifies whether rollover avoids browsing and retains deterministic coding
   correctness.
2. **Interrupted experiment/research workflow** — decisive state is split
   between transcript and durable artifacts; tests query quality,
   reformulation, and selective reads.
3. **Sparse operational continuation** — the continuation instruction supplies
   almost no searchable vocabulary; tests whether the bounded rollover's exact
   previous-session ID is enough for selective recovery.

For every task, the comparison was:

- **ordinary resume:** restore the source session through the product's resume
  path, then issue the continuation instruction;
- **rollover:** start a fresh interactive root session with a bounded handoff,
  previous-session ID, and the existing session tools.

The interactive root path was required because non-interactive term2
intentionally does not register `SessionBrowser`. Every result below passed all
three identity checks: conversation filename equals `session_init.id`, a first
persisted user message exists, and the provider index's preview matches that
message. Cost and traffic were sliced from the exact continuation user event,
not a wall-clock attribution window.

The resulting cells were:

| Task | Flow | Result session ID | Session calls | Requests | Elapsed | Tokens | Cost | Outcome |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| diagnosis-rich coding | rollover | `296b1363-dd2d-4d8e-b306-b1e057de3a02` | none | 21 | 220.5 s | 811,302 | $0.0347 | hidden evaluator PASS 9/9 + typecheck |
| diagnosis-rich coding | ordinary resume | `9cc61896-a75e-4af9-b1bb-c4f6c432a75c` | none | 17 | 136.4 s | 1,233,639 | $0.0431 | hidden evaluator PASS 9/9 + typecheck |
| interrupted research | rollover | `01eca185-0682-40c6-a25f-cd4377f92f5a` | 1 search, 1 read | 5 | 23.4 s | 69,053 | $0.0049 | checklist PASS |
| interrupted research | ordinary resume | `b9ba496e-e3ba-4c43-b026-dbb50196e55f` | none | 1 | 8.6 s | 13,401 | $0.0010 | checklist PASS |
| sparse operational | rollover | `26f365a3-4255-4a02-99a1-86a855eeba88` | 1 read | 2 | 9.3 s | 25,156 | $0.0033 | checklist PASS |
| sparse operational | ordinary resume | `8b8d3860-7d3c-4104-8d11-ab206bbb2426` | none | 1 | 4.8 s | 12,848 | $0.0007 | checklist PASS |

`Tokens` is provider-reported total input plus output for the continuation and
includes cached input. Source-session work is excluded. Ordinary resume reuses
the source session ID, so its first-message verification correctly checks the
source's first prompt rather than the later continuation prompt.

### Ordered retrieval evidence

The coding handoff was self-sufficient: both cells made zero session calls and
passed the same hidden evaluator. The rollover used fewer tokens and cost less,
but took longer and made more requests; this pair supports handoff
self-sufficiency, not a universal rollover performance advantage. Its two
isolated coding trees had different project paths, so the rollover browser
could not have read the project-scoped source transcript if the handoff had
failed.

The interrupted-research rollover made two calls in order:

1. `session_search` with query
   `acceptance rule routing versus prompt distinction retrieval desired-behavior invocation coding oracle`,
   `limit: 10`, `maxChars: 6000`; 4 ms, 2,563 characters, six results.
2. `session_read` of the exact source ID, `cursor: null`, `limit: 12`,
   `maxChars: 10000`; 4 ms, 3,941 characters, six records.

The read supplied the transcript-only acceptance rule and scope distinction and
was necessary. The preceding search was redundant: the rollover brief already
provided the exact source ID and named the missing facts. There were no errors,
retries, reformulations, omitted records, or cursor failures.

The sparse-operational rollover directly called `session_read` on the source
ID with `cursor: null`, `limit: 20`, and `maxChars: 12000`; it returned all five
records in 2,696 characters in 5 ms. That one read was necessary and sufficient.
There was no list, search, retry, reformulation, omission, or error. The ordinary
resume needed no retrieval because the original transcript was restored.

### Decision

The controlled phase confirms the existing routing can complete all three task
shapes. It also supplies a concrete avoidable-search case, but not a repeatable
failure that justifies changing product routing: the other retrieval-dependent
rollover used the exact-ID read directly, and the strong coding handoff used no
retrieval. Local tool execution remained 4–5 ms; the material cost came from an
extra model continuation, not local scanning.

Therefore retain the current APIs, defaults, budgets, and prompt. A future
candidate may test an explicit “when a rollover gives an exact previous-session
ID, read it directly before searching” routing instruction, but it should be a
controlled prompt counterfactual with missed-history checks—not an inference
shipped from this one redundant search. The naturalistic broad-output and stale
self-cursor cases remain diagnostics, not established default defects.

The study collected per cell:

- ordered session-tool calls and full arguments;
- result sizes, errors, omitted counts, execution latency, retries, and query
  reformulations;
- whether each retrieval supplied a fact used in the successful outcome;
- deterministic evaluator/checklist result and any missed-history failure;
- retrieval-bearing turn and whole-continuation requests, tokens, elapsed time,
  and cost.

All three pairs are settled. The report now contains baseline distributions,
necessary and redundant calls, cursor/error failure cases, and controlled
counterfactual outcomes. The done condition is met without a product change.

