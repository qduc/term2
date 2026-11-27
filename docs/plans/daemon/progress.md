# Singleton Daemon Progress Ledger

Tracks every step of [the singleton daemon plan](README.md), its status, key artifacts, and merge commits on `main`.

| Step | Description | Status | Artifacts / Notes | Merge Commit |
| --- | --- | --- | --- | --- |
| 0 | Goals, non-goals, threat model, "works like now" | Done | `criteria-and-threat-model.md` | `65db33e` |
| 1 | Shape (4 parts, 2 contracts) | Done | `README.md` | `65db33e` |
| 2 | Start small (session-list stream first) | Done | Implemented in Step 13 | pending PR |
| 3 | RFC-style spec governs Client API | Done | `spec/client-api.md` (v1.0 Frozen) | pending PR |
| 4 | MCP/LSP spec format + TypeScript schema + JSON Schema | Done | `src/protocol/client-api/`, `spec/client-api.schema.json` (D006) | pending PR |
| 5 | Design-then-review rounds & freeze rule | Done | Round 1 (2 reviewers, 21 blockers fixed) + Round 2/2b PASS | pending PR |
| 6 | Fix comparison criteria before Step 7 | Done | `criteria-and-threat-model.md` | `65db33e` |
| 7 | Ownership boundaries (Branch A code-blind vs Branch B code-derived) | Done | `step7-ownership-comparison.md` | `65db33e` |
| 8 | Scenario validation against chosen boundaries | Done | `step8-scenarios.md` (10/10 scenarios pass) | `65db33e` |
| 9 | Client API inventory (names & directions only) | Done | `step9-client-api-inventory.md` | `65db33e` |
| 10 | Draft RFC spec + conformance suite + review rounds | Done | `spec/*.md`, `tests/host/client-api-conformance.integration.test.ts` | pending PR |
| 11 | Sub-module zoom-ins (Host full, Web client, Runtime shallow) | Done | `zoom/host-and-runtime.md`, `zoom/web-client.md` | pending PR |
| 13 | Prototype session-list stream (web sidebar) & feed back into review | Done | `SessionIndex`, `GET /sessions/events`, BFF + web sidebar live push (17/17 browser flows pass) | pending PR |
| 12 | Recheck draft spec & freeze Client API v1.0 | Done | Frozen 2026-11-27 (D008) | pending PR |
| 14a | Daemon core (Unix socket + lifecycle + headless policy + sandbox lease fix) | Next | Depends on Step 12 | — |
| 14b | Remote `DirectConnection` over Unix socket | Pending | Depends on Step 14a | — |
| 14c | Headless client over daemon | Pending | Depends on Step 14b | — |
| 14d | TUI zoom-in + TUI client over daemon | Pending | Depends on Step 14c | — |
| 14e | Control socket, Discord (and ACP) clients over daemon | Pending | Depends on Step 14d | — |
| 14f | Default flip to daemon mode + in-process escape hatch + full verification | Pending | Depends on Step 14e | — |
