# `run_code` failure and recovery audit (2026-09-13)

## Decision

Do not implement type-checked or pseudo-TypeScript from this sample. Its
distinctive safety case -- rejecting a later static mistake before an earlier
effect -- was not demonstrated at a material rate. None of 87 non-successful
invocations recorded an applied effect receipt, although canonical evidence
revealed one memory mutation followed by a result-shape failure that the receipt
ledger missed. Parameter-shape failures were 4/1,820 (0.22%), and six runtime
result-shape assumptions were normally repaired within seconds.

One narrower problem is both current and concentrated: **all 37 parse failures
were scripts carrying an edit payload inside a JavaScript string**. Thirty-five
used a template literal and two used a quoted string. They were 4.96% of the
746 matched edit scripts in the sample. All remained in the same model turn;
35 were followed immediately by a successful `run_code` invocation, with a
median 16-second and p90 29-second interval. This is repeated model friction,
not evidence of user-visible task failure or unsafe partial execution.

The audit therefore recommended that the next product experiment target the
extra code/data quoting layer for edit payloads rather than add a general type
system. At the frozen decision point it did not select or authorize a public
interface; the follow-up below records the subsequently selected boundary and
the evidence still needed to measure its naturalistic benefit.

## Follow-up experiment selected (2026-09-13)

The implemented candidate adds optional `run_code.inputs`: a JSON object exposed
to the script as the VM-realm global `inputs`. `run-code.ts` preserves JSON keys
such as `__proto__` as inert own data through parameter validation.
`SandboxedCodeHostImpl.run` serializes the object before worker creation, and
`WORKER_TEMPLATE` parses and installs it inside the VM rather than interpolating
payload text into generated source. The public tool supplies an empty object when
the parameter is omitted; shared-host workflow callers omit the binding.

The existing 65,536-byte source admission guard now measures executable source
plus serialized input UTF-8 bytes for callers that provide input data. Rejection
still occurs before worker creation and uses `code_too_large`; its message names
the measured combined bytes and limit. The completion telemetry fields
`sourceBytes`, `sourceLines`, and `sourceDigest` remain measurements of executable
source only, so their established meaning does not silently change.

Public-boundary tests pin syntax-heavy patch text, omitted-input behavior, and
magic-key fidelity. Shared-host tests pin VM provenance for root, nested, and
array values; caller non-mutation; temporary-binding cleanup; property
descriptors; omitted workflow bindings; serialization failure; and ASCII, empty,
and multibyte admission boundaries. This proves the candidate's boundary
contract, not its naturalistic benefit. Re-evaluate fresh completion telemetry
after enough post-change edit scripts exist; compare parse-repair incidence,
same-turn recovery, and latency with this report's frozen baseline.

## Scope and accounting

The frozen window is `2026-09-10 00:00:00` through
`2026-09-13 08:21:00` local time (UTC+7), before this audit began changing the
live log. Inputs were the four daily application logs under
`~/.local/state/term2-nodejs/logs/` and canonical JSONL conversations under
`~/.local/share/term2-nodejs/conversations/`.

The extraction reproduces the telemetry ledger exactly:

| Outcome | Count | Share of 1,820 |
| --- | ---: | ---: |
| Success | 1,733 | 95.22% |
| Parse | 37 | 2.03% |
| Nested validation | 37 | 2.03% |
| Runtime | 11 | 0.60% |
| Cancelled | 2 | 0.11% |
| **Total** | **1,820** | **100%** |

The events span 57 session IDs. Canonical conversations joined 1,817
invocations, including 85 failures. The two unmatched records are cancellations
in session `bfd309d4-0276-452d-b0d0-6872a7cd4ad9` at
`2026-09-11 21:35:03`; both had zero nested calls and empty effect ledgers.
Their absence from the persisted conversation does not change the authoring
classification. Three successful telemetry records also lacked a canonical
join, so source-form denominators use the 1,817 matched calls.

The population is not a production-rate sample. September 12 contributes
1,410/1,820 calls (77.5%), and the conversations mix interactive use, delegated
engineering, audits, and evaluation. The earlier naturalistic audit warns about
the same contamination and distinguishes execution, nested-call, and task
success ([Evidence and scope](../research/tool-real-world-log-audit-2026-09-05.md#evidence-and-scope)).

## Method

`scripts/experiments/run-code-failure-audit.mjs` performs the reproducible join:

```sh
RUN_CODE_AUDIT_BEFORE='2026-09-13T08:21:00+07:00' \
  node scripts/experiments/run-code-failure-audit.mjs \
  2026-09-10 2026-09-11 2026-09-12 2026-09-13
```

For each telemetry event, the script hashes canonical `tool_started` source
with the same truncated SHA-256 convention and joins on session plus digest. It
then joins the `tool_result`, inspects the next matched invocation in that
session, and emits aggregate and per-failure records. The generated output is
not checked in because it includes local session identifiers and bounded error
text; the script is the durable recipe.

Recovery interval means the time from failed tool start to the next matched
`run_code` start. It includes model processing, but it is not a causal latency
estimate and the next invocation is not necessarily a retry. `nextSameTurn` is
stronger evidence: it establishes that no new user turn was needed, not that the
task eventually succeeded.

Provenance labels are deliberately coarse. First-user-message markers classify
obvious reviews, audits, measurements, and delegated engineering; the remaining
bucket is `interactive-or-other`, not a claim of end-user production traffic.
Raw source, arguments, and user text are excluded from this report.

## Finding 1: parse failures are an edit-payload quoting problem

Matched invocation source forms were:

| Source form | Calls | All failures | Parse failures |
| --- | ---: | ---: | ---: |
| Non-edit script | 1,071 | 44 | 0 |
| Edit script without an embedded string payload | 57 | 0 | 0 |
| Edit payload in template literal | 590 | 38 | 35 |
| Edit payload in quoted string | 99 | 3 | 2 |
| **Matched total** | **1,817** | **85** | **37** |

Thus all 37 parse failures carried patch/file-edit data inside JavaScript source.
The parser messages point into payload content, including identifiers such as
`boundedText`, `subagent_question`, `DEFAULT_SETTINGS`, and `term2`, plus
invalid tokens where embedded source closed the outer literal. This is the same
mechanism previously established by canonical examples: nested backticks ended
an outer 10,983-character patch string and forced a retry 63 seconds later; a
second worker repeated it, and another JSX/template failure escalated into an
oversized argument and a user `continue`
([Patch-in-JavaScript quoting is a repeated failure mechanism](../research/tool-real-world-log-audit-2026-09-05.md#a-patch-in-javascript-quoting-is-a-repeated-failure-mechanism)).

Current recovery was fast but not free:

- 37/37 had another `run_code` invocation in the same turn.
- 35/37 next invocations succeeded; one next invocation parsed unsuccessfully
  and one reached nested validation.
- Next-invocation interval: median 16 seconds, p90 29 seconds, maximum 89
  seconds, sum 809 seconds. The sum is descriptive elapsed time, not wholly
  attributable latency.
- 35/37 failures occurred in template-literal payloads and two in quoted
  payloads; changing quote delimiters alone does not remove the composition
  problem.
- Provenance: 25 delegated-engineering, seven analysis/evaluation, and five
  interactive-or-other. The concentration in autonomous engineering explains
  why no new user turn was needed.
- Every parse failure dispatched zero nested calls and recorded zero effects.

TypeScript would parse valid TypeScript syntax, but these failures were not a
population of typed JavaScript annotations. They were JavaScript source made
invalid while carrying another language's text. A compiler would still need the
outer program to parse and would not remove delimiter collisions in embedded
data.

## Finding 2: runtime shape mistakes exist but are small and cheap here

The 11 runtime failures divide as follows:

| Class | Count | Static checking could help? |
| --- | ---: | --- |
| Assumed result or regex-match shape | 6 | Sometimes, if the value has a precise machine contract; not for nullable regex matches |
| Undefined runtime binding (`models`, `setTimeout`, `process`) | 3 | Yes, with an exact virtual ambient environment |
| Non-JSON-safe function in returned object | 1 | Possibly with an exact structured return constraint |
| Invalid JSON in dynamic tool output | 1 | No; runtime data |

Ten were followed by success and one by another runtime failure. Ten recoveries
remained in the same turn. Median next-invocation interval was two seconds, p90
21 seconds, maximum 62 seconds. Nine were followed within ten seconds.

One pair is important but does not justify a compiler by itself: a successful
`memory_update` was followed by an invalid projection of its result, then a
`memory_get` projection made another wrong shape assumption. The mutation
itself applied, but the completion telemetry recorded zero effect receipts
because memory tools do not currently issue those receipts. This is a receipt
coverage limitation: the aggregate `effectReceipts.applied == 0` does **not**
prove no nested mutation happened before any failure. Canonical conversation
evidence shows this one result-shape-after-mutation sequence at
`~/.local/share/term2-nodejs/conversations/6f17189b-f59c-4882-8a15-ae36c39285cc.jsonl:722-730`.
The next call verified the mutation rather than replaying it.

The existing TypeScript plan already requires return declarations to use only
machine-readable `scriptedReturnSchema`, with missing contracts exposed as
`unknown` ([Authoritative tool types](../plans/run-code-typescript.md#authoritative-tool-types)). Before reopening a
compiler, the six shape cases should be checked against actual contract
coverage. A precise contract for a high-use tool may be a smaller fix; nullable
dynamic matches remain runtime concerns.

## Finding 3: nested-validation failures mostly express runtime reality or policy

The 37 nested-validation failures were 22 unknown-tool, 11 nested-call, and four
parameter-shape cases.

The unknown-tool calls sought deliberately unavailable members: `shell`;
policy-hidden `grep`/`glob`; and hidden editing tools such as `create_file` and
`search_replace`, sometimes through `tools.describe`. This agrees with the
earlier registry analysis, which found every inspected unknown name deliberately
absent rather than omitted from discovery
([Milestone 4](../plans/run-code-codemode-improvements.md#milestone-4--measure-and-if-justified-improve-discovery)). Static declarations
could reject them earlier but cannot grant the missing capability.

The 11 nested-call failures included missing paths, a malformed regular
expression, approval-policy refusal, and a nested result over the 100,000-byte
script delivery limit. These are runtime facts rather than static type errors.
The four parameter failures were two maximum-size violations, one `NaN` line
range derived from dynamic data, and one array passed where `grep.exclude`
accepts a string. Only the last is an uncomplicated TypeScript win.

Thirty-one nested-validation failures were followed in the same turn; 31 were
followed directly by success. Median next-invocation interval was eight seconds,
p90 92 seconds. The 1,427-second maximum was a missing-path event followed much
later by other work and should not be charged to recovery.

## Finding 4: current task-level harm is limited but measurement is incomplete

Across all 85 canonically joined failures:

- 78 were followed by another invocation in the same turn.
- 76 were followed immediately by success.
- no source digest failed twice; agents generated repaired source rather than
  replaying an identical script.
- no failed invocation recorded an applied effect receipt.
- no parse failure dispatched a nested call.
- no parse or runtime failure required a new user turn before the next
  invocation.

This supports a finding of repeated autonomous repair cost, not false completion
or widespread user intervention. It does not prove eventual task correctness.
Command lifecycle `completed`, script success, nested success, effect truth, and
task success are separate states ([Completion telemetry is not success telemetry](../research/tool-real-world-log-audit-2026-09-05.md#d-completion-telemetry-is-not-success-telemetry)).

The effect ledger is also incomplete for this decision. The memory-update case
above demonstrates a nested mutation followed by a runtime failure despite an
empty effect ledger. The TypeScript plan's proposed mutation-before-type-error
acceptance test remains sensible ([Acceptance and measurement](../plans/run-code-typescript.md#acceptance-and-measurement)),
but current telemetry cannot measure that safety case for every mutating tool.

## Disposition

1. **Do not implement TypeScript now.** This sample contains too few clearly
   static contract failures, most repaired within seconds, to pay for compiler
   packaging, exact declaration generation, ambient isolation, cancellation,
   resource guards, and source mapping.
2. **Treat embedded edit payloads as the demonstrated residual pain.** The
   37/37 concentration reproduces the older incident mechanism after the
   diagnostics improvements. The selected narrow code/data-separation boundary
   is recorded above; compare fresh parse repairs, task completion, tokens, and
   end-to-end latency against this frozen baseline before broadening it.
3. **Audit effect-receipt coverage before using `applied == 0` as a safety
   conclusion.** At least memory mutation is not represented by that aggregate.
4. **Check the six shape-assumption cases against actual return-schema
   coverage.** Improve an owner-reviewed contract only where it is missing or
   wrong; do not build a handwritten parallel type catalog.
5. **Do not change tool discovery from this evidence.** The unknown names were
   unavailable by policy, and the existing message named the available surface.

The proposed TypeScript reconsideration criterion asks whether statically
preventable failures materially cause retries, false completion, or repeated
effects ([Completion telemetry](../plans/run-code-typescript.md#completion-telemetry-implemented-2026-09-10)). The present sample shows
some cheap self-repair, no identical replay, no observed false completion, and
one canonically visible mutation-before-result-shape-failure that the effect
ledger missed. That is enough to keep measuring and to improve the narrower
interfaces, but not enough to add the compiler.
