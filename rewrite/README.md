# term2 rewrite skeleton

This folder holds the interfaces for a restructured term2 and its production
composition. The earlier native-engine example lives in a separate fixture
directory so its toy facts and restart behavior cannot define canonical
session persistence. It is separate from `source/`, and nothing in `source/`
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
  with a serializable `TurnCheckpoint`. The native tracer fixture may inspect
  that value, but canonical sessions never resume native checkpoints after a
  process restart.
- **Names are jobs.** No layer is called service, adapter or orchestrator.

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

The layer guard follows imports from `src/<layer>/adopted/` into `source/` and
checks every reached source layer against the table above. Existing dependency
edges within `source/` that cross those rules are recorded one edge per line in
`scripts/source-edge-allowlist.json`; the guard rejects newly added edges and
prints stale entries for cleanup. It also reports reached source files missing
from the map. Only adopted adapters may import `source/`, and `source/` cannot
import from `rewrite/`.

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
node rewrite/scripts/build.mjs                         # production build
pnpm exec tsx rewrite/bench/c1-adopted-approval.mts   # real adopted approval and canonical replay
pnpm exec tsx rewrite/bench/c1-adopted-kill.mts       # parked approval process-kill recovery
pnpm exec tsc -p rewrite/tsconfig.native-tracer.json && node rewrite/bench-dist/rewrite/bench/native-tracer/tracer.js
```

The build script emits the TypeScript tree and copies the runtime assets just as
the root build does: prompts come from `source/prompts/` and provider presets
from `source/providers/provider-presets.json`.

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
