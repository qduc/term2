# Lens report: dependencies
Codebase: /Users/qduc/src/term2  |  Scope: whole repo (package.json + source/)  |  Date: 2026-08-01

## Summary
The old `@openai/agents*` SDK is fully gone from `package.json`, `pnpm-lock.yaml`, and `source/` — the decoupling migration claimed in `docs/plans/decouple-from-openai-agents-sdk.md` checks out. However, the manifest carries real rot: two dead build-tooling devDependencies (`@babel/cli`, `@babel/preset-react`, `import-jsx`), three orphaned `@types/*` packages left over from a pre-extraction web-fetch implementation, one hand-rolled `deepEqual` duplicating an already-declared `fast-deep-equal`, one wholly unused runtime dependency (`fast-glob`), and a systematic one-major-version staleness across almost the entire AI-provider stack (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/provider`, `@openrouter/ai-sdk-provider`, `openai`) plus a security-relevant sandbox package hard-pinned 11 patches behind. None of this is exotic — it's ordinary manifest drift, but the AI-stack staleness overlaps directly with the open "uninvestigated hang in the openai provider" item noted in AGENTS.md.

## Findings

### F-dependencies-001: `fast-glob` is a declared runtime dependency with zero imports anywhere in the repo
- **Severity**: low
- **Confidence**: high
- **Location**: package.json:79 (`"fast-glob": "^3.3.2"`); only other repo hit is a comment at source/services/file-service.ts:44
- **Claim**: `fast-glob` is never imported by any source, script, or test file; the only textual match in the codebase is a comment referencing "the previous fast-glob behavior," implying it was replaced and the dependency was never removed.
- **Evidence**: `grep -rn "fast-glob" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.mjs" --include="*.json" .` (excluding node_modules/.git/dist) returns exactly two hits: the package.json declaration and the comment in file-service.ts. No `import ... from 'fast-glob'` or `require('fast-glob')` exists.
- **Verify by**: `grep -rn "fast-glob" --include="*.ts" --include="*.tsx" source/ scripts/ tools/` — confirm no import statement; then `pnpm remove fast-glob` in a scratch branch and run `pnpm typecheck && pnpm test` to confirm nothing breaks.
- **Invariant impact**: none (no invariants.md present at audit/invariants.md — file does not exist in this checkout; see Blocked).

### F-dependencies-002: `@babel/cli`, `@babel/preset-react`, and `import-jsx` are dead devDependencies with no config or import referencing them
- **Severity**: low
- **Confidence**: high
- **Location**: package.json:95-96 (`@babel/cli`, `@babel/preset-react`), package.json:114 (`import-jsx`)
- **Claim**: None of these three packages are referenced by any babel config file (none exists in the repo), any npm script, or any import statement — the project's actual build/test toolchain is `tsc` (`tsconfig.build.json`) and `vitest`, not babel or `import-jsx`.
- **Evidence**: `find . -maxdepth 2 -iname "*babel*"` (excluding node_modules/.git) returns nothing; `grep -rn "babel" package.json vitest.config.* tsconfig*.json` only matches the two package.json dependency lines themselves; `grep -rn "import-jsx" .` (excluding node_modules/.git/dist) matches only its own package.json declaration.
- **Verify by**: confirm no `.babelrc`/`babel.config.*` file exists; confirm `pnpm build`/`pnpm test` scripts (package.json:41-56) never invoke babel or import-jsx; then try removing all three and re-running `pnpm typecheck && pnpm build && pnpm test`.
- **Invariant impact**: none.

### F-dependencies-003: `@types/jsdom`, `@types/mozilla-readability`, `@types/turndown` are orphaned type packages — their runtime counterparts (`jsdom`, `mozilla-readability`/`@mozilla/readability`, `turndown`) are not dependencies at all, and none are used in source
- **Severity**: low
- **Confidence**: high
- **Location**: package.json:100-101, 105 (`@types/jsdom`, `@types/mozilla-readability`, `@types/turndown`)
- **Claim**: These three `@types/*` devDependencies have no corresponding runtime package anywhere in `package.json`, and zero usages of `jsdom`, `turndown`, or `Readability`/`mozilla-readability` exist in `source/` or `scripts/`. This strongly suggests they are leftovers from an earlier in-repo web-fetch/HTML-to-markdown implementation that was later extracted to the external `@qduc/web-fetch` package (currently dynamically imported at source/tools/web/web-fetch.ts:81).
- **Evidence**: `grep -E '"jsdom"|"turndown"|"mozilla-readability"|"@mozilla/readability"' package.json` returns nothing (no runtime package declared); `grep -rln "jsdom\|turndown\|mozilla-readability\|Readability" --include="*.ts" --include="*.tsx" source/ scripts/` returns no files.
- **Verify by**: same grep commands; then remove the three `@types/*` entries and run `pnpm typecheck` to confirm no ambient-type breakage.
- **Invariant impact**: none.

### F-dependencies-004: `@types/marked` is a stale, redundant type stub — `marked` (v17, in dependencies) ships its own bundled types
- **Severity**: low
- **Confidence**: high
- **Location**: package.json:83 (`"marked": "^17.0.1"`), package.json:100 (`"@types/marked": "^5.0.2"`)
- **Claim**: The installed `marked` package declares `"types": "./lib/marked.d.ts"` in its own package.json and ships native TypeScript definitions; `@types/marked` is a DefinitelyTyped stub still pinned at version 5.0.2 — 12 majors behind the actual `marked` v17 API it nominally types — and TypeScript's module resolution will use marked's own bundled types when resolving `import ... from 'marked'`, making the DefinitelyTyped package dead weight.
- **Evidence**: `node_modules/marked/package.json` contains `"types": "./lib/marked.d.ts"` and a matching `exports.types` entry; `node_modules/@types/marked/package.json` reports `"version": "5.0.2"`.
- **Verify by**: `cat node_modules/marked/package.json | grep types`; remove `@types/marked` and run `pnpm typecheck` — marked's own types should still resolve correctly for source/components/MarkdownRenderer.tsx and source/utils/conversation/markdown-commit-frontier.ts.
- **Invariant impact**: none.

### F-dependencies-005: `@types/ssh2` is listed under `dependencies` rather than `devDependencies`
- **Severity**: low
- **Confidence**: high
- **Location**: package.json:75 (inside the `dependencies` block, package.json:68-93)
- **Claim**: `@types/ssh2` is a compile-time-only type package but is declared as a production dependency; this project ships a CLI binary (`"files": ["dist"]`, `"bin": {"term2": "dist/cli.js"}`), not a library whose consumers need `ssh2`'s ambient types, so shipping it as a runtime dependency needlessly bloats installs for end users (npm won't literally install it at runtime since types aren't needed, but it does get resolved/fetched as part of the production dependency tree and appears in `pnpm install --prod` resolution).
- **Evidence**: package.json:68-93 is the `"dependencies"` block; line 75 is `"@types/ssh2": "^1.15.5"` sitting between `@anthropic-ai/sandbox-runtime` and `@openrouter/ai-sdk-provider`. `ssh2` itself (the runtime package, correctly a dependency) is used in source/services/ssh-service.ts.
- **Verify by**: `grep -n '"@types/ssh2"' package.json` and confirm it falls within the dependencies object bounds (lines 68-93); compare against `@types/env-paths` and `@types/marked`, both correctly placed under `devDependencies` (package.json:98, 100).
- **Invariant impact**: none.

### F-dependencies-006: Hand-rolled `deepEqual` duplicates the already-declared `fast-deep-equal` dependency
- **Severity**: low
- **Confidence**: high
- **Location**: source/services/agent-runtime/structured-output.ts:177-190 (hand-rolled); source/providers/chained-wire-state.ts:1, source/services/settings/settings-persistence.ts:3 (library usage)
- **Claim**: `structured-output.ts` implements its own recursive `deepEqual(a, b)` function for enum-value comparison instead of importing the `fast-deep-equal` package that two other files in the same codebase already depend on for the identical purpose.
- **Evidence**: `source/services/agent-runtime/structured-output.ts:177` defines `function deepEqual(a: unknown, b: unknown): boolean { ... }` with manual array/object key-walking logic; `source/providers/chained-wire-state.ts:1` and `source/services/settings/settings-persistence.ts:3` both do `import deepEqual from 'fast-deep-equal'`.
- **Verify by**: read source/services/agent-runtime/structured-output.ts:176-190 and compare against the `fast-deep-equal` import sites; confirm the hand-rolled version has no schema-comparison-specific behavior that would prevent swapping in the library (it appears to be a generic structural equality check used only for enum-value matching).
- **Invariant impact**: none. Flagging for the overbuild/duplication lens to make the deletion call — this is a "could reuse an existing dependency" observation, not a case for removing the dependency itself.

### F-dependencies-007: Entire AI-provider dependency stack is pinned one major version behind current upstream releases
- **Severity**: medium
- **Confidence**: high
- **Location**: package.json:69-92 — `ai` (^6.0.177 vs registry latest 7.0.47), `@ai-sdk/anthropic` (^3.0.76 vs 4.0.27), `@ai-sdk/google` (^3.0.72 vs 4.0.31), `@ai-sdk/provider` (^3.0.10 vs 4.0.4), `@openrouter/ai-sdk-provider` (^2.9.0 vs 3.0.0), `openai` (^6.9.1 vs 7.3.0)
- **Claim**: Every package in the recently-migrated-to AI-provider stack — the exact set of packages this codebase moved onto per `docs/plans/decouple-from-openai-agents-sdk.md` — is capped by its caret range at least one major semver version behind what the npm registry currently serves as latest, as of this audit (2026-08-01).
- **Evidence**: Live `npm view <pkg> version` results (run from a scratch directory, no install performed) for each package: `ai@7.0.47`, `@ai-sdk/anthropic@4.0.27`, `@ai-sdk/google@4.0.31`, `@ai-sdk/provider@4.0.4`, `@openrouter/ai-sdk-provider@3.0.0`, `openai@7.3.0` — all one major ahead of the ranges declared in package.json. Caret ranges (`^6.x`, `^3.x`, `^2.x`) cannot resolve past their major boundary, so this is a hard ceiling, not a lockfile-freshness issue.
- **Verify by**: `npm view ai version`, `npm view @ai-sdk/anthropic version`, `npm view @ai-sdk/google version`, `npm view @ai-sdk/provider version`, `npm view @openrouter/ai-sdk-provider version`, `npm view openai version` (run outside this repo's directory to dodge the `devEngines` pnpm-only gate — see Blocked); compare against package.json:69-92.
- **Invariant impact**: none directly, but this touches the area AGENTS.md flags as active work — `docs/plans/provider-bug-sweep.md` records "a newly-found, uninvestigated hang in the openai provider." Whether the pinned `openai@^6.9.1` (vs. current `7.3.0`) is related is unverified and outside this lens's remit, but the coincidence is worth the bug-sweep owner checking upstream changelogs for relevant fixes before further local debugging.

### F-dependencies-008: `@anthropic-ai/sandbox-runtime` is hard-locked to 0.0.56, eleven patch releases behind current, for a security-relevant component
- **Severity**: medium
- **Confidence**: high
- **Location**: package.json:72 (`"@anthropic-ai/sandbox-runtime": "^0.0.56"`); pnpm-lock.yaml:235-236 and :424 (locked to exactly `0.0.56`); consumed by source/utils/shell/sandbox/shell-sandbox-runner.ts:1-2 and source/utils/shell/sandbox/sandbox-policy.ts:4
- **Claim**: Under npm/pnpm semver rules, a caret range on a `0.0.x` version (`^0.0.56`) resolves to that exact version only — there is no auto-update headroom at all — and the registry's current version is `0.0.67`, meaning 11 patch releases have shipped upstream that this project cannot pick up without a manual `package.json` bump, for the package that implements the actual OS-level shell sandbox this repo's `AGENTS.md` Shell Safety section treats as a hard boundary.
- **Evidence**: pnpm-lock.yaml:236 shows `specifier: ^0.0.56` / `version: 0.0.56`; `npm view @anthropic-ai/sandbox-runtime version` (from scratch dir) returns `0.0.67`; source/utils/shell/sandbox/sandbox-policy.ts imports `SandboxRuntimeConfig` from this package and is the file AGENTS.md explicitly names as the sandbox write-allowlist authority.
- **Verify by**: `npm view @anthropic-ai/sandbox-runtime version`; `npm view @anthropic-ai/sandbox-runtime versions --json` to see the 0.0.57-0.0.67 changelog surface (not fetched in this pass — flagging staleness, not confirming specific missed fixes); cross-reference against sandbox-policy.ts's allowWrite logic referenced in AGENTS.md's Parallel Work Isolation section.
- **Invariant impact**: none in a written invariants file (none present — see Blocked), but touches the sandbox boundary AGENTS.md describes as load-bearing for agent write permissions.

### F-dependencies-009: `unbash` (shell command parser used for safety classification) is one major version behind
- **Severity**: low
- **Confidence**: medium
- **Location**: package.json:88 (`"unbash": "^3.0.0"`), pnpm-lock.yaml:3129/6281 (locked to `3.0.0`); consumed throughout source/utils/shell/command-safety/*.ts and source/services/rtk-service.ts:6
- **Claim**: `unbash` is pinned to major version 3 (locked exactly at 3.0.0) while the registry's current version is 4.0.4, a full major behind, for the library that parses shell commands for the safety/approval classifier described in AGENTS.md's Shell Safety section.
- **Evidence**: `npm view unbash version` (scratch dir) returns `4.0.4`; pnpm-lock.yaml locks `unbash@3.0.0` with no patch/minor headroom used within major 3 either.
- **Verify by**: `npm view unbash version`; `grep -n "unbash@" pnpm-lock.yaml`; check unbash's own changelog/releases for parser-correctness fixes between 3.0.0 and 4.0.4 (not done in this pass — confidence is medium because impact on safety-classification correctness is unverified, only the version gap itself is confirmed).
- **Invariant impact**: none in a written invariants file (none present).

## Non-findings
- **No leftover `@openai/agents*` packages.** Confirmed zero matches for `@openai/agents` in package.json, pnpm-lock.yaml, and all of `source/`. The only hits repo-wide are historical/planning references in `CHANGELOG.md` and `docs/plans/*.md`, consistent with the migration being complete as `docs/plans/decouple-from-openai-agents-sdk.md` claims.
- **`ai`/`@ai-sdk/*`/`@openrouter/ai-sdk-provider` are each used, not overlapping/duplicated.** `@ai-sdk/anthropic`, `@ai-sdk/google`, and `@openrouter/ai-sdk-provider` each back exactly one distinct provider file (source/providers/ai-sdk-anthropic.provider.ts, ai-sdk-google.provider.ts, ai-sdk-openrouter.provider.ts) — this is intentional multi-provider support, not redundant capability.
- **`ws` correctly scoped to devDependencies.** All 6 usages are in scripts/ (fake WebSocket test servers, black-box harness), never in production source/. No misclassification.
- **`@qduc/web-fetch` correctly flagged as used** despite a 0-hit static-import grep — it's loaded via dynamic `import('@qduc/web-fetch')` at source/tools/web/web-fetch.ts:81. Confirms the "verify before reporting" step in the task instructions was necessary here.
- **No `npx`-installable second HTTP client, date library, or schema validator found alongside an existing one.** `zod` is the sole schema validator (44 files); no lodash-style utility duplication surfaced beyond the `deepEqual` case (F-dependencies-006).
- **`meow` genuinely used** for the actual CLI entrypoint arg parsing (source/cli.tsx:6,115), not dead despite only 2 total usage sites.
- **Version pins for `zod`, `ink`, `react` are healthy** — same major as current registry latest, only minor/patch behind (zod ^4.1.13 vs 4.4.3, ink ^7.0.1 vs 7.1.1, react ^19.0.0 vs 19.2.8).

## Blocked
- **`audit/invariants.md` does not exist** in this checkout (`ls audit/` shows only a `reports/` directory). Proceeded without it per the ground rules — "Invariant impact" fields above are marked "none" where no invariant could be checked, since there was nothing to check against. This should be surfaced to the synthesis pass: this lens ran without the invariants document it was told to treat as ground truth.
- **`knip`/`depcheck` unavailable.** `npx --no-install knip --version` fails with `EBADDEVENGINES` — this repo's `package.json` `devEngines.packageManager` requires `pnpm`, and npm/npx refuses to run inside the repo directory as a result. Did not attempt `pnpm dlx knip` since that would trigger a network install, which the task instructions say to avoid/skip on. Fell back to manual grep-based cross-checking for every dependency in package.json (documented above), plus live (read-only) `npm view <pkg> version` calls run from the scratchpad directory (outside the repo, so the `devEngines` gate doesn't apply) to check staleness — no installs performed, no files modified.
- **Did not fetch full changelogs for `@anthropic-ai/sandbox-runtime` 0.0.57-0.0.67, `unbash` 3.x-4.x, or `openai` 6.x-7.x** to determine whether the version gaps correspond to security fixes, breaking changes, or irrelevant churn — flagged the gaps as verifiable facts (F-dependencies-007/008/009) but did not characterize their content, which is outside a dependency-manifest lens's remit and better suited to whoever owns the provider-bug-sweep or sandbox work.
