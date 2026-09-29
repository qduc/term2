# Henshin run-code subagents: phase 2 delivery

## Progress: 1/3 separately mergeable points

Phase 2a merged to main with `--no-ff` at `651fd9e5` (branch `henshin-run-code`). Phase 2b and 2c have **not** merged. No push or publish was performed.

## Delivered in 2a

Scripts can compose host-resolved child executions via `agent.run/start/status/result/cancel`, with host-side authority attenuation, parent scope, worktree pinning, budgets, async lifecycle and fail-closed interruption. Direct subagent tools remain available. The exact foreground continuation seam is present, but approval-interactive child tools are **not** supported by the merged script capability: a child interruption is a catchable error rather than a completed result. The proposed session-owned approval adapter at `43ce70e6` has not been transplanted or independently reviewed against main.

## Verification of 2a

- Cross-model review `/tmp/henshin-p2a-review.md` identified moved-worktree authority, cross-model editor aliases and implicit skill exposure. Corrections landed at `7d468e1f`, `0aaea1c4` and `6f39c5dd`, including a symlink-retarget regression.
- Focused checks: capability 83/83 and tool policy 93/93 passed; `pnpm test:related` passed 53 files, 1101 tests and one expected failure. `pnpm test:changed` selected no tests on the committed branch, so explicit changed-source related selection passed 118 files, 2124 tests and one expected failure.
- Sequential `pnpm test && pnpm test:integration && pnpm test:provider-black-box && pnpm typecheck` exited 0 in 299.116 seconds: unit 684 files, 9344 passed, three expected failures and two skipped; integration 12 files, 106 passed and one skipped; provider black-box 20 files, 178 passed and one skipped; typecheck completed. Earlier isolated load-sensitive deadline failures are not counted as green full gates; the final sequential rerun is the cited gate.

## Remaining acceptance and retirement disposition

| Surface | 2a disposition | Required before retirement |
| --- | --- | --- |
| Direct foreground/background subagent tools | Retained unchanged | 2b approval parity and async cancellation/notification equivalence at public boundary |
| Direct role/tool layer and presets | Retained | 2c caller inventory, compatibility decision and migration tests |
| Script catalog/prompt guidance | 2a advertises capability with explicit approval limit | 2c migrate guidance and measure before/after catalog chars/4 |
| Mentor, user interaction, rollover | Remain outside script agent execution | Preserve separate contracts |

Next: transplant `43ce70e6` onto a main-derived 2b branch, cross-model review and verify the integrated adapter before a distinct merge. Then address 2c migration, cost and evidence-gated retirement with its own review and gates. Phase 2 is not complete.
