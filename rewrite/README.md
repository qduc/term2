# term2-next (rewrite)

This folder holds term2-next: a restructured term2 whose production entry is
`src/app/cli.ts`, built to `rewrite/dist/rewrite/src/app/cli.js`. It is separate
from `source/` (legacy term2, which remains the product spec), and nothing in
`source/` imports it.

## Layers

Each folder in `src/` is one layer, named after its job. A layer may only use
the layers listed after its name, so dependencies always point down.

Production files are the `direct-*`, `turn*`, `conversation*` and `server-*`
families plus the layer's `index.ts`. `session/adopted/` is the one adopted
folder left: it keeps the old session-fact validator for the offline v3
conversation migration and is not reached from the CLI.

| Layer       | Job                                                           | May depend on                  |
| ----------- | ------------------------------------------------------------- | ------------------------------ |
| `clients/`  | Render the protocol (TUI, headless, ACP, control, Discord)    | host, protocol                 |
| `host/`     | Transport and access: in-process host, HTTP server, auth      | protocol, session, config      |
| `protocol/` | The one public event and command format, one projection       | session and everything below   |
| `session/`  | One durable conversation: append-only log and its replay      | engine, model, tools, config   |
| `engine/`   | The turn loop: waits for answers, compacts, recovers          | model, tools, config           |
| `tools/`    | Tool contracts: schema, approval policy and execute function  | model, config                  |
| `model/`    | Providers behind one streaming interface, item format         | nothing                        |
| `config/`   | Settings reader contract                                      | nothing                        |
| `app/`      | Composition root: the only place concrete layers are wired    | everything                     |

## Rules that make it different from `source/`

- **One log.** A session stores a single append-only JSONL log of native facts
  (`session/facts.ts`). History, status, the pending interaction, the queue and
  retry eligibility are all replayed from it (`session/replay.ts`), so there is
  no second journal to keep in sync.
- **One projection.** `protocol/direct-projection.ts` turns session updates
  into wire events once per session, and every client attached to that session
  reads the same events, so no client keeps its own event translator.
- **The engine waits instead of calling up.** An approval or question is an
  `interaction_required` event; the turn waits in memory for the session to
  answer it, and the session alone writes the pending interaction to the log.
  A process that dies while a turn waits reopens that turn as interrupted;
  nothing resumes on its own.
- **Names are jobs.** No layer is called service, adapter or orchestrator.

## Shared JSON transport contract

`source/utils/json-value.ts` owns `JsonValue` and `isJsonValue` for workflow,
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
   `app/direct-launch-headless.ts`. It resolves the workspace (local or SSH),
   connects the configured MCP servers, builds the direct application
   (`app/direct-application.ts`, which owns the in-process host), creates or
   connects to the session through that host, and starts the headless client
   on the resulting connection.
2. The client (`clients/headless/direct.ts`) sends a `submit` `WireCommand` on
   its `DirectConnection` (`host/in-process-direct.ts`).
3. The host passes the command to `protocol/direct-commands.ts`
   (`applyDirectCommand`), the only wire-to-domain translation, which calls
   `submit` on the live `DirectSession` (`session/direct-session.ts`).
4. The session's `Conversation` (`session/conversation.ts`) appends the
   admission facts and starts an engine turn with `startTurn`
   (`engine/turn.ts`). `session/conversation-turn.ts` is the only reader of that
   turn's events: it appends each event's facts to the log and then calls
   `accept(token)`, and the turn does not advance past an event until it is
   accepted.
5. `engine/turn-model.ts` asks for the model through the registry the app
   built (`app/direct-application-models.ts`, wrapped by
   `app/generation-guard.ts`). `model/provider.ts` streams from the source
   provider in `source/providers/`, retrying through `model/retry.ts`.
6. On the way back, each accepted fact and live delta reaches the host as a
   `DirectSessionUpdate`. `host/in-process-direct-attachment.ts` keeps one
   `DirectProjection` per session (`protocol/direct-projection.ts`); it turns
   the update into `WireEvent`s, which every connection to that session
   receives in order.

**Where an approval waits.** When a tool needs approval, the engine emits
`interaction_required` and waits in memory. `conversation-turn.ts` appends the
pending interaction, so the session status and the client's snapshot show it.
The client replies with an `answer` command, which `direct-commands.ts` turns
into an answer on the session, and `conversation-turn.ts` passes it to the
waiting turn with `TurnHandle.answer`. Headless decides with the policy in
`clients/headless/direct-approvals.ts`: without `--auto-approve` it denies;
with it, it allows everything except medium- or high-risk shell commands. The
TUI asks the user. If the process dies while it waits, reopening the
session ends that turn as interrupted.

## Keeping it readable

The point of this rewrite is that a person can follow it. Three checks in CI,
with budgets in `scripts/complexity-budget.json`, and one review step keep that
measurable:

- `scripts/check-complexity.mjs` fails when the source-edge allowlist grows, or
  when a file passes 500 lines. The line limit is a prompt to look for a second
  job, not a target: split along a real seam, or, when a file reads better
  whole, give it a ceiling with a one-line reason. When something gets smaller,
  the check prints the new number to record.
- `scripts/check-reachability.mjs` walks every import from `src/app/cli.ts` and
  fails when a file under `src/` is never reached, so dead code cannot hide in
  the layers. A file kept on purpose goes in
  `scripts/reachability-allowlist.json` with the reason it stays.
- `bench/hops.mts` runs the real entry in-process against a local fake
  provider, sends one headless prompt, and records the chain of files active
  when the provider's HTTP request goes out, starting at the client's submit.
  It fails when that chain gets longer (hops) or touches more files. Today it is
  14 hops through 14 files, one pass down the layers: clients, host, protocol,
  session, engine, app, model, then the source provider.
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

The layer guard follows imports from `src/session/adopted/` and the direct
files named in `check-layers.mjs` into `source/`, and checks every reached
source layer against the table above. Existing dependency
edges within `source/` that cross those rules are recorded one edge per line in
`scripts/source-edge-allowlist.json`; the guard rejects newly added edges and
prints stale entries for cleanup. It also reports reached source files missing
from the map. Only `session/adopted/` and that named list may import
`source/`, and `source/` cannot import from `rewrite/`.

Concrete source-tool assembly lives in `app/source-tools.ts`: it binds source
run-code to a concrete nested approval owner and session access/policy state.
The native `tools/` contracts do not construct those upper-layer owners.

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

The direct CLI is a separate program,
`node rewrite/dist/rewrite/src/app/cli.js ["<prompt>"]`, with no fallback to the
old engine. It stores native conversation logs in its own directory
(`conversations-next`) and does not read old conversations; the offline
`scripts/migrate-conversations.mjs` copies v3 conversations into native logs.
`rewrite/bench/m1-direct.mjs` covers the headless path.

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
paths beneath `rewrite/dist/`; imports of `source/` therefore resolve to the emitted
`source/` tree beside `rewrite/`.

```sh
pnpm exec tsc -p rewrite/tsconfig.json                 # production typecheck
node rewrite/scripts/check-layers.mjs                  # production dependency direction
node rewrite/scripts/check-reachability.mjs            # every src file is reached from app/cli.ts
node rewrite/scripts/check-complexity.mjs              # size budgets only shrink
node --import tsx rewrite/bench/hops.mts               # one message's path stays short
node rewrite/scripts/build.mjs                         # production build
node rewrite/bench/m1-direct.mjs                       # headless behaviour against the built CLI
```

A profile-dependent probe needs an explicit profile rather than the
application default: Bare omits `user-interaction`, so an unoffered
`propose_goal` or `ask_user` returns `Unknown tool` and never opens the
interaction the probe waits for. Isolate the probe's settings directory too:
`disableFilePersistence` disables writes, not loading existing settings.

The build script emits the TypeScript tree and copies the runtime assets just as
the root build does: prompts come from `source/prompts/` and provider presets
from `source/providers/provider-presets.json`.
The production build config also explicitly includes
`source/utils/worker-cwd-preload.cts`. `workerBootstrapExecArgv` locates its
emitted `.cjs` through a URL, not a static import, so transitive compilation
alone misses it. Without that entry, built `run_code` workers fail at startup
before executing any tool, even though the CLI and provider turn can complete.

## Owner scope: dropped and deferred features

Owner decisions on 2026-11-01 narrow current parity work to everyday Bare use
(including `--lite`), control socket, Discord and SSH. Goldens stay unchanged;
mentor-only catalog entries needed by Bare remain. Shared or ambiguous settings
and dependencies stay until their consumers are traced. These scope decisions
are not permission to delete code or change the legacy CLI before the flip.

"Dropped" below means no further parity work: the inventory marks the feature
`dropped`, and no scenario has to prove it. It does not mean term2-next lacks
the code. Each dropped feature is still wired in production, as noted, and
behaves as it does today.

- **MCP servers — dropped from parity work, still wired.** The headless run
  (`app/direct-launch-headless.ts`) and the TUI (`app/direct-launch-tui.tsx`)
  connect the configured servers through `app/direct-application-mcp.ts` and
  `app/direct-mcp.ts`, which drive the source MCP manager, and offer their tools
  through `app/tool-surface.ts`. Fixing gaps against legacy would need the
  catalog binding, connection lifecycle and approval policy together.
- **Plan, pair, mentor and orchestrator profiles/modes, and
  `run_agent_workflow` — dropped from parity work.** `--profile` still selects
  any of them through `source/services/profiles/`, and the TUI's `/plan`,
  `/mentor` and `/orchestrator` commands still switch them; parity for their prompts, settings and workflow execution
  is not being checked. Bare, `--lite`, subagent `ask_orchestrator` and the
  retained mentor catalog are kept.
- **ACP — dropped from parity work, still wired.** `term2 acp` dispatches to
  `app/direct-launch-acp.ts`, with `clients/acp/` as the adapter for session
  attachment, rendering and permission/question mapping.
- **Sandbox execution — dropped from parity work, still present.** The TUI's
  `/sandbox` command and the tool surface's `allowUnsandboxed` posture
  (`app/tool-surface.ts`) remain, and `term2 serve` and `term2 acp` warn when
  the sandbox is unavailable. A real return needs shell policy in
  `source/utils/shell/sandbox/`, approval rules and the sandboxed code-host
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
  end, not per commit; no web repair work is authorized now. Deferred inventory
  entries remain incomplete and block the default flip, just like `todo`.

The traced direct control/Discord runtime uses the in-process host and direct
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
