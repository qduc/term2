# Cheap Bare additions: capped screens

This report describes the original screen stage. The subsequent user-authorized
root-cause analysis and bounded retry, including final cumulative accounting of
244,495 tokens / 20 paid runs, are in [cheap-additions-retry.md](cheap-additions-retry.md).
Original charges and this stage's evidence remain unchanged.

## Decision

**Defer all six additions; adopt none from this experiment.** All ten available
screen arms were capped/incomplete. None establishes a completion benefit or a
quality-qualified efficiency benefit. No finalist advances, so the conditional
confirmation stage is not run. This is an inconclusive experiment under these
fixtures and allocations, not evidence that the additions cannot help.

No production source, profiles, permissions, or runtime budgets were changed.
The earlier pilot remains paused. Neuralwatt `deepseek-v4.1-flash`, high reasoning,
was used for every paid screen and the checklist helper, without substitution.

## Accounting and every screen

Token counts are provider-reported totals, summed once across upstream calls.
Input includes cached input; reasoning is a subset of output, not an extra charge.
The first capped run and its 14,748-token charge are preserved without retry.

| Pair | Arm | Input | Output | Total | Upstream calls | Elapsed seconds | Exact artifact on final disk |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Skills | Bare | 13,978 | 770 | 14,748 | 4 | 241.252 | Yes |
| Skills | Addition | 14,950 | 420 | 15,370 | 4 | 6.763 | No |
| Bounded read/search | Addition | 13,199 | 439 | 13,638 | 3 | 5.858 | No |
| Bounded read/search | Bare | 13,611 | 564 | 14,175 | 4 | 6.230 | No |
| Environment | Addition | 14,544 | 1,224 | 15,768 | 4 | 7.867 | Yes |
| Environment | Bare | 13,633 | 555 | 14,188 | 4 | 5.933 | Yes |
| Clarification | Bare | 14,584 | 909 | 15,493 | 4 | 7.758 | No |
| Clarification | Addition | 11,662 | 710 | 12,372 | 3 | 5.856 | No |
| Sessions | Addition | 16,583 | 770 | 17,353 | 3 | 14.519 | No |
| Sessions | Bare | 11,332 | 845 | 12,177 | 3 | 7.169 | No |

Every row is **capped/incomplete**, including rows with a correct artifact.
Elapsed time includes instrumentation and is not a valid capability speed comparison:
the first row includes a 240-second settlement timeout repaired before resuming.

| Pair | Paired total | Addition relative to Bare | Disposition |
| --- | ---: | ---: | --- |
| Skills | 30,118 | +4.2% | Defer: both capped, no completion benefit |
| Bounded read/search | 27,813 | -3.8% | Defer: both capped, below saving threshold anyway |
| Environment | 29,956 | +11.1% | Defer: both capped, both artifacts correct |
| Clarification | 27,865 | -20.1% | Defer: saving is not quality-qualified |
| Sessions | 29,530 | +42.5% | Defer: both capped, no completion benefit |
| External connector | Not run | Not measured | Unavailable without a runtime change |

Screens: **145,282 tokens, 10 paid root runs, 36 upstream calls**. This exceeds
the 144,000 screening target by 1,282, but remains below the 288,000 overall ceiling.
Each 12,000-token per-run monitor could overshoot on its in-flight response;
observed overshoots range from 177 to 5,353 tokens. Hard reservations were waived
by the user's "skip budget" amendment, not silently enforced or claimed.

One independent checklist helper: **8,996 input + 1,500 output = 10,496 tokens**,
one upstream call, exact authorized model/high effort. All output was reasoning;
`content` was null and finish reason was `length`. No complete checklist verdict
was returned. Do not treat this as an independent verification pass.

**Final paid total: 155,778 tokens, 11 paid runs, 37 upstream calls.** One local
refusal in the first screen was not dispatched upstream and has no paid usage.
No paid candidate retry, confirmation, or contradictory-result reserve pair was
used. There is no unknown paid usage. Currency cost is not calculated: no frozen
price schedule was established.

## Required behavior, policy, verification, claims

These are coordinator observations, not a substitute for the incomplete blind
checklist. Complete raw evidence is retained in the accompanying archive.

- Skills: Bare read the relevant skill through shell alongside three decoys,
  wrote the exact receipt, and observed a JSON parse and sentinel hash check.
  It did not follow the decoys' unrelated write requests. The addition activated
  the relevant skill directly and read the target before emitting a write;
  that write has no observed successful execution and the artifact stayed wrong.
- Read/search: both avoided dumping the multi-megabyte irrelevant logs. The
  addition used dedicated reads; Bare used shell reads and emitted a targeted
  replacement. Neither final disk artifact changed correctly. Emitting a tool
  call does not prove that call ran.
- Environment: both read the target and produced exact JSON in the active
  checkout; sibling decoy and sentinel were preserved. The addition's first
  verification command failed because the inline inequality expression reached
  Node with an extra escape. A subsequent parse/assert command exited zero.
  Bare emitted a verification command, but its successful result is not in the
  captured request history; disk correctness alone is not observed verification.
  The addition emitted a `goal_check` achieved assertion after its successful
  parse check. Its artifact assertion is supported, but it is not a completed
  screen and does not prove independent review.
- Clarification: Bare asked in natural language before editing, received the
  frozen "Use 14 days." answer, then emitted a replacement. The artifact remained
  unset. The addition read first and emitted `ask_user`, but capped before the
  structured question/answer route executed: no answer was delivered in this paid
  arm. Thus lower tokens cannot be credited to a successful clarification path.
- Sessions: the addition attempted session listing/reading and then shell access
  to the same seeded transcript; Bare used the legitimate shell route. Neither
  applied the dialect. Both preserved the sentinel despite the unrelated old
  request. Tool success versus attempted retrieval is inspectable in the calls;
  no successful end-to-end session-search benefit is established.
- All ten final-disk oracles found unrelated files preserved. This is narrow
  evidence of collateral-write compliance, not proof of complete policy compliance.
  No confident wrong final completion prose was observed. Missing final prose
  and incomplete verification are not scored as successful completion.

## Wiring and local checks

Runtime revision frozen at `70127c2525139314cc560db11548902ede7ea20a`, whose
production code matches inspected baseline `31bf8380137d7f48f463e54f31570a3f3026b4fc`.
Each available pair has matching fixture/instruction hashes and a retained salt.
Fresh homes, workspaces and sessions were used; Bare had legitimate shell access
to the same information. Order was frozen before the first arm and retained on
resume; the nominal six pairs balance three Bare-first/three addition-first,
while omitting external leaves two Bare-first/three addition-first actual pairs.

Actual interactive outgoing request sizes (bytes, **not tokens**): Bare 11,040;
environment 11,273; skills 12,200; read 15,441; clarification 13,527; sessions
18,507; external 11,040. Full messages/tool schemas and profile digests are retained.
Startup paths differ: raw byte deltas are descriptive and are not an isolated
token premium. Clarification also brings `propose_goal`; session capability
brings the session tool family. These are actual bundles, not single-tool claims.

External MCP is registered through `run_code` in `source/agent.ts`; Bare identity
suppresses that surface. The addition therefore did not wire an actual connector.
It is unavailable, not represented by injected model answers or a fabricated pair.

Retained local evidence includes:

- Real headless and interactive request captures, with no interactive unattended
  no-question addendum.
- Six wrong/good/collateral oracle triplets, real seeded session access and missing
  session failure, loopback service success and 404 failure.
- Existing completion-verification integration suite: 39 passing tests, including
  unavailable/inconclusive reviewer states blocking verified completion and a real
  bounded verifier reading disk. This is runtime boundary evidence, not evidence
  that the paid screen candidates received independent review.
- Two successful ten-arm local rehearsals before paid screens; successful production
  shell sandbox probe inside evaluator containment. Local infrastructure required
  an extracted `socat`; no host installation or production policy change was made.
- Cap-repair rehearsal: ten injected local caps terminate promptly instead of
  waiting for a settled assistant turn. Resume of that completed manifest launched
  zero extra arms. Paid resume retained the first row and launched exactly the
  remaining nine arms, with matching salts and original order.
- Final focused ESLint, TypeScript typecheck, accounting/disk reconciliation, and
  diff whitespace checks passed. No permanent unit tests were added.

## Instrument defects and limits

The first cap exposed a runner defect: refusing the next provider request did not
produce a settled `assistant_turn`, so the runner waited 240 seconds and aborted
remaining pairs. An event-driven cap exit and explicit manifest resume repaired
that dead wait; the original attempt was neither erased nor retried.

**The repair also changes the tool-execution observation boundary:** subsequent
arms stop as soon as a completed response reaches the monitor, potentially before
that response's tool calls execute. The first arm ran its last tool and was refused
on the next request. This asymmetry prevents interpreting the first skills artifact
versus its variant as a capability effect. All comparisons remain capped/deferred;
do not use these traces to declare a winning addition or a lower-cost solution.
No further paid runs were used to repair the result after observing it.

The blind helper was a fresh isolated provider request with randomized opaque ids,
condition names/costs hidden, and a retained mapping. Tool names necessarily reveal
some capabilities. Packets were reduced evidence, not complete raw diffs; the first
artifact oracle was not supplied in that packet (subsequent reconciliation checked
it). Reviewer wall time was about eight seconds; no completed checklist was delivered.
There is therefore **no completed blind quality review**. No adoption claim is made.

Old six-pair pilot traces and the old Full composition could not be recovered.
No trace-derived causal claim or reconstructed Full is invented. Full would be a
gate if a finalist needed confirmation; none does here. No ordinary-edit overhead
measurement, fresh relevant confirmation, combination result, cross-model result,
or general performance conclusion is supported.

## Retained evidence and reproduction boundary

`cheap-additions-evidence-2026-10-21.tar.gz` retains the frozen manifest, full paid
requests/responses and records, fixture/oracle metadata, reconciliation, failed
blind review and mapping, interactive wiring, local oracle/cap evidence and sandbox
receipt. `cheap-additions-evidence-2026-10-21.sha256` identifies the archive.
Temporary local dependency binaries and the downloaded package are excluded.

The `cheap-*.mjs` scripts are experiment-specific harnesses requiring this runtime's
built `dist`, isolated local provider settings, `bwrap`, PTY support, and `socat`.
They are not a new production benchmark framework or a promise of portable
one-command reproduction. Evidence paths and temporary homes are historic; paid
commands must not be rerun merely to inspect these results. Future comparison would
need a separately frozen instrument/allocation and a fresh protocol, retaining these
failed charges rather than replacing them.

## Runner retrospective

Preventable, latent defect in this uncommitted experiment harness: a locally
aborted turn and an ordinary successful turn were both represented by the same
settlement wait. The process boundary did not promise an `assistant_turn` after
provider refusal. The structural repair makes the stop event an explicit alternate
exit from that wait; monitored token accounting remains the source of truth.
The missing check was the whole cap/error category, not normal-turn rehearsal.
Injected caps now exercise that boundary through the real CLI/PTY, and accounting
reconciliation asserts uniqueness, paired hashes, exact models and known usage.

Timing/ordering, implicit coupling to persisted events, and missing boundary
contract caused the bug; a type or static lint rule alone would not expose this
process behavior. There was no documented settlement invariant for the abort path.
The first paid cap exposed it within that run; local fault injection would have
surfaced it before spending. Sibling audit found both waits in `cheap-screen.mjs`
use the same repaired helper. `cheap-probe.mjs` waits only for capture-fixture idle
and has no paid cap path. No production persistence or run-loop repair is claimed.
The repaired cap boundary's effect on pending tool execution remains an explicitly
unresolved measurement limitation; expanding this throwaway harness further is
not justified to promote a candidate that already has no qualifying evidence.
