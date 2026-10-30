# term2 rewrite skeleton

This folder holds the interfaces for a restructured term2, with no
implementations yet. It is separate from `source/`, and nothing in `source/`
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

## Checks

```sh
tsc -p rewrite/tsconfig.json         # typecheck
node rewrite/scripts/check-layers.mjs   # dependency direction
```
