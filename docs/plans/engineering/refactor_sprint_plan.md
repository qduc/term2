# Session Architecture Refactor Sprint

This document tracks the progress of the "Session Ravioli Code" refactoring sprint. The goal is to consolidate the over-decomposed turn lifecycle into a cohesive workflow and unify the persistence models.

## Phase 1: Fix Split-Brain Persistence (Risk: High)
*Goal: Establish a single source of truth for turn output recovery before modifying execution flows.*
- [x] Write characterization tests asserting JSON output of `AssistantTurnJournal` matches `ToolExecutionLedger` for success, error, tool approval, and aborted turns.
- [x] Update `InitialTurnRecoveryHandler` to read from the Journal instead of the legacy ledger.
- [x] Update `ContinuationRecoveryHandler` to read from the Journal.
- [x] Remove `ensureJournal` defensive checks; make Journal a required, stable dependency in composition.
- [x] Deprecate/Remove `ToolExecutionLedger` read paths for crash recovery.

## Phase 2: Consolidate the Runners (Risk: High)
*Goal: Unify initial and continuation execution paths into a cohesive `TurnWorkflow`.*
- [x] Design and introduce the new `TurnWorkflow` (or state machine) structure side-by-side with existing code.
- [x] Move execution logic from `InitialTurnRunner` and `InitialStreamCycle` into `TurnWorkflow`.
- [x] Move execution logic from `ContinuationDriver` and `ContinuationStreamCycle` into `TurnWorkflow`.
- [x] Run parallel tests or feature-flag tests to ensure the new workflow matches the exact mutation order of the old nanoservices.
- [x] Wire `TurnWorkflow` into the entry points, bypassing the old runners.

## Phase 3: Eliminate Outcome Type Proliferation (Risk: Medium)
*Goal: Clean up scattered state transitions and return a single, standard output contract.*
- [x] Map all scattered transition types (`auto_approve`, `fresh_start_required`, `resume`, `stale`, etc.) into the new internal state machine.
- [x] Define a single, unified output contract for the `TurnWorkflow` to return to the outside world.
- [x] Update `TurnCoordinator` to consume the new unified output contract.
- [x] Remove outdated outcome types from `turn-transition.ts` and related files.

## Phase 4: Clean up Composition Root (Risk: Low)
*Goal: Remove dead code and simplify dependency injection in `session-composition.ts`.*
- [x] Delete `TurnExecutor` and related factory classes if no longer used.
- [x] Delete legacy runner/driver files (`initial-turn-runner.ts`, `continuation-driver.ts`, etc.).
- [x] Clean up `session-composition.ts` by removing construction of unused micro-classes.
- [x] Remove the `Proxy` wrapper around `shellAutoApproval` and inject it cleanly.
- [x] Final pass over `session` directory to ensure file count and complexity are significantly reduced.
