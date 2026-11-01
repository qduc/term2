# term2 rewrite skeleton

This folder holds the interfaces for a restructured term2 and its production
composition. The earlier native-engine example lives in a separate fixture
directory so its toy facts and restart behavior cannot define canonical
session persistence. It is separate from `source/`, and nothing in `source/`
imports it.

## Layers

Each folder in `src/` is one layer, named after its job. A layer may only use
the layers listed after its name, so dependencies always point down.

Most layers also have an `adopted/` folder. Code there wraps the existing
`source/` implementation behind the layer's interface, which is how the port
reuses the old CLI while the layers are filled in. `app/adopted/` wires those
pieces together for production.

| Layer       | Job                                                         | May depend on                  |
| ----------- | ----------------------------------------------------------- | ------------------------------ |
| `clients/`  | Render the protocol (TUI, headless, ACP, Discord)           | host, protocol                 |
| `host/`     | Transport and access: in-process or HTTP server, auth       | protocol, session, config      |
| `protocol/` | The one public event and command format, one projection     | session and everything below   |
| `session/`  | One durable conversation: append-only log + one reducer     | engine, model, tools, config   |
| `engine/`   | The turn loop: suspends for approval, checkpoints, compacts | model, tools, config           |
| `tools/`    | Schema, approval policy and execute function per tool       | model, config                  |
| `model/`    | Providers behind one streaming interface, item format       | nothing                        |
| `config/`   | Settings, scoped per session                                | nothing                        |
| `app/`      | Composition root: the only place concrete layers are wired  | everything                     |

## Rules that make it different from `source/`

- **One log.** `session/` stores a single append-only log of `SessionFact`s.
  History, status, the pending approval, the queue and retry eligibility are
  all projections of it, so there is no second journal to keep in sync. The
  fact types live in `session/adopted/conversation-log.ts`, because most of
  them are the old CLI's conversation-log events and only adopted files may
  import `source/`.
- **One projection.** `protocol/` turns session updates into `WireEvent`s
  once. The TUI reaches it through the in-process host. The gateway's web
  client, ACP and Discord will reach the same protocol through an HTTP server
  host that is not built yet, so no client keeps its own event translator.
- **The engine suspends instead of calling up.** An approval ends the turn run
  with a serializable `TurnCheckpoint`. The native tracer fixture may inspect
  that value, but canonical sessions never resume native checkpoints after a
  process restart. In production the adopted engine keeps the old run loop
  parked in memory under that checkpoint, so a decision continues it.
- **Names are jobs.** No layer is called service, adapter or orchestrator.

## Shared JSON transport contract

`source/utils/json-value.ts` owns `JsonValue` and `isJsonValue` for workflow,
sandbox-host and scripted tool-return consumers. The type and validator are
transport primitives, not workflow policy: importing the workflow domain from
these tool leaves inverted ownership. Workflow and host type modules retain
their existing exports for callers. Moving the implementation does not change
which values validate; in particular finite numbers and shared acyclic objects
remain accepted, while ancestor cycles are rejected.

## Native tracer fixture

The pre-C2 native engine example is isolated under `bench/native-tracer/` with
fixture-local session facts. It calls the fixture Session API directly and is
not evidence for the canonical conversation log or C2 acceptance. It verifies
that approval and in-flight tool work reopen as interrupted, stale decisions
fail, reopening adds no duplicate facts, and opening does not resume the model
or execute a tool. Compile it separately with
`rewrite/tsconfig.native-tracer.json`.

What building it changed in the interfaces:

- `TurnInput` held live `Tool` objects and a settings reader, so a
  `TurnCheckpoint` could not be persisted. It now carries tool names and the
  workspace, and live dependencies go in once through `EngineDeps`.
- The host built user `Item`s from wire commands, which the layer check
  rejected (`host/` may not import `model/`). Inbound command handling moved
  to `protocol/commands.ts`, so the protocol owns both directions.
- `HostDeps` gained `resolveWorkspace` and `defaultModel`; creating a session
  needs both and the host had neither.

Known gaps in the fixture, left out on purpose: no input queue (a busy session refuses), no
compaction, progress events are buffered until a tool returns, and each
checkpoint stores the full turn input.

## How a message travels

This section describes the adopted bridge path. The direct headless program is
described under the layer guard below, and starts at `src/app/cli.ts`.

1. A client turns the user's text into a `submit` `WireCommand` and sends it on
   its host `Connection`.
2. `protocol/commands.ts` (`applyCommand`) turns that command into
   `Session.submit(requestId, items)`.
3. The session (`session/local-store.ts`, with the turn driver in
   `session/adopted/foreground.ts`) appends the admission facts, then calls
   `Engine.start`.
4. In production the engine is `engine/adopted/`. It runs the old CLI's
   `AgentClient` and run loop from `source/`, which call the provider through
   `model/adopted/`.
5. Each fact the session appends, and each live engine event, reaches
   subscribers as a `SessionUpdate`. The in-process host passes every update
   through `Projection.toWire` (`protocol/projection.ts`) before the client
   sees it.

**Where an approval waits.** When a tool needs approval, the engine ends the
turn run as suspended with a `TurnCheckpoint`, and the old run loop stays
parked in memory. The turn's interaction owner
(`session/adopted/turn-interaction.ts`) appends `session_interaction_pending`,
and the session status becomes `awaiting_interaction`. The client answers with a
`decide` command. `applyCommand` adds the pending interaction's revision and
generation from session state and calls `Session.decide`, which resumes the
parked loop. If the process dies while it waits, reopening the session ends
that turn as interrupted; nothing resumes on its own.

## Keeping it readable

The point of this rewrite is that a person can follow it. Two checks in CI,
with budgets in `scripts/complexity-budget.json`, and one review step keep that
measurable:

- `scripts/check-complexity.mjs` fails when the source-edge allowlist grows, or
  when a file passes 500 lines. The line limit is a prompt to look for a second
  job, not a target: split along a real seam, or, when a file reads better
  whole, give it a ceiling with a one-line reason. When something gets smaller,
  the check prints the new number to record.
- `bench/hops.mts` sends one message and follows its async chain from Session
  submit to the provider call. It fails when the path gets longer (hops, where
  consecutive frames in one file count once) or touches more files. Today the
  path is 29 hops through 7 files. Most of those hops are callbacks bouncing
  between `source/lib/agent-client.ts` and `application-run-loop.ts`.
- At the end of each phase, a fresh reader gets only this README and each
  layer's `index.ts`, and explains how a message travels and where an approval
  waits. Whatever they get wrong gets fixed in the structure or the docs before
  the next phase starts.

## Porting: completeness and parity

`parity/` holds the two checks that gate the port of `source/` onto these
layers. The full plan, including the task breakdown, lives in the "term2 port
plan" doc.

- `parity/inventory.mjs` extracts every feature of the current architecture
  (CLI flags and subcommands, slash commands, tools, settings, providers, hook
  events, gateway routes, persisted log events) and checks them against the
  tracker `parity/features.json`. It fails on an untracked feature, a vanished
  one not marked `dropped`, or a `ported` entry no scenario proves. `--write`
  adds new features as `todo`.
- `parity/run.mjs` runs each scenario in `parity/scenarios/` against a CLI
  build, with a scripted fake provider, and compares exit code, output, every
  provider request and the workspace files against `parity/goldens/`. Goldens
  are recorded only from the old architecture.

The layer guard follows imports from `src/<layer>/adopted/` into `source/` and
checks every reached source layer against the table above. Existing dependency
edges within `source/` that cross those rules are recorded one edge per line in
`scripts/source-edge-allowlist.json`; the guard rejects newly added edges and
prints stale entries for cleanup. It also reports reached source files missing
from the map. Adopted adapters and the direct path's short named list in
`check-layers.mjs` may import `source/`, and `source/` cannot import from
`rewrite/`.

Concrete source-tool assembly lives in `app/source-tools.ts`: it binds source
run-code to a concrete nested approval owner and session access/policy state.
The native `tools/` contracts do not construct those upper-layer owners. Host
configuration types use the existing Session facade rather than importing
model/tool types directly.

Source mappings describe jobs, not directory names: the input React context is
client state, provider-management policy is model-owned, the plan-mode
interceptor is tool policy, and the provider-picker integration fixture is app
composition. The source-edge list still records legacy coupling: provider-picker
readiness reaches provider auth/registry through `utils/ai/provider-credentials`,
model-picker metadata imports setting keys, and rewind display metadata imports
the store's authoritative target type. These exact existing edges (plus the
picker's provider-policy seam and legacy gateway's interceptor installation) are
grandfathered, not evidence that clients or shared helpers have unrestricted
model/config/Session access. Every reached target's closure is still checked;
new source edges and reverse `source/` → `rewrite/` imports remain prohibited.

The direct headless path is a separate program,
`node rewrite/dist/rewrite/src/app/cli.js "<prompt>"`, with no fallback to the
old engine. It stores native conversation logs in its own directory and does
not read old conversations. M1 is text-only: a model tool call fails the turn.
`rewrite/bench/m1-direct.mjs` covers it.

For direct HTTP session configuration, the BFF's `session_update` assertion binds
only `sessionId`, not `workspaceId`; session lookup is separate, and the gateway
authorizes the session owner. An empty `{}` POST is read-only discovery, not a
keyed mutation. Discovery does not activate the v2 hydration or mutation gates.

```sh
node rewrite/parity/inventory.mjs
node rewrite/parity/run.mjs check --cli dist/cli.js          # old CLI: must stay green
node rewrite/parity/run.mjs check --cli <new build>/cli.js   # new CLI: the port's progress
node rewrite/parity/run.mjs record --cli dist/cli.js <id>    # new scenario, from the old CLI only
TERM2_TEST_CLI=<new build>/cli.js pnpm test:integration      # CLI-level suite against any build
```

## Checks

These use the root project's TypeScript options and dependencies, so run
`pnpm install` at the repository root first. The build keeps repository-relative
paths beneath `rewrite/dist/`; adopted imports therefore resolve to the emitted
`source/` tree beside `rewrite/`.

```sh
pnpm exec tsc -p rewrite/tsconfig.json                 # production typecheck
node rewrite/scripts/check-layers.mjs                  # production dependency direction
node rewrite/scripts/check-complexity.mjs              # size budgets only shrink
node --import tsx rewrite/bench/hops.mts               # one message's path stays short
node rewrite/scripts/build.mjs                         # production build
pnpm exec tsx rewrite/bench/c1-adopted-approval.mts   # real adopted approval and canonical replay
pnpm exec tsx rewrite/bench/c1-adopted-kill.mts       # parked approval process-kill recovery
pnpm exec tsc -p rewrite/tsconfig.native-tracer.json && node rewrite/bench-dist/rewrite/bench/native-tracer/tracer.js
```

Capability-dependent adopted benches need an explicit profile rather than the
application default. In `c3a-goal.mts`, proposals select Pair because Bare omits
`user-interaction`; an unoffered `propose_goal` returns `Unknown tool` and never
opens the approval the bench waits for. The other goal modes retain default
Bare coverage. Its settings directory is isolated too: `disableFilePersistence`
disables writes, not loading existing settings.
The `c3a-interactions.mts` ask-navigation/cancellation modes likewise select Pair
and isolate settings; shell-approval modes stay on default Bare. An unoffered
`ask_user` produces the same unknown-tool result, not a pending interaction.

The build script emits the TypeScript tree and copies the runtime assets just as
the root build does: prompts come from `source/prompts/` and provider presets
from `source/providers/provider-presets.json`.
The production build config also explicitly includes
`source/utils/worker-cwd-preload.cts`. `workerBootstrapExecArgv` locates its
emitted `.cjs` through a URL, not a static import, so transitive compilation
alone misses it. Without that entry, built `run_code` workers fail at startup
before executing any tool, even though the CLI and provider turn can complete.

## C2 canonical-log proof

The bounded C2 entry composes the existing source CLI/non-interactive runner
with `LocalSessionStore`; it is not the production CLI. Build the proof graph,
copy the source runtime assets beside it, then run old-writer/new-session resume
parity and the real approval-kill process proof:

```sh
pnpm exec tsc -p rewrite/tsconfig.c2-proof.json
cp -r source/prompts rewrite/bench-dist/source/
mkdir -p rewrite/bench-dist/source/providers
cp source/providers/provider-presets.json rewrite/bench-dist/source/providers/
node rewrite/parity/run.mjs check --cli dist/cli.js --first-cli dist/cli.js --resumed-cli rewrite/bench-dist/rewrite/bench/c2-proof-cli.js resume-follow-up
node rewrite/bench/c2-approval-kill.mjs
node rewrite/bench/c2-answer-kill.mjs
node rewrite/bench/c2-storage-failure.mjs
node rewrite/bench/c2-boundary-failure.mjs
```

The proof CLI persists source materialized events and lifecycle boundaries
through the C2 store. Its approval-kill barrier exists only in the bench
composition. It does not cover the later C1 pre-tool-dispatch durability gate.
The fault matrix distinguishes failures before write, after admission, and at
pending/final event boundaries. A failed fsync may leave a complete atomic
terminal batch when the write reached the kernel first; the caller still
receives failure and the transaction is never partially projected.

## Owner scope: dropped and deferred features

Owner decisions on 2026-11-01 narrow current parity work to everyday Bare use
(including `--lite`), control socket, Discord and SSH. Goldens stay unchanged;
mentor-only catalog entries needed by Bare remain. Shared or ambiguous settings
and dependencies stay until their consumers are traced. These scope decisions
are not permission to delete code or change the legacy CLI before the flip.

- **MCP servers — dropped.** A future return can reuse
  `app/direct-mcp-source.ts` and `app/tool-surface.ts`, but needs the source MCP
  manager, catalog binding, connection lifecycle and approval policy together.
- **Plan, pair, mentor and orchestrator profiles/modes, and
  `run_agent_workflow` — dropped.** Reintegration would go through
  `source/services/profiles/` and the offered tool surface, with profile prompts,
  settings and workflow execution dependencies. Bare, `--lite`, subagent
  `ask_orchestrator` and the retained mentor catalog are not dropped.
- **ACP — dropped.** `clients/acp/` remains the adapter seam, depending on session
  attachment, rendering and permission/question mapping; it is not just a CLI
  subcommand to re-enable.
- **Sandbox execution — dropped.** This crosses execution: a return needs shell
  policy in `source/utils/shell/sandbox/`, approval rules and sandboxed code-host
  lifecycle together, not a new isolated adapter. Shared settings remain.
- **Web server/browser and canonical v2 wire — deferred, not dropped.** Retain
  candidate server/browser code, branches and the vendored wire artifact; gates
  remain closed. Web is the milestone after kept-core M6 and before the default
  flip, so there must be no gap where neither CLI serves it. The existing
  `host/server` and browser/protocol seams still need the canonical gate,
  branch/tool/approval browser paths, reconnect replay limits and aggregate cost
  contract established. Reconnect replay is protocol-demanding, not a UI-only
  plug-in. Run the existing real-browser plain-text turn exercise once at M6's
  end, not per commit; no web repair work is authorized now. Deferred inventory
  entries remain incomplete and block the default flip, just like `todo`.

The traced direct control/Discord runtime uses the in-process Host and direct
protocol plus shared `source/services/control-socket/` and
`source/services/discord/` modules, not the HTTP server or ACP backend. The CLI
still statically imports `source/gateway/serve-args.ts` and
`source/acp-v2/serve-args.ts`; preserve those modules while the imports exist.
This bounded trace does not authorize deleting the whole gateway/ACP trees or
legacy dependencies. Existing source integration tests do not by themselves
prove direct integration; no live SSH fixture was identified in that trace.

## Local nine-golden scores

Build both CLIs, then run the read-only score command (optional argument selects
another checkout root):

```sh
pnpm build
node rewrite/scripts/build.mjs
node scripts/golden-scores.mjs /path/to/term2
```

The reporter checks both `.term2-build-provenance.json` receipts before running
any scenarios and again before printing `direct: N/9` and `old CLI: N/9`.
After the single nine-scenario pass per CLI, it repeats `subagent-batch` 24 times
per CLI at six parallel and prints the loaded totals. A single mismatch fails;
failed occurrences are never retried or outvoted. Exit 0 requires both 9/9 and
24/24; 1 means a real mismatch; 2 means no trustworthy score (missing/stale build
or runner failure). It never records goldens.
Both normal build commands capture HEAD and SHA256 hashes of actual owned
source/config/build inputs, including untracked files, and final output bytes;
mtime and the old version-only `build-info.json` are not freshness evidence.
The direct build now clears its generated output first. Old builds without
receipts must be rebuilt. A commit, dirty input edit or output replacement
requires rebuilding the affected CLI, even if timestamps are unchanged.

Input coverage is deliberately conservative (whole source/build-script trees,
root package/lock/config files, and native source/config/scripts for direct).
Receipts assume installed dependencies follow the package/lock files, not
hand-edited `node_modules`; owned input/output symlinks are refused. Before/after
checks catch observed concurrent changes, not an edit-and-revert racing a read;
run builds and scores without concurrent edits in that checkout.
