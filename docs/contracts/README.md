# Seam contracts — Phase 1 of ROADMAP.md

Status: **completed and owner-reviewed 2026-08-14.** Records were verified
against production source at `75d2ec249f8e4a30529a3368da31294c60a85a4b`
with the Phase 1 test-only characterizations in the working tree.

These are the executable seam contracts required by
[`ROADMAP.md`](../../ROADMAP.md) Phase 1 — "Define executable seam contracts".
They are durable ownership records, not implementation plans: each names the
invariants, owners, boundary-crossing state, settlement semantics,
observability, public test boundary, and verification commands for one
cross-owner seam. They do not propose architecture work; repairs happen only in
Phase 2 and only on a red proof through an owning public boundary.

## Index

| # | Contract record | Owners (enforcement / recovery) | Focused verification command |
| --- | --- | --- | --- |
| 01 | [Conversation submission and turn lifecycle](./01-conversation-submission-and-turn-lifecycle.md) | `QueueController`, `ConversationAdapter`, `TurnCoordinator` + `TurnStatusMachine`, `ApplicationRunLoop` steer admission, `ConversationOrchestrator` projection | 10 files, 340 tests — green 2026-08-14 |
| 02 | [Provider input, continuity, and effect settlement](./02-provider-input-continuity-and-effect-settlement.md) | `ToolExecutionLedger` + history projection, `ProviderContinuity`, `SessionInputPlanner`, `ChainedInputFilter`, `SessionStreamProcessor`, retry/recovery policy | 14 files, 355 tests — green 2026-08-14 |
| 03 | [Child-run identity, authority, and lifecycle](./03-child-run-identity-authority-and-lifecycle.md) | `createSubagentRuntime` runners, `SubagentBridge`, session traffic context | 12 files, 262 tests — green 2026-08-14 |
| 04 | [Settings consumption](./04-settings-consumption.md) | Settings schema/resolution, runtime consumers, `ConversationConfigurationService` + `runtime-setting-router`, `/settings` | 14 files, 303 tests — green 2026-08-14 |
| 05 | [Runtime guards and retention](./05-runtime-guards-and-retention.md) | Guard owners per `docs/plans/guard-ledger.md` and linked owner plans | 26 files, 423 passing tests — 2026-08-14; the retained expected-failure characterization became two passing tests when Phase 2 repaired it on 2026-08-15 |

All focused commands re-ran with exit code 0 on 2026-08-14 (76 file
invocations / 1,683 passing test invocations plus one retained expected-failure
characterization). The authoritative Phase 0 baseline
(`docs/plans/validation-baseline-2026-08-14.md`) now records these commands and
results, alongside its full-suite, typecheck, lint, and provider black-box
results for the same production-source commit. Phase 1 added tests but made no
production changes, so those broader results remain the truthful recorded
source baseline. Contract 05's expected-failure proof queued the
watchdog-fallback defect for Phase 2; that repair merged on 2026-08-15 and the
proof is now two passing tests. See §10 of that record for the approved
deferral covering the residual ambiguous case.

## How to read a record

Every record follows the same template (the eight required elements from
ROADMAP Phase 1):

1. **Contract** — invariants, each paired with the user-visible harm it prevents.
2. **Owners** — enforcement owner and recovery owner per invariant.
3. **Execution paths** — every path that shares the invariant.
4. **Identities and state crossing the boundary.**
5. **Settlement semantics** — success, failure, cancellation, retry, ambiguous.
6. **Observability** — logs/events that diagnose a violation.
7. **Public boundary under test** — the interface through which the contract is
   tested deterministically.
8. **Deterministic contract matrix** — the ROADMAP minimum-matrix cells mapped
   to exact test evidence (`file:line` + test title) or classified gaps.
9. **Verification commands** — focused command (recorded result) and broader
   gates.
10. **Known gaps and classification** — every gap is classified per ROADMAP rule
    4; only product defects proceed to Phase 2.

## Failure classification legend

Per ROADMAP "Working rules" item 4, every discovered failure is one of:

- **product defect** — production behavior violates a contract (Phase 2 repair);
- **test defect** — the test or verification command is wrong;
- **fixture defect** — wire fixtures or recorded traffic are wrong;
- **dependency defect** — a third-party behavior;
- **environment limitation** — sandbox/PTY/network/Node behavior outside the app;
- **known baseline** — already recorded in the Phase 0 baseline.

A **coverage gap** (matrix cell with no deterministic test) is not by itself a
product defect: current behavior may be correct but uncharacterized. It is
listed with the exact public-boundary test that must be written to turn it into
a red/green characterization before any Phase 2 repair.

## Historical baseline correction found during Phase 1

On 2026-08-14, Phase 1 verification found that the original Phase 0 focused
commands for Seams 2, 3, and 4 referenced test files that do not exist in this
checkout:

| Seam | Nonexistent path(s) in baseline command | Verified effect (2026-08-14 re-run) |
| --- | --- | --- |
| 2 | `source/services/context-compaction/provider-neutral-compactor.test.ts`, `source/lib/session-input-planner.test.ts` | Vitest silently ran only the 4 existing files / 139 tests; baseline recorded "6 files / 172 tests" |
| 3 | `source/services/subagents/runtime.test.ts`, `source/services/subagents/subagent-bridge.test.ts`, `source/services/subagents/subagent-event-bus.test.ts` | Vitest silently ran only 2 existing files / 106 tests; baseline recorded "5 files / 91 tests" |
| 4 | `source/services/settings/settings-manager.test.ts`, `source/services/settings/settings-store.test.ts` | Vitest silently ran only 1 existing file / 26 tests; baseline recorded "3 files / 44 tests" |

**Classification: test defect in the baseline record (not a product defect).**
The real test files exist under the corrected paths (see each record's
"Verification commands"); the current implementation was green under the
corrected commands. The authoritative baseline has been corrected to use those
commands and results; it retains this table as the dated history of the
test-record defect. Seam 1 and Seam 5 were also expanded from valid but
under-covered original commands to their full contract-owner verification.

## Update rules

- Any production change to an owner listed in a record must re-run that
  record's focused command (`NODE_ENV=test`) during development.
- Provider, bridge, run loop, registry, and non-interactive changes must also
  run `NODE_ENV=test pnpm test:provider-black-box` per `AGENTS.md`.
- A contract change (invariant added/removed/weakened) requires updating the
  owning record, re-running the matrix, and recording the outcome in the
  verification section — this is the Phase 3 institutionalized workflow.
