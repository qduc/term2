# Cheap Bare additions: pre-dispatch evidence

This is the historical preflight, not the current execution state. The user
subsequently waived hard reservations; the completed capped screens and final
accounting are in [cheap-additions-results.md](cheap-additions-results.md).

## Scope and authorization

The user authorized the new cheap-additions experiment on 2026-10-21.
The earlier paired pilot remains paused. No production profile change is
authorized by this experiment. Experiment model invocations, including helpers,
must use Neuralwatt `deepseek-v4.1-flash`, high reasoning, without substitution.

The inspected checkout was clean at
`31bf8380137d7f48f463e54f31570a3f3026b4fc`, matching the proposed baseline.
This is the inspected revision, not a claim that an execution configuration has
been frozen or that provider-resolved model availability has been checked.

## Blocking admission finding

User amendment after this report was committed: **"skip budget"**, in response
to the explicit choice between skipping the experiment and skipping budget
enforcement. The pre-dispatch reservation prerequisite below is waived for this
experiment. It is retained as evidence of a known limitation, not a current
dispatch blocker. Whole-run hard containment must not be claimed. Other plan
limits and accounting requirements remain in effect; use the 12,000-token
per-run target as a monitored ceiling and disclose possible in-flight overshoot.
No runtime budget repair is requested.

The inspected budget owners do not establish the experiment's required
12,000-total-token reservation before dispatch:

- `ExecutionBudget.tryAcquireChild()` in
  `source/services/agent-runtime/execution-budget.ts` checks already-recorded
  aggregate tokens. It does not reserve worst-case input and output for the child.
  `recordUsage()` charges completed-child usage and can abort after the limit
  has been reached. Concurrent children can therefore be admitted against the
  same remaining balance.
- `RunBudget.evaluate()` in
  `source/services/agent-runtime/run-budget.ts` computes stages from recorded
  request costs. Its token dimension counts unpriced requests rather than every
  request's total usage. This is not an all-call reservation ledger.
- `docs/plans/agent-runtime/run-budget-stall-escalation.md`, under **Resume here**, explicitly
  records unclamped mentor/async runs and siblings exceeding a parent's remainder.
- `experiments/bare-profile/README.md`, under **Accounting**, records that
  completion-verifier charges are additional to the foreground footer and
  missing helper usage makes accounting incomplete.

These are source-inspection findings, not a dynamic exploit or a claim that no
external reservation-capable runner could exist. No suitable experiment runner
has been established by this preflight. A per-response output cap or a
post-response usage monitor cannot replace the requested whole-run reservation.

Before the amendment, the pre-dispatch stopping rule prevented relying on these
controls alone. The amendment removed that blocker without claiming hard bounds.

## Evidence and limits

- Ran `git status --short` and `git rev-parse HEAD`: clean checkout and the
  baseline SHA above.
- Read the budget implementations and the original Bare comparison notes.
- Searched the agent-runtime source for reservation terminology; matches did
  not establish a shared pre-dispatch token reservation API.
- No live provider calls, helper calls, retries, or screen runs were dispatched.
  Experiment usage incurred by this work: zero provider calls; token measurements
  for unexecuted experiment runs are absent, not measured zeros.
- No production code, profiles, permissions, or budget defaults were changed.
- This is a partial Stage 0 preflight. Old-trace hypotheses, six fixture/oracle
  validations, outgoing request differences and sizes, reviewer handoff probes,
  model identity, randomization, and screen/confirmation measurements remain
  unperformed. No candidate recommendation is supported yet.

## Superseding outcome

The waiver authorized monitored rather than reserved accounting: 12,000 tokens
per run, 288,000 overall, at most 24 paid runs, helper charges included. The
experiment concluded with all ten available screens capped, one incomplete blind
review, and 155,778 total tokens across 11 paid runs. No addition advances and no
production runtime repair was made. See the results and retained evidence rather
than restarting from the obsolete reservation prerequisite.
