# Ordinary safe runs

Authorized outcome (2026-10-07): ordinary Term2 completes useful work without
context tuning or token-growth babysitting, preserves progress and instructions
when reducing context, and pauses with recoverable work when safe continuation
is unavailable. This supersedes opt-in containment as the product destination.
No paid validation is authorized yet. Existing settings and other work are retained.

## Guard contract

- Harm: unbounded request growth, silent budget overrun, instruction/effect loss.
- Scope: the ordinary AgentClient request boundary, direct chat summarization,
  interactive and unattended root runs; shared child paths retain their contracts.
- Classes: request admission, context retention, per-run containment.
- Owners: ApplicationRunLoop admits/parks; LocalContextCompactor reduces closed
  history; session persistence retains checkpoints and the event journal.
- Signals: rendered instructions/tool schemas/history, latest input usage, paired
  closed tool rounds, growth since checkpoint, existing priced/unpriced/time counters.
  Token estimates and unpriced counts are proxies, not exact monetary forecasts.
- Legitimate large work: repeated reads, single-user long tool loops, large source
  files, many instructions. Reduce only closed history; never classify size as failure.
- Precedence: live/CLI > environment > persisted > defaults. Explicit null/off,
  warn/pause, custom ceilings and role limits remain untouched; missing keys get
  the new defaults. Do not guess whether a persisted old default was intentional.
- Selected default: 96k estimated or last-observed request input; auto compaction enabled; critical
  budget containment with advisory warning/stall. Local and auto-native triggers are bounded by 75% of the selected input ceiling
  (72k with fresh defaults). Native ratio/raw and smaller catalog limits still apply.
  See the calibration below; the supervised environment retains its explicit 60k/80k policy.
- Action: compact before admission where a closed prefix exists; otherwise reject
  before dispatch with retained history and clear resume instructions. No truncation
  of user requests, admitted effects, tool pairs or in-flight work.
- Partial settlement: genuine user messages remain verbatim; host receipts describe
  observed tool results without asserting exactly-once/domain success. Summaries
  remain untrusted; effects must be reconciled before retry. Original logs remain.
- Retry/fallback: refusal never consumes a model request or retries; compaction
  clears chaining atomically. Hysteresis requires genuine growth and a closed cut,
  not a new human turn. Local reductions have no one/run cap. Codex native
  replacement retains its existing one/run policy because opaque state has no
  portable growth checkpoint; at subsequent pressure, admission pauses safely. Failure leaves history intact.
- Observability: code/action/effective ceiling/estimate/observed usage, typed budget
  evidence, compaction size/cost/checkpoint, session resume locator; no prompt/key content in guard diagnostics.
- Migration: change missing defaults only; no rewriting persisted customized values.
- Rollback: settings defaults, closed-round compaction, budget presentation and
  helper control inheritance are separable. Ledger owner row will reference this plan.

## Evidence required

Red/green public-boundary cases: long single-user repeated compaction without replay;
verbatim corrections even with an unhelpful summarizer; full instructions/schema
accounting; bounded chunks; post-generation failure accounting; growth/no-thrash;
budget critical pause and no unattended grant; effective persisted overrides;
recoverable CLI checkpoint and typed exit. Focused, related, changed, typecheck,
provider black-box and broad gates per repo instructions are required.

Offline containment and scripted task completion are not semantic model-quality
evidence. Inspect preserved real traces separately. If live validation is needed,
present an exact bounded paid plan and wait for authorization before any call.

## Offline calibration and chosen tradeoff

The preserved October 6–7 OpenRouter traffic has 795 priced/terminal request
records across 16 launch traces, reported native input 2481–256543 tokens.
The request logs omit long text and full tool schemas. They support reported-usage
calibration, **not** byte-estimator accuracy or counterfactual completion rates.
The two healthy research runs independently reconciled 13/16 generations and
peaked at 28919/31295 native input. Coding traces include productive runs peaking
at 47518, 51473, 57727 and 75843, as well as the problematic 256543-token run.
Counts below are correlated requests from a small task collection, not 795 tasks.

| Ceiling | 75% trigger | Recorded requests below ceiling | Recorded requests at/above trigger |
| --- | --- | --- | --- |
| 32000 | 24000 | 192 | 699 |
| 48000 | 36000 | 424 | 553 |
| 64000 | 48000 | 563 | 371 |
| 80000 | 60000 | 651 | 250 |
| **96000** | **72000** | **696** | **183** |
| 128000 | 96000 | 777 | 99 |

96k leaves more room than 64k for ordinary coding and fewer summary opportunities
than 80k, while bounding admitted growth below the runaway traces. 128k avoids
more reductions but allows another 32k input per request before containment.
This is an evidence-informed starting policy, not a measured optimal threshold.
25% headroom allows growth between boundaries; a single larger output can still
cross it. Admission then rejects rather than truncating work. Neither byte/4
estimation nor the prior provider count guarantees the next native token count.
Fixed instructions and JSON tool schemas are included at both native/local
eligibility and final admission. Smaller catalog windows reserve output and 10%
safety space; unknown models use the selected ceiling as a conservative planning
scale without claiming a provider context-window size.

## Implementation and detection gaps

- Missing settings select enabled auto compaction, 96k input and `contain` budget.
  Existing null/off/warn/pause/disabled and custom values survive reload.
- Local planning cuts settled tool rounds within a long single-user request,
  verifies pairing, retains the newest closed round, and preserves every genuine
  user request. Whole user-turn cuts remain preferred when they fit. The hot-tail
  target is soft: larger legitimate paired tails may use the remaining fit budget.
- Host receipts retain call IDs, tool names, argument SHA256 and bounded argument/
  response previews. They prove observed responses only. Earlier session logs
  contain full source evidence; the model must reconcile effects before retry.
  The receipt list can itself become too large: reduction is refused without loss.
- Summary requests include prior summaries and fixed summarizer instructions in
  admission. Oversized historical chunks become inert bounded fragments. No
  non-reducing candidate is committed. A refused/failed candidate preserves source
  history and billed completed summary chunks; helper failures retain an explicit
  unpriced request record when the stream lacks accepted charge metadata.
- Helper requests inherit selected input, character, deadline and idle guards,
  forward cancellation, and report each completed chunk to root budgeting before
  another chunk starts. Cost telemetry remains queue-only and cannot turn a
  pre-output error into committed replay evidence.
- Successful reduction invalidates old observed input. New provider usage can
  replace it; absent usage uses the current full estimate and growth hysteresis.
- Native auto thresholds align with admission, and live input-setting changes
  rebuild the native threshold. Inline native state stays native; local reduction
  refuses ciphertext checkpoints without portable source coverage.
- Headless runs persist their user request and journal before dispatch. `contain`
  pauses at critical evidence even with `--auto-approve`; warning/stall remain
  advisory. Context and budget pauses return exit 2 plus a session locator.
  The terminal collector now preserves `checkIn` and host error codes. Background
  notification turns use the same pause status. Explicit advisory settings also
  retain the session required by context recovery.
- Verbatim protected users are marked in local checkpoints and verified against
  source events during replay. Completed-turn provenance uses actual suffix
  identity; retaining old users no longer makes the resolver infer zero coverage.

The old tests checked multiple human turns and success-only summary accounting,
without long delegated tasks, missing post-checkpoint usage, or the whole
headless/event/terminal conversion path. New boundary tests expose that class.

## Verification and limits

The new scripted AgentClient task creates 20 distinct artifact receipts through
multiple reductions with a deliberately incomplete summarizer. It checks exact
user constraints/current system instructions on each normal request, one action
per artifact, host receipts across repeated checkpoints and summary cost counts.
This demonstrates application control flow with deterministic model/tool
boundaries, not live-model understanding or actual filesystem writes.

Built-CLI loopback cases exercise default successful work, excessive-input refusal
with zero requests under both fresh/explicit warn settings, and a budget pause
followed by actual process restart with `--resume --fork`. The resumed wire must
contain the original request, settled tool evidence and the new verification
request. Existing crash-window provider tests cover a real fsynced effect and
SIGKILL recovery. No new paid model call is made for this task.

Per-run budgets are measured after reported costs, not a prepaid account limit.
Unknown pricing/failed-stream missing usage stays explicitly unpriced; one
in-flight request/retry sequence can overshoot, and sibling child spend is not
an enforced aggregate monetary cap. Logical budget/grant state is not restored
across process restart: the resumed user request starts a fresh bounded run.
An interrupted single-user reduction may lack whole-turn checkpoint provenance;
replay then retains the original journal/full history rather than inventing
coverage. A finalized request snapshot retains the compacted history. It can
require another reduction on explicit resume; it does not automatically replay
external effects. Long accumulated user instructions/receipts may require a
concise artifact-backed handoff. No exactly-once guarantee.

Semantic summary quality and live model completion under these defaults remain
unverified. The traffic is redacted and retrospective; all new task comparisons
use local mocks. Further natural-language task trials need new paid authorization
and a provider-enforced spending guard before any request.

Validation receipts and final broad/independent status will be recorded in the
PR. The guard-ledger owner entry links here. No merge/release/deployment.



## Handoff evidence

The implementation is supervisor-authored in an isolated worktree and independently
reviewed; this task makes no paid Term2/provider calls. The read-only reviewer
recomputed all calibration counts and passed 403 focused/CLI checks, then another
91 checks after the final compatibility repairs. Passing counts overlap between
runs and must not be summed as distinct tests.

The full unit command completed with 10885 passing tests, 5 failing tests,
3 expected failures and 2 skipped tests across 704 files (203.34 seconds,
exit 1). All five failures reproduce on the unchanged base e8bbefb8:
four session-log-lifecycle cases cannot create the environment's home journal
path, and one session-index test disagrees about ordering. They are retained
as failed gates rather than hidden by changing unrelated assertions or access.
The integration tier passed 106 tests with 1 skipped across 13 files
(72.67 seconds, exit 0). Typecheck, scoped ESLint, formatting and whitespace
checks passed. The affected compatibility paths independently pass 91 tests,
including genuine gateway reduction/lifecycle and nested approval continuations.

Remote CI must be reported for the published commit, separately from local
verification. The existing CI workflow triggers only on pushes to main;
opening a draft branch does not by itself produce a PR workflow run. No
merge, workflow-deploy, release or paid live validation is part of this handoff.


The changed-test gate completed with 6469 passing tests and 6 failures
(172.55 seconds, exit 1): the four home journal failures above, a session-index
25ms timing bound under load, and an existing run-code test that waits for
`requestId !== oldId` without requiring a non-null next snapshot. The full
unit run passed both latter cases. These are reported as gate failures, with
paired base/current reruns retained; no timing threshold or unrelated approval
assertion is relaxed. The provider suite exposed two stale fixture contracts:
an implicit one-turn agent budget despite tool-plus-final completion, and the
old 217600 native threshold despite the new 72000 default. Their fixtures now
assert the intended two-turn task and the exact new admission-aligned threshold.
The read-only reviewer separately passed the repaired nested provider case.


Paired reruns of the index and run-code files passed all 159 tests on both
the unchanged base (21.10 seconds) and current tree (20.97 seconds). These
reruns support intermittent/scheduling behavior but do not erase the failed
changed gate or claim a new fix for those unrelated cases. Provider and
changed commands are subsequently repeated serially to remove their competing
load; all prior results are retained.


The complete provider black-box rerun passed 186 tests with 1 skipped across
22 files (131.94 seconds including its build, exit 0). The skipped existing
OpenAI WebSocket reasoning case lacked persisted application-owned response
traffic; it is not reported as verified. The new ordinary-safety CLI cases and
existing fsynced-effect crash-window/native-compaction/chaining/recovery cases
passed. Fake-Codex network checks passed all 15 tests (4.62 seconds, exit 0).


The serial changed-test rerun passed 6470 tests with only the same five baseline
failures across 318 files (116.82 seconds, exit 1); the timing/race cases passed.
The final independent diff review found no remaining material findings. Required
related checks exposed the repaired contract issues; affected-path reruns and
both the changed and full unit commands cover the final implementation. Local
gates with baseline failures remain explicitly non-green. No paid call, merge,
release or deployment was performed.
