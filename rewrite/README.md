# term2 rewrite skeleton

This folder holds the interfaces for a restructured term2, plus a tracer
bullet: the thinnest implementation of each layer, wired end to end to prove
the structure holds. It is separate from `source/`, and nothing in `source/`
imports it.

## Layers

Each folder in `src/` is one layer, named after its job. A layer may only use
the layers listed after its name, so dependencies always point down.

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
  all projections of it, so there is no second journal to keep in sync.
- **One projection.** `protocol/` turns session updates into `WireEvent`s
  once. The TUI uses the same protocol as the web client, through the
  in-process host, so no client keeps its own event translator.
- **The engine suspends instead of calling up.** An approval ends the turn run
  with a serializable `TurnCheckpoint`; `Engine.resume` continues it. The same
  checkpoint, saved at each tool-call boundary, lets `SessionStore.open`
  resume a turn after a crash when the pending tools are idempotent.
- **Names are jobs.** No layer is called service, adapter or orchestrator.

## Tracer bullet

Each layer has one thin implementation: a scripted model (`model/scripted.ts`),
two note tools (`tools/notes.ts`, one read-only and idempotent, one write that
asks first), the turn loop (`engine/loop.ts`), a JSONL-backed session
(`session/local-store.ts`), the projection both ways (`protocol/`), an
in-process host and a headless client. `app/tracer.ts` drives three scenarios
through all of them:

1. **An approval survives a restart.** The session is dropped while waiting
   for approval, reopened from its log, approved, and the turn completes.
2. **A crash during an idempotent tool resumes.** A child process is
   `SIGKILL`ed inside `read_note`. Reopening resumes from the last checkpoint,
   re-runs the read, and commits its result once.
3. **A crash during an approved write is interrupted.** A child is killed
   inside `write_note`. Reopening marks the turn interrupted and offers a
   retry instead of replaying the write.

What building it changed in the interfaces:

- `TurnInput` held live `Tool` objects and a settings reader, so a
  `TurnCheckpoint` could not be persisted. It now carries tool names and the
  workspace, and live dependencies go in once through `EngineDeps`.
- The host built user `Item`s from wire commands, which the layer check
  rejected (`host/` may not import `model/`). Inbound command handling moved
  to `protocol/commands.ts`, so the protocol owns both directions.
- `HostDeps` gained `resolveWorkspace` and `defaultModel`; creating a session
  needs both and the host had neither.

Known gaps, left out on purpose: no input queue (a busy session refuses), no
compaction, progress events are buffered until a tool returns, an idempotent
tool that needs approval is asked again after a crash, and each checkpoint
stores the full turn input.

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

```sh
node rewrite/parity/inventory.mjs
node rewrite/parity/run.mjs check --cli dist/cli.js          # old CLI: must stay green
node rewrite/parity/run.mjs check --cli <new build>/cli.js   # new CLI: the port's progress
node rewrite/parity/run.mjs record --cli dist/cli.js <id>    # new scenario, from the old CLI only
TERM2_TEST_CLI=<new build>/cli.js pnpm test:integration      # CLI-level suite against any build
```

## Checks

These use the root `node_modules` (for `@types/node` and `tsc`), so run
`pnpm install` at the repository root first.

```sh
pnpm exec tsc -p rewrite/tsconfig.json                 # typecheck
node rewrite/scripts/check-layers.mjs                  # dependency direction
pnpm exec tsc -p rewrite/tsconfig.build.json && node rewrite/dist/app/tracer.js
```
