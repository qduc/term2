# Field-test task design: why A-D failed, and what to replace them with

Written 2026-09-04 after E5. **Do not reuse tasks A-D as a benchmark.**

## The measurement failure

Every model passed tasks B and C in both arms, in every round. Round 2: 3/3
found task B's seeded bug with genuinely-failing regression tests, 3/3 did
task C with tests untouched. E5: 6/6 on task B. A benchmark where nothing
fails discriminates nothing, so E5 could only report token cost - and at
n=1 with a 22% coefficient of variation, it could not report that reliably
either.

## What is wrong with each

**The prompt hands over the diagnosis.** Task B's report is not "the output
looks wrong sometimes"; it states that the *tail* is missing its *first
character* and that the head and the trimmed-count note are correct. That is
the root cause localised to one expression. What remains is `slice(-k + 1)`
-> `slice(-k)`.

**The prompt names the seam.** Task C says to extract "the command
approval-decision logic ... into its own module". Deciding *what* to extract
is the refactor skill; the prompt spends it. All three models produced
near-identical ~160-line `shell-approval.ts` files.

**No wrong premises.** Real work here is full of them. This session: a doc
claim that was stale, a lane failure that looked like a regression but
reproduced pre-merge, a flake that looked seed-determined but was
load-sensitive, and a diff capture that silently omitted untracked files.
Nothing in A-D penalises accepting a plausible-but-false premise, which is
the failure mode that actually burns hours.

**Single file, single gate, short horizon.** Nothing crosses provider ->
service -> UI. Nothing requires choosing *which* gate to run, though lane vs
full suite vs provider black-box is a real judgement in this repo. Nothing
has to survive a merge.

**Nothing requires fan-out.** This is fatal for the question E5 was built to
answer: fan-out amortisation is the justification codemode was merged on, and
no task in any round required scripting to win. E5 could only ever have shown
"no regression".

## Replacement principles

1. **State symptoms, never causes.** The diagnosis is the work.
2. **Leave the seam, the gate, and the scope to the model.** Grade the choice.
3. **Include at least one task with a false premise** in the report, and grade
   whether the model detects it rather than building on it.
4. **Include at least one task that cannot be done well without fan-out** -
   aggregation over hundreds of files - or the codemode question stays open.
5. **Tasks must be able to fail.** Pilot each one; if 3/3 models pass on the
   first try, it is not a benchmark task, it is a smoke test.
6. **Ground truth must exist and be checkable** without a human re-deriving it.

## Candidate tasks (all have known ground truth in this repo)

| # | shape | task | grades |
| --- | --- | --- | --- |
| N1 | diagnosis from symptom | "`pnpm test:lane` sometimes fails, different files each time. Find out why and say what should change." | Does it discover load-sensitivity vs seed-determinism? Does it wrongly blame the most recent merge? Ground truth: manifest drift, reproduces on `cb73db64`. |
| N2 | fan-out, forces scripting | "Across every file in `.github/vitest.lane.safe.txt`, find which mutate a global (`process.cwd`, `Date`, env, singletons) and rank by blast radius." | 567 files - infeasible one read at a time. Directly tests the codemode premise. |
| N3 | unnamed seam | "`shell.ts` is too big. Choose the highest-value extraction, justify the seam, execute it." | Quality of the seam choice, not the mechanics. |
| N4 | cross-cutting | "Add setting X end to end so it appears in `/settings` and takes effect at runtime." | Multi-file wiring; the `setting-wiring` skill is the rubric. |
| N5 | false premise | A bug report whose stated cause is wrong but plausible. | Does the model verify the premise or build on it? |
| N6 | gate judgement | A change touching a provider, with no instruction on what to run. | Does it run `test:provider-black-box`, per AGENTS.md? |

## Measurement, not just tasks

E5's other failure was statistical. With ~22% CV, detecting a 15% effect needs
roughly 8-10 runs per cell. **Prefer few tasks with many repeats over many
tasks with one run.** Report distributions and the aggregate across pairs;
never quote a single cell. See `e5/RESULTS.md` and the variance section of
`HANDOFF.md`.

Grade on outcome quality with a rubric, not on wall time or diff size - diff
size is not a quality signal, and the recorded diffs were incomplete anyway
(see `archive/README.md`).
