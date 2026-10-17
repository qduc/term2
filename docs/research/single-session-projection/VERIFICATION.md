# Independent verification

Status: **accept**. Final source hashes match the inspected and independently exercised implementation. No actionable regression found.

Scope: baseline `bd59c499` to the seven production files in `evidence/source-sha256.txt`, plus the repeated-question provider black-box scenario. The verifier did not implement production changes. All seven final source hashes independently matched (`evidence/independent-source-manifest.log`).

The source has one `TurnProjectionState` allocation per logical turn, retained through recovery, and one `#projectStream` pipeline. `source` continues to distinguish initial request, ordinary continuation and abort resolution for existing projection/recovery policy. Reset precedes retry delay and preparation so preparation failures select initial recovery. Decision binding retains projection accumulators. Removed cumulative message/item fields were forwarded through approval snapshots without a consuming result-builder read.

## Independently executed evidence

`pnpm test source/services/session/projection-independent.tmp.test.ts --reporter=verbose`: three temporary scenarios passed on final production source. The executable test was removed. Its text, output, effect records and persisted journal records are retained as `evidence/independent-runtime-probe*` and `evidence/independent-{ordinary,recovery}-*`.

The probe uses the actual `ApplicationRunLoop`, session composition, stream processor, approval flow, conversation adapter, journal and retry handlers. Only the model stream and tool definition are fixtures; tool execution and log persistence write real temporary files. Client construction is a thin adapter to the real run loop rather than the full `AgentClient` provider stack, which the built CLI scenario covers separately.

- Two manual approvals in one logical turn: exactly two filesystem effects, two distinct emitted command messages, and two journal tool results. All three reasoning segments persist and emit in order. Usage is 30 input / 6 output tokens: the last cumulative value replaces earlier values. All observed reset/decision calls use one projection object.
- A provably unsent request after the first approved effect: recovery sends the completed first result in full history, does not repeat the effect, retains one projection object across two attempt resets, preserves both command outputs and all reasoning journal deltas, and reports post-recovery request accounting as 20 / 4 tokens.
- A preparation exception after that recovery: exactly one invocation of the actual initial recovery handler, already-reset `startStream` source, one projection object, and only the first approved effect executed. This directly checks the reset ordering correction.

`pnpm exec vitest run --config vitest.provider-black-box.config.ts scripts/provider-black-box/turn-decisions.blackbox.ts --reporter=verbose`: passed independently against the final rebuilt CLI (5.96 seconds; `evidence/independent-built-cli-decisions-final.log`). It exercises two sequential questions in one turn, one result per decision on the provider wire, response chaining, question cancellation, and a successor turn. The earlier independent run against the pre-ordering build is retained separately and is not final-build evidence.

The checks would fail on duplicate tool effects/command emissions/journal results, lost reasoning, summed cumulative usage, replacement of projection identity during recovery, or continuation-policy dispatch on a post-recovery preparation failure.

## Limits

No live external-provider request was made. The temporary probe checks representative deterministic recovery and persisted journal records, not every recovery classification or save/resume path. Independently inspected final implementer logs show typecheck/build success, lint with 31 warnings and no errors, 28 static checks passing, no-unit-test policy passing, 121 integration checks passing with one skip, 31 e2e checks passing, and 204 provider black-box checks passing with one skip (24 files, 102.63 seconds; `evidence/provider.log`). No actionable regression was found in independent review or executed scenarios.
