# SB-00 — `hooks/` cluster disposition

Status: **audit/docs — all 10 `source/services/hooks/` production files disposed.**
Evidence basis: export inventory (`grep '^export'` per file), bounded source reads of every
member, line counts (`wc -l`), and cross-references to the SB-08 hooks disposition
(HookService family local; public-hooks V1 package contract **earned and evidenced** —
`docs/plans/public-hooks-system.md` Status: Complete, closure validation 2026-08-13;
`docs/public-hooks.md` V1 documentation) and the guard ledger. No test was executed; no
claim of passing tests is made. No production source changed; no new formal contract
created; no commit or merge.

## Disposition summary (10 files)

**Already owned — SB-08 hooks disposition (HookService family + public V1 package
contract), recorded, not re-owned (9):**

| File | Ownership |
| --- | --- |
| `hook-contracts.ts` (286) | **Public V1 package contract** — `TERM2_HOOK_SCHEMA_VERSION = 1`, event names/map, `Term2Hooks` registration surface; documented by `docs/public-hooks.md` and evidenced by `public-hooks-system.md` (Complete). Not re-owned here. |
| `hook-service.ts` (179) | `HookService` composition boundary (discovery + module evaluation + registry; `HookLifecyclePort`). SB-08 HookService family, V1 package owner surface. |
| `hook-registry.ts` (255) | `HookRegistry` — ordered passive callback registry, transactional registration rollback, callback timeout guard (`DEFAULT_HOOK_CALLBACK_TIMEOUT_MS = 5_000`); guard-ledger.md:654 (constructor validation), `:657` (lifecycle/state-machine guards at `:115-181`). |
| `hook-discovery.ts` (306) | `HookDiscovery` — user/project trust policy (implicitly-trusted user, disabled-by-default project, `hooks.trustedProjectRoots` realpath check, symlink rejection, lexical order). Security-relevant trust seam of the V1 package. |
| `hook-module-loader.ts` (88) | `NativeHookModuleLoader` + `JitiHookModuleLoader` (lazy jiti, injected so the app never depends on the dev tsx runner); guard-ledger.md:659 (programmer-error helper at `:72`). |
| `hook-event-factory.ts` (61) | `HookEventFactory` — versioned envelope builder with include/redaction flags (`summarizeHookValue` bounded at 500 chars). |
| `hook-composition.ts` (33) | `createRootHookRuntime` — root-session composition; hooks stay local to Term2 in SSH/remote mode (V1 closure: "SSH hooks bind to local session"). |
| `hook-tool-lifecycle.ts` (60) | `createToolExecutionLifecyclePort` — adapts the run-loop `ToolExecutionLifecyclePort` seam to the public observational contract (before/after/error). |
| `hook-editor-shim.ts` (196) | `term2-hooks.d.ts` + `tsconfig.json` editor shim for TypeScript hooks (dev UX of the V1 package). |

**Not a seam (1):**

| File | Evidence |
| --- | --- |
| `index.ts` (33) | Public re-export barrel of `hook-contracts.ts` types. Deliberate surface control, not a seam. |

**Formal contract (0 new):** the V1 package contract was already earned
(`public-hooks-system.md` Complete) and the HookService family is the recorded SB-08
local disposition; no port was added for export alone.

## Remaining undisposed after this follow-up

SB-00 remains **open**: 1 cluster / **1 file** now undisposed at cluster level —
`queue/` (1), carrying only the partial module-level disposition recorded in the SB-00
correction record (Contract 01 `QueueController` + Contract 12 persistence). The `queue/`
row was not started in this packet.

## Gates

Prettier clean; `git diff --check` clean; worktree touch set exactly seven docs files
(correction + follow-ups 1–5 + this record). No test suite applicable. Primary protected
dirt and HANDOFF.md byte-identical.
