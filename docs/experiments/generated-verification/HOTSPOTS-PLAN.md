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
  Input order and idempotent reconstruction/nonmutation hold. No claim of crash,
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

Base89141139; own frozen install passed. No implementation edits yet. Production
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
