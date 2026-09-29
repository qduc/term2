# Henshin agent runtime — phase 1 report

## Resume here

Phase 1 merged into `main` at `70e9ba3e`, incorporating plan commit `951cfa1e`, implementation `769a8959`, cross-review correction `0df0acc6` and report commit `b0286525`. Phase 2 is queued in `/tmp/henshin-phase2-brief.md` and may start after this report update.

## Delivered

- Generic `AgentSpec` supports per-invocation goal, context, tool allowlist, constraints, completion guidance, model and bounded parameters through `AgentRuntime.runAgent` and role-free `run_subagent({agent_spec})`. A shared mapper keeps API and delegation semantics aligned.
- Foreground and background generic runs reuse existing execution, approvals, cancellation, notification, worktree pinning and session mechanics. Read-only generic runs can continue; writable runs cannot. Generic foreground runs can transfer to background. Role presets remain compatible.
- Independent Claude/Opus review (`/tmp/henshin-review-report.md`) caught reachable plan-mode bypass, writable continuation escape, unsupported budget claims, role-pool failover error masking and lease-adoption failure. Commit `0df0acc6` addressed those findings and added regression tests. Plan mode rejects generic invocations; named read-only roles remain available there.

## Gates

- Baseline before edits: focused AgentRuntime/delegation tests, 66 passed.
- Worker after fixes: focused 9 files / 308 passed; `pnpm test:changed` 104 files / 1,898 passed / 1 expected failure; `pnpm test:provider-black-box` 20 files / 178 passed / 1 skipped; `pnpm typecheck` passed. `pnpm test:related` selected no files in the committed worktree, so changed tests were used instead.
- Coordinator independent validation: `pnpm test` exit 0, 681 files / 9,288 passed / 3 expected failures / 2 skipped (154.50s); `pnpm test:integration` exit 0, 12 files / 106 passed / 1 skipped (41.14s); `pnpm typecheck` exit 0; diff check clean. The unit runner emitted a `TimeoutNaNWarning` but completed successfully.

## Deliberate limits and follow-ups

- `doneWhen` is model-facing completion guidance, not a machine predicate. Generic `budget.maxTokens` is a per-response provider output cap, not an aggregate tree budget. Only enforced budget fields appear in the tool schema.
- Existing role prompts, tier pools and the mentor retained-session path remain as compatibility presets, not fully converted into `AgentSpec` invocations. Phase 2 is separately queued to move subagent execution inside `run_code` and retire the direct role/tool layer; it is not part of this merge.
- No push or publish performed. No live-provider generic-spec smoke test was run; the deterministic provider black-box tier passed.

## Merge

Merged with `git merge --no-ff henshin-agent-runtime` into `main` at `70e9ba3e`; primary checkout was clean immediately after the merge. Validation above ran on the branch head before integration; no production changes were made after those gates.

Progress: 6/6 phase-1 stages (assessment, plan, implementation, cross-review, correction/gates, merge/report).
