# BDV pilot: approval call binding

This pilot links a frozen behavior claim to a retained integration probe and a machine-readable evidence ledger. It does not change product behavior or replace existing tests.

## Run

```sh
pnpm bdv approval-call-binding
```

The runner requires a clean checkout (the evidence ledger itself may already contain earlier runs) and checks that the probe matches the digest frozen in [`claims.json`](claims.json). It then runs Vitest's JSON reporter with a 120-second process timeout and requires each of the four exact scenario names to appear exactly once with `passed` status. Aggregate counts or earlier console text cannot produce a passing verdict.

Before and after the probe, it records the commit and hashes the claim, probe, and runner. It rejects dirty executable inputs and any change to those hashes or `HEAD` during execution. The appended ledger entry includes before/after input hashes, the command, timeout and exit status, exact scenario results, result digest, elapsed time, output digest, and normalized output. This makes the observed result checkable against the committed contract and probe.

## Independence and limits

Acceptance is a fixed contract that the runner does not generate from the observed output. It expresses the approval rule as externally observable outcomes: only the allowed file is created, the denied target survives, each tool call receives its own decision, and the provider sees paired calls and results. The probe crosses the built CLI, a loopback HTTP provider fixture, and isolated filesystem effects. Its approved source digest and exact scenario names bind the runner to the reviewed probe; changes require an explicit contract update.

This is one claim and one probe, not a general probe scheduler. The claim contract and its probe are maintained in the same repository, so hashes establish provenance and change detection, not independent authorship. An independent reviewer has not yet challenged this pilot contract. It does not yet enforce independent contract approval, compare costs across broad test suites, or show that passing the selected scenarios proves all approval paths safe.

## Baseline and pilot result

Baseline at `d93142ea` (before the runner), using the same probe directly:

```text
pnpm exec vitest run --reporter=minimal --config vitest.integration.config.ts source/cli.integration.test.ts -t 'an approved shell call does not approve a later call'
Test Files  1 passed (1)
Tests       4 passed | 30 skipped (34)
Duration    2.60s
```

The baseline establishes repeatability and elapsed test time only; it is not a full-project defect-detection or cost comparison. The pilot evidence record is appended when `pnpm bdv approval-call-binding` runs.

The first runner execution result and elapsed time are captured in the evidence ledger. Compare them with the baseline as a one-run observation only; this pilot does not establish a performance trend.
