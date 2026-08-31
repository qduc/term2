# Session retrieval tools — observed usage and outcome study

## Status

**In progress.** Naturalistic baseline captured 2026-08-31 from seven verified
sessions and 79 calls to `session_list`, `session_search`, and `session_read`.
The controlled paired rollover-versus-resume phase has not run yet. No session
tool API, default, budget, or prompt has changed.

The acceptance bar remains the one in
`docs/plans/session-rollover-handoff.md`: multiple task shapes, both rollover
and ordinary-resume flows, outcome evidence, and concrete failure cases before
any tuning proposal is accepted.

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
  > /tmp/session-retrieval-corpus.json
```

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

Run at least three task shapes, with the same model/effort and source state in
each pair:

1. **Diagnosis-rich coding handoff** — old transcript mostly unnecessary;
   verifies whether rollover avoids browsing and retains deterministic coding
   correctness.
2. **Interrupted experiment/research workflow** — decisive state is split
   between transcript and durable artifacts; tests query quality,
   reformulation, and selective reads.
3. **Sparse operational continuation** — the user supplies no session ID and
   little searchable vocabulary; tests `session_list` discovery and mistaken
   identity recovery.

For every task, compare:

- **ordinary resume:** restore the source session through the product's resume
  path, then issue the continuation instruction;
- **rollover:** start a fresh interactive root session with a bounded handoff,
  previous-session ID, and the existing session tools.

Use the interactive root path because non-interactive term2 intentionally does
not register `SessionBrowser`. Archive the exact source session, first message,
continuation prompt, rollover brief, model/effort, and outcome oracle. Attribute
every run by exact session ID and verify it against its first user message in
both the conversation log and provider index. Run cells serially so provider
usage cannot be mixed.

Collect per cell:

- ordered session-tool calls and full arguments;
- result sizes, errors, omitted counts, execution latency, retries, and query
  reformulations;
- whether each retrieval supplied a fact used in the successful outcome;
- deterministic evaluator/checklist result and any missed-history failure;
- retrieval-bearing turn and whole-continuation requests, tokens, elapsed time,
  and cost.

Do not propose or implement tool tuning until all three pairs settle and the
report contains both baseline distributions and counterfactual failure cases.

