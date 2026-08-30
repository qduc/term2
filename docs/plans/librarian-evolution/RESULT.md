# Librarian workflow experiment

Status: **complete — incumbent retained, prompt candidate rejected.**

Date: 2026-08-30

## Verdict

Do **not** remove the Librarian yet. When directly assigned a broad retrieval
task, the incumbent produced a complete 10/10 decision brief with one memory
call, versus seven memory calls and almost twice the latency for the root agent
doing the same retrieval itself.

Do **not** promote the tested prompt rewrite. It did not cause the parent to use
the Librarian in the natural coding task, and its direct retrieval quality tied
the incumbent while latency and proxy cost were effectively unchanged.

The observed weakness is invocation and lifecycle, not retrieval competence.
The next experiment should change routing or tool-level affordances and run in
an interactive lifecycle that can receive a background completion. More role
prose is not justified by this evidence.

## Candidate mutation

The frozen incumbent was the role prompt at `c8f574dd`. The candidate made one
behavioral mutation across the role and parent-facing trigger:

- describe a concrete use boundary: several memories, possible conflict or
  staleness, or memory maintenance;
- use a decision-ready output with applicable constraints, conflicts, and gaps;
- begin with one focused `memory_retrieve`, expanding only for a named gap;
- omit harmless discarded results.

The production files were restored after evaluation because the candidate did
not beat the incumbent. Only this experiment record and its reproducibility
harness remain.

## Experiment 1 — natural real-world coding task

### Task

Both arms received the same history-free rewind of the real
`r-grok-credit-meter` task, the same five-memory store, and the same model:
`codex/gpt-5.6-luna`, medium effort. Runs were sequential and capped at 900
seconds. The prompt asked the agent to recover prior decisions using its normal
memory/delegation policy before implementing the feature; it did not mandate a
particular role.

The deterministic evaluator was the task's hidden StatusBar test. Three blind
Claude judge samples included the real merged human implementation as a
calibration candidate. Proxy cost uses the model-benchmark price table and is
not an invoice.

### Results

| Metric | Incumbent | Prompt candidate | Human calibration |
| --- | ---: | ---: | ---: |
| Librarian invoked | 0 | 0 | n/a |
| Direct `memory_retrieve` calls | 1 | 1 | n/a |
| Run status | OK | OK | n/a |
| Wall time | 351 s | 283 s | n/a |
| Model requests | 44 | 38 | n/a |
| Agent tool calls | 43 | 37 | n/a |
| Total tokens | 2,651,392 | 1,768,150 | n/a |
| Proxy cost | $0.0840 | $0.0617 | n/a |
| Typecheck | PASS | PASS | n/a |
| Hidden evaluator | FAIL (1/2 tests) | FAIL (1/2 tests) | PASS at origin |
| Blind quality score, mean of 3 | 6.33/10 | 7.00/10 | 9.33/10 |
| Diff size | +175 / -3 | +155 / -2 | +912 / -1 |

Judge samples after unblinding:

| Sample | Incumbent | Prompt candidate | Human |
| --- | ---: | ---: | ---: |
| 1 | 5.5 | 6.5 | 9.5 |
| 2 | 7.0 | 7.5 | 9.0 |
| 3 | 6.5 | 7.0 | 9.5 |

Both model candidates implemented the broad architecture and correctly omitted
missing usage instead of inventing zero. Both failed the hidden reset-date
contract. Blind review also found that both guessed the live response shape,
which would leave the meter empty against the real endpoint. The prompt
candidate was somewhat tighter and handled transient failure better, but that
cannot be attributed to the Librarian because neither arm invoked it. One
sample per arm is insufficient to interpret the latency and cost difference as
anything beyond run variance.

The candidate's acceptance criterion — increase useful Librarian invocation in
a task depending on several memories — was therefore **not met**.

### Judge tooling caveat

All three judge calls returned valid JSON and substantive reviews, but
`run-judge.sh` rejected them as `invalid dimension score` because of the known
rubric-key parser mismatch. Scores above were reconciled from
`judge-{1,2,3}.txt` and `mapping-{1,2,3}.json`; no judge prose or scores were
discarded.

## Experiment 2 — isolate retrieval quality

### Task and oracle

The real credit-meter context was made more demanding and fully oracle-backed:
the endpoint and nested wire shape, presentation contract, lifecycle policy,
failure handling, an adjacent Codex design, and a plausible but explicitly
superseded polling design were split over five memories. The 10-point rubric in
`retrieval-rubric.md` required correct, cited recovery of every load-bearing
fact.

To avoid the non-interactive background lifecycle, the experiment harness ran
the production `ExecutionSubagentRunner` directly with role `librarian`. This is
a real provider/model run using the production role loader, model client,
memory tools, and run loop; only the parent launch/notification layer is
excluded.

### Incumbent versus prompt candidate

| Metric | Incumbent | Prompt candidate | Change |
| --- | ---: | ---: | ---: |
| Rubric score | 10/10 | 10/10 | tie |
| Memory calls | 1 | 1 | tie |
| Model requests | 2 | 2 | tie |
| Wall time | 20 s | 21 s | +5% |
| Wire input tokens | 13,760 | 13,121 | -4.6% |
| Wire output tokens | 766 | 829 | +8.2% |
| Total wire tokens | 14,526 | 13,950 | -4.0% |
| Proxy cost | $0.00367 | $0.00362 | -1.4% |
| Brief length | 348 words | 364 words | +4.6% |

The candidate's structure was cleaner and included explicit verification gaps,
but the incumbent already recovered every required fact, cited the governing
memory IDs, and rejected the superseded design. A 1.4% proxy-cost difference
and one-second latency regression are noise at one sample. This is a tie, so the
candidate is rejected under the workflow-evolution promotion rule.

## Experiment 3 — is the incumbent useful versus direct root retrieval?

The incumbent root agent received the same store and oracle but was instructed
to use its own memory tools without delegation.

| Metric | Incumbent Librarian only | Root direct retrieval |
| --- | ---: | ---: |
| Rubric score | 10/10 | 10/10 |
| Memory calls | 1 | 7 |
| Model requests | 2 | 8 |
| Wall time | 20 s | 37 s |
| Wire input tokens | 13,760 | 142,289 total / 19,409 uncached |
| Cached input tokens | 0 | 122,880 |
| Wire output tokens | 766 | 1,157 |
| Proxy cost | $0.00367 | $0.00773 |

This isolated comparison shows a real specialization benefit: equal oracle
quality with substantially less retrieval work and compressed output context.
It is not an end-to-end delegation cost comparison because the Librarian arm
excludes the parent's launch and result-integration requests. A trial parent
launch cost about $0.0041 before the child run, which would bring total proxy
cost close to direct retrieval. The likely product benefit is therefore lower
latency and context compression, not guaranteed dollar savings.

## Lifecycle observation

In non-interactive mode, an explicit parent request to delegate launched the
Librarian in the background, printed `Done.`, and exited before returning the
brief. This is why the isolated retrieval harness calls the production runner
directly, and why future invocation experiments must use an interactive
session or otherwise preserve the completion-notification lifecycle. The
observation does not establish an interactive product bug.

## Decision and next experiment

Decision: **reject** the prompt candidate; **retain** the incumbent Librarian
for now.

A next candidate is worth testing only if it addresses invocation rather than
rewriting the role again. The strongest testable options are:

1. Put the broad-synthesis handoff at the `memory_retrieve` tool affordance or a
   deterministic routing seam, where it is visible at the moment the root is
   choosing between direct retrieval and delegation.
2. Benchmark in an interactive lifecycle against a larger store where one
   `memory_retrieve` result cannot fit all relevant items.
3. Require promotion to improve natural Librarian invocation and preserve the
   coding oracle, with end-to-end cost and latency including parent launch and
   result integration.

If that routing candidate still produces zero natural invocations, removal or
replacement with a deterministic `memory_synthesize` operation would be better
supported than another prompt-only iteration.

## Follow-up experiment — deterministic synthesis routing

The next experiment tested the concrete replacement suggested above: expose a
root-only `memory_synthesize` operation that accepts 2–5 search angles,
de-duplicates the loaded memories, and returns one bounded evidence packet.
The candidate also removed `librarian` from the root's advertised subagent
schemas. The incumbent retained the existing root memory tools and Librarian
role. Both arms used the same five-memory corpus and `openrouter/openai/gpt-5.4-mini`.

### Isolated real-model retrieval run

Five runs per arm used the production session/runtime path and the same
Grok-credit decision brief. The retrieval oracle required all load-bearing
endpoint, wire-shape, UI, lifecycle, failure, and superseded-design facts.

| Metric | Incumbent | Synthesis candidate |
| --- | ---: | ---: |
| Retrieval-oracle score | 10/10 in 5/5 | 10/10 in 5/5 |
| Runs invoking `memory_synthesize` | 0/5 | 4/5 |
| Runs using direct `memory_retrieve` | 5/5 | 3/5 |
| Mean model requests | 2.6 | 2.8 |
| Mean wall time | 7.0 s | 6.4 s |
| Mean total wire tokens | 31,315 | 31,966 |

The candidate therefore changed the observed routing behavior rather than only
changing prose: broad retrieval was usually expressed as one synthesis call,
while quality remained tied. The small token difference is not material at this
sample size.

### End-to-end coding control

One paired run used `codex/gpt-5.6-luna` on the real `r-grok-credit-meter`
history-free task, with the same prompt and memory fixture. The incumbent took
292 seconds and the synthesis candidate 449 seconds. Both passed typecheck and
both failed the same hidden evaluator assertion: the meter showed `Credits 29%`
but omitted the required `· reset 08/24` text. The candidate did invoke
`memory_synthesize`; it did not improve the coding oracle, but it also did not
regress it. The run is evidence for routing, not evidence of a coding-quality
gain. A parallel OpenRouter smoke run failed before editing in both arms when
the model repeatedly supplied an invalid patch-tool shape; it is excluded from
the comparison.

### Follow-up decision

Decision: **promote the deterministic synthesis affordance as the routing
candidate; do not claim that it improves implementation quality.** It met the
primary invocation criterion (4/5 versus 0/5), tied the retrieval oracle, and
preserved the paired coding result. This is a replacement of the rarely invoked
Librarian entry point, not an improvement to the Librarian role prompt itself.
Keep the old role implementation available for direct/internal callers until a
separate cleanup decision removes it completely. The candidate implementation
and its real-run harness are preserved on the `librarian-routing` branch.

## Reproduction assets

- `task-prompt.txt` — natural coding prompt
- `retrieval-prompt.txt` — isolated Librarian prompt
- `direct-retrieval-prompt.txt` — root-only control prompt
- `memory-seed.json` — frozen five-memory corpus
- `retrieval-rubric.md` — deterministic 10-point retrieval oracle
- `scripts/experiments/run-librarian-benchmark.mjs` — direct production-runner
  harness used for the isolated role arms
- `scripts/experiments/run-librarian-routing-benchmark.mjs` — production
  session/runtime harness used for the routing comparison

Ephemeral raw workspaces and provider traces were written under
`/tmp/librarian-bench-r-grok-credit-meter` and
`/tmp/librarian-retrieval-bench`. The compact metrics and unblinded judge
results needed for the verdict are preserved above.

