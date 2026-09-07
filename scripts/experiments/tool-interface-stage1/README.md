# Stage 1 tool-interface bench

Serial A/B of the combined Stage 1 `run_code` treatment vs baseline `76e51d24`.

- Protocol: `protocol.md` (gates B1–B9 / L1–L4). **Paid launch is blocked until protocol review.**
- Candidate pin: `80f7488401c1043445cf3974f163633693c8c20f`. Not `67560fa9`.
- Header bytes: factory-bound **non-interactive** snapshots (construction) and `provider-traffic-raw` (trials). The candidate test's interactive replica +8,471 B is not acceptance evidence (F3).
- Tasks: 2 untreated-essential + 2 treated-nonessential. `aggregate-owners` is off the primary schedule.

```
node scripts/experiments/tool-interface-stage1/driver.mjs preflight
pnpm exec vitest run scripts/experiments/tool-interface-stage1/stage1-bench.test.ts
```
