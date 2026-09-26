# Assignment: build the controlled approval replay harness

Run ID: `jev-auth-replay-20260919`
Task ID: `replay-harness`
Worker: `harness-terra`
Return-only sink: your own Herdr pane; finish with the exact marker `TASK_COMPLETE replay-harness` or `TASK_BLOCKED replay-harness`.

## Goal

Build a reproducible, append-only replay harness for the production approval-shadow cases. It must isolate two interventions on the same cases:

- Context: exact production compact context vs reconstructed fuller conversation context.
- Authorization rubric: current Jev direct/necessary-step rubric vs a reviewer-aligned in-scope-normal-step rubric derived faithfully from the production reviewer prompt.

This yields four cells per case. The harness must also support a frozen independent ambiguity label supplied later, but you do not perform that adjudication.

## Ownership and authority

- You own only `/home/qduc/term2/docs/research/jev-approval-replay/replay/`.
- Do not modify source, settings, tests, existing experiment artifacts, or reconstruction output.
- You may inspect the existing Jev experiment infrastructure and source implementation.
- Do not make any live provider request in this assignment. Build and locally validate with fixtures/dry-run only.
- Never print, copy, or persist API keys.

## Required deliverables

Create:

1. `runner.py`: consumes the reconstruction JSONL, selects the prespecified target cohort (human reviewer approved, Jev production authorization `weak` or `unknown`, unique join), materializes the four cells, calls the pinned OpenRouter Decisions endpoint only with an explicit `--go`, appends one immutable result per attempted cell, captures resolved model/usage/errors, and never retries over a recorded failure.
2. `analyze.py`: paired per-case analysis of authorization upgrades and final approval changes. Report context-only effect, rubric-only effect, interaction, exact paired denominators, bootstrap or exact paired uncertainty, and a decision rule that distinguishes:
   - missing/truncated context as dominant;
   - rubric interpretation as dominant;
   - genuine ambiguity as dominant after independent adjudication;
   - mixed/inconclusive.
3. `protocol.md`: preregister the cohort, four payloads, endpoints/model pin, primary outcome, ambiguity adjudication input schema, thresholds, failure handling, exclusions, and limitations. The rubric intervention must change only rubric wording; the context intervention must change only context.
4. `fixtures/` plus `verify.py`: deterministic tests proving cell isolation, append-only/idempotent behavior, no-call dry run, and correct paired calculations.
5. `receipt.json`: run/task/worker, artifact paths/digests, verification argv copied exactly, declared children `[]`, unresolved risks.

Relevant references:

- `/home/qduc/term2/source/services/approval/decision-shadow.ts`
- `/home/qduc/term2/source/prompts/shell-auto-approval.ts`
- `/home/qduc/term2/source/providers/openrouter-decisions.ts`
- `/home/qduc/term2/docs/research/jev-experiments/infra/runner.py`
- `/home/qduc/term2/docs/research/jev-experiment-protocol.md`

Pin subject model `typesafe/jev-1.13`. Preserve the response-resolved model. Estimate and enforce at most four calls per selected case; refuse more than 380 calls unless explicitly overridden in code and CLI.

## Verification

Coordinator-supplied verification argv (copy exactly into `receipt.json`):

`["python3","/home/qduc/term2/docs/research/jev-approval-replay/replay/verify.py"]`

## Completion report

State artifact paths, SHA-256 digests, verification command/result, dry-run call count on fixtures, declared children, unresolved risks; then emit the exact completion marker.
