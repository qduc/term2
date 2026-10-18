# Agent assembly comparison

This is a disposable composition experiment, not a replacement Term2 runtime.
Both candidates use the same deterministic model, echo tool, loop, and pieces.
The independent variable is composition: Awilix scopes versus Fastify plugins.

## Human decisions

- Keep the model–tool loop fixed; make product features optional.
- Assemble services separately because multiple pieces may share them.
- Resolve declared dependencies automatically; choose implementations in configuration.
- Pieces may expose extension hooks for other pieces.
- Configuration controls hook order.
- Missing required dependencies prevent startup.
- Hooks may deny execution, rewrite arguments, or replace execution with a cached result.
- Different agents may have different assemblies.

## Observable acceptance criteria

1. Approved main: rewrite ` hello ` to `HELLO`, approve that exact invocation,
   return `cached:HELLO`, and dispatch no physical echo operation.
2. Order change: move cache before rewrite; expect a cache miss and
   `executed:HELLO`. Handler traces follow configured order.
3. Denial: return `Denied`, with no physical dispatch.
4. Cancellation during approval: return `cancelled`, close the interaction,
   tool, step and run lifecycles, and dispatch no tool afterward.
5. Memory: save input through memory's own beforeSave extension point. A separate
   redaction piece turns `secret=token` into `secret=[redacted]` in the real file.
   A subsequent run reads that saved context before replacing it.
6. Main and peer use the identical storage instance and separate memory instances;
   explorer has neither memory nor storage. Their persisted keys are independent.
7. Missing memory storage binding rejects startup before a model request.
8. Configuration can select `alternate` storage without editing a piece or loop.
9. Reversing memory/redact installation order probes automatic dependency
   resolution. Record unsupported behavior as a candidate limitation, not a pass.
10. Invalid hook order, unknown pieces and dangling plugin dependencies reject startup.

Run the CLI as the public workflow and inspect its JSON artifacts and actual
stored files. Use temporary independent assertions rather than committed unit tests.
Exercise interactive approval through the CLI as well as scripted scenarios.

## Scope and risks

The cache is deliberately pre-seeded and exact-key. The model is scripted, returns
whole responses, and the tool performs no external effect. This experiment does
not establish production streaming, retry safety, compaction, provider continuity,
parallel execution, crash consistency, untrusted-plugin isolation or production
Term2 compatibility. The filesystem store is for sequential demo runs, not
concurrent writes to one key. Hooks are trusted in-process code.

Piece catalogs are static imports in both adapters. Installing a brand-new piece
still requires catalog registration; there is no dynamic package discovery.
Agent-specific model and tool selection is not configurable in this slice.

## Verification plan

Run both CLIs, inspect retained traces/files, typecheck the standalone package and
Term2, run repository lint, and obtain independent inspection and execution.
Production provider black-box tests do not exercise these standalone prototypes.
Human suitability remains a decision after trying the assemblies, not an automated claim.
