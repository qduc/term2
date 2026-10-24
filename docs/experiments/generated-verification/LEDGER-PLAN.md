# Generated ledger verification slice

## Goal and authority

User approved the first bounded rollout slice after three independent model
consultations: two ledger properties, not five new targets. Extend the installed
history target without changing runtime production behavior or dependencies.
Base: 6a25ecc7. Worktree: .worktrees/generated-ledger, feat/generated-ledger.

## Frozen acceptance and checks

1. `history.ledger-settlement` drives public ToolExecutionLedger operations with
   unique supported call identities, observed results, dispatch evidence, scoped
   interruption/rejection, turn changes and export/import. An independent per-ID
   state model checks C2.5 aborted vs unknown, preservation of completed outcomes,
   scope isolation and imported next-turn identity. No actual effect executes;
   do not claim this proves executor retry behavior.
2. `history.ledger-reconciliation` drives real ledger construction, generated
   partial transcripts, user anchors and retry-attempt drift. Check C2.1/C2.2
   exact pair membership, payload/order, no orphans, idempotence and nonmutation.
   Replacement boundaries prevent old ledger injection; model-request projection
   starts at the last replacement boundary. Use supported canonical/Responses
   shapes only; no raw multi-call-envelope assertion.
3. Both use existing 1,000 cases/property default and at most30 generated actions
   or entries/case, retain shrink/replay/identity metadata, require no AI/network.
   Run multiple fixed seeds and targeted mutation checks that must fail. Retain
   exact source diffs/hashes for dirty runs; restore injected faults immediately.
4. Existing properties stay green. Run syntax, typecheck, static guards, full
   isolated lint/build plus installed CLI/replay/output safety. No package,
   production or provider changes intended, so no unrelated whole-tier reruns.
   If a real supported defect appears, preserve red/replay and adapt verification.
5. Independent fresh-agent code/use review must accept the final artifact with
   retained commands and concrete property challenges. This is tooling-only, not
   an orchestrator/skill change, but fresh installed-command use is required here.
6. Record costs/unknowns and append test/task ledgers, commit and --no-ff integrate
   while preserving others; primary smoke plus exact merged-artifact lint. Known
   primary untracked artifact lint caveat must not be silently bypassed.

## Scope exclusions and risks

No arbitrary malformed saved entries, reused call IDs/reopen policy, real effects,
filesystem crash behavior, full replay, approval orchestration, or full-history
semantics for unsupported raw chat envelopes. Avoid asserting globally unique
IDs on arbitrary corrupt histories or a heuristic's exact insertion index.
User anchoring is checked only for generated valid histories with explicit
userTurnCount. Setup/maintenance cost claims remain estimates until measured.

## Implementation observations

Added `ledger.mjs` with two properties, reusing the history target and unchanged
runner. Production source, packages and dependencies remain unchanged.
Four seeds ×10,000 cases ×five properties =200,000 passing cases (80,000 new
ledger cases). Checker totals were6.98–7.31s per seed; wall totals8.01–8.37s.

Initial one-call red was an oracle mistake, not a product defect: raw Responses
`arguments` is already JSON text, preserved by normalizeRunItem. Expected native
JSON was wrong. Fixed expected wire encoding; checked both call construction
sites and reconciliation payload assertion. This before-acceptance fixture error
was caught immediately by generated scalar0; the property now checks arbitrary
JSON wire preservation. No runtime repair or broader mechanism was justified.
Approval rejection generation was narrowed to never-dispatched open calls;
rejection is not an API for cancelling already-executing effects.

Two deliberate mutation challenges (not discovered bugs) both failed, shrank,
replayed red, and passed the same shrunk paths after byte-exact restoration:
misclassifying dispatched interruption as aborted, and bypassing the replacement
boundary. Mutation hashes/replays are in checks/ledger/mutation-checks.json.
The first parent evidence parser incorrectly assumed pnpm's nonzero stdout was
JSON only; it contained trailing lifecycle diagnostics. Source was restored by
finally. Parsed the retained JSON value with raw_decode, did not repeat that
completed red run, then finished both challenges. No checker-output change was
needed; README already allows package-manager diagnostics. Initial red oracle
snapshot was dirty and not committed: retained as diagnosis, not advertised as
an exact replay of the final property version.


## Independent review triage

Fresh Opus5.5 accepted28a20727 after installed history/all-target seeds and exact
replays; all11 independent in-memory mutants went red. No permission denials.
Report is retained in checks/ledger/independent-opus.md and raw JSON.
One narrowing accepted: turn identity requires greater than the imported maximum,
not exactlymax+1. The new nextTurn assertion preserves collision detection while
allowing valid gaps. README now explicitly distinguishes30 generated entries
from their multiple API calls. Final amended-artifact review/rerun required.
Other nits are coverage limits, not confirmed defects: unknown settlement is
sparsely sampled;75% of reconciliation cases exercise replacement checkpoints;
post-boundary ledger entries, newer user messages after the latest entry and
reused-call policy are not covered. No coverage/production claim is expanded.


## Final amended independent acceptance

Opus ACCEPTS `d5e6fb0aaaa1ebeb1b5a78eaf4701716b30fa645`. Its fresh installed
commands pass; in-memory import collision/stalled counter/wrong format fail,
while valid skipped turn numbers pass. No source changes or permission denials.
Raw report/trace and final code hashes retained. The parent final seed ran50,000
cases (20,000 new ledger cases); earlier four-seed evidence was200,000 cases at
28a20727-identical checker bytes, not falsely relabeled final-commit evidence.
Final session-reported list-price cost$1.1182692 is cumulative, not added to the
earlier$0.8813244. Author active time/tokens/billing remain unknown. Full tiers
are not rerun: this slice changes checker/docs only, not product/package/deps.
The previous pilot's integration/provider observations remain historical; no new
whole-tier green claim is made. Syntax, types, static guards, build and isolated
lint are appropriate checks here. Final hygiene and integration records follow.

## Successor checkpoint (2026-10-24)

Canonical task state is this file. Active task: user said go after recommending
first two ledger properties; deliver this slice end-to-end, NOT all five hotspots.
Current feature `feat/generated-ledger` in `.worktrees/generated-ledger` at
`d5e6fb0aaaa1ebeb1b5a78eaf4701716b30fa645`. Initial implementation28a20727.
No production/package/dependency changes; only newledger.mjs,2-line history import,
README and this plan committed. All evidence+docs/test-results.json uncommitted.

Final independent Opus5.5 ACCEPT and amended recheck COMPLETE, no live reviewer.
Session8d752a0d-fa66-47e8-9a7d-faa35d2a3de1; raw reports, md and full trace in
checks/ledger/. Source hashes final-identity.json. First11mutants detected; final
collision-isolation/wrongformat/stalledcounter red and validgaps green. Reviewer
read-only under explicit allowed tools, no permission denials. Parent owns checks.

LIVE ONLY shell3a29e717-cf63-42ea-a709-4821227dc665 (unlimited monitor) final
syntax/types/static/build/fullisolatedlint at finalchecker with evidencechanges.
Wait completion notification, inspect final-tiers.json and final-lint.log. All
previous background jobs finished. Earlier28a types/static/build/lint PASS.
Four seeds10k x5properties=200kcases before narrow assertion; finald5 seed10k
x5=50k PASS. Parent final exact mutation replays PASS. Scope is bookkeeping, not
proof of executor retry behavior. No real supported production defect discovered;
only initial oracle JSON-wire mismatch and assertion narrowing fixed preacceptance.
Mutation challenges intentionally planted faults, NOT product bug discoveries.

Run ledger rows already appended for initialoraclered, fourseeds, initialtiers,
mutants, finalseed, finalreview and committedCLI. Append finaltiers and primary
results after observing. Check recorded command text: two manually assembled rows
have missing spaces (`--seed424242`, `--runs10000`) despite evidence commands being
correct; fix these NEW uncommitted rows before commit, don't alter historical runs.
Need final task tasks.jsonl row (NOT WRITTEN): id2026-10-24-generated-ledger,
unknown author time/tokens null; final session cost$1.1182692 cumulative list-price
estimate, don't sum initial$0.8813244. Known command timings in JSON evidence.

Next concrete steps:
1. Finish finaltier check; fix any genuine hygiene failure. No writer remains
   after shell done. Preserve final JSON raw reports(.raw.txt already done) before
   formatting. final-tiers JSON newly written may need prettier. Explicitly stage
   evidence/docs and commit; do not add example unit tests or broaden lint ignores.
2. Reread primary status/HEAD/AGENTS before --no-ff integration. Last primary clean
   at6a25ecc7; preserve concurrent work and branch. User authorized commits/integration.
3. Primary installed command smoke+exact replays and relevant static/build/types;
   primary own frozen install. Full primary lint known scans untracked .cache/.coord/
   .term2/packages yielding9318errors0tracked errors (prior pilot diagnostic retained
   in checks/primary/). Do not remove others' files or add excludes. Exact merged
   artifact full lint in ownedisolated worktree previously successful strategy;
   retain any new primary failure honestly, not report unfilteredprimarylintgreen.
4. Append task/test ledgers+integration disposition inclmergeSHA in laterdocscommit.
   Plans status header is mergeSHA only. Validate JSON/JSONL, source/depsunchanged,
   dirtydiffcheck, preserve otherwork; cleanup only owned clean integrated worktree
   and branch afterwritersend. Final concise report new2props, final50kpassing,
   prior200k separately, independentfaultchallenge, no newproductbug, nextcompaction.

Reload applicable skills/instructions as needed; rootAGENTS only scoped. Loaded
agentic-loop,implementation,testing,verification,writing-docs,debugging,finding-triage,
bug-retro,code-review,real-useguide. No guards changed; budgets test-only. No full
integration/e2e/provider reruns warranted for checker-only unchangeddependencies;
prior pilot caveats are historical, not asserted passing newruns.
