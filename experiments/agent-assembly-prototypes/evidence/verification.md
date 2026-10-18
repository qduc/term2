# Verification record

Verified on 2026-10-18 as a bounded prototype comparison. No production Term2 source,
provider, settings, persistence or tool-execution path changed.

## Claims and evidence

- The same fixed loop runs both assemblies: `results.jsonl`, `demo.log`, and the
  independent CLI traces show the shared model–tool workflow through both hosts.
- Configuration controls hook order and service implementation: author order
  assertions and independent alternate-storage artifacts exercise actual CLI input.
- Denial/cancellation prevent dispatch in the exercised approval path:
  `author-checks.log` and independent traces check absence of dispatch and balanced
  lifecycle boundaries. Cancellation before dispatch ends the tool as cancelled.
- Memory redaction, saved context reuse, and agent isolation: real files plus the
  independent extension probe verify redacted storage, subsequent model context,
  identical shared storage and distinct memory instances.
- New pieces extend plugin-owned hooks without core edits: independent external
  catalog stamp piece, raw probe source and results retained by the verifier.
- Missing dependencies and malformed hook orders reject assembly before model
  invocation: independent CLI and structured-artifact checks. The observational
  demo exits zero for these scenarios; process exit alone is not a pass criterion.
- Awilix resolves reversed piece installation order; this Fastify prototype rejects
  it: recorded dependency-order scenarios. Fastify is not claimed to meet that requirement.
- Storage failure paths: independent injected read/write failures produce failed
  reports and close the run lifecycle.
- Actual terminal approval: both backends were driven through a PTY. Author
  entered y in both; independent verifier also exercised a denial in Fastify.

## Executed checks

- Standalone `pnpm typecheck`: exit 0, `prototype-typecheck.log`.
- Repository `pnpm typecheck`: exit 0, `root-typecheck.log`.
- Repository `pnpm lint`: exit 0, `root-lint.log`; 31 warnings from unchanged
  production files, no ESLint errors, formatting passed.
- Repository `pnpm check:no-unit-tests`: exit 0, `no-unit-tests.log`.
- `git diff --check`: exit 0.
- Independent verdict: accept the bounded comparison, `independent-review.md`.

The standalone package has its own lockfile/workspace and dependencies. The root
lint override includes its TypeScript project; machine-generated evidence is
excluded from formatting so recorded bytes survive commits.

## Uncertain

Human assessment of assembly ergonomics; real provider streaming and continuity;
compaction/retries; parallel dispatch; physical stop evidence; crash consistency;
concurrent writes; untrusted-plugin behavior; plugin resource disposal; production
Term2 integration. No production provider suite was run: it does not execute these
standalone prototypes. These are not a newly shipped orchestration skill, and
ordinary API exercise is not presented as full orchestration real-use verification.

Design friction: Fastify requires prerequisite-first registration and a fixed boot
tree in this adapter. Kept visible as comparison evidence rather than adding a
custom dependency sorter or dynamic-host layer.
