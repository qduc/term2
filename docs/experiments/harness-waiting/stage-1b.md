# Harness waiting, stage 1b: A1 vs A2 (2026-11-27)

Companion to the plan's README and pilot log on branch
`docs/harness-waiting-experiment` (local to the user's machine at the time of
writing). Append this to its "Pilot log" when that branch is next touched.

## What ran

- **A1:** `origin/main` `3508603` (PR #452).
- **A2:** branch `ccr-810bdd67-6pz3cf` at `ca23b0b`: A1 plus the 60 s
  foreground handoff (`shell.foregroundHandoffMs`) and the watch notice that
  allows ending the turn silently.
  - Not built from the plan's A2 list: the `sleep N > 30` refusal and the
    running-jobs list in notice-started turns.
  - Not built: monitor line dedupe, because the stage 1a evidence does not
    support it. DeepSeek's seven S5 wakes were six distinct `PASS` lines plus a
    no-op job of its own; no delivered line repeated.
- **Grid:** 5 models × S1–S6 × 1 rep = 60 runs, one runner process,
  concurrency 8, cap 900 s. The fixture was rebuilt from the stage 1a session
  transcript, and the replay matches that session's checkpoints.
- **Environment:** a Linux cloud container, all models through OpenRouter.
  `gpt-6.2-sol` was `codex:` in stage 1a.
- **Cost:** about $1.38 for the 60 runs.

## Fixture lesson: the unattended reviewer is the model under test

The first 60-run batch used `--approval-mode unattended`, as stage 1a did. A1
scored 19/30 against 30/30 in stage 1a.

Almost every failure was the approval reviewer refusing the model's own `gh`
calls. With no reviewer configured, the reviewer is the session model, so
`gpt-6.2-sol` refused `gh pr view` as "authenticated GitHub CLI … requires
manual approval". That confound hits both arms and swamps the waiting
behaviour being measured.

The counted batch used `--approval-mode always`. The fixture is a sealed fake
world, so allowing everything exposes nothing real. A1 then scored 29/30,
consistent with stage 1a.

Lesson: pin approvals out of the measurement (or pin one reviewer model)
rather than inheriting the machine's configuration.

## Results (approvals pinned)

| Measure | A1 | A2 |
|---|---|---|
| Success | 29/30 | 29/30 |
| Detection delay p90 | 26 s | 19 s |
| Longest foreground call p90 | 0 s | 0 s |
| Foreground sleeps | 1 | 3 |
| Early wakes med/p90 | 0/1 | 0/1 |
| Cap hits | 0 | 0 |
| Prompt tokens, median per run | 82k | 76k |

Per-model bar: each model must pass at least 5 of the 6 scenarios on success,
detection ≤ 60 s, longest foreground call ≤ 60 s, early wakes ≤ 2, no leak and
no cap hit.

| Model | A1 | A2 |
|---|---|---|
| claude-haiku-5.5 | 6/6 | 6/6 |
| hy4-flash | 6/6 | 6/6 |
| gpt-6.2-sol | 6/6 | 6/6 |
| gemini-4-hydrogen | 6/6 | 6/6 |
| deepseek-v4.1-flash | **4/6**: S5 wrong final + 5 wakes, S6 detected at 216 s | **4/6**: S1 3 wakes, S3 contamination |

I read every DeepSeek miss:

- **A1 S5:** it put a monitor on the suite's `PASS` lines, as in stage 1a, and
  was woken 5 times. Its final message was about a leftover timer, not the
  result.
- **A1 S6:** it noticed the merge 216 s late.
- **A2 S1:** it wrote its own PR-watch script and put a monitor on the script's
  progress lines. That gave 3 wakes before the merge (bar: 2). The new notice
  text did not lead it to cancel the monitor.
- **A2 S3:** it finished the task (fix, push, merge reported), but ran
  `grep -r … /tmp /` and read the fixture's scenario and world files. The
  analyser counts that as contamination, so the run fails. The fixture design
  is the same as stage 1a, so this is the model's behaviour, not a new fixture
  defect, and it is not rerun.

## The handoff in practice

- **This batch:** no model ran a foreground command past 60 s in either arm,
  so the handoff never fired. Haiku did not repeat stage 1a's foreground S5
  run.
- **The discarded unattended batch:** the handoff fired once, on Haiku S5
  under the pre-fix build. The 140 s suite moved to the background at 60 s,
  and the failure was reported 16 s after it printed (success). Under A1 in
  the same batch, Haiku backgrounded the suite itself.
- **Conclusion:** this data cannot measure its effect; it was exercised once
  and behaved as designed. It raised no failures (A2 29/30, the same as A1).
  That satisfies the rule that a kept guardrail must not add more than one M1
  failure in eighteen.

## Decision under the plan's rules

- **A1 does not meet the bar:** DeepSeek 4/6.
- **A2 does not meet the bar:** DeepSeek 4/6.
- **Next step under the rules:** stage 2, C and B. Thresholds are not
  loosened.
- **What stage 2 would target:** every remaining miss is DeepSeek monitoring
  progress output, apart from one late detection and one contamination. C and
  B attack exactly that, because the harness owns the loop and wakes only on
  a final state.
- **Nothing for stage 2 is built or run.** The plan requires the user's go and
  a cost estimate first. At this batch's cost, C and B × 30 runs each is about
  $1.50 per rep.
