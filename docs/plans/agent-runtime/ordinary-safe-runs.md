# Ordinary safe runs

The authorized outcome is useful ordinary work with preserved instructions and
progress, automatic reduction where safe, and recoverable refusal where it is
not. The revision removes the proposed universal 96k/72k policy: a small set of
correlated request traces does not establish an optimal universal context size
or show that large context alone caused the incident. No trace-derived dataset
is published by this revision. Live semantic quality remains unverified.

## Guard contract and revised policy

Context capacity, requested output, estimation reserve, automatic reduction and
an optional cost/latency ceiling are separate quantities. Capacity comes from
provider/model metadata. At every prepared dispatch the known model's input
budget is capacity minus actual selected output minus the existing 10% estimate
reserve. A smaller explicit input ceiling additionally bounds input; null means
no extra user ceiling, not permission to exceed known capacity. Instructions,
tool schemas, aligned full history and latest valid usage participate. Unaligned
chains fail closed wherever a known bound applies. Tool-only continuations need
still-open producing-call IDs in the full snapshot; unknown/duplicate/settled
IDs cannot establish admission. No history is truncated.

The existing 0.8 capacity ratio remains the preferred soft trigger. It is bounded
below hard admission by 10% input headroom; explicit smaller ceilings retain
75% trigger headroom. Explicit raw triggers remain soft policy and cannot waive
hard admission. These ratios are documented heuristics, not optimal thresholds.
For default/inherited output only, allocation is bounded to one quarter of a
known window so small models retain usable input space. Explicit selected or
role output keeps its precedence; an impossible allocation pauses rather than
silently replacing user intent. Provider output maxima still apply.

Unknown models receive no invented capacity. Explicit input ceilings still apply;
raw triggers may enable bounded reduction but do not become total context windows.
Without capacity/trigger metadata automatic reduction cannot be scheduled honestly.
Provider errors and journals retain work; known structured context overflow is a
recoverable context pause when surfaced to the runtime, which stops its own
retry loop. Provider SDK transport retries remain provider-owned. Per-run budgets
remain an independent backstop, not
a prepaid monetary cap or a proof of unknown provider fit.

Default auto compaction stays enabled. Critical `contain` budgets are opt-in
(`agent.runBudget.escalation: contain`); since 2026-10-08 the default is advisory
`warn` again. Explicit compaction-off/advisory/custom settings persist. Closed rounds, verbatim requests,
host-observed tool receipts, failure costs, cancellation, growth hysteresis,
non-reducing refusal and source-verified replay remain independently useful.
Native ciphertext stays native. Codex retains its one-successful-replacement-per-run policy;
local checkpoints can rearm after growth. Headless journals start before dispatch;
critical/context pauses expose saved-session locators and do not auto-grant.

## Primary-source comparison

Other agents separate capacity from policy rather than proving a universal ceiling:
[Codex 0.160.1](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/protocol/src/openai_models.rs)
uses an operating window with distinct compaction/effective-window percentages;
[Claude Code](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds)
uses native model capacity and reserved space;
[Pi 1.0.4](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/docs/compaction.md)
reserves space below model capacity. These support separating quantities. Their
numbers are not copied or asserted optimal for Term2.

## Verification required and limits

Offline evidence must cover small/large/unknown capacity, explicit caps/null/off,
actual output reserve and default/explicit output precedence, provider/model
switches, native thresholds, prepared-prefix hard refusal, failed/non-reducing
summaries, repeated growth and instruction/progress retention. Required focused,
related/changed, type/lint, full unit/integration and provider gates follow repo
instructions. Independent review checks the final diff. Exact published-head CI
is inspected separately; main-only workflows do not imply green draft CI.

Mocks establish control flow, not live semantic understanding. Byte estimation
and metadata can be wrong. Budgets use reported costs after requests, may overshoot
in flight, and do not aggregate siblings. Explicit resume starts a fresh budget.
Interrupted checkpoints can retain the full journal; host receipts do not prove
domain success or general exactly-once behavior. Receipt growth can refuse safely.
Manual planning estimates omit the active instructions/tool prefix; prepared
dispatch admission includes them and may still pause after manual reduction.
No paid calls, security/billing-cap changes, merge or trace dataset publication are
authorized. A revised smallest synthetic live validation proposal follows offline
verification only. Rollback can revert default policy independently of retention,
accounting, journaling, budgets and controlled-ingress repairs.

## Previous published-tree verification (0aae2a03)

- Full unit: 10,911 passed, 5 failed (166.90s). Four journal-path failures
  reproduce on unchanged base `e8bbefb8`; the unchanged 100ms candidate deadline
  test failed under the full run and passed isolated on both base and current.
  This remains a non-green full-unit result.
- Related and changed: 5,821 passed each across 267 files (107.77s/113.29s).
- Integration: 106 passed, 1 skipped (41.01s) on repeat. The first run had
  105 passed, 1 skipped and a first CLI help/cache-build timeout (48.46s).
- Full provider black-box: 189 passed, 1 skipped across 22 files (128.27s,
  including build). Small/large model admission, unknown-model overflow,
  restart/resume, native state, chaining and effect crash-window cases pass.
- Fake-Codex network: 15 passed (1.70s); typecheck passed (7.39s).
- Independent review: final chain/policy gate passed 219 tests across five
  files plus earlier 352-test policy coverage. Counts overlap. Final probes
  verified original-prefix admission and mismatched-tool refusal; no remaining
  material finding.

All 51 changed source/test hashes match the stable tested tree. Scoped lint,
formatting, commit hooks and published-head inspection are recorded in the PR.
No paid call or live semantic validation was performed. Earlier provisional
failures remain in local logs rather than being relabeled as passing evidence.

## Output provenance repair contract

Real settings startup must not turn an untouched default output allocation into
an explicit preference by serializing a defaults snapshot. For the provenance-
sensitive output key, absence on disk means default; an explicit property means
explicit even when its value equals 32,000. Preserve absence during startup,
missing-key fill and unrelated locked saves, preserve explicit write intent, and
remove the property on explicit reset. Reconciliation must use the locked raw
file projection, rather than schema-filled defaults or stale process origin.
Existing files containing the property remain explicit; their historical intent
cannot be inferred safely. Required regressions cover real persistence/reload,
missing-key fills, same-value explicit writes, reset, concurrent stale saves and
built-CLI small-model tiny-request success. No paid calls. Delivery remains an updated draft PR under the latest instruction.

## Native continuation and locked batch repair

Admission uses the shared native replacement projection for the actual prepared
request. Completed OpenAI native compaction invalidates only the obsolete input
usage hint; cumulative billed usage and cost records remain intact. Native
completion order determines placement of encrypted reasoning around replacement
boundaries, including reasoning first seen as stream fragments. Tool receipts
after the boundary stay in the request and tools execute once. Durable history
retains the original request and ordered native state.

Persistent batches validate before locking and record successful batch intents
before reconciling the locked committed settings; they cannot replace a peer's unrelated output
allocation with a stale defaults snapshot. Real persistence tests replace the
previous source-stub coverage gap, and provider tests run two production-mode
CLI invocations on the same isolated settings file. The 16k Reka Edge CLI case
completes with a 4,096-token output allocation. The default CLI prefix can exceed
the 8k GPT-4 model's 5,324-token input budget even with the corrected 2,048-token
output allocation; that legitimate prepared-context refusal remains intact.
Partial ancestor writes preserve omitted-leaf provenance, CLI/env precedence,
peer allocations and ordered mixed batch intent. Earlier dense files retain
explicit-property semantics because historical user intent is unknowable.

The defect classes were source provenance being inferred from schema-filled
values, stale pre-lock snapshots replacing reconciled state, and different
continuation projections/orderings at admission and dispatch. Regressions now
exercise these actual boundaries rather than reproducing resolver arithmetic.
Final-tree verification (post-review source/test hashes frozen):

- Full provider black-box: 190 passed, 1 existing skip, 22 files; exit 0,
  127.71s including build. Production-mode fresh/reload Reka Edge requests
  each carry output allocation 4,096 and persist no output-default property.
- Related: 6,165 passed, 4 failed, 294 files; exit 1, 116.88s.
- Changed: 6,159 passed, 5 failed, 293 files; exit 1, 114.42s.
- Full unit: 10,923 passed, 5 failed, 705 files; exit 1, 161.03s.
  The four unavailable-home journal failures and session-index ordering failure
  reproduce on unchanged base e8bbefb8. Their source/test files are unchanged.
  The broad gates remain non-green; no assertions or deadlines were relaxed.
- Integration: 106 passed, 1 skipped; exit 0, 41.82s.
- Fake-Codex network: 15 passed; exit 0, 1.60s.
- Typecheck: exit 0, 6.34s. Scoped lint and formatting passed.
- Independent review: 368 passed across 8 files, plus production CLI probes,
  ordered mixed batches, CLI/env/peer precedence and refused-write overlay
  preservation. No remaining demonstrated material finding.

All 55 changed code/test hashes match the final tested tree. The reported cloud
connection notification did not terminate the executor: the existing sequencer
completed all checks, without duplicate launches. Supervisor/Codex authored these
repairs; no new paid Term2 coding-worker or provider calls, security changes,
trace-dataset publication, merge, release or deployment.
