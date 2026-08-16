# Calibration probe

Run 2026-08-10, before funding the Milestone 2 calibration wave. Four test files,
two reviewers, working independently and without sight of each other's artifact.

The probe existed to answer one question: **can a cheap explorer state a Behavior
Contract usefully?** If not, the fan-out is not worth funding. It answered that
question yes, and surfaced a second problem that the wave design has to absorb.

## Setup

| | Reviewer A | Reviewer B |
| --- | --- | --- |
| id | `probe-fleet-a` | `probe-codex-b` |
| harness | term2 Orchestrator, `explorer` subagent | codex |
| model | `opencode/deepseek-v4-flash` | `gpt-5.6-luna` high |

Deliberately different configurations. Two reviewers on the same model, given the
same brief, can agree because they share a bias rather than because the evidence is
strong.

Sample, two files where a contract should be easy to state and two where it is hard:

- `source/utils/shell/sandbox/sandbox-failure-classifier.test.ts`
- `source/services/approval/approval-decision-policy.test.ts`
- `source/components/input/menu-system.integration.test.tsx`
- `source/lib/agent-client.application-run-loop.test.ts`

Both reviewers were given a schema-valid example artifact. The graph is empty, so
without one the probe would have measured YAML guessing rather than contract
statement.

## What passed

**Schema conformance.** Both artifacts validated, each on its own first reported
attempt. `probe-fleet-a`: 4 tests, 22 contracts, 4 decisions. `probe-codex-b`:
4 tests, 10 contracts, 4 decisions.

**Contract statements.** Both wrote observable, outside-in statements, and neither
fell into the restating-the-implementation failure mode the brief warned against.
Representative, from `probe-codex-b`:

> A successful command, a command already running with Docker host control, or
> ordinary stderr without a sandbox signal is not replaced by a sandbox failure
> result.

**Factual accuracy of coverage claims.** This was the failure mode with real
consequences, since a hallucinated sibling is how a deletion gets justified. Three
claims were spot-checked against the repository and all three held:

- `probe-fleet-a`: "no other file imports `classifySandboxFailure`" — correct; the
  only other importer is `source/tools/system/shell.ts`, which is production code.
- `probe-codex-b`: shell-level consumer coverage exists — correct; `shell.test.ts`
  carries 243 sandbox-related assertions.
- `probe-codex-b`: "nearby controller-only" menu tests — correct;
  `menu-controller.test.ts` exists and drives the controller directly.

The two reviewers described the classifier's sibling situation differently and both
were right: one counted test importers, the other counted consumer coverage. That is
a granularity difference, not a contradiction.

## What did not pass, and why it matters

**Discrimination is unproven.** Both reviewers returned `keep` on all four files.

That is probably the correct answer — these are four load-bearing files, and the
sample was drawn to be representative rather than to contain waste. But it means the
probe never observed either reviewer produce any label other than `keep`. A reviewer
that always answers `keep` produces exactly this artifact, and would have scored
equally well.

So agreement here is much weaker evidence than 4-of-4 suggests. It establishes that
both reviewers can recognise a test worth keeping and justify it accurately. It does
not establish that either can recognise one that is not.

The only disagreement was in confidence: `probe-codex-b` said `high` four times,
while `probe-fleet-a` said `medium` on the approval-policy and menu-system files,
both times because it judged sibling coverage to carry part of the contract. The
cheaper reviewer was the more cautious one, which is the opposite of the expected
failure and mildly reassuring.

A granularity gap also needs settling before fan-out: 22 contracts versus 10 over the
same four files. Both are defensible readings of "separate contracts that can change
independently," but they do not merge cleanly, and per-contract counts would not be
comparable across shards.

## Consequences for the calibration wave

1. **Salt the sample.** The wave's 10-20 files must include files that plausibly
   warrant a non-`keep` label, or it will reproduce this result at four times the
   cost and prove no more. The near-duplicate clusters are the natural source:
   `conversation-session` spans 10 test files, `subagent-manager` 8, `command-safety`
   7. If neither reviewer proposes `consolidation_candidate` anywhere in a cluster
   like that, treat explorer judgment as unusable for anything but `keep`.
2. **Include a positive control.** At least one file whose status the coordinator has
   already determined independently, not disclosed to either reviewer. Agreement with
   a known answer is worth more than agreement with each other.
3. **Fix granularity first.** Decide whether a contract is per-behaviour or
   per-cluster and say so in the brief, since it is not recoverable afterwards.
4. **Keep the differently-configured pairing.** It cost nothing extra and the two
   reviewers' independent errors would not have correlated.

## Standing caution

`keep` is the cheap answer. It is never wrong in a way that shows up later, it
requires no replacement evidence, and the validator does not challenge it. Every
review of explorer output should ask what the reviewer would have had to notice in
order to say anything else.
