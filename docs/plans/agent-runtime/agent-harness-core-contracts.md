# Agent harness core contracts

Status: **plan.** Design only. Phase 1 is tracked in [#224](https://github.com/qduc/term2/issues/224); the
open questions below are waiting on a decision before their parts are implemented.

Implementation location update: the portable driver and contracts now live in
`packages/agent-harness-core/src/`. Term2-specific agent resolution, scopes,
completion verification, billing composition and notices live in `src/session/`.
`src/engine` retains only contract and continuity/history compatibility surfaces;
its import-exception baseline is empty. The “today” source paths below describe
the pre-extraction design snapshot.

Drafted 2026-11-08 against Term2 `ec59cf0` and ChatForge (`qduc/chat`) at the same date. Verify every
claim about current code against the source before acting on it.

Related, earlier design: [Runtime capability seams](runtime-capability-seams.md) analyses the pre-`src/engine`
run loop (`ApplicationRunLoop`). This plan starts from the engine that replaced it.

## Purpose and principles

The harness, not the model, is the reusable part: chat, coding agents and future use cases share one engine
and differ only in tools, prompts and UI. This doc defines that engine's contracts on paper and checks them
against Term2 and ChatForge before any code moves.

**The rule.** If not every use case needs it, it is not core. Anything we can't decide on is, by that fact,
not core.

**Three rings.**

1. **Core harness.** Small and stateless per turn. The app hands it history, tools and a model; it runs the
   loop and streams events back. The app owns the history.
2. **Optional modules.** Sessions and storage, compaction, subagents, memory. Opt-in, and built only on the
   core's public API.
3. **Use cases.** Term2, ChatForge, third-party apps. Tools, prompts, UI, auth.

**Seams, not internals.** The core exposes a few named extension points. Each seam states four things: when
it fires, what it receives, what it may change, and what happens if it fails or is slow. Every seam is public
API forever, so each one must be earned.

**How seams are earned.** Optional modules are designed outside the core on purpose. If a module can't be
expressed through the seams, a seam is missing, and we add it deliberately.

**Ground truth.** Term2's `src/engine` already runs real workloads. These contracts describe and clean up what
it does today rather than invent a new design.

**Home.** Packages incubate in Term2's workspace and graduate to
[`qduc/agent-runtime`](https://github.com/qduc/agent-runtime) once their API is stable, as `@qduc/agent-wire`
did.

## Core types

Term2's engine already has the right core shape: one call, `startTurn(spec, deps)`, takes history in and hands
back a stream of events plus a handle to answer, steer and cancel. The work is trimming Term2-specific fields
out of these types, not redesigning them.

| Type | Role | Today in Term2 | Verdict |
| --- | --- | --- | --- |
| `Item` | Provider-neutral history entry: user, assistant, reasoning, tool call, tool result, summary, provider-opaque | `src/model/index.ts` | Keep |
| `Model` | `stream(request, signal, onDispatched)` yields `ModelEvent`s; optional native `compact` | `src/model/index.ts` | Keep, trim request fields |
| `ModelRegistry` | `resolve(ref)` and `list()` | `src/model/index.ts` | Keep |
| `Tool` | `spec` (JSON Schema input), `parse`, `approval`, `execute`, `parallelSafe` | `src/tools/index.ts` | Keep |
| `ToolRegistry` | `get(name)`, `available(ctx)` | `src/tools/index.ts` | Keep, generic context |
| `ToolContext` | What a running tool may use: signal, progress, interact, nested run | `src/tools/index.ts` | Trim hard |
| `InteractionRequest` / `InteractionDecision` | Approval or question out; allow, deny or answer back, with scoped grants | `src/tools/index.ts`, `src/engine/types.ts` | Keep |
| `TurnSpec` | One turn's input: history, new items, instructions, model, tools, settings | `src/engine/types.ts` | Keep |
| `TurnHandle` | `events`, `accept(token)`, `answer`, `steer`, `cancel` | `src/engine/types.ts` | Keep |
| `TurnEvent` | Text and reasoning deltas, items, tool lifecycle, interactions, usage, `turn_ended` | `src/engine/types.ts` | Keep, map onto wire, trim |
| `TurnResult` | `completed`, `cancelled`, `interrupted`, `failed` | `src/engine/types.ts` | Keep, trim causes |

Two properties are worth protecting:

- **The engine never writes history.** Every event carries an acceptance token, and the turn only advances
  after the host calls `accept`. The app owns storage, and a crash loses at most the unaccepted tail.
- **Tool input is JSON Schema plus a `parse` function.** No zod object crosses the boundary, so ChatForge's
  zod 3 stops being a blocker.

### Term2 leaks to remove from core

- `ModelEvent` and `TurnEvent` carry `codex_quota`, a single provider's concern. It should travel as provider
  metadata.
- `ModelRequest` has OpenAI-only flags (`useStandardServiceTier`, `downgradeTransport`). They belong in
  `providerOptions`.
- `ToolContext` requires `workspace` and `settings`, and offers `shellTasks`, `subagents`, `askOrchestrator`,
  `executeChild`. Core keeps signal, progress, interact and nested runs; the rest becomes app-supplied context.
- `TurnResult` and `NormalStopDecision` name `goal_check_unresolved` and `completion_verification_blocked`. Core
  needs a generic app-defined stop cause.
- `TurnDeps` mixes seams with Term2 features (`contextMilestones`, `compactionHold`, `shellTasks`). The next
  section sorts them.
- `createProviderRegistry` keeps process-wide compaction state and reads the prompt cache key from ambient
  session context. Both break with many concurrent users in one process.

## Seams

The core needs seven seams, and six already exist in Term2's `TurnDeps` and `TurnHandle`. The missing one is a
way for a module to replace history mid-turn, which compaction needs before it can leave the core.

Failure behavior marked *today* is what the engine does now (hook exceptions are not caught at the call site,
so they end the turn). Marked *proposed* is a contract choice still to confirm.

| Seam | When it fires | Gets | May change | On failure or delay | Used by |
| --- | --- | --- | --- | --- | --- |
| **S1 Prepare request** (`prepareRequest`) | Before every model request, including mid-turn tool loops | The request, turn id, model step, signal | The request sent (input, instructions, tools) and the tools offered. Live only: stored history stays raw | Throw ends the turn (*today*). Slow delays dispatch; cancel aborts | Prompt caching, notices, reminders |
| **S2 Replace history** (new) | From S1, when a module decides history must shrink | Same as S1, plus a context estimate | Replace history with summary items. Emitted as `history_replaced`; takes effect only after acceptance | Throw ends the turn (*proposed*). Module may skip instead | Compaction |
| **S3 Steering** (`takeSteering` + `handle.steer()`) | At the next request boundary after the host admits new input | Turn id | Adds user items before the next request. Never interrupts a response in flight | Throw ends the turn (*today*) | Term2 queued input; chat follow-ups while a tool runs |
| **S4 Interactions** (`interaction_required` + `handle.answer`) | When a tool's `approval` asks, or a tool calls `ctx.interact` | Approval or question, summary, risk, grants | Allow (with one grant), deny, or answer; optionally stop after it settles | Unanswered waits until cancel (*today*). Timeout is app policy (*proposed*) | Approvals, `ask_user` |
| **S5 Event acceptance** (`events` + `accept(token)`) | Every event | The event and its token | Nothing; the host persists, then accepts | Never accepted means the turn waits; that is the durability guarantee | Sessions, persistence, streaming to clients |
| **S6 Normal stop** (`normalStop`) | When the model finishes without calling tools | Turn id, signal | Stop, or continue with a reminder; app-defined stop cause | Throw ends the turn (*today*) | Term2 goal checks, completion verification |
| **S7 Nested run** (`runNested`, exposed as `ctx.runNested`) | When a tool starts a child run | Instructions, items, tool names, model, budget, foreground or background | Host assigns identity, runs the child through the same loop, returns items and outcome | Child failure is a result, not a parent failure (*today*) | Subagents |

Two hooks stay but are not seams: `onTurnBoundary` is observe-only lifecycle (dispatched, parked, ended,
cancelled), and `Model` and `Tool` implementations are supplied inputs rather than extension points.

### Where today's `TurnDeps` fields go

| Field | Goes to |
| --- | --- |
| `models`, `tools`, `maxParallelToolCalls`, `recovery`, `continuity` | Core inputs and config |
| `prepareRequest`, `takeSteering`, `normalStop`, `runNested`, `onTurnBoundary` | Core seams S1, S3, S6, S7 |
| `compaction`, `compactionHold`, `contextMilestones`, `warn` | Compaction module, through S1 and S2 |
| `budget` | Open: a budget module needs to stop a turn and ask the user, so it may need S1 plus S4 |
| `subagents`, `shellTasks`, `askOrchestrator`, `toolContext` | Term2 app context, passed to its own tools |

## Walkthrough: Term2

Five of six Term2 features fit the seams as written. Mid-turn compaction is the one that doesn't: a compaction
module outside core can't make its summary request through the engine's retry and budget path, and can't see
how full the context is.

| Feature | Path through the contracts | Fits? | Gap |
| --- | --- | --- | --- |
| Compaction during a long tool loop | S1 fires before the next request → module sees context is too full → S2 replaces history with a summary → `history_replaced` is accepted (S5) → next request uses the shorter history | Partly | S1 doesn't receive a context estimate or last usage. A module calling `Model` directly skips the engine's retry, budget and dispatch accounting. Native compaction (`Model.compact`) has the same problem |
| Subagent asks for approval | Parent tool calls `ctx.runNested` (S7) → child turn runs → child tool needs approval → `interaction_required` carries `executionId` and `parentExecutionId` → host shows it, answers the child's handle (S4) | Yes | Host must route answers to the child's handle; worth a sentence in the S7 contract |
| Background subagent | S7 with `mode: background` returns a run id at once → child keeps running under the host → its completion arrives later as steering (S3) or the next turn's input | Yes | None; task registry stays in the host |
| Steering while a tool runs | Host admits new input, calls `handle.steer()` → S3 adds it before the next request; a response in flight finishes first | Yes | None |
| Resume after a crash | Only accepted events were persisted (S5) → host rebuilds history from accepted items → starts a new turn | Yes, with a rule | A tool call with no result (tool debt) must be repaired before the next turn. Today Term2's session does it; core should state the rule and offer the repair as a helper |
| Coding tools that need a workspace | Term2 tools read workspace, settings and shell tasks from app context | Needs change | `ToolContext` should take an app-defined context type (for example `ToolContext<AppCtx>`) instead of fixed `workspace` and `settings` fields |

## Walkthrough: ChatForge

ChatForge fits better than expected because the core is stateless: forking, comparison and the
OpenAI-compatible proxy all fall out of "the app owns history." The real gaps are multi-user safety, per-user
tool context, and a loop cap on the root turn.

| Feature | Path through the contracts | Fits? | Gap |
| --- | --- | --- | --- |
| Fork at any message | App loads the branch's messages up to the fork point and passes them as `TurnSpec.history`; core never knows branches exist | Yes | None. `Item.id` gives stable fork points |
| Comparison mode (N models side by side) | N `startTurn` calls in parallel, each with its own history and `ModelRef` | Only if instance-local | Process-wide state breaks it: `createProviderRegistry` shares compaction state, reads the cache key from ambient context, and `src/engine/agent-runtime/scope-resolver.ts` keeps a module-level workspace root |
| Abort and keep partial text | Host collects `text_delta` events (S5) and checkpoints them as it does today; `handle.cancel()` ends the turn | Yes, host-side | Contract must state that accepted history holds no partial assistant message, and that a delta marked `withdrawn` (retry) must be removed from checkpoints |
| User-configurable tool iteration limit (1–50) | Should be a turn setting | No | `TurnSpec.limits` applies only to nested branches today. Every use case needs a loop cap, so the root turn needs one in core |
| Journal tool scoped to the user | Tool reads the user id from app context | Needs change | Same as Term2's workspace: `ToolContext<AppCtx>` |
| Prompt caching breakpoints | Inside chat's Anthropic `Model` implementation, as Term2's Anthropic provider does | Yes | `Item` has no portable cache hint; providers decide placement. Fine unless apps need to choose |
| Existing providers (OpenAI, Anthropic, Gemini, llama.cpp) | Each adapter wrapped as a `Model`, converting `Item` to and from its wire format | Yes | Real work, but no contract change. Alternatively adopt Term2's providers later |
| Judge and evaluation | A plain `Model.stream` call after the comparison, outside any turn | Yes | None. `Model` is usable without the engine |
| Non-streaming JSON and OpenAI-compatible API | Host consumes all events and builds one response | Yes | None |

## Gaps and open questions

The walkthroughs found seven contract changes; none requires redesigning the turn loop. The biggest is making
the core fully instance-local, because every multi-user or side-by-side use breaks without it.

### Contract changes

1. **Everything instance-local.** No module-level or process-wide state anywhere in core or `Model`
   implementations. Checked by running two turns concurrently with different settings in one process.
2. **Add S2, replace history.** Plus three things a compaction module needs from S1: a context estimate, the
   last usage, and a way to make auxiliary model requests through the engine's retry, budget and dispatch path.
3. **Generic tool context.** `ToolContext<AppCtx>`: core keeps signal, progress, interact and nested runs;
   workspace, settings, user id and shell tasks become the app's context.
4. **Loop cap on the root turn.** Max model calls and tool calls per turn, in `TurnSpec`, for every turn.
5. **Tool-debt rule and helper.** A new turn never starts with a tool call that has no result. Core states the
   rule and ships the repair.
6. **Partial output on cancel.** State that accepted history holds no partial assistant text, and how
   `withdrawn` deltas behave.
7. **Remove Term2 names.** `codex_quota` moves to provider metadata, OpenAI-only flags move to
   `providerOptions`, stop causes become app-defined.

### Open questions

- [ ] **Core events vs wire.** Is wire v2 the core's public event type, or does core keep `TurnEvent` and each
  host maps it? One contract is simpler; two lets wire stay transport-focused.
- [ ] **Budget.** Core, or a module over S1 and S4? A loop cap is core; cost budgets with "ask the user to
  extend" may not be.
- [ ] **Unanswered interactions.** Should core offer a timeout, or leave it to app policy?
- [ ] **A third use case.** Both walkthroughs have a human present. A batch job with no UI (no one to answer
  approvals) would test whether S4 works with a policy that answers automatically.
- [ ] **Providers.** Does ChatForge wrap its own adapters as `Model` first, or switch to Term2's providers in
  the same move?

## Rollout

Term2 goes first and does only what ChatForge needs; ChatForge then adopts the packages one at a time, and
every step after the engine is optional. Compaction extraction and the other changes wait until something
needs them.

### Before anything

- [ ] Merge the stacked wire PRs in `qduc/agent-runtime`
  ([#1](https://github.com/qduc/agent-runtime/pull/1), then [#2](https://github.com/qduc/agent-runtime/pull/2))
  so `main` matches the `0.2.3` tarball Term2 ships. Tracked in
  [qduc/agent-runtime#3](https://github.com/qduc/agent-runtime/issues/3).
- [ ] Check the Node version ChatForge runs in Docker and Electron. Term2 requires Node 24; if ChatForge is
  older, upgrade it as a separate change now.

### Phase 1: Term2, the minimal set

Tracked in [#224](https://github.com/qduc/term2/issues/224).

1. Make core and `Model` implementations instance-local (contract change 1), starting with the provider
   registry's shared compaction state, the ambient cache key, and `src/engine/agent-runtime/scope-resolver.ts`.
2. Change `ToolContext` to `ToolContext<AppCtx>` (contract change 3) and move workspace, settings and shell
   tasks into Term2's app context.
3. Add the root-turn loop cap to `TurnSpec` (contract change 4).
4. Add a static guard that limits what `src/engine` may import, and shrink its allowlist to contracts, `zod`
   and Node builtins. Adding a guard needs approval under the
   [evidence-driven development rules](../../experiments/evidence-driven-development/README.md).
5. Move the engine and its contracts into a workspace package in Term2, with Term2 as its first consumer.
6. Add the boundary test: pack the tarball, install it in a scratch plain-JS project, run two turns
   concurrently with different settings against a fake model and tool, using only the public entry point.

Compaction stays inside the core for now, opt-in.

### Phase 2: ChatForge, one package at a time

1. **Engine.** Wrap ChatForge's own providers as `Model` and its tools against the `Tool` contract. Replace
   the streaming tool loop first, behind a flag, and keep the old path until they match. Comparison mode
   follows; JSON mode and the OpenAI-compatible proxy come last.
2. **Providers (optional).** Swap ChatForge's adapters for Term2's, one provider at a time.
3. **Web tools (optional).** Search and fetch are already near-identical in both.
4. **Host modules (optional).** Sessions and persistence only if ChatForge wants to drop its own.

### Later

- Contract changes 2, 5, 6 and 7: replace-history seam and compaction extraction, the tool-debt helper,
  partial-output rules, Term2 renames.
- Graduation: a package moves to `qduc/agent-runtime` and npm once its API stops changing week to week and
  both apps use it.
