# CI failure handoff — run 34119875565 (2026-09-07)

Status: **Buckets 1-3 fixed (2026-09-07); bucket 4 fixed (2026-09-10).** The
worktree-bisect evidence below is the authoritative root-cause record for the fixes.

## Scope

`gh run view 34119875565` — `main` at commit `76e51d24` ("merge live fix verification
evidence"). Both `test` and `e2e` jobs failed; `provider-black-box` passed. Green baseline for
comparison: `34005192985` at `2dc4d00d`. ~200 commits merged in between.

All four buckets were reproduced locally and bisected in throwaway worktrees
(`git worktree add` at specific commits + `vitest run <file>`). Worktrees removed after use.

## Bucket 1 — Auto-approval tests (14 failures, deterministic, REAL regression)

Files: `source/services/session/conversation-session.auto-approval.test.ts` (12),
`source/non-interactive.test.ts` (2). Error: `expected 'gpt-5.1' to be 'test-auto-model'`.

Cause: commit `a4400feb` "feat(settings): finish vocabulary migration (M2)" repointed
`source/services/approval/shell-auto-approval-evaluator.ts:448-449` to read canonical tier keys
`agent.choreModel`/`agent.choreProvider` instead of legacy `agent.autoApproveModel`/
`agent.autoApproveProvider`. Production is covered by `ancillary-settings-migration.ts` (copies
legacy->tier at startup), but these two test files were NOT migrated — they still inject
`agent.autoApproveModel: 'test-auto-model'`, so the evaluator falls back to default model `gpt-5.1`.

Fix option A (align tests): update the two test files to inject/assert `agent.choreModel`/
`agent.choreProvider`. Fix option B (keep legacy read): add `?? get('agent.autoApproveModel')`
fallback in the evaluator per the plan doc's line 69-71 intent.

## Bucket 2 — e2e job (6 failures, CI-workflow gap, NOT a code bug)

File: `source/services/sandboxed-code-host/sandboxed-code-host.e2e.test.ts`. Error:
`ERR_MODULE_NOT_FOUND .../dist/services/sandboxed-code-host/sandboxed-code-host.js`.

Cause: the 6 `built`-worker variants (added by `841fc361`/`dc5042fa`, sandbox cwd-repair work)
import the compiled `dist/` module, but the `e2e` job in `.github/workflows/ci.yml` runs
`pnpm test:e2e` with NO build step, so `dist/` is absent in CI. Passes locally only because
`dist/` is prebuilt.

Fix: add a `dist` build step to the `e2e` job (or guard the `built` variant to skip when
`dist/` is missing).

## Bucket 3 — Nested-approval-hide (1 failure, deterministic, REAL product regression)

File: `source/app.nested-approval-hide.test.tsx`. Expects hidden nested file-edit approval frame
(`create_file`) but only model-picker/processing chrome renders.

Cause (bisected): commit **`54b45c0a`** "feat(run-code): require the description parameter"
(inside run-code DX merge `f04932fc`). Parent `3ac8ce47` PASSES; `54b45c0a` FAILS; current main
still fails. Making `description` required in the sandboxed-code-host tool binding broke the
nested `tools.create_file(...)` approval flow inside run_code — the M4-hide nested file-edit
approval never triggers.

## Bucket 4 — Model-picker-host (3 failures, deterministic, REAL defect)

File: `source/services/models/model-picker-host.test.tsx`. Error `Test timed out in 10000ms`;
the `waitFor` for a frame containing the mocked model never resolves. Reproduced deterministically
outside CI: `CI=true pnpm test source/services/models/model-picker-host.test.tsx` fails 3 of 11 on
an idle machine, `CI=false` passes 11/11. Runner contention was never the cause.

Cause: Ink 7.0.1 resolves `interactive` as `!is-in-ci && stdout.isTTY`
(`node_modules/ink/build/ink.js`, `resolveInteractiveOption`), and CI detection wins even over a
real TTY. In non-interactive mode Ink defers output and writes only the final frame at unmount, so
`runModelPickerHost` mounted, accepted input, and exited — but never painted the menu, and the
frame assertion could not hold. `is-in-ci` reads the environment once at import, so the picker's
two env values produce two different renders, not slower and faster runs of one render.

Fix: pass `interactive: true` at the picker's `render()` call site. Interactivity is already
guaranteed there by `isModelPickerHostSupported` (a real TTY on both ends), and the shipped CLI
hits the same Ink default in any CI-marked PTY — which is why
`scripts/provider-black-box/provider-test-harness.ts` deletes `CI` from its child env.

## Resolution (2026-09-07)

1. **Bucket 1** — migrated the two stale test files to canonical `agent.choreModel`/`agent.choreProvider`
   keys (option A). The legacy fallback was removed intentionally in `a4400feb`; the plan's
   E2 intent is tier-first reads, so the tests are the fix, not the evaluator.
2. **Bucket 2** — added `SKIP_BUILD_BACKUP=1 pnpm build` to the `e2e` CI job before the suite.
3. **Bucket 3** — added the missing `description` to the outer run_code call in
   `app.nested-approval-hide.test.tsx`; `e7f966e5` had already updated every other outer
   payload but missed this file. Match to the intended description-required contract; no
   schema revert.
4. **Bucket 4** — was passed as flaky timing with no code change, which is why CI kept failing on
   every push until 2026-09-10; see the bucket 4 root cause above for the actual fix.

Fixed in three worktrees then merged `--no-ff` to main.
