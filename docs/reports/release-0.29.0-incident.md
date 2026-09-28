# Release 0.29.0 — status and publish visibility

Status: release prepared and tagged; the publish workflow returned a 2xx from the
registry, but 0.29.0 is not yet visible on npm's read surface. Written 2026-09-28.

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

## Publish visibility: read paths lag, write returned 2xx

The registry does not expose `0.29.0`, ~8 minutes after the workflow's publish
step reported success:

- `npm view @qduc/term2@0.29.0 version` → 404 (also with a fresh `--cache` dir).
- `curl https://registry.npmjs.org/@qduc/term2/0.29.0` → 404; the tarball
  `/-/term2-0.29.0.tgz` → 404; the body reads `"version not found: 0.29.0"`.
  Controls at `0.28.0` return 200 (tarball 2.8 MB).
- Packument: `_rev` 50-3e77490c, version count 50, last three
  `0.26.1, 0.27.0, 0.28.0`, `dist-tags.latest` = `0.28.0`,
  `last-modified` = the `0.28.0` publish (`2026-09-27T09:45:24Z`).
- Provenance: `/-/npm/v1/attestations/@qduc/term2@0.29.0` → 404;
  `@0.28.0` → 200 with two attestations.
- The publish step log has no error, OTP, 403, or authorization line after the
  success message.

### What the "stale sandbox" reading got wrong

A stale local view is ruled out: the packument fetched with a cache-busting
query parameter returns `cf-cache-status: MISS` (Cloudflare went to origin) yet
the identical document, and `/-/v1/search?text=typescript` returns packages
published minutes before the query, so this read path is current.

But the argument that "unpkg and jsdelivr agree" carried no weight: unpkg and
jsDelivr both proxy `registry.npmjs.org`, and npmmirror syncs from it, so every
sampled path is downstream of npm's own read API. A `replicate.npmjs.com` probe
was discarded — it returns 404 for `react` too, so that endpoint is dead and its
404 for `@qduc/term2` meant nothing.

### What the success line proves

pnpm 11.7.0's bundled `dist/pnpm.mjs` is decisive: `✅ Published package <name>@<version>`
is emitted only inside `if (response.ok)`, where `response` is the raw
`libnpmpublish` result of the publish `PUT` to the registry. Any non-2xx throws
`createFailedToPublishError` before that line; the OIDC token exchange also
logged `200`. So the registry answered the publish `PUT` with 2xx.

### Reading

A 2xx write response plus a read path that has not yet surfaced the version is
the signature of npm holding a newly published version back from its read
surface, not of a lost publish. No action is required: the version is expected
to appear once read propagation catches up, and waiting for that is the only
step needed.

If it never appears, the fallback is to confirm from outside this sandbox with
`npm view @qduc/term2 version`, then re-dispatch the publish workflow
(`workflow_dispatch` is the documented retry path) and inspect npm's HTTP
response. Constraints while unresolved: do not retag, do not move `v0.29.0`, do
not create a `0.29.1` to route around it. The version stays `0.29.0`.

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

- The stray untracked `14-29` file (0 bytes, from a mistyped shell redirect) has
  been removed; the working tree is clean.
