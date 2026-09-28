# Release 0.29.0 — status and unresolved publish discrepancy

Status: release prepared and tagged; npm publish reported success but is not
visible in the registry. Unresolved. Written 2026-09-28.

## Verified state

- Release commit `d64eed1f` `chore(release): v0.29.0` is on `main` and pushed.
- Tag `v0.29.0` → `d64eed1f`, pushed to `origin`.
- Follow-up commit `a6e0d7d3` `test: pin release-gate assertions to controlled fixtures`
  is on `main` and pushed.
- `package.json` version is `0.29.0` at HEAD.
- `git diff d64eed1f..a6e0d7d3` is only the two test files from `a6e0d7d3`; no
  product source changed. The publishable artifact is therefore identical.

## CI results

| Run | Commit / ref | Result |
| --- | --- | --- |
| `36441607603` CI | `d64eed1f` (main push) | **failed** — `test` and `provider-black-box` jobs |
| `36441612700` Publish | tag `v0.29.0` | **failed** — stopped at `Run tests` |
| `36443233063` CI | `a6e0d7d3` | success (includes the black-box tier) |
| `36443845022` Publish | `a6e0d7d3` via `workflow_dispatch` | workflow **success**; step `Publish package` logged `✅ Published package @qduc/term2@0.29.0` |

## Unresolved: publish success claimed, version absent

The registry does not expose `0.29.0`:

- `npm view @qduc/term2@0.29.0 version` → 404 (also with a fresh `--cache` dir).
- `curl https://registry.npmjs.org/@qduc/term2/0.29.0` → 404, four samples over ~60s.
- Packument: `_rev` 50, version count 50, last three `0.26.1, 0.27.0, 0.28.0`,
  `dist-tags.latest` = `0.28.0`.
- unpkg and jsdelivr: `0.28.0` → 200, `0.29.0` → 404.
- The publish step log has no error, OTP, 403, or authorization line after the
  success message.

Two readings, not yet distinguished:

1. The publish did not actually take effect despite pnpm printing success.
2. This sandbox's network path serves a stale registry view.

Note for reading 2: earlier in the same session these same commands returned
accurate data (`latest` = `0.28.0`), so staleness would have had to begin after
that point. Reading 2 also has to explain the unpkg/jsdelivr agreement.

Next step: verify from outside this sandbox (on a normal machine,
`npm view @qduc/term2 version`), or re-dispatch the publish workflow and inspect
npm's HTTP response.

Constraints while unresolved: do not retag, do not move `v0.29.0`, do not create
a `0.29.1` to route around it. The version stays `0.29.0`.

## Root causes of the CI failures

Both are regressions this release introduced, invisible until the push because
the commits were local-only and had never run CI.

1. `source/agent.test.ts` asserted the guidance sentence
   `Global memories are listed in your instructions`, which
   `memory-capabilities.ts` emits only when a global memory store exists. The
   test never pinned `memory.directory`, so it read the developer's real store:
   green on a machine with memories, red on a clean runner. Reproduced exactly
   with `XDG_DATA_HOME=<empty>`. Fixed by asserting the unconditional sentence
   `Treat summaries as leads, not authoritative facts.`; the conditional wording
   remains covered by `memory-capabilities.test.ts`, which does pin its directory.
2. `scripts/provider-black-box/provider-contract.test.ts` still compared whole
   `text_delta` events after `8306e53e` added an optional `partId` to the
   contract. `partId` is fixture-specific (Anthropic carries its content-block
   index `'1'`; a Responses fixture with no `item_id` carries none), so no single
   expected object fits every provider case. Fixed by comparing the delivered
   text at both sites; part identity stays pinned by the provider unit tests.

Triage note: `pnpm test:provider-black-box` runs with `--bail=1` and reveals
these one at a time. `pnpm exec vitest run --config vitest.provider-black-box.config.ts <file>`
gives the full failure list in one pass.

## Local verification at `a6e0d7d3`

typecheck ✓ · eslint `source` ✓ (0 errors) · prettier ✓ · build ✓ · unit 676/676
files (9214 passed) · integration 12/13 (106 passed) · provider black-box 20/20
files (178 passed) · contract file 26/26.

## Housekeeping

- `14-29` (0 bytes) at the repo root is untracked and came from a mistyped shell
  redirect. It is not referenced by any process; safe to delete.
