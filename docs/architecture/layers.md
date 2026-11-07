# Source layers

This describes term2's source tree, `src/`, which began as the term2-next
rewrite. Its production entry is `src/app/cli.ts`, built by `pnpm build` to
`dist/src/app/cli.js` and started by the package's `dist/cli.js` (#86). All production code lives in
`src/`: legacy code the CLI no longer reached was deleted (#88) and the rest of
the old `source/` tree was moved into these layers (#87). Tests live in the
root `tests/` folder, laid out by the same layer names.

## Layers

Each folder in `src/` is one layer, named after its job. A layer may only use
the layers listed after its name, so dependencies always point down.

Every file under `src/` is reached from `src/app/cli.ts`; the reachability
check below enforces it, and its allowlist names the five exceptions with
reasons. `session/adopted/` is the one adopted folder left: it keeps the old
session-fact validator for the offline v3 conversation migration and is not
reached from the CLI.

| Layer       | Job                                                           | May depend on                  |
| ----------- | ------------------------------------------------------------- | ------------------------------ |
| `clients/`  | Render the protocol (TUI, headless, ACP, control, Discord)    | host, protocol                 |
| `host/`     | Transport and access: in-process host, HTTP server, auth      | protocol, session              |
| `protocol/` | The one public event and command format, one projection       | session and everything below   |
| `delegation/` | Child agents, roles/pools, runners and workflow execution   | session and everything below   |
| `session/`  | One durable conversation: append-only log, replay, recovery policy | engine, model, tools           |
| `engine/`   | The turn loop: waits for answers, compacts, recovery mechanics | model, tools                   |
| `tools/`    | Tool contracts: schema, approval policy and execute function  | model                          |
| `model/`    | Providers behind one streaming interface, item format         | nothing                        |
| `config/`   | Pure schemas, defaults and profile definitions                | nothing (pure leaf)            |
| `shared/`   | Helpers every layer may import (utils, contracts, types)      | nothing (pure leaf)            |
| `app/`      | Composition root: the only place concrete layers are wired    | everything                     |

Both `config/` (pure schemas and profile definitions) and `shared/` (pure helpers) are leaf layers that any layer may import, and neither may import any other layer. Settings service and file I/O live in `app/` (Decision D1).

### Known exceptions

The scheduled architecture cleanup (#181) reduced allowlisted crossing edges from 116 down to 7, then #197 removed two obsolete runtime edges. The 5 remaining edges correspond to
[Phase 3 of the architecture cleanup plan](../plans/engineering/architecture-cleanup.md#phase-3-the-seven-real-design-problems-ports-when-touched),
addressed pay-as-you-go when those components are next touched. Each edge and its reason, which names its
Phase 3 row and what removes it, live in `scripts/layer-allowlist.json` rather than here, so the reason sits
next to the entry it justifies. `node scripts/gate-exceptions.mjs layer-direction` prints them.
`check-layers.mjs` fails on any unlisted edge and prints listed edges that no longer exist.

`delegation/` sits between protocol and session; session does not import it.
The app injects its concrete launcher/evaluator implementations into tools.
Tool-facing schemas/results/control ports stay in tools, while resolved child
definitions, execution-tree budgets and session-running policy stay above it.
See [the delegation public interface](../../src/delegation/README.md).

## Rules that make it different from the old engine

- **One log.** A session stores a single append-only JSONL log of native facts
  (`session/facts.ts`). History, status, the pending interaction, the queue and
  retry eligibility are all replayed from it (`session/replay.ts`), so there is
  no second journal to keep in sync.
- **One projection.** `protocol/projection.ts` turns session updates
  into wire events once per session, and every client attached to that session
  reads the same events, so no client keeps its own event translator.
- **The engine waits instead of calling up.** An approval or question is an
  `interaction_required` event; the turn waits in memory for the session to
  answer it, and the session alone writes the pending interaction to the log.
  A process that dies while a turn waits reopens that turn as interrupted;
  nothing resumes on its own.
- **Names are jobs.** No layer or file under `src/` is called service, adapter or orchestrator.

## Rule checks

Every rule above and every claim below has a check, or it is not a rule. Each check was shown failing on a
seeded violation (`bash scripts/prove-checks.sh` redoes that in about a minute). Per-commit checks are
static and need no build; the heavy ones run per candidate and report, they do not gate commits. Times are
wall-clock on a loaded 7-core box.

| Rule | Check | When | Time |
| ---- | ----- | ---- | ---- |
| Dependencies point down the layer table | `check-layers.mjs` | every commit | 4.1 s |
| Only `session/` reads the log (`app/`, `clients/` ask the live session) | `check-layers.mjs` (log-reader guard) | every commit | in the above |
| One projection: wire events are built only in `protocol/` | `check-rules.mjs` (one recorded exception: deferred web server) | every commit | 2.4 s |
| Names are jobs (no service/adapter/orchestrator file or folder) | `check-rules.mjs` | every commit | in the above |
| No new unused runtime exports (recorded in `rule-baseline.json`, reported by `scripts/arch-report.mjs`) | `check-rules.mjs` | every commit | in the above |
| File basenames are unique under `src/` unless recorded with a reason | `check-rules.mjs` | every commit | in the above |
| Every runtime file is reached by value edges from `app/cli.ts` | `check-reachability.mjs` | every commit | 1.2 s |
| Files stay under 500 lines, folders stay under 15 files unless a ceiling records why; layer edges within budget | `check-complexity.mjs` | every commit | 0.15 s |
| A new exception or raised ceiling carries a reason, and the reviewer is shown each one | `check-baselines.mjs` | every commit | 0.2 s |
| Root directory contains only allowlisted files | `check-root.mjs` | every commit | 0.05 s |
| A message's path stays short and runs through the production direct files | `bench/hops.mts` | every commit | 5.8 s |
| The engine waits instead of calling up | layer table above (no upward import); `check-engine-callbacks.mjs` for the callbacks that write facts (audit F1): every `TurnDeps`/`TurnBudget` callback that reaches the session writer must be recorded in `rule-baseline.json` (`engineCallbackWrites`) with a reason. It follows calls it can resolve to a body, interface members into the object literals and classes that implement them, and port signatures named `commit*`/`accept*`/`append`; a write reached only through a value the checker cannot resolve is not seen | every commit | 10 s |
| One log: no second state to keep in sync | only the log-reader half is checked; the duplicate-reducer half (audit H1) is **not** | every commit | - |
| Speed stays within 1.2x of legacy on a large session | queue job, run on each candidate at load under 9 | per candidate | minutes |
| A fresh reader can explain how a message travels from this README and the `index.ts` files | queue job `measure-fresh-reader-review`, each milestone | per milestone | minutes |

A check that has a false positive or flakes is fixed or deleted the same day; never retry it through.

## When a gate fails

A gate's number is a prompt for judgement, not a target. Agents follow the signal a gate gives, so a gate that
only says "too many" teaches them to satisfy the number: split a file into pieces that only make sense together,
rename `*-service` to `*-manager`, or hide an import. Each failure therefore prints, once per rule, why the rule
exists, the usual fix, the moves that only satisfy the number, and how to record a deviation. That text lives in
`scripts/gates/rules.mjs`, the one place to change it.

When a gate fails, in order:

1. **Fix the violation** if the rule's reason applies here. It usually does.
2. **Record a deviation** if you judge the rule wrong for this case: add the entry to the rule's exception file as
   an object with a `reason` (or, for a long file, a ceiling with a reason). Write the reason for someone who was
   not there: what you weighed, why the fix would cost more, and what would let the entry go. Read precedent
   first with `node scripts/gate-exceptions.mjs <rule>`.
3. **Ask the user** for rules with no exception route (`log-readers`, `one-fold`), for raising the global line
   limit, and for adding a unit-test guard.

`check-baselines.mjs` enforces the second step against the merge base. A new exception passes only with a reason
that is not empty, short or a placeholder; a bare legacy-style string fails; a raised ceiling must rewrite its
reason; `maxLayerEdges` may rise only by the number of reasoned edges added. Every accepted deviation is printed
and written to the CI step summary under "Recorded gate deviations". A reviewer reads each one and rejects the
change if the reason does not hold; a reason the gate accepts is not thereby a good one.

Entries written as bare strings predate per-entry reasons. They are grandfathered with one shared reason per list
(`LEGACY_REASONS` in `scripts/gates/rules.mjs`) and cannot grow; give one a reason when you touch it.

This replaced a rule that no baseline could grow. That rule kept the lists shrinking, but it left no honest route
when a rule was wrong for a case, so the only way to green was to game the number.

## Shared JSON transport contract

`src/shared/utils/json-value.ts` owns `JsonValue` and `isJsonValue` for workflow,
sandbox-host and scripted tool-return consumers. The type and validator are
transport primitives, not workflow policy: importing the workflow domain from
these tool leaves inverted ownership. Workflow and host type modules retain
their existing exports for callers. Moving the implementation does not change
which values validate; in particular finite numbers and shared acyclic objects
remain accepted, while ancestor cycles are rejected.

## How a message travels

This is the path `bench/hops.mts` measures for one headless prompt, from the
client's submit to the provider's HTTP request. The TUI, ACP and the control
socket attach to the same host the same way.

1. `app/cli.ts` parses the command line and hands a headless run to
   `app/launch-headless.ts`. It resolves the workspace (local or SSH),
   connects the configured MCP servers, builds the direct application
   (`app/application.ts`, which owns the in-process host), creates or
   connects to the session through that host, and starts the headless client
   on the resulting connection.
2. The client (`clients/headless/direct.ts`) sends a `submit` `WireCommand` on
   its `DirectConnection` (`host/in-process-direct.ts`).
3. The host passes the command to `protocol/commands.ts`
   (`applyDirectCommand`), the only wire-to-domain translation, which calls
   `submit` on the live `DirectSession` (`session/session.ts`).
4. The session's `Conversation` (`session/conversation.ts`) appends the
   admission facts and starts an engine turn with `startTurn`
   (`engine/turn.ts`). `session/conversation-turn.ts` is the only reader of that
   turn's events: it appends each event's facts to the log and then calls
   `accept(token)`, and the turn does not advance past an event until it is
   accepted.
5. `engine/turn-model.ts` asks for the model through the registry the app
   built (`app/application-models.ts`, wrapped by
   `app/generation-guard.ts`). `model/provider.ts` streams from the
   provider in `model/providers/`, retrying through `model/retry.ts`.
6. On the way back, each accepted fact and live delta reaches the host as a
   `DirectSessionUpdate`. `host/in-process-direct-attachment.ts` keeps one
   `DirectProjection` per session (`protocol/projection.ts`); it turns
   the update into `WireEvent`s, which every connection to that session
   receives in order.

**Where an approval waits.** When a tool needs approval, the engine emits
`interaction_required` and waits in memory. `conversation-turn.ts` appends the
pending interaction, so the session status and the client's snapshot show it.
The client replies with an `answer` command, which `commands.ts` turns
into an answer on the session, and `conversation-turn.ts` passes it to the
waiting turn with `TurnHandle.answer`. Headless decides with the policy in
`clients/headless/approvals.ts`: without `--auto-approve` it denies;
with it, it allows everything except medium- or high-risk shell commands. The
TUI asks the user. If the process dies while it waits, reopening the
session records that turn as interrupted; nothing resumes on its own.

## Keeping it readable

The point of this rewrite is that a person can follow it. Three checks in CI,
with budgets in `scripts/complexity-budget.json`, and one review step keep that
measurable:

- `scripts/check-complexity.mjs` fails when the layer-edge allowlist grows, or
  when a file passes 500 lines. The line limit is a prompt to look for a second
  job, not a target: split along a real seam, or, when a file reads better
  whole, give it a ceiling with a one-line reason. When something gets smaller,
  the check prints the new number to record.
- `scripts/check-reachability.mjs` walks value imports, re-exports, literal
  dynamic imports and `require` calls from `src/app/cli.ts`. Type-only edges do
  not make runtime code reachable; modules containing only erased type
  declarations/imports and explicit type re-exports need no runtime importer.
  This is a source-graph check, not proof that a value import survives bundler
  tree-shaking. A runtime file kept on purpose goes in
  `scripts/reachability-allowlist.json` with the reason it stays.
- `bench/hops.mts` runs the real entry in-process against a local fake
  provider, sends one headless prompt, and records the chain of files active
  when the provider's HTTP request goes out, starting at the client's submit.
  It fails when that chain gets longer (hops) or touches more files. Today it is
  14 hops through 14 files, each layer once: `clients/headless/direct.ts`,
  `host/in-process-direct.ts`, `protocol/commands.ts`,
  `session/session.ts`, `session/conversation-turn.ts`, `engine/turn.ts`,
  `engine/turn-model.ts`, `app/generation-guard.ts`,
  `app/application-models.ts`, `model/provider.ts`, and four
  `model/providers/` files. `app/` appears below `engine/` because the engine
  calls the model registry the app injected, not because `engine/` imports
  `app/`.
- At the end of each phase, a fresh reader gets only this README and each
  layer's `index.ts`, and explains how a message travels and where an approval
  waits. Whatever they get wrong gets fixed in the structure or the docs before
  the next phase starts.

## Parity

`parity/run.mjs` runs each scenario in `parity/scenarios/` against a CLI
build, with a scripted fake provider, and compares exit code, output, every
provider request and the workspace files against `parity/goldens/`. The goldens
were recorded from the old engine and are never edited to make a run pass.

The feature tracker that gated the port (`parity/inventory.mjs` and
`parity/features.json`) was retired at the flip (#87): it extracted features
from `source/`, which no longer exists. Its last state, including the dropped
and deferred entries described below, is in git history.

`app/source-tools.ts` binds run-code to a concrete nested approval owner and
session access/policy state. The native `tools/` contracts do not construct
those upper-layer owners.

The CLI is `node dist/cli.js ["<prompt>"]` (the `term2` bin), with no fallback
to the old engine. It stores native conversation logs in its own directory
(`conversations-next`) and does not read old conversations; the offline
`scripts/migrate-conversations.mjs` copies v3 conversations into native logs.
The CLI refuses the reserved legacy directory, including symlink aliases and
not-yet-created stores. Filename checks alone cannot protect an empty legacy store;
custom native stores elsewhere remain supported, even when named `conversations`.
On macOS and Windows, alternate-case spellings of that reserved path are also
refused, including on case-sensitive volumes.
`bench/m1-direct.mjs` covers the headless path.

For direct HTTP session configuration, the BFF's `session_update` assertion binds
only `sessionId`, not `workspaceId`; session lookup is separate, and the gateway
authorizes the session owner. An empty `{}` POST is read-only discovery, not a
keyed mutation. Discovery does not activate the v2 hydration or mutation gates.

```sh
node parity/run.mjs check --cli dist/cli.js          # the built CLI against the goldens
TERM2_TEST_CLI=dist/src/app/cli.js pnpm test:integration   # CLI-level suite, as the CI lanes run it
```

## Checks

These use the root project's TypeScript options and dependencies, so run
`pnpm install` at the repository root first. The build keeps repository-relative
paths beneath `dist/` (`dist/src/...`).

```sh
pnpm exec tsc -p tsconfig.build.json --noEmit         # production typecheck
node scripts/check-layers.mjs                  # production dependency direction
node scripts/check-reachability.mjs            # every src file is reached from app/cli.ts
node scripts/check-complexity.mjs              # long files carry a recorded reason
node --import tsx bench/hops.mts               # one message's path stays short
node scripts/build.mjs                         # production build
node bench/m1-direct.mjs                       # headless behaviour against the built CLI
```

A profile-dependent probe needs an explicit profile rather than the
application default: Bare omits `user-interaction`, so an unoffered
`propose_goal` or `ask_user` returns `Unknown tool` and never opens the
interaction the probe waits for. Isolate the probe's settings directory too:
`disableFilePersistence` disables writes, not loading existing settings.

The build script emits the TypeScript tree and copies the runtime assets just as
the root build does: prompts come from `src/session/prompts/` and provider presets
from `src/model/providers/provider-presets.json`.
The production build config also explicitly includes
`src/shared/utils/worker-cwd-preload.cts`. `workerBootstrapExecArgv` locates its
emitted `.cjs` through a URL, not a static import, so transitive compilation
alone misses it. Without that entry, built `run_code` workers fail at startup
before executing any tool, even though the CLI and provider turn can complete.

## Owner scope: dropped and deferred features

Owner decisions on 2026-11-01 narrow current parity work to everyday Bare use
(including `--lite`), control socket, Discord and SSH. Goldens stay unchanged;
mentor-only catalog entries needed by Bare remain. Shared or ambiguous settings
and dependencies stay until their consumers are traced. These scope decisions
were made before the flip.

"Dropped" below means no further parity work: the retired inventory marked the
feature `dropped`, and no scenario has to prove it. It does not mean term2-next lacks
the code. Each dropped feature is still wired in production, as noted, and
behaves as it does today.

- **MCP servers — dropped from parity work, still wired.** The headless run
  (`app/launch-headless.ts`) and the TUI (`app/launch-tui.tsx`)
  connect the configured servers through `app/application-mcp.ts` and
  `app/mcp.ts`, which drive the MCP manager in `tools/mcp/`, and offer their tools
  through `app/tool-surface.ts`. Fixing gaps against legacy would need the
  catalog binding, connection lifecycle and approval policy together.
- **Plan, pair, mentor and orchestrator profiles/modes, and
  `run_agent_workflow` — dropped from parity work.** `--profile` still selects
  any of them through `config/profiles/`, and the TUI's `/plan`,
  `/mentor` and `/orchestrator` commands still switch them; parity for their prompts, settings and workflow execution
  is not being checked. Bare, `--lite`, subagent `ask_orchestrator` and the
  retained mentor catalog are kept.
- **ACP — dropped from parity work, still wired.** `term2 acp` dispatches to
  `app/launch-acp.ts`, with `clients/acp/` as the adapter for session
  attachment, rendering and permission/question mapping.
- **Sandbox execution — dropped from parity work, still present.** The TUI's
  `/sandbox` command and the tool surface's `allowUnsandboxed` posture
  (`app/tool-surface.ts`) remain, and `term2 serve` and `term2 acp` warn when
  the sandbox is unavailable. A real return needs shell policy in
  `src/shared/utils/shell/sandbox/`, approval rules and the sandboxed code-host
  lifecycle together. Shared settings remain.
- **Web server/browser and canonical v2 wire — deferred, not dropped.** Retain
  candidate server/browser code, branches and the vendored wire artifact; gates
  remain closed (`AGENT_WIRE_V2_RUNTIME_AVAILABLE` is `false`). Web is the
  milestone after kept-core M6 and before the default flip, so there must be no
  gap where neither CLI serves it. The existing `host/server*` and
  browser/protocol seams still need the canonical gate,
  branch/tool/approval browser paths, reconnect replay limits and aggregate cost
  contract established. Reconnect replay is protocol-demanding, not a UI-only
  plug-in. Run the existing real-browser plain-text turn exercise once at M6's
  end, not per commit; no web repair work is authorized now. The flip went
  ahead with web still deferred.

The traced direct control/Discord runtime uses the in-process host and direct
protocol plus the `clients/control-socket/` and `clients/discord/` modules,
not the HTTP server or ACP backend. The CLI
still statically imports `src/host/gateway/serve-args.ts` and
`src/clients/acp-v2/serve-args.ts`; preserve those modules while the imports exist.
No live SSH fixture was identified in that trace.

## Build receipts

`pnpm build` writes a `.term2-build-provenance.json` receipt: HEAD and SHA256
hashes of the owned source/config/build inputs, including untracked files, and
of the final output bytes. mtime and the version-only `build-info.json` are not
freshness evidence. A commit, dirty input edit or output replacement requires a
rebuild, even if timestamps are unchanged. Receipts assume installed
dependencies follow the package/lock files, not hand-edited `node_modules`;
owned input/output symlinks are refused.
