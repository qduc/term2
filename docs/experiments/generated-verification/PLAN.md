# Generated edge-case verification

Integrated by merge `7561e1df77cdaa5fc81be9815c25104ee0bb17a7`.

## Goal and authority

Deliver a permanent, inexpensive, LLM-free-at-runtime edge-case discovery command.
The user authorized end-to-end implementation, evaluation, independent verification,
and integration. LLMs may build/maintain/investigate the tool, never participate in
its execution. The user explicitly clarified that the traditional-unit-test ban
**does not prohibit this generated verification method or persistent tooling**.
This exception is not permission to restore the example-based unit suite.

## Acceptance criteria (frozen before implementation)

1. A documented installed command generates supported inputs/action sequences
   against production code without models, credentials, or AI network calls.
2. Properties cite contracts; explicit case and sequence-size budgets make runs
   finite. Initial evaluation budget: 1,000 cases/property, at most 30 actions/case,
   target <=30 seconds per target on this host after dependencies are installed.
   These are evaluation defaults, not correctness guarantees or runtime guards
   on product execution. Record actual costs and revise explicitly if unsuitable.
3. Failed properties exit nonzero, shrink to a replayable example, retain seed,
   replay path, revision/dirty state, case counts and runtime in structured output.
4. History repair/projection is the first target. A queue-controller action model
   is the proposed second target (confirm contracts/callers before implementing).
   Demonstrate structured properties and generated state-machine sequences.
5. Demonstrate detection of a genuine current or historical supported edge-case
   defect, not merely a deliberately injected fault. Independently validate it.
6. Classify every candidate discovered during bounded evaluation. Fix confirmed
   defects and verify before/after, or obtain explicit human agreement to defer.
   Reject/narrow unsupported properties; do not silently weaken contracts.
7. Measure runtime/cases and observed setup/triage effort; distinguish unknown
   effort from zero. No invented token-cost or speedup comparison.
8. Required static and behavioral checks pass; required independent review and
   fresh-agent real-use verification pass on the final artifact. If unavailable,
   completion remains verification-pending.
9. Integrate commands, docs, policy clarification and retained evidence. Promote
   only if the pilot is useful and inexpensive; an evidence-backed do-not-promote
   decision is a valid endpoint, with experimental additions isolated or removed.

## Scope and design direction

Prefer fast-check for structured generation, shrinking, seeds and state commands;
check compatibility before adopting. Keep tooling separate from runtime code and
Vitest unit-test discovery. No generic verification platform, no whole-repo proof,
no model-driven oracle, no mandatory provider spend. Do not auto-enable expensive
CI until its value is demonstrated. Any product bug fix is a separately reviewed
change with appropriate project checks.

## Execution and evidence

- Worktree: `.worktrees/generated-verification`, branch `feat/generated-verification`.
- Base: `6075a3cf` (primary clean when inspected).
- Dependencies installed with frozen lockfile successfully, Node 24.19.0 / pnpm 11.7.0.
- Loaded methods: agentic-loop, implementation, testing, verification, writing-docs,
  guard-design (test-only budgets excluded), finding-triage, term2.
- Required real-use guide: `/home/qduc/.agents/skills/coordinator/references/real-use-verification.md`.
  The global AGENTS link through `qduc-skills/skills/coordinator` is stale; the
  installed canonical equivalent above was read.
- No checker or source modifications yet. Original Gemini checker is hand-written
  deterministic cases plus limited BFS, not conventional fuzzing or formal proof.
- Old queue finding may already be mitigated by `QueueController.#snapshot`:
  inspect before claiming it. Current remove_queued lacks explicit paused cleanup,
  but snapshots can normalize the state.
- `dropUnpairedFunctionCalls` uses first canonical item only; investigate supported
  multi-tool-call histories through `projectHistoryForProvider` (actual export name
  to confirm) in conversation-state-projector.ts before claiming a defect.

## Next steps

1. Inspect contracts, public callers and existing suites for the two targets.
2. Implement small generated runner and target properties; update policy docs.
3. Run bounded discovery, classify/reproduce findings, fix confirmed scoped bugs.
4. Execute required tiers and CLI failure/replay checks; retain evidence.
5. Independent review plus fresh-agent use, evaluate promotion, integrate cleanly.

## Discovery checkpoint (2026-10-24)

- Checker implementation retained at `0f40efc8a475487874488312640b8c252cd13550`.
  Production queue/history code still equals base. Discovery and replay JSON are
  committed alongside the checker, making the dirty discovery snapshot recoverable.
- Seed 424242: history 1,000 cases passed (248.6ms); queue failed at case 314,
  shrank 22 times to submit/submit/fail/remove (32.3ms). Replay exits 1 in one
  case with the same four-action failure (11.5ms). No fault injection used.
- Finding Q1: empty paused queue after removing last failure-retained item.
  Candidate supported by explicit empty-pause invariant in controller cancellation
  and restore paths; public UI caller confirmation/independent validation pending.
  Proposed route: fix at queue owner, keep nonempty failure pause and unproven
  cancellation ownership unchanged. No new queue manager or settings needed.
- No other candidate discovered by these bounded runs. Multi-call chat histories
  are outside initial property scope; first-item normalization observation remains
  an unvalidated lead, not a reported supported defect.
- Independent discovery/fresh-agent attempt uses existing Codex configuration,
  read-only sandbox, trace `independent-discovery.trace.jsonl`. It reports command
  execution blocked by sandbox/pnpm/Git; any helper-only fallback is supporting
  evidence, not a completed real-use gate. Must rerun shipped workflow with usable
  workspace permissions on final artifact. No author implementation hints sent.
- Package dependency mandates all tiers; background job is running sequential
  typecheck/lint/static/integration/e2e/provider with individual logs and exits in
  `checks/baseline-tiers.json`. Source must remain unchanged until this ends.

### Queue repair guard contract (before code)

Harm prevented: fresh input blocked behind an empty failure pause after removal.
Scope/owners: public QueueController queue mutation and restart restoration;
controller owns admission/pause/recovery, adapter/UI only reflect state.
Class: existing lifecycle/admission pause, not a new budget or timeout.
Signal: phase paused plus zero retained queue items, direct state evidence.
Legitimate signal: a user just removed all retained follow-ups; must become idle.
True-positive protection: retained nonempty queues stay paused; cancelling active
execution stays owned until matching proof, even if its queue becomes empty.
Configuration/default/clamping: none added or changed; capacity and cancellation
policy remain unchanged. No environment/persisted setting migration.
Action: release only an empty paused phase, do not abort or replay anything.
Partial work: no active execution exists in paused state; queued removals remain
explicit user actions. Unobserved effects are neither labeled failed nor retried.
Retry/fallback/provider continuity: unchanged, no model request added.
Observability: state kind, retained queue, pause reason; no new content logging.
Persisted state: normalize an existing empty pause on load if included in repair;
retain nonempty customized records and recovery diagnostics.
Rollback: separate queue repair commit, generated checker independently retained.
Ledger: append scoped empty-pause incident and red/green evidence to guard ledger.

## Independent discovery outcome and next implementation

`independent-discovery.md` ACCEPTS the defect, independently reproduced with
public API plus actual next-submit non-dispatch; it confirms adapter retract
caller and input ownership consequences but did not drive a full keyboard journey.
Review trace contains hashes/identity. Its direct-property fallback does NOT meet
fresh-agent installed-command real-use gate (read-only sandbox blocked pnpm/Git).
Use workspace-write sandbox for final fresh-agent run, no profile/model override.

Finding triage (all findings from discovery review):
- Q1 empty failure pause: **Route**. Supported production defect, parent already
  independently reproduced the shrunk property. Add minimal owner fix.
- Q2 saved empty pause: **Route for generated characterization**, then minimal
  restoration normalization if red. `#restore` saved-pause branch currently
  unconditionally pauses even when empty (unlike interrupted-active branch).
  This is a supported record producible by Q1 with persistence. Suggested small
  shared `#releaseEmptyPause` helper for discard/remove/restore, not a new manager.
- F1 checker execution IDs share submission counter: **Route**. Genuine fixture
  defect. Use independent execution counter. Preserve queue generator/action shape
  so original failure path stays replayable. This changes no production behavior.
- F2 stale event only never-issued: **Route narrowly**. Replay a previous real
  execution ID when available, retaining never-issued case when none completed.
- F3 driver checks only IDs: **Route narrowly**. Record/check dispatch snapshot
  text and item text too. Same generated sequences, no extra simulation framework.
- F4 readonly pnpm/Git restriction: **Narrow**. Method requires usable local
  workspace process permissions. Fresh gate must rerun shipped command in writable
  sandbox; helper fallback is supporting evidence only.
- F5 README claims #restore universally normalizes: **Route docs correction**.
  Scope backing to interrupted-active restoration before fix; no false historical
  claim even if repair later covers saved pauses.

Baseline tier job `fd765420-a11a-459b-adf0-03dd3dffdd8a` still running. At latest
notification: typecheck PASS 3.13s; lint FAIL 35.27s solely prettier formatting in
new `checks/cli-contract.json` (ESLint 0 errors/31 warnings); static PASS 3.06s.
No product edits yet. Fix evidence formatting and rerun lint after all logs settle.
Do not call that lint failure pre-existing. All tier logs are retained.

Before queue repair, guard-design skill read; complete ledger was requested via
cat but model-visible output truncated. Read uninspected ranges of mandatory
`docs/plans/approvals-and-sandbox/guard-ledger.md` before editing source:
1511–3103 and 3288–3600, and 400–499 (other ranges inspected). This ledger is
3,796 lines, mostly historical; queue-specific enforcement/settlement contract
is under “Interactive foreground cancellation proof settlement” near 340.
Guard contract above is frozen and preserves cancellation fail-closed ownership.
Skills implementation, testing, verification, writing-docs, guard-design,
agentic-loop, finding-triage, debugging and bug-retro have been read in this run
(some long outputs trimmed; consult exact relevant sections as needed).

After source changes: generated replay red/green and bounded multi-seed runs,
script syntax checks, final typecheck/lint/relevant integration, final independent
review and fresh-agent real use, parent inspection/rerun, results/task ledger,
promotion/cost decision, commits then merge --no-ff to primary (preserve others).
Current checker includes no TS edits; scripts are .mjs run by tsx, ESLint excludes
scripts but Prettier checks them. Node --check explicitly for changed .mjs.
Persistent generated checks are user-authorized, do not disguise Vitest unit tests.

Integration baseline tier finished exit 1, 65.24s Vitest / 66.46s wall:
23 passed files, 1 failed, 1 skipped; 222 passed tests, 4 failed, 1 skipped.
All failures in unchanged `source/cli.integration.test.ts`: two Bare small-tool-
surface/config cases ENOENT `result.txt`; outside-workspace edit expected `/exit
[1-9]/` but received noninteractive approval denial; scratch write required shell
approval and target absent. Production code equals base but new dependency exists;
MUST reproduce focused failures on base (isolated worktree + own install) before
calling pre-existing. E2E/provider still running. Primary git status remained clean.
Independent agent finished exit 0 after 193.6sec; thread ID
`01a16d34-bb4b-7600-8953-3c51a8e5e6ce`, configured model gpt-6.1-sol / medium,
no override. Live child agent work: none. Only tier job remains live.

## Successor checkpoint

Strengthened checker commit `9288a02c` preserves production code unchanged.
Independent execution counter, real previous-ID stale events, and dispatch
item/snapshot text are now checked. Original serial failure remains case 314,
22 shrinks, same replay path (78.3ms). New `queue.restore-pause` fails case 7
with saved `failure` pause and empty queue (10.9ms, one shrink, path `6:0`).
Red artifacts retained in that commit; these dirty records are reconstructible
with the committed checker against unchanged production code. Q2 confirmed.

Baseline e2e: 2 failed files / 7 failed tests, 3 passed files / 25 passed tests,
1 skipped file / 4 skipped tests. Several fail on missing built worker modules;
e2e was run before an explicit build. Provider runner builds automatically.
Do not classify e2e baseline until inspected/re-run with build prerequisite.
Base reproduction worktree `.worktrees/generated-verification-base` detached at
6075a3cf has its own successful frozen install; focused CLI integration is
running, job `28a4d09a-4392-4a88-8451-18c61acf8653`. Logs in checks/base-*.log.

Guard-ledger remaining designated ranges were read in successor (large calls
had omitted display; short follow-up sections inspected). Methods reloaded:
implementation, agentic-loop, testing, verification, guard-design, bug-retro,
writing-docs, finding-triage, provider-testing, real-use gate.


## Repair and bounded evaluation

The owner repair adds shared `#releaseEmptyPause` for discard, remove, and saved
pause restoration. No cancellation or provider logic changes. Seed 424242 passes
all three 1,000-case properties (history 298.7ms, restore 56.2ms, serial 41.7ms;
396.6ms total checker). Both exact previously failing shrink paths pass.
Four further seeds each target 10,000 cases/property. Positive seeds 1,
20261024 and 2147483647 pass; negative-seed space-separated invocation was
rejected by Node parseArgs (exit 2, retained stderr), then equals syntax passed.
This revealed runner replay strings use space-separated seeds and cannot replay
negative seeds: **C1 Route**, supported CLI reproducibility defect, fix formatting
rather than adding a parser. Pending until independent review finishes to keep
its inspected checker snapshot stable. No claim that the invocation error is a
production queue defect. Costs retained in checks/generated-costs.json; negative
corrected run lacks separate wall timing, checker timing remains in its JSON.

Baseline CLI integration reproduced exactly on unchanged detached 6075a3cf with
own frozen install: 51 passed / 4 failed, same four bare profile approval/write
signatures. Final full integration still fails; compare exact signatures before
classification. Final typecheck/static/build pass. After explicit build, e2e
passes (therefore initial missing-built-module failures were setup, not source).

Independent final reviewer/real-use job `bae1fd28-7546-4f17-a87e-b430a8c12bb4`
uses existing Codex config with workspace-write (no model/profile overrides),
brief `review-brief.md`, JSONL trace and final report retained. Parent supplied
acceptance and scope, not exact commands or intended implementation. Source
must stay unchanged during final-tier job `df0be68d-ab81-4d5d-8ad3-febf3c8e24e7`.

### Bug retrospective (proportional, prevention artifact implemented)

1. Representability: separate phase/queue fields permit empty paused state; a
   full union refactor is disproportionate. Shared normalization is local.
2. Single source: empty-pause release logic was distributed; shared helper now
   owns three affected transitions. Cancellation retains its stronger proof.
3. Boundary: public removal and valid persisted record load lacked normalization.
4. Coupling: removal changed retention without updating phase; generated model
   checks phase and payload after every supported generated action.
5. Assumption: pause could outlive its retained work; no timing assumption needed.
6. Detection: no permanent generated transition/restore property existed; former
   isolated path tests did not protect all ways of emptying a pause.
7. Automation: pilot generated properties now cover the category, opt-in; no new
   static guard or CI budget is imposed without authority.
8. Siblings: inspected failure, discard, remove, resume, cancellation proof and
   cleanup, interrupted-active/saved-pause/plain-queue restoration. Only removal
   and saved-pause normalization are confirmed omissions; others already avoid
   empty pause or preserve active ownership intentionally.
9. Knowledge: invariant was explicit in cancellation/active recovery comments
   but not shared with removal; now greppable helper plus generated oracle.
10. Observability: existed at least in base; lifespan uncertain. State() exposed
    paused/zero items, but generated property found it automatically at case314.
11. Origin: remove branch dates to `15c50d2d2` (2026-07-12); later cancellation
    retention repair updated IDs but did not normalize ordinary paused removal.
    This supports a latent omitted transition; exact introduction of the complete
    failure-retention scenario is not bisected or claimed.

No remaining design friction requiring a new interface or manager. Generated
category contracts are the structural prevention artifact, not just one fixed
example; concurrency and full terminal keyboard reachability remain outside the
bounded checker claims.


### Required gate exposed launcher portability defect

Fresh workspace-write agent could invoke pnpm, but installed tsx CLI launcher
failed `listen EPERM` at its local IPC socket before executing the checker.
Unlike the prior read-only attempt, this is a specific unnecessary launcher
capability requirement. **C2 Narrow**: replace the tsx CLI with Node's supported
`--import tsx` loader; same checker and no sandbox/model override. Do not count
helper fallback as installed-command acceptance. Parent changed package script
and negative-seed replay formatting while reviewer was active after observing
its retained failure evidence; this is an author intervention. Must rerun the
actual shipped workflow and independent review against the updated artifact.


## Cost and promotion assessment (decision pending final independent gate)

Observed bounded costs: four seeds, 10,000 cases for each of three properties
(120,000 generated cases total), all passed after repair. Total checker time per
seed: 4.6475s (seed1), 3.3085s (20261024), 3.5805s (-2147483648, corrected
invocation), 3.3318s (2147483647). Per-property maxima: history 3.4445s, restore
0.7696s, serial actions 0.4588s. Positive-seed wall totals including package
startup: 6.4430s, 4.8257s, 4.6085s. Corrected negative wall not measured.
Default 1,000-case/property run: 0.3966s checker total. All are comfortably under
the frozen <=30s/target evaluation goal on this host. No claim about an unloaded
host, exhaustive coverage, total engineering cost savings, or token speedup.

There were real setup/triage costs: frozen dependency install, contract tracing,
independent discovery/review, oracle fixture repair, baseline all-tier runs,
isolated base install/reproduction, explicit e2e build prerequisite, negative
seed invocation diagnosis and nested-sandbox launcher diagnosis. Author totals
and initial install timing were not independently tracked: unknown, not zero.
First independent discovery run took 193.6s; its trace records 691,992 input
(including 642,176 cached) and 5,878 output tokens. Those are observed invocation
usage, not the whole task's token cost, and no price comparison is inferred.

Recommendation: retain the generated method as an opt-in installed development
command if final independent/fresh-use gate passes. It found two supported queue
lifecycle omissions, shrank the principal one to four actions, and reruns cheaply.
Do not auto-enable CI or expand to provider transport/concurrency/malformed
history without new contracts and measured benefit. The pilot is not evidence
that the wider no-unit-test experiment is cheaper or equally safe.

Parent boundary probe passed: unproven cancellation retained active ownership
after removing retained work; stale proof did not release; matching proof alone
dispatched fresh input; removing one of two failure-retained items preserved
pause/reason; last removal persisted an empty queue without pause; all three
valid empty saved-pause reasons normalized. Output:
`checks/parent-queue-boundary.json`. Temporary CLI fault injection (explicitly
not discovery evidence) verified a negative-seed failure exits1, emits equals
syntax and replays with same seed/exit1; `checks/negative-replay-contract.json`.
No temporary example test is committed.

Final source/checker commits: queue repair `4de1cebf`; portable command and
negative replay `db1c1f88`. All previously retained dirty green snapshots have
matching source retained in the repair commit. Source unchanged during all-tier
runs. Mandatory command results (including failures) are appended, not rewritten,
in docs/test-results.json; committed-snapshot results will follow separately.


## Final-gate follow-ups

Committed all-tier snapshot `db1c1f884d663cb14cc90da9487683fc1afab6ac` passed
static/typecheck/build/e2e; integration reproduced the same four base failures.
Provider suite had one late 40s PTY state timeout in `turn-decisions.blackbox.ts`
(repeated questions), after 220 passed / one skipped. Earlier repaired-source
suite passed221/skip1; do NOT silently use it as committed-gate success. Focused
scenario then CI-bounded full suite now running, job
`cbb53539-c0d3-450e-a66b-9706a40d7034`; retain/classify all results.

Lint run failed9 errors, all in independent review's temporary evidence `.mjs`
files under checks/real-use (Node globals and one unused parameter). Not
pre-existing, not production. After reviewer stops, remove or archive temporary
probe sources as non-executable text evidence, format retained JSON/Markdown,
and rerun full lint. Do not add a blanket ignore or change production lint.

Nested workspace-write verifier also blocks Node `spawnSync git EPERM` even
outside parent's sandbox. Helper Git shims are supporting evidence ONLY. Parent
requested host runtime approval for one bounded read-only-code independent use
with Codex nested process sandbox removed (`danger-full-access`); shell permission
was granted and job `c21d3689-eb2e-4bcb-b1d1-53680e682b4e` runs current shipped
workflow. Model/profile unchanged. Preserve this explicit author intervention,
all failed attempts and actual acceptance; no claim that fallback met the gate.
Its report/trace are `approved-installed-use.*`. The workspace-write attempt
`81928cde-4c52-453c-a74d-22e1e3cad8f3` remains separate failed/pending evidence
(`fresh-installed-use.*`). Original independent final review job
`bae1fd28-7546-4f17-a87e-b430a8c12bb4` still active and must be read/triaged.


### Independent final review triage

Report checks/real-use/REPORT.md rejects only R1: synchronous Git metadata query
fails in this managed development workspace. **R1 Route**: same-process probe
proves async Git works where sync Git fails; parent independently inspected its
retained diagnostic output. Replace the two sync calls with awaited async calls,
retain exact revision/dirty and failure exit2. No retries/fallback/new abstraction.
Narrowing this actual developer environment out or dropping metadata would weaken
the intended method; approved broad-sandbox success is supporting evidence, not
the final answer to R1. A new fresh workspace-write use must pass after this fix.
Reviewer accepted queue repair/oracle behavior after21 boundary checks; no other
must-fix candidates. Its own probes initially supplied an unsupported empty item
ID and wrongly expected the original snapshot-factory object to be frozen; both
were corrected against production contracts, not routed as product defects.
Its network guard initially blocked local IPC; retained as invalid instrumentation,
not discovery. Final supported-runtime probes observed zero network attempts.

Focused provider follow-up passed (7.106s); CI=1 full provider suite passed
(119.536s). Late default-worker failure remains an observed intermittent PTY
wait, not claimed a base-reproduced defect or proven contention root cause.


### Final runtime compatibility repair and review scope

`29d154543c31e9682499de4ecfefaee2c1786ddd` replaces only sync metadata calls
with awaited `execFile` calls. Parent installed seed424242, final typecheck,
static guards and all three script syntax checks pass. `git diff db1c1f88..HEAD
--name-only` lists only `scripts/generated-verification/run.mjs`; package,
lockfile and production source remain exactly the all-tier-tested versions.
Final normal-sandbox fresh agent job `5d0d854c-3885-4422-8de4-b4f20ecd776a`
uses shipped method and independently chooses commands, no shims or override.
Full report/trace pending at `final-fresh-use.*`; acceptance requires inspecting
and rerunning its deliverable. The broader-approved verifier independently
ACCEPTED db1c1f88 after7,008 sampled/replay cases and12 invalid CLI cases;
that supporting report does not replace R1 closure in normal sandbox.

Proportional portability retro: (1) runner syntax admitted negative seed values
whose emitted space-separated replay was invalid; (2) replay formatting was the
single owner, now equals syntax; (3) Node parser and subprocess boundary contracts
were not exercised by initial help/positive-seed checks; (4) launcher/sync-process
assumptions coupled checker use to unnecessary host capabilities; (5) those
capabilities are not guaranteed by a writable sandbox; (6) detection gap was the
actual installed fresh-agent workflow, not production generation; (7) temporary
CLI failure/replay and final actual-use gates now cover this category; (8) inspected
all two Git queries, seed validation/template, output file refusal and launcher;
(9) supporting helper runs are explicitly not workflow acceptance; (10) exits2
were already visible and now retained, total historical lifespan limited to
this pilot; (11) all three defects originated in initial runner0f40efc8, not
an upstream production regression. Structural prevention is fewer host
requirements plus actual installed-boundary evidence, not a new permanent
example suite or broad exception to lint/sandbox rules.

Primary advanced independently to `298fb429` (session-rollover tool description,
one-line change only). Primary remained clean. Preserve that commit during the
authorized --no-ff merge; do not reset/rebase primary. Owned unchanged-base
reproduction worktree was removed after logs were retained; feature worktree
remains until final evidence/integration.


## Handoff checkpoint after final implementation (2026-10-24)

Current product/checker HEAD29d15454; production fix4de1cebf, launcher/negative
replaydb1c1f88. Code complete, final normal-sandbox independent-use still running:
job5d0d854c-3885-4422-8de4-b4f20ecd776a, monitor unlimited notifications installed.
Trace/report `final-fresh-use.*`, evidence `checks/final-fresh-use/`. All other
jobs in this document have completed. **Do not claim final gate or merge yet.**

Independent discovery ACCEPTED real bug; final reviewer R1 rejected sync Git and
found no other supported source/oracle defect,21 boundary checks passed. R1 fixed
and committed29d. Final fresh agent sees that artifact and uses actual installed
method with no author command sequence, no Git shim, normal workspace-write,
same configured model/profile. Approved broad-sandbox run ACCEPTED prior db1c,
retained separately, not used as substitute for final normal-sandbox acceptance.

All-tier committed db1c: types/static/build/e2e pass; integration four unchanged
bare-shell-policy failures reproduced exactly on isolated base6075 (51pass4fail)
and final suite(222pass4fail1skip). Default provider had late PTY timeout
(turn-decisions repeated questions), focused retry passed, CI=1 full provider
passed(119.536s); previous repaired-source full provider also passed. Keep all
failure evidence, do not claim timeout root cause or whole integration green.
Only run.mjs async metadata differs db1c..29d; package/source/deps identical.
Final29d typecheck/static/script syntax and installed parent seed424242 pass.

Recorded docs/test-results.json contains13 baseline/dirty/base-repro runs plus
6 committed runs and interim lint failure. Still append provider follow-up,
29d final static checks, final successful lint, generated/independent evidence
and primary integration results as appropriate. Schema established in existing
rows. Final task tasks.jsonl row NOT yet written: add when verified, use unknown
(null) total author time/tokens rather than fabricated zero/cost improvement.
Known independent usage/costs and default/multi-seed timings in prior sections.
No escaped completed-task defect record needed for within-task checker fixes.

Initial final lint failed9 errors only in reviewer's temporary .mjs Node probes.
Reviewer has now archived .mjs/.ts as .txt (no blanket ignore); find under checks
showed no executable .mjs/.ts before final fresh run. It must pass rerun after all
agent writes end. Parent formatted all COMPLETED .json/.md evidence, excluding
currently active final-fresh-use files. Before formatting independent .json,
21 byte-identical *.json.raw.txt copies were retained, preserving hashes and
output-file refusal byte evidence; stdout/stderr/JSONL traces were never changed.
After final fresh finishes, do same raw preservation for its JSON then format
new docs/evidence and full pnpm lint. If probes are executable, archive their
own sources as .txt only after agent done (do not edit their logic/outputs).

Next concrete steps:
1. Wait final fresh completion notification, read full report and important raw
   commands/results. Triage every finding; parent rerun at least installed seed
   and exact replays/output refusal, verify final hashes match. Need ACCEPT in
   actual normal workspace or explicitly blocked; no helper/shim acceptance.
2. Finalize evidence/test-result and task ledgers; record promotion as opt-in,
   not CI/exhaustive proof/total engineering-cost saving. Run lint to passing.
3. Commit evidence/docs on feature (explicit staging; no temporary example tests).
4. Primary currently clean at298fb429, an unrelated session-rollover tool
   description change; preserve it. Re-read primary status/HEAD, merge feature
   --no-ff without switching primary branch or stashing others. Run own frozen
   install then appropriate primary command/static/type/lint/build smoke, retain
   results, append integration doc commit if needed. Preserve concurrent work.
5. Only then report verified criteria plus known four pre-existing integration
   failures and intermittent PTY observation. User authorized end-to-end commits
   and integration, no human deferral for confirmed scoped defects (all fixed).

Owned base reproduction worktree already removed. Feature worktree remains;
remove it only after no live writers, commits integrated, and evidence saved.
Raw evidence size ~2MB; no secrets observed. Primary no tracked changes at last
inspection. User task can be resumed entirely from this PLAN plus reports.

## Final independent acceptance and promotion (2026-10-24)

Final fresh normal-workspace-write workflow at product/checker commit
`29d154543c31e9682499de4ecfefaee2c1786ddd`: **ACCEPT**, report
`checks/final-fresh-use/REPORT.md`. The first invocation hit its parent 360-second
reporting deadline after all 24 commands completed. Report-only continuation
completed successfully without repeating commands or altering source. Both traces
are retained; this interruption is not recorded as a successful original run.
The report explicitly records the continuation's advertised broader permissions;
acceptance commands were completed in the original normal workspace-write run,
and the continuation only archived probes and wrote evidence. No failed checker
was bypassed. Independent checks: 9,222 passing sampled/replay cases, 24.792s
aggregate command wall time, 1.226s aggregate checker time; billing unknown.
Independent before/after public queue boundary probes prove foreground dispatch,
saved-record recovery, nonempty pause retention and cancellation ownership.

Parent independently reran installed seed424242, exact serial/restoration red
replays and new/existing output-file commands: expected exits0/2, preserved file
matches original stdout. All six source/checker/package/lockfile identity hashes
match the independently tested snapshot. See `checks/parent-final/`.
No final-review must-fix finding remains. All earlier confirmed candidates are
fixed; unsupported multi-call history assertions were rejected with scope noted.

**Promotion decision: retain as opt-in developer tooling.** It discovered a real
supported queue lifecycle defect and its persisted manifestation, shrinks to
replayable inputs, and sampled runtime is well below the frozen30s/target goal.
Do not enable automatic CI or claim exhaustive correctness or engineering-cost
savings. Full author effort/tokens remain unknown. Known setup, failed attempts,
review and rework are retained, not excluded from the evaluation.

Full-tier caveats remain: four exact integration failures reproduced on unchanged
base; default provider late PTY wait failed once, focused retry and complete CI=1
provider run passed. No proven cause claimed for that timeout. Final hygiene and
primary integration evidence follow below; historical checkpoint text above is
retained as chronology, not current live-job state. No verifier writer remains.

Final feature lint passed (0 errors,31 existing warnings; Prettier pass). A parent ledger append overlapped the previous lint and caused only a docs/test-results.json formatting failure; its log and resolving run are retained. No checker/source change.

## Primary integration outcome

Merged with --no-ff as `7561e1df77cdaa5fc81be9815c25104ee0bb17a7`, preserving
primary parent `298fb429` and its unrelated session-rollover description. Primary
own frozen install, installed seed424242 (3,000 cases), both exact historical red
replays, typecheck, static guards and build all pass. Six reviewed source/package/
lockfile hashes match final independent acceptance. See `checks/primary/`.

Unfiltered primary lint FAILS: 9,318 errors exclusively in untracked local
.cache/.coord/.term2/packages artifacts; zero tracked-file errors. No artifact
was deleted, moved, ignored or edited to hide it. Exact merged commit was then
fast-forwarded into the owned isolated feature worktree, where full unchanged
`pnpm lint` PASSed with0errors31warnings and Prettier pass. This is an explicit
artifact/environment distinction, not a claim that unfiltered primary lint passes.
Diagnostic counts and original failure log are retained. No implementation
changes followed independent acceptance. Broader feature-tier integration/base
failure and provider-timeout caveats above still apply; no new whole-tier run is
inferred from primary smoke checks. All owned background writers have ended.

Outcome: opt-in pilot accepted and integrated, including actual queue repair;
not an exhaustive proof, automatic CI promotion, or measured total-cost reduction.
