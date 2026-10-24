# Remaining high-value generated verification rollout

## Contract and authority

User authorized all four remaining candidates after the ledger slice. Exact
shortlist recovered from session63a75839, recommendation message112:
compaction-cut planning; continuity debt plus chained-input filtering;
journal-to-ledger reconstruction and event identities; provider-opaque lane
isolation. Existing five properties stay. Opt-in, LLM-free checker execution,
supported inputs, no permanent example-based unit tests. Worktree isolation and
--no-ff integration preserve others' work.

## Acceptance

- Compaction: generated settled and unpaid rounds, genuine/synthetic users,
  payload sizes and unsafe pair shapes. Planned cuts preserve genuine users
  verbatim/in order, partition projected history at settled boundaries, retain
  ordered pairs, and do not mutate inputs. Unsafe duplicate/orphan shapes refuse.
  Assert structural postconditions, not the heuristic's selected cut.
- Continuity: authoritative segments and reset/chaining-break boundaries feed
  real continuity debt into chained filtering. Selected outputs are an exact
  order-preserving selection; known-call orphans and empty required output fail;
  retired response anchors/debt cannot revive through stale lineage updates.
  No complete copy of the continuity state machine.
- Reconstruction: supported multi-turn journal histories with per-turn sequence
  identity, calls/results/reasoning and terminal statuses reconstruct exact
  per-(turn,call) entries and payloads, with no cross-turn reasoning leakage.
  Sequential journal order and deterministic reconstruction/nonmutation hold. No claim of crash,
  filesystem durability or executing/retrying actual effects.
- Opaque: real public adapter wire conversion with unique sentinels must never
  leak a foreign lane or explicitly foreign backend. Own compatible payloads
  survive verbatim where supported; ordinary content survives. Exclude disputed
  legacy openai-compatible -> Grok acceptance pending owner policy decision;
  do not bless or change that behavior. Cover unambiguous lane pairs now.
- Existing runner metadata, bounded 1,000-case default and <=30 generated entries,
  deterministic seed/shrink/replay, and output-preservation safety stay intact.
  Several fixed seeds plus targeted red/shrink/replay/restored-green fault
  challenges per new area; all existing properties remain green.
- Fresh independent code and installed-use review accepts final artifact.
  Syntax/static/type/build/full isolated lint and primary installed smoke/replays;
  appropriate broader tiers if production/package/dependency changes arise.
  Record exact snapshots, costs/unknowns and task/test ledgers; integrate/cleanup.

## Current state

Base89141139; own frozen install passed. Implementation65de0f5d. Production
and dependencies remain unchanged. Source confirms the legacy Grok policy issue
still exists; its resolution is not implied by permission to add generated
checks. All other supported lane behavior can be checked without deciding it.

## Initial implementation observations

All four areas implemented as five new properties (compaction has a separate
unsafe-pair property), ten properties total. Real adapters use captured SDK
clients, no transport/network. Backend-origin pins are exercised on Responses
and Codex, while Chat tests configured lane identity only. Grok legacy shared-tag
policy explicitly excluded pending the focused human question; no production
policy changed. Planner generator uses canonical function_call_result records.

Initial reds were author fixture/API mistakes, not demonstrated product bugs:
Responses function_call_output is not the canonical planner result spelling;
synthetic user detection uses recognized content markers, not an isSynthetic
field; continuity APIs are clear/breakChaining/observeCandidate, not guessed
reset/applyRunState names; adapter requests require tools:[]. Retained initial
reports are diagnostic only, not claimed final-version replays. Prevention is
explicit canonical construction and real public request envelopes in generators;
sibling construction sites checked. All ten properties passed seed424242 at
1,000 cases/property before adding Grok (then focused Grok target also passed).

## Parent verification at65de0f5d

Four seeds x10,000 x10properties pass400,000 cases (200,000 new). Checker totals
28.7–40.1s per seed on the concurrently loaded host, not author effort. Source
identity retained in checks/hotspots/identity.json. Four isolated source faults
(users lost at compaction, unpaid debt retained, journal turn identities merged,
foreign opaque lanes accepted) all fail/shrink/replay red; same paths pass after
byte-exact restoration. Mutation checkout never changed reviewer source.

Installed help/four targets/invalid-target/property/output-nonoverwrite checks
have expected outcomes. Blanket network denial initially misclassified two tsx
loader local Unix socket attempts as external network. Direct diagnostic stacks
identify both tsx IPC paths. Refined probe still denies ALL socket connections,
counts IPC separately and passes all10,000 cases with zero external attempts.
No network exemption or production change was made; both failed probes retained.

Independent fresh Opus5.5 review and full clean isolated lint still pending.
No production/package/dependency diff. No new whole integration/e2e/provider-tier
claim: checker/docs-only rollout. Actual supported production defect not found.

## Independent round1 triage

Fresh Opus5.5 REJECT65de0f5d, accepts compaction/continuity/opaque and runner.
F1 ACCEPT (must fix, small generator change): reasoning was always consumed
before a different-turn event; global pending-reasoning mutant survived. Add
reasoning-only aborted turns followed by another turn's call. Use sequential
turn numbers rather than arbitrary turn interleaving, avoiding an unnecessary
oracle commitment about interleaved journal ordering. Call IDs still reused
across turns.
F2 NARROW (false checker claim, no product repair): only top-level history
records are fresh; nested arguments/output alias journal payloads. No production
contract promises deep snapshots. README/comment now explicitly state nested
values may alias. Nonmutation during reconstruction remains checked.
Independent nested-alias probe is diagnosis, not an authorized new production
requirement. No source change warranted. Fresh amended review required.
Before-acceptance checker gap is preventable: immediate reasoning+call adjacency
hid retained per-turn state. Durable category improvement is generated stranded
reasoning turns plus sensitivity to the independent global-buffer mutant.
Review cost USD1.7723466 is session-reported list price, not actual invoice;
author active time/tokens unknown. No permission denials.

## Final amended verification

Opus5.5 ACCEPT8d789a2c; the formerly surviving reasoning-scope mutant now
fails, as do identity/payload/own-reasoning faults; valid deep-clone and retired
other-turn-buffer alternatives pass. Raw reports, captured outputs and tool-use
trace retained. Reviewer-only probe modules archived as .mjs.txt evidence, not
installed suite modules. Final cumulative list-price session estimate USD2.110373
is not added to the earlier USD1.7723466. Actual billing/author effort unknown.

Parent final amended seed passes100,000 cases; earlier400,000 at65de0f5d is
separate evidence, not relabeled. Final syntax/types/28static/build/clean isolated
lint all pass. Two final journal faults fail/shrink/replay and restore green;
three unchanged-area final replays pass. Final10,000case network-denied run
passes with zero external attempts (all sockets still denied). Initial in-memory
hook failed to apply an uncompiled text edit; retained as infrastructure failure,
then corrected to the verifier's compiled-module edits. No production change.

Integration and task acceptance records follow after primary checks. Policy
question about legacy Grok compatibility remains excluded/unchanged; no settings,
approval or broad filesystem/crash coverage has been added by implication.
