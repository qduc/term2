# BDV pilot: approval call binding

This pilot links a frozen behavior claim to a retained integration probe and a machine-readable evidence ledger. It does not change product behavior or replace existing tests.

## Run

```sh
pnpm bdv approval-call-binding
```

The runner executes the selected Vitest integration case, compares the reported test and file counts with the fixed acceptance counts in [`claims.json`](claims.json), and appends the command, exit code, elapsed time, commit, SHA-256 digests of the claim/probe/runner, result counts, output digest, and output to [`evidence.jsonl`](evidence.jsonl). A later reviewer can verify the contract and artifacts, inspect the probe assertions, compare their hashes, and rerun the command.

## Independence and limits

Acceptance is a fixed contract that the runner does not generate from the observed output. It expresses the approval rule as externally observable outcomes: only the allowed file is created, the denied target survives, each tool call receives its own decision, and the provider sees paired calls and results. The probe crosses the built CLI, a loopback HTTP provider fixture, and isolated filesystem effects. Hashes expose changes to the contract or probe between recorded runs.

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
