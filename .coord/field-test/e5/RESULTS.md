# E5 — paired codemode vs no-codemode (2026-09-04, 18/18 cells)

Arms: `nocm` = `.worktrees/e5-nocodemode` (detached `ab5938cb`, the pre-change
main that already contains the sandboxed host); `cm` = `.worktrees/e4-shape`.
The comparison isolates the tool-surface reduction (27 -> 9) plus e4-shape's
structured scripted returns. Tasks: D (web lookup), B (seeded off-by-one +
regression test), C (refactor). Three models, n=1 per cell.

Raw input tokens are the primary cost metric: prompt caching is
prefix-dependent, so cached counts are not comparable across arms.

| task | model | reqs cm/nocm | in_tok cm/nocm | delta | wall cm/nocm |
| --- | --- | --- | --- | --- | --- |
| d | ds   | 3/3   | 56,751 / 71,626 | **-21%** | 11s / 15s |
| d | muse | 3/3   | 57,510 / 62,239 | **-8%** | 14s / 14s |
| d | glm  | 3/2   | 51,205 / 43,194 | +19% | 11s / 35s |
| b | ds   | 15/21 | 434,965 / 739,993 | **-41%** | 151s / 382s |
| b | muse | 11/13 | 236,577 / 322,037 | **-27%** | 64s / 66s |
| b | glm  | 19/12 | 492,281 / 292,141 | +69% | 315s / 172s |
| c | ds   | 36/40 | 2,167,922 / 2,052,854 | +6% | 255s / 231s |
| c | muse | 20/28 | 822,580 / 1,595,346 | **-48%** | 115s / 136s |
| c | glm  | 23/20 | 1,035,831 / 905,050 | +14% | 475s / 296s |

**Totals:** input tokens 5,355,622 (cm) vs 6,084,480 (nocm) = **-12.0%**.
Requests 133 vs 142 = -6.3%. Wall 1,411s vs 1,347s = **+4.8% (cm slower)**.

## Verdict

**The per-cell numbers above are n=1 and the noise floor is larger than the
effect.** Do not read any single row as a result. Measured after the fact:

- glm / task D, 5 repeats of the *same* arm: input tokens 37,124-71,082
  (**1.91x spread**), wall 10-39s (**3.9x**). The cm-vs-nocm delta for that
  cell was 8,011 tokens - about a quarter of the within-arm spread.
- glm / task B, 4 runs per arm: nocm mean 440,385 (292k-497k, stdev 98,991);
  cm mean 379,437 (280k-492k, stdev 94,694). **cm/nocm = 0.86x.**

The table's headline glm regression (`b glm` +69%) was the worst cm run paired
against the best nocm run. With repeats the sign reverses: codemode is ~14%
*cheaper* for glm on task B, and the arms overlap almost completely. **There is
no glm regression.** An earlier version of this file called that regression
"the single most interesting open thread"; that was wrong, and the
model-level pattern it described (muse 3/3, ds 2/3, glm 0/3) is not
distinguishable from chance at n=1.

What survives: the **aggregate** across all 9 pairs, -12.0% input tokens, is
averaged over more samples and is the only cost number worth quoting - and
even it rests on one run per cell. Speed is a wash. Quality is parity (below).

Sample-size guidance for the next round: with a ~22% coefficient of variation,
detecting a 15% effect needs roughly 8-10 runs per cell, not one. Prefer few
cells with many repeats over many cells with one.

## Quality

**Parity — all six task-B cells found the seeded off-by-one and wrote an
equivalent regression test** pinning the tail's first character
(`slice(-keepChars + 1)` -> `slice(-keepChars)`). No arm missed it, no arm
produced a fake test. `cm-b-glm` wrote the most thorough set (three tests
covering tail, head, and the exact trimmed count) — but paid 19 requests and
315s for it. Task C diffs are comparable in size across arms (cm 159-327
lines, nocm 163-340).

## What this does NOT show

**Fan-out amortisation is still undemonstrated.** No task in this round
required scripting to win — D is a single web lookup, B and C are ordinary
file work that both arms did with direct tools. E5 shows "no regression on
ordinary work, modest cost win"; it does not show the design paying off on
the workload it was built for. That justification remains unvalidated across
every round so far.

n=1 per cell. Single-cell deltas here are not separable from run-to-run
variance; only the direction of the model-level pattern is worth much.

## Data integrity notes

- **`cm-b-glm` was originally mis-mapped.** `run.sh` recorded the *newest*
  traffic session dir after each cell; a concurrent E4 re-run created newer
  dirs mid-cell and stole the mapping, crediting this cell with E4's 3
  requests instead of its real 19. Corrected by session id and the timing
  chain (`10-13-41`, ends 17:18:56, immediately before `nocm c ds` at
  `10-18-57`). Backup: `out/sessions.tsv.bak`. `run.sh` now picks the oldest
  dir created at or after the cell start.
- **`nocm-b-ds.diff` was captured empty and has been recovered.** Both arms
  share one cell worktree, and the `cm` run's reset to main (17:06:02) beat
  the `nocm` run's diff capture (17:06:03) by one second. The commit survived
  in the reflog (`90b1b9a6`); the diff is restored. **Both arms sharing a
  worktree is a harness defect** — serialise the reset, or give each arm its
  own worktree, before running another round.
- The four task-D cells that reported `unmapped` were backfilled by matching
  the task prompt in the traffic logs.
