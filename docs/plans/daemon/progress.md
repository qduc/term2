# Singleton Daemon Progress Ledger

Tracks every step of [the singleton daemon plan](README.md), its status, key artifacts, and merge commits on `main`.

| Step | Description | Status | Artifacts / Notes | Merge Commit |
| --- | --- | --- | --- | --- |
| 0 | Goals, non-goals, threat model, "works like now" | Done | `criteria-and-threat-model.md` | pending PR |
| 1 | Shape (4 parts, 2 contracts) | Done | `README.md` | pending PR |
| 2 | Start small (session-list stream first) | Planned | First concrete slice in Step 13 | — |
| 3 | RFC-style spec governs Client API | Planned | Spec drafted in Step 10 | — |
| 4 | MCP/LSP spec format + `@qduc/agent-wire` schema + JSON Schema | Planned | Drafted in Step 10 | — |
| 5 | Design-then-review rounds & freeze rule | Planned | Applied in Steps 10–12 | — |
| 6 | Fix comparison criteria before Step 7 | Done | `criteria-and-threat-model.md` | pending PR |
| 7 | Ownership boundaries (Branch A code-blind vs Branch B code-derived) | In progress | Independent subagents launching | — |
| 8 | Scenario validation against chosen boundaries | Pending | Depends on Step 7 | — |
| 9 | Client API inventory (names & directions only) | Pending | Depends on Step 8 | — |
| 10 | Draft RFC spec + conformance suite + review rounds | Pending | Depends on Step 9 | — |
| 11 | Sub-module zoom-ins (Host full, Web client, Runtime shallow) | Pending | Depends on Step 10 | — |
| 13 | Prototype session-list stream (web sidebar) & feed back into review | Pending | Runs before Step 12 freeze (D002) | — |
| 12 | Recheck draft spec & freeze Client API v1/v3 | Pending | Depends on Steps 10, 11, 13 | — |
| 14a | Daemon core (`term2 serve` / Unix socket + HTTP+SSE + lifecycle) | Pending | Depends on Step 12 | — |
| 14b | Remote `DirectConnection` over Unix socket | Pending | Depends on Step 14a | — |
| 14c | Headless client over daemon | Pending | Depends on Step 14b | — |
| 14d | TUI zoom-in + TUI client over daemon | Pending | Depends on Step 14c | — |
| 14e | Control socket, Discord (and ACP) clients over daemon | Pending | Depends on Step 14d | — |
| 14f | Default flip to daemon mode + in-process escape hatch + full verification | Pending | Depends on Step 14e | — |
