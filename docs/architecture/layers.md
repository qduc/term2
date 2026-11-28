# Source layers

This describes term2's source tree, `src/`, which began as the term2-next
rewrite. Its production entry is `src/app/cli.ts`, built by `pnpm build` to
`dist/src/app/cli.js` and started by the package's `dist/cli.js` (#86). Term2 application code lives in
`src/`; the reusable turn loop and contracts live in `@qduc/agent-core`, developed in
[qduc/agent-runtime](https://github.com/qduc/agent-runtime) (`packages/core/`) and consumed here as an exact-pinned npm prerelease (paths below written
`agent-runtime/packages/core/src/...` are in that repository). Legacy code the CLI no longer reached was deleted (#88) and the rest of
the old `source/` tree was moved into these layers (#87). Tests live in the
root `tests/` folder, laid out by the same layer names.

## Layers

Each folder in `src/` is one layer, named after its job. A layer may only use
the layers listed after its name, so dependencies always point down.

The reachability check walks value imports from `src/app/cli.ts`.
[`scripts/reachability-allowlist.json`](../../scripts/reachability-allowlist.json)
records exceptions such as worker entry points and the offline v3 conversation
migration.

| Layer       | Job                                                           | May depend on                  |
| ----------- | ------------------------------------------------------------- | ------------------------------ |
| `clients/`  | Render the protocol (TUI, headless, ACP, control, Discord)    | host, protocol                 |
| `host/`     | Transport and access: in-process host, Unix daemon binding, HTTP server, auth      | protocol, session              |
| `protocol/` | Native event and command types, shared projection and fold     | delegation and everything below |
| `delegation/` | Child agents, roles/pools, runners and workflow execution   | session and everything below   |
| `session/`  | One durable conversation and its host policy: log, replay, branches, permissions, completion and billing | engine, model, tools |
| `engine/`   | Compatibility types and continuity/history helpers for the portable harness | portable package contracts |
| `tools/`    | Tool contracts: schema, approval policy and execute function  | model                          |
| `model/`    | Providers behind one streaming interface, item format         | nothing                        |
| `config/`   | Pure schemas, defaults and profile definitions                | nothing (pure leaf)            |
| `shared/`   | Helpers every layer may import (utils, contracts, types)      | nothing (pure leaf)            |
| `app/`      | Composition root: the only place concrete layers are wired    | everything                     |

Both `config/` (pure schemas and profile definitions) and `shared/` (pure helpers) are leaf layers that any layer may import, and neither may import any other layer. Settings service and file I/O live in `app/` (Decision D1).

### Known exceptions

The scheduled architecture cleanup (#181) reduced allowlisted crossing edges from 116 down to 7, #197 removed two obsolete runtime edges, `1b618d5bc` removed the obsolete `Banner.tsx -> engine/agent-runtime/model-resolver.ts` edge, and #299 removed the three `clients/tui` edges (rows 3.1 and 3.2). The one remaining edge is
[Phase 3 of the architecture cleanup plan](../plans/engineering/architecture-cleanup.md#phase-3-the-seven-real-design-problems-ports-when-touched)
row 3.5, addressed pay-as-you-go when those components are next touched. Its reason, which names the
Phase 3 row and what removes it, lives in `scripts/layer-allowlist.json` rather than here, so the reason sits
next to the entry it justifies. `node scripts/gate-exceptions.mjs layer-direction` prints it.
`check-layers.mjs` fails on any unlisted edge and prints listed edges that no longer exist.

The portable harness owns turn mechanics and imports only its own contracts,
Node builtins and optional schema dependencies. `src/engine` contains only its
compatibility surfaces and has an empty import-exception baseline. Term2-specific
agent resolution, permission scopes, budgets, completion verification, prompt
notices and history presentation live in `session/` and `app/`. These host modules configure
the harness; they are not part of the reusable package. Their source moves in
#224 preserve existing policy and call paths.

`delegation/` sits between protocol and session; session does not import it.
The app injects its concrete launcher/evaluator implementations into tools.
Tool-facing schemas/results/control ports stay in tools, while resolved child
definitions, execution-tree budgets and session-running policy stay above it.
See [the delegation public interface](../../src/delegation/README.md).

## Session ownership

- A session writes accepted facts to one append-only JSONL conversation log
  (`session/facts.ts`, `session/log.ts`). `session/replay.ts` projects durable
  history, queue and interaction state from those facts.
- `protocol/projection.ts` turns session updates into native wire events.
  Attachments share that projection. Unix RPC and HTTP own their transport
  envelopes and access rules.
- The portable turn emits `interaction_required` and waits in memory. The
  session commits durable human interaction facts. When a running turn is
  recovered from disk, the session records the interruption.
- Names under `src/` describe the file's job. The name guard's grandfathered
  exceptions live under `jobNameExceptions` in `scripts/rule-baseline.json`.

## Rule checks

The [CI workflow](../../.github/workflows/ci.yml) runs production typechecking
and static repository guards in `quality`. It runs the headless path probe in
`bench` and golden parity in `e2e`. Behavioral lanes can skip inert pull
requests. The `port` check aggregates the lanes.

| Rule | Check |
| ---- | ----- |
| Dependency direction and log-reader boundaries | `check-layers.mjs` |
| Event projection, one-fold boundary, job names, runtime exports and unique basenames | `check-rules.mjs` |
| Runtime reachability from `app/cli.ts` | `check-reachability.mjs` |
| File, folder and layer-edge budgets | `check-complexity.mjs` |
| Reasons for new exceptions and raised ceilings | `check-baselines.mjs` |
| Terminal and web parity across app wiring, wire types and browse-tab settings | `check-surface-parity.mjs` |
| Allowlisted root directory entries | `check-root.mjs` |
| Fact writes reached through portable-engine callbacks | `check-engine-callbacks.mjs` |
| Hop and file budget for the in-process headless path | `bench/hops.mts` |

The log-reader guard scans calls to known readers in `app/` and `clients/`.
The one-fold guard restricts imports of the named leaf reducers and their
modules to the owners in `session/`. Direct file reads or independent reducers
can escape these checks. The callback guard follows resolvable calls from
`TurnDeps` and `TurnBudget` into the session writer. The
`engineCallbackWrites` entries in `scripts/rule-baseline.json` record the
reviewed paths. Calls that cannot be resolved statically may need manual review.

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

## Host paths

`createDirectApplication` in [application.ts](../../src/app/application.ts)
constructs the native session store and direct host. The default launchers
build that application in their own process. In daemon mode,
`startTerm2Daemon` in [daemon.ts](../../src/app/daemon/daemon.ts) creates it
once for the daemon. [daemon-unix.ts](../../src/host/daemon/daemon-unix.ts)
accepts local Client API connections and [daemon-rpc.ts](../../src/host/daemon/daemon-rpc.ts)
dispatches calls into the host. `createRemoteDirectHost` in
[remote-direct-host.ts](../../src/host/daemon/remote-direct-host.ts) presents
the same host interface to local Unix clients. See the
[daemon ownership contract](../contracts/15-daemon-session-ownership.md) for
launch values, disconnect and shutdown.

| Surface | Entry point for the daemon path |
| --- | --- |
| TUI | `runDaemonTuiSession` in [daemon-tui-backend.ts](../../src/app/daemon/daemon-tui-backend.ts) |
| Headless | `runHeadlessOverDaemon` in [launch-headless.ts](../../src/app/launch-headless.ts) |
| ACP | `launchAcpOverDaemon` in [launch-acp-daemon.ts](../../src/app/acp/launch-acp-daemon.ts) |
| HTTP and web | `DaemonServeLeaseManager` in [serve-lease.ts](../../src/app/daemon/leases/serve-lease.ts) wraps the daemon's host in the same [HTTP server](../../src/host/server.ts) used by the in-process launcher. |
| Named control socket and Discord | `DaemonControlLeases` in [control-lease.ts](../../src/app/daemon/leases/control-lease.ts) owns the endpoint, with the TUI using `createDaemonControlBridge` in [control-bridge.ts](../../src/app/daemon/leases/control-bridge.ts). |

For the wire boundary see the [Client API](../plans/daemon/spec/client-api.md)
and [HTTP server contract](../contracts/14-agent-wire-v2-server.md).

## How a message travels

This is the path `bench/hops.mts` measures for a headless prompt in the
in-process lane. In the daemon lane, see [Host paths](#host-paths) for
the additional transport before the same native command and session.

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
   admission facts and starts a portable turn through `session/harness.ts`
   (`agent-runtime/packages/core/src/engine/turn.ts`). `session/conversation-turn.ts` is the only reader of that
   turn's events: it appends each event's facts to the log and then calls
   `accept(token)`, and the turn does not advance past an event until it is
   accepted.
5. `agent-runtime/packages/core/src/engine/turn-model.ts` asks for the model through the registry the app
   built (`app/application-models.ts`, wrapped by
   `app/generation-guard.ts`). `model/provider.ts` streams from the
   provider in `model/providers/`, retrying through `model/retry.ts`.
6. On the way back, each accepted fact and live delta reaches the host as a
   `DirectSessionUpdate`. `host/in-process-direct-attachment.ts` keeps one
   `DirectProjection` per session (`protocol/projection.ts`); it turns
   the update into `WireEvent`s, which its attached connections receive in order.

**Where an approval waits.** When a tool needs approval, the engine emits
`interaction_required` and waits in memory. The session's `ApprovalReviews`
(`session/approval/approval-arbiter.ts`) first applies the shared route in
`approval-route.ts`: review, scoped bypass, human prompt or unattended refusal.
Under review the request is live-only; settlement records the open and any
policy close. A human prompt is durable and reaches clients through the shared
projection. The client replies with an `answer` command, which `commands.ts`
turns into a session answer; `conversation-turn.ts` passes it to the waiting
turn with `TurnHandle.answer`. The headless `--auto-approve` boolean controls
execution separately from the four approval modes. For in-process headless runs,
`clients/headless/approvals.ts` owns the client answer path. For daemon-backed
headless runs, the daemon applies the headless policy inside the session. When a
process dies with a waiting turn, reopening records the interruption.

## Keeping it readable

`scripts/check-reachability.mjs` walks value imports, re-exports, literal
dynamic imports and `require` calls from `src/app/cli.ts`. It checks the
source graph. Type-only edges do not make runtime code reachable, and a
reachable source file can still be removed by a bundler.

`bench/hops.mts` sends one headless prompt against a local fake provider and
records the chain of active files up to its HTTP request. The hop and file
budgets live in `scripts/complexity-budget.json`. The probe classifies the
portable package's engine files as engine code. App files can appear further
down the call stack because the harness calls back into the injected model
registry.

## Parity

`parity/run.mjs` runs each scenario in `parity/scenarios/` against a CLI
build, with a scripted fake provider, and compares exit code, output, every
provider request and the workspace files against `parity/goldens/`. These reviewed
behavior snapshots began as old-engine parity evidence and now guard the current
CLI contract. Never re-record them merely to make a run pass: intentional changes
need review and the live `golden-change` pull-request label, enforced by `quality`.

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
`bench/headless.mjs` covers the headless path.

## Build and probe details

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

## Build receipts

`pnpm build` writes a `.term2-build-provenance.json` receipt: HEAD and SHA256
hashes of the owned source/config/build inputs, including untracked files, and
of the final output bytes. mtime and the version-only `build-info.json` are not
freshness evidence. A commit, dirty input edit or output replacement requires a
rebuild, even if timestamps are unchanged. Receipts assume installed
dependencies follow the package/lock files, not hand-edited `node_modules`;
owned input/output symlinks are refused.
