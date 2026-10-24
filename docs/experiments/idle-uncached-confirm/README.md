# Idle uncached-input confirmation removal

The guard still accounts for payload size and still warns for provider/model/config changes and undo/rewind. Idle age alone no longer adds a warning; stale resumed-session age alone no longer adds one. Unknown resumed-session age remains a warning.

## Evidence

Source identity: `4731459c44584c6e49854dac4a1d50cb849687dd` (working tree additionally contains the change). Production module exercised: `source/services/large-uncached-input-guard.ts`; entry point: `verify.mjs`.

Green command: `node docs/experiments/idle-uncached-confirm/verify.mjs`
Output: `PASS: below/exact/above idle boundary; resumed session; provider-change warning preserved`

The probe uses local TypeScript runtime support (`tsx`) and production `LargeUncachedInputGuard`, deterministic timestamps, and synthetic payloads. It exercises the guard decision layer rather than the full interactive renderer, keyboard/control-socket wiring, or provider. The input-admission workflow calls this shared guard preview before admission; other admission paths were not end-to-end exercised. Tool-approval controls are outside this guard and not directly exercised. No live provider or external effects.

A before-change red run was not retained in this attempt. Independent verification was not performed. Full `pnpm lint` reports 4 errors (3 in this script before an import correction; remaining unrelated findings need separate baseline comparison); after correction scoped eslint passes. `pnpm typecheck` passes.
