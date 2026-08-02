# Phase 0 baseline report

## Repository state

- Worktree: `/Users/qduc/src/term2/.worktrees/post-refactor-provider-boundary-audit`
- HEAD: `8ed71544d3e63948116562517035a3a0e4b95503` (`Merge branch 'fix-console-go-reasoning'`, 2026-08-02 11:07:03 +07:00)
- Branch: `post-refactor-provider-boundary-audit` (also `main` points at this commit).
- Status: one untracked file, `docs/plans/post-refactor-provider-boundary-audit.md`; no staged files and no tracked diff. This is the plan named by the handoff, not an unrelated source edit.
- `git diff --check`: passed.

## Historical comparison point

Best comparison point is the parent of the refactor commit:

- Pre-refactor: `1d9b15155d989ae65a80ca0e359c6068352906ef` (parent of `5824007bd7e812717c3c13daf8e47ff6c4d9d512`), where `source/lib/agent-run-orchestrator.ts` imports and runs `@openai/agents` (`Agent`, `run`, `Runner`, `RunState`, `StreamedRunResult`).
- Refactor boundary: `5824007bd7e812717c3c13daf8e47ff6c4d9d512` (`decouple from openai agents sdk`, 2026-08-01 07:36:25 +07:00). Its diff introduces `source/contracts/streamed-model-turn.ts` and application-owned runtime contracts; current `source/lib/agent-run-orchestrator.ts` instead imports `ApplicationAgent` from `source/services/agent-runtime/application-run-loop.ts`.
- Current history after that point includes subsequent stream/history/reasoning fixes through HEAD, so the pre-refactor parent is the cleanest historical semantic comparison, while `5824007b` is the first post-refactor contract snapshot. The old SDK orchestrator is not the current executable path; compatibility symbols remain (for example `LegacyRunner` and `source/providers/agents-model-bridge.ts`) and should be treated as residual compatibility paths, not proof that the old runtime is active.

## Verification

Focused command from the plan:

```text
pnpm exec vitest run source/utils/ai/token-usage.test.ts source/services/agent-runtime/application-run-loop.test.ts source/services/stream-event-processor.test.ts source/services/session/terminal-result-collector.test.ts source/components/layout/StatusBar.test.tsx
```

- **Passed**: 5 test files, 102 tests.
- Vitest reported duration: 921 ms; shell wall time (`/usr/bin/time -p`): 2.88 s (real).

Typecheck:

```text
pnpm typecheck
```

- **Passed**: `tsc --noEmit`; shell wall time: 2.47 s (real).

The requested provider black-box and full test suites were not run (Phase 0 request explicitly defers them). No environment blocker occurred; dependencies were already present (`node_modules` exists), and no install was performed because this baseline was read-only.

## Codex traffic aggregate

The configured log path exists: `$HOME/Library/Logs/term2-nodejs/logs/provider-traffic/2026-08-02/`. Running the plan's compact `jq`/`awk` aggregation (without printing payloads) reproduced:

```text
requests=13 cache_hits=9 input_tokens=111997 cached_tokens=68352 cached_rate=61.0%
```

No prompt, credential, or full payload was copied into this report.

## Baseline findings / residual risks

- **High — known, unaddressed:** `ApplicationRunLoop` accumulates direct `cachedInputTokens`, while `normalizeAgentRunUsage()` does not consume that direct field; stream processing can prefer the incomplete run-state usage and omit cache reads from footer/terminal usage. Evidence: plan lines 40–45 and 61–66; focused baseline is green but has no required production-seam red proof yet.
- **High — known, unaddressed:** `AgentConfiguration` supplies Codex `prompt_cache_key`, but the application run-loop request projection does not carry it to the Codex native request. Evidence: same plan section and the current `StreamedModelTurnRequest` contract in `source/contracts/streamed-model-turn.ts`.
- **Residual risk:** the old runtime cannot be executed as the current path; differential validation must use history/source comparison against `1d9b1515` and the refactor boundary `5824007b`. Provider black-box and full-suite status remains unknown by design.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Baseline includes repository state, historical comparison evidence, exact focused-test/typecheck outcomes, reproducible compact Codex aggregate, and severity-tagged findings with source paths."
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "pnpm exec vitest run source/utils/ai/token-usage.test.ts source/services/agent-runtime/application-run-loop.test.ts source/services/stream-event-processor.test.ts source/services/session/terminal-result-collector.test.ts source/components/layout/StatusBar.test.tsx",
      "result": "passed",
      "summary": "5 files, 102 tests passed; Vitest 921 ms, wall 2.88 s"
    },
    {
      "command": "pnpm typecheck",
      "result": "passed",
      "summary": "tsc --noEmit passed; wall 2.47 s"
    },
    {
      "command": "compact jq/awk Codex aggregate for 2026-08-02",
      "result": "passed",
      "summary": "13 requests, 9 cache hits, 111997 input, 68352 cached, 61.0%"
    },
    {
      "command": "pnpm test:provider-black-box",
      "result": "not-run",
      "summary": "Deferred by task scope"
    }
  ],
  "validationOutput": [
    "git diff --check passed",
    "No environment blockers; provider black-box/full suite intentionally deferred"
  ],
  "residualRisks": [
    "Known footer cache-usage and Codex prompt_cache_key boundary defects remain unaddressed.",
    "Old runtime is historical-only; current compatibility paths require explicit audit."
  ],
  "noStagedFiles": true,
  "diffSummary": "Read-only audit; no project files changed.",
  "reviewFindings": [
    "high: source/services/agent-runtime/application-run-loop.ts and source/utils/ai/token-usage.ts - direct cachedInputTokens is not normalized through the authoritative usage path.",
    "high: source/lib/agent-configuration.ts and source/contracts/streamed-model-turn.ts - Codex prompt_cache_key is not projected through the application-owned request contract."
  ],
  "manualNotes": "The audit plan itself is untracked in the worktree, as documented by git status; this report was written only to the mandated external artifact path."
}
```