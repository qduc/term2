# E4 — structured scripted returns: clean re-run (2026-09-04 17:16)

Build: `.worktrees/e4-shape` at `6fa27d36`, dist built 16:37 — **verified to
contain both the structured returns and the agent-factory coercion fix**
(`grep -rl scriptedReturnShape dist/`, `grep scripted dist/lib/agent-factory.js`).
The quarantined `*-broken.out` cells predate that build.

Metric: **requests per run** (proxy for shape-discovery turns), from
provider-traffic session request counts. Wall time is secondary and noisy.

| model | before (main) | after (broken build) | **after2 (fixed)** | wall before → after2 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 7 | 13 | **2** | 89s → 50s |
| muse-spark-1.3-contributor | 5 | 46 | **3** | 29s → 11s |
| glm-5.3-flash | 12 | 18 | **3** | 146s → 11s |

Sessions: before `09-18-49`, `09-20-16`, `09-20-46`; broken `09-25-22`,
`09-28-55`, `09-33-05`; after2 `10-15-05`, `10-15-53`, `10-16-04` (UTC names).

## Correctness

All three produced the same table and the same top three
(`apply-patch` > `code-context` > `search-replace`) and correctly reported no
file hit the read truncation limit. Ground truth confirms 13 non-test files and
that ranking. Absolute line counts read 868/696/669 against main's 871/703/668
because the cells run in `.worktrees/e1-<mkey>`, which sit at an older commit —
not a tool error.

All three cite the structured fields directly ("every read came back with
`truncated: false`"), which is what the change was for: the broken run's
46-request muse cell was probing for a shape.

## Verdict

The 2–3 request floor is the shape being *advertised* rather than discovered.
`e4-shape` is validated and unblocked for merge.
