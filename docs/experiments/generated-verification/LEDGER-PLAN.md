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
