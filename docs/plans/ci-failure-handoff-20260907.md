# CI failure handoff — run 34119875565 (2026-09-07)

Status: **Diagnosed, not fixed.** Fixes deferred to next session. Read this before touching
the files it names; the worktree-bisect evidence below is the authoritative root-cause record.

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

## Bucket 4 — Model-picker-host (3 failures, flaky timing)

File: `source/services/models/model-picker-host.test.tsx`. Error `waitFor: condition not met
within timeout`. PASSES locally (11/11); times out in CI under runner contention. Not a logic
regression.

## Next steps (this session's agreed plan)

1. Bucket 1 fix — migrate the two stale auto-approval test files to canonical keys.
2. Bucket 2 fix — build `dist` in the `e2e` CI job.
3. Bucket 3 fix — repair the nested run_code tool-binding regression from `54b45c0a`.
4. Re-run full suite + e2e; verify bucket 4 clears.

Each fix in its own worktree per repo parallel-isolation guidance, then merge to main.
