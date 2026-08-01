# Behavioral review packets

## Objective

Make the system reviewable without separating behavior from its contracts, tests, persistence rules, or safety mechanisms. Review packets follow behavioral seams—not folders, packages, or arbitrary line counts.

Do not reorganize code before the pilot. Refactor only when a review demonstrates a concrete ownership or coupling problem.

## Baseline prerequisite

Every packet must record a pinned base commit. Before review begins, confirm whether uncommitted changes are excluded or form part of the review snapshot. Do not review an ambiguous or moving baseline.

## Packet contract

Each packet contains:

- One architectural question or responsibility.
- The production files and behaviorally relevant callers needed to answer it.
- Applicable contracts and tests.
- Explicit exclusions and dependencies.
- Exact focused verification commands.
- A completion record containing:
  - the answer to the architectural question;
  - evidence-backed findings;
  - command results and test gaps;
  - unresolved risks and follow-up ownership.

A packet is independently testable when its named verification can support conclusions about the reviewed behavior at the pinned base.

The 3–10 production-file range is a sizing heuristic, not an acceptance criterion. Split a packet when it contains multiple independently actionable behavioral questions, requires unrelated verification paths, or cannot be reviewed coherently without unrelated production areas. Do not split behavior merely because it crosses directory boundaries.

## Mandatory coupling and verification

| Area | Keep in the same behavioral scope | Verification |
|---|---|---|
| Provider boundary, bridge, registry, run loop, or non-interactive path | Semantic wire fields, roles, ordering, IDs, reasoning/options, authoritative completion and error behavior | For read-only review, run focused checks needed to support conclusions. For resulting changes, run relevant provider unit tests, `pnpm typecheck`, `pnpm test:provider-black-box`, and `pnpm test:codex-network`; run full `pnpm test` before handoff. |
| Persistent events or schemas | Decoder, writer, replay, state projection, repair, and migration behavior | Focused persistence/replay tests and `pnpm typecheck`; full suite before integrating related changes. |
| Settings | Schema, storage, runtime behavior, `/settings` metadata, completion behavior, and UI tests | Focused settings and UI tests plus `pnpm typecheck`. |
| Prompt Markdown or tool descriptions | Agent construction and behavioral expectations | Relevant behavioral tests plus `pnpm typecheck`. |
| Ink interaction | Reducers, focus behavior, keyboard hooks, and visual component behavior | Focused Ink tests plus `pnpm typecheck`. |
| Continuation, tools, and approval | Continuation IDs, tool results, approvals, and terminal events | Focused lifecycle and approval tests plus `pnpm typecheck`. |

Record exact focused test targets in each instantiated packet. Run `pnpm test` before integrating each related group of review-driven changes, in addition to the provider-specific handoff requirements above.

## Pilot

Run these packets against one pinned commit before committing to the remaining backlog.

### P1. Core runtime contracts

**Question:** Are provider input, continuation, and conversation-event contracts minimal, coherent, and consistently consumed?

**Initial scope:**

- `source/contracts/`
- `source/services/conversation-agent-client.ts`
- `source/services/agent-stream.ts`
- Behaviorally relevant callers and focused tests

**Exclusions:** Provider wire transports and UI projection.

Split provider input, continuation, and conversation events only if they prove independently reviewable.

### P2. Session admission and attempts

**Question:** Are turn admission and attempt ownership explicit, and do lifecycle transitions preserve approvals, tool results, continuation identifiers, and terminal outcomes?

**Initial scope:** Relevant admission and attempt modules under `source/services/session/`, their contracts, direct behavioral callers, and focused tests.

**Exclusions:** Retry policy, durable replay, and UI projection except where needed to establish the lifecycle contract.

The packet owner must instantiate the exact file list and test commands before review begins.

### P3. Durable writer and schema

**Question:** Can durable conversation events be written and decoded without ambiguity while preserving compatibility with replay, state projection, repair, and migration behavior?

**Initial scope:** Persistence writer and schema modules under `source/services/conversation/` and `source/services/logging/`, plus the minimum replay/projection/repair context needed to verify compatibility.

**Exclusions:** UI-message projection and broad conversation orchestration.

The packet owner must instantiate the exact file list and test commands before review begins.

## Pilot decision

For each pilot, record:

- preparation effort;
- files required beyond the initial scope;
- missing or overly broad verification;
- whether one architectural question was answered;
- concrete ownership or coupling problems discovered.

After all three pilots:

- Continue with backlog packets that serve an identified review goal.
- Split only where the packet criteria demonstrate multiple seams.
- Refactor only demonstrated ownership or coupling problems.
- Revise the packet contract if context expansion or preparation cost is consistently excessive.
- Stop rather than scheduling the entire backlog when further review has no defined outcome or realistic risk to address.

## Review backlog

This is a coverage inventory, not a mandatory serial sequence. Instantiate a backlog item only when it has a current architectural question, exact scope, and required verification. Order items only where the stated dependency requires it.

| Area | Initial scope and question | Dependencies and exclusions |
|---|---|---|
| Settings and configuration | Review a setting vertically across schema, storage, runtime, commands/completion, metadata, and UI. | Use the settings coupling gate above. |
| Provider catalog and selection | `source/providers/registry.ts`, `source/providers/provider-service.ts`, and provider/model-selection hooks. Does selection construct the correct runtime behavior? | Exclude wire transports. Coordinate the registry-to-run-loop boundary with the runtime packet. |
| Provider transports | Registry-reachable provider families and shared fetch, SSE, WebSocket, retry, request-capture, and watchdog middleware, with `scripts/provider-black-box/`. Do transports preserve semantic provider behavior and fail incomplete streams safely? | Exclude catalog/selection ownership. Derive subpackets from the registry and provider capability matrix rather than a fixed family list. Apply the full provider verification gate. |
| Model run loop and client bridge | `source/services/agent-runtime/application-run-loop.ts`, `source/lib/tool-invoke.ts`, and the relevant client/orchestration modules under `source/lib/`. Does the model/tool loop preserve lifecycle and client contracts? | Separate runner selection only when it forms an independent question. Apply the provider gate when the provider boundary changes. |
| Approval and command safety | `source/services/approval/`, `source/utils/shell/`, and shell-tool approval behavior. Are ownership, approval, and sandbox policy enforced at the correct boundary? | Generic approval and shell sandbox policy may be separate packets when independently verifiable. |
| Session retry and continuation | Retry, continuation, and terminal-state modules under `source/services/session/`. Are retries and continuations safe and unambiguous? | Depends on the relevant runtime contracts and admission/attempt conclusions. Keep IDs, approvals, tool results, and terminal events together. |
| Turn workflow and session composition | `source/services/session/turn-workflow.ts`, then `source/services/session/session-composition.ts`, with necessary collaborators. Are orchestration and composition responsibilities coherent? | Standalone treatment is conditional on each forming one answerable behavioral seam. |
| Conversation replay and repair | `source/services/conversation/conversation-replay.ts` and its durable-state collaborators. Can stored events be replayed, projected into provider history, and repaired correctly? | Depends on writer/schema behavior. “Projection” here means durable-state reconstruction, not UI messages. |
| Conversation admission and facade | Queue controller, adapter, runtime factory, and `source/services/conversation/conversation-service.ts`. Does the public facade preserve queue and admission behavior? | Review queue/admission behavior before conclusions about the facade. |
| Conversation-to-UI projection | `source/services/conversation/conversation-orchestrator.ts`, result builder, UI-message projection, and UI reducer. Are conversation outcomes projected consistently for the UI? | Exclude durable-state/provider-history projection. Keep `app.tsx` and visual components out unless needed to establish behavior. |
| Subagent lifecycle | `source/services/subagents/`, `source/lib/subagent-bridge.ts`, and agent tools. Are execution, asynchronous lifecycle, and security policy coherent? | Split execution, async lifecycle, and `tool-policy.ts` only when each has an independent question and verification path. |
| Tools and agent behavior | Tool families under `source/tools/`, `source/agent.ts`, and `source/prompts/`. Do tool behavior and agent assembly match their behavioral contracts? | Review file, shell, web, memory, and agent tools separately when warranted; assemble the agent last. Preserve prompt/tool-description coupling. |
| Ink UI | `source/components/`, hooks, context, and reducers. Are rendering, input, menu, focus, and application state behavior correct? | Split by behavior rather than component folders. Apply the Ink coupling gate. |
| Entrypoints and integration | `source/cli.tsx`, `source/non-interactive.ts`, `source/app.tsx`, and build scripts. Do entrypoints compose the reviewed behavior consistently? | Review one entrypoint at a time when useful. Perform a final integration audit only after enough related packets have been completed to justify it. |

## Pilot completion record

**Pinned review base:** `8a95be5a0e27dbb1bd7a10a6061eb34e6e02d808`

The three pilots completed successfully. Their scopes expanded where concrete cross-boundary failures required it, but no preliminary architectural reorganization was needed.

### P1 outcome — runtime contracts

The review found that terminal stream state was not consumed consistently:

- opaque continuation state hid authoritative usage from one consumer;
- competing `newItems`, `output`, and `history` snapshots had inconsistent precedence;
- the application run loop did not preserve cumulative multi-completion usage.

The fixes introduced an explicit run-usage boundary, cumulative usage accounting, and consistent `newItems` → `output` → `history` precedence while retaining legacy fallbacks. Provider-boundary verification passed.

### P2 outcome — admission and attempts

The review found that phase state did not identify which admitted turn owned completion, allowing aborted work to interfere with a newer turn. It also found that terminal-less iteration was synthesized as success.

The fixes added turn ownership leases, suppressed late events, revalidated delayed approval decisions, rejected incomplete outcomes, and classified only application-owned cancellation as cancellation.

### P3 outcome — durable writer and schema

The review found malformed known events could poison replay, durability failures could be hidden, reopened journals reused sequence numbers, and forked conversations could retain their source identity.

The fixes added replay-significant structural validation with forward-compatible unknown events, latched durability failures, bounded sequence recovery with JSONL boundary repair, and durable fork identity/provenance.

### Pilot decision

The packet method produced actionable findings with manageable context. Keep the remaining areas as a backlog and instantiate them only for a current architectural question or realistic risk; do not schedule a repository-wide serial review merely to exhaust the list. No ownership problem found by the pilots requires packages, directory moves, service boundaries, or new dependency-injection architecture.

Final integration verification:

- `pnpm typecheck`
- `pnpm test` — 5,008 passed, 1 skipped
- `pnpm test:provider-black-box` — 150 passed
- `pnpm test:codex-network` — 11 passed

## Deferred work

Do not introduce new packages, service boundaries, directory moves, dependency-injection abstractions, or persistent formats solely for reviewability. Preserve paths for future change, but build those changes only when review evidence establishes a present need.
