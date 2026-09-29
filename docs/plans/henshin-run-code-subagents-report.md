# Henshin run-code subagents: phase 2 delivery

## Progress: 2/3 separately mergeable points

Phase 2a merged to main with `--no-ff` at `651fd9e5` (branch `henshin-run-code`). Phase 2b merged separately at `eb2febdd` (branch `henshin-p2b-integration`). Phase 2c has **not** merged. No push or publish was performed.

## Delivered in 2a

Scripts can compose host-resolved child executions via `agent.run/start/status/result/cancel`, with host-side authority attenuation, parent scope, worktree pinning, budgets, async lifecycle and fail-closed interruption. Direct subagent tools remain available. At the 2a checkpoint, approval-interactive child tools were not supported: a child interruption rejected instead of falsely completing. The 2b merge added session-owned approval continuation.

## Verification of 2a

- Cross-model review `/tmp/henshin-p2a-review.md` identified moved-worktree authority, cross-model editor aliases and implicit skill exposure. Corrections landed at `7d468e1f`, `0aaea1c4` and `6f39c5dd`, including a symlink-retarget regression.
- Focused checks: capability 83/83 and tool policy 93/93 passed; `pnpm test:related` passed 53 files, 1101 tests and one expected failure. `pnpm test:changed` selected no tests on the committed branch, so explicit changed-source related selection passed 118 files, 2124 tests and one expected failure.
- Sequential `pnpm test && pnpm test:integration && pnpm test:provider-black-box && pnpm typecheck` exited 0 in 299.116 seconds: unit 684 files, 9344 passed, three expected failures and two skipped; integration 12 files, 106 passed and one skipped; provider black-box 20 files, 178 passed and one skipped; typecheck completed. Earlier isolated load-sensitive deadline failures are not counted as green full gates; the final sequential rerun is the cited gate.

## Delivered in 2b

The `agent.run` foreground child can pause at a tool approval and resume the exact retained continuation through the session's `NestedApprovalOwner`. Public `run_code` tests using the real nested runner cover approval, denial, repeated pauses, concurrent wait-clock behavior, cancellation, folder and Docker grants. Independent Codex Sol review found that the initial adapter wrote nested grants into root access state; `b9a17208` corrected this, with a red/green folder-grant regression. Child session-edit grants without a nested edit store now reject rather than promising persistence. This does not prove real-provider or Ink UI behavior.

Focused test 27/27, related and changed 57 files/1200 passed with one expected failure, and typecheck passed. Sequential full unit/integration/provider-black-box/typecheck gate exited 0 in 306.189 seconds: unit 684 files/9352 passed, three expected failures, three skipped; integration 12 files/106 passed, one skipped; provider 20 files/178 passed, one skipped.

## Remaining acceptance and retirement disposition

| Surface | Current disposition | Required before retirement |
| --- | --- | --- |
| Direct foreground/background subagent tools | Retained unchanged | Script path rejects `continue_run_id`, while direct session/role paths support continuation and compatibility callers. Approval tests prove the session owner boundary, not the live Ink or provider boundary. |
| Direct role/tool layer and presets | Retained for compatibility; 2c inventory below | Stored-run continuation, reviewer explorer-only tool and plan-mode handling lack script parity |
| Script catalog/prompt guidance | 2c candidate corrects the 2a approval limit and adds conditional invocation guidance | Cross-review and gates before merge |
| Mentor, user interaction, rollover | Remain outside script agent execution | Preserve separate contracts |

## 2c migration and retirement decision (pending review and merge)

The conditional `run_code` catalog now describes the 2b session-owner approval path instead of claiming all child approvals are unsupported. The orchestrator and delegation addendum describe `agent.run/start` conditionally on the capability being advertised; direct role guidance remains for compatibility. A rendered foreground-only agent catalog from the public tool description measured **1,075 chars (~269 tokens) before** and **1,193 chars (~299 tokens) after**, using the MCP catalog convention of chars/4. The 118-char increase is the replacement approval sentence; the non-agent tools header is unchanged. The old count is the rendered current section with that sentence replaced by the previous catalog sentence, not a second full-tool render.

Direct tool/role removal is **not justified** by the 2b evidence:

- `run_subagent`, `get_subagent_result/status`, cancellation and messaging remain model-facing compatibility paths in `agent.ts`, `source/tools/agent/run-subagent.ts`, `source/prompts/subagent-delegation.ts`, and non-interactive/plan-mode interceptors. Script `agent.start` rejects `continue_run_id` and cannot replace the direct stored-run continuation contract; plan-mode generic capabilities are not yet intercepted equivalently.
- `source/services/subagents/tool-policy.ts` provisions `run_explorer` for the reviewer preset; `source/prompts/subagents/reviewer.md` promises that single tool. Replacing the preset with a generic script child would alter the reviewer evidence boundary rather than remove a redundant name.
- The specialized mentor/librarian/reviewer/worker role behavior, retained sessions and background notifications remain shared by direct users. `ask_mentor`, user interaction and rollover stay outside script agent execution. Removing these definitions without matching caller and session behavior would regress existing contracts. Keep the direct role layer as explicit compatibility, not claim it was retired.

Next: independent review, related/changed/typecheck and appropriate broad gates, then a separate 2c `--no-ff` merge and final report update. No 2c completion is claimed here.
