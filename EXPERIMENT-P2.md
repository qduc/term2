# Experiment P2 — generation repetition disposition

Status: complete, uncommitted isolated TDD experiment.

## Guard contract

 - **Harm prevented:** ordinary periodic or repetitive model output must not be
   treated as proof of a runaway and terminate a productive turn.
 - **Scope:** the shared per-request `GenerationGuard` and the foreground
   `SessionStreamProcessor` path. Input admission, providers, settings, and
   every unrelated guard are out of scope.
 - **Class and owners:** repetition was a runaway-detector proxy and is no
   longer an enforcement signal. `GenerationGuard` remains the per-request
   output-containment owner; `SessionStreamProcessor` no longer owns a second
   foreground abort path.
 - **Evidence/action:** periodicity is an inconclusive proxy, so it has no
   terminal action or `unsafeToReplay` classification. Direct aggregate
   visible-output count remains conclusive containment evidence: more than
   100,000 output characters terminates with the existing
   `GenerationGuardError { code: 'output_characters', unsafeToReplay: true }`.
 - **Partial-work and recovery:** already forwarded output remains in the
   stream. A real cap trip still aborts the active request and retains the
   existing ambiguous-outcome/no-blind-replay settlement. No configuration,
   default, or persisted value changed.

## Exact diff

 - `source/services/agent-runtime/generation-guard.ts`: removed the
   4,096-character repetition options, suffix detector, repetition error codes,
   and text/reasoning aborts. Kept all explicit character caps, including the
   default 100,000-character aggregate output cap.
 - `source/services/session/session-stream-processor.ts`: removed the
   200-character/8-copy foreground repetition abort, its provider-stream abort,
   and its terminal error path.
 - `source/services/session/repetition-detector.ts`: removed the now-unused
   terminal `RepetitiveModelOutputError`; the bounded boolean detector remains
   available only as a non-enforcing diagnostic primitive.
 - `source/services/agent-runtime/generation-guard.test.ts` adds direct
   periodic-output and exact-default-cap contracts.
 - `source/services/agent-runtime/application-run-loop.test.ts` replaces the
   shared repetition-abort cases with periodic text and reasoning survival
   across 200 provider chunks and typed cap settlement through the public
   run-loop boundary.
 - `source/services/session/session-stream-processor.test.ts` replaces the
   foreground repetition-abort case with periodic-stream survival.

## Results

Red proof before production edits:

```text
NODE_ENV=test pnpm test source/services/agent-runtime/generation-guard.test.ts source/services/agent-runtime/application-run-loop.test.ts source/services/session/session-stream-processor.test.ts
FAIL 5 tests: periodic output terminated as repetitive_text or
repetitive_model_output; the 100,000-character cap test was preempted by
repetitive_text.
```

The focused green proof and final verification commands are recorded after the
implementation checks below. They cover direct GenerationGuard containment,
ApplicationRunLoop typed settlement, foreground session processing, and the
retained non-enforcing detector.

```text
NODE_ENV=test pnpm test source/services/agent-runtime/generation-guard.test.ts source/services/agent-runtime/application-run-loop.test.ts source/services/session/session-stream-processor.test.ts source/services/session/repetition-detector.test.ts
PASS 4 files, 116 tests

NODE_ENV=test pnpm test:related ./source/services/agent-runtime/generation-guard.ts ./source/services/session/session-stream-processor.ts ./source/services/session/repetition-detector.ts
PASS 103 files, 1,823 tests; 2 expected failures

NODE_ENV=test pnpm test:changed
PASS 103 files, 1,823 tests; 2 expected failures

NODE_ENV=test pnpm typecheck
PASS

pnpm exec prettier --check EXPERIMENT-P2.md source/services/agent-runtime/generation-guard.ts source/services/agent-runtime/generation-guard.test.ts source/services/agent-runtime/application-run-loop.test.ts source/services/session/session-stream-processor.ts source/services/session/session-stream-processor.test.ts source/services/session/repetition-detector.ts
PASS

NODE_ENV=test pnpm test:provider-black-box
PASS 19 files, 171 tests; 1 skipped

NODE_ENV=test pnpm test
KNOWN BASELINE FAILURE: 543 files passed, 1 failed, 1 skipped; 6,952
tests passed, 1 failed, 3 expected failures, 2 skipped. The sole failure is
source/hooks/stop-processing-probe.test.tsx:75, the pre-existing blank final
frame recorded in MORNING.md; it does not exercise either repetition owner.
```

## Success and failure criteria

Success requires all of the following:

1. Fixed-width periodic text and reasoning longer than 4,096 characters
   complete through ApplicationRunLoop, and periodic text completes through
   SessionStreamProcessor, without an abort.
2. At the default limit, 100,000 visible text characters followed by one more
   visible tool-argument character fails as `output_characters` with
   `unsafeToReplay: true` and aborts the active request.
3. No production repetition-only terminal code or error remains in either
   execution owner.

The experiment fails if a periodic stream is rejected for repetition, the
100,000-character aggregate cap ceases to have its typed settlement, or any
repetition-only path regains terminal/unsafe-to-replay behavior.

## Unresolved risks

 - A genuinely looping model may now emit until an explicit output, text, tool
   argument, deadline, or inactivity bound stops it; repetition itself is not
   sufficient evidence to terminate it.
 - `RepetitionDetector` remains an unowned non-enforcing primitive. This
   experiment deliberately adds no advisory telemetry or policy, so any future
   use must not restore a terminal inference without separate guard review.
 - This experiment uses deterministic synthetic streams. Live provider behavior
   and unrelated guards are intentionally outside its change scope.
