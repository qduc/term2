# Background-status friction evidence assessment (2026-09-07)

**Scope:** presentation of the model-facing periodic check-in notification and
its related tests. The compact background-task strip is already merged and is
not changed here. This change does not alter task cards, provider logging,
execution-event delivery, liveness controls, or the check-in schedule.

## Executive disposition

The evidence supports one narrow behavior change: tell the agent explicitly to
end a check-in turn silently when it has no action or user-facing update to
make. The existing instruction that doing nothing is valid was directionally
correct, but it did not prohibit a filler acknowledgement or a repeated
progress paragraph. The formatter now says:

> If no action or user-facing update is warranted, end this check-in turn
> silently: produce no assistant prose, acknowledgement, or filler.

This is guidance for the model-only check-in prompt, not a change to the
user-facing command row. The latter remains a concise status presentation.

## Evidence inspected

The local provider-traffic archive was searched for requests whose final input
was an assembled `Periodic check-in on ...` notification. The bounded scan
found 148 such request artifacts across 28 sessions. This is observational
traffic from mixed implementation and review work, not a controlled quality
experiment.

Concrete examples show the friction without establishing that every
check-in was harmful:

* Session `d27dc356-4eda-4882-9c38-80d8aa46cdbd` received check-in #2 at
  `2026-09-06T02:51:12.590Z` (the assembled input was 3,197 characters) and
  replied, “Both follow-up tasks are still progressing ... No intervention is
  warranted from this check-in.” The request artifact is
  `/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/02-51-12.590Z_1099e.json`.
* The same session's check-in #3 at `2026-09-06T03:56:11.126Z` replied,
  “Both tasks are progressing ... No stall is indicated by this check-in.”
  That artifact is
  `/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/01-59-40_d27dc/03-56-11.126Z_3dfe8.json`.
* A separate session's check-in #1 at `2026-09-06T17:02:47.192Z` replied,
  “The audit is still active and making progress ... I’m leaving it running.”
  That artifact is
  `/home/qduc/.local/state/term2-nodejs/logs/provider-traffic/2026-09-06/16-59-17_eab6b/17-02-47.192Z_a089d.json`.

These are plausible no-op status acknowledgements, not proof that the model
should be prevented from speaking on every check-in. The archive also contains
substantive check-in responses and provider failures, so completions, blockers,
and useful supervision must remain visible and actionable.

## What was already handled

The current implementation already provides the following protections and
controls:

* `settings-schema.ts` defaults `agent.backgroundCheckIn.enabled` to `true`
  and `intervalMs` to `300_000` (five minutes). This change does not alter
  either default.
* `BackgroundCheckInScheduler` permits per-task enable/disable, interval, and
  next-due overrides through the existing task-control path. User oversight is
  therefore preserved; no control was removed or hidden.
* The check-in formatter already labels the input as an automatic system
  notification, says that it does not by itself indicate a problem, permits
  doing nothing, and limits user reports or intervention to cases where the
  elapsed time or task nature warrants it.
* Completion, question, budget/stall, shell-output, and user-control
  notifications continue through their existing paths. This work does not
  deduplicate execution events or weaken liveness evidence.

## Why the change is no broader

The full subagent task brief is still included in each model-facing check-in.
That repetition is a real prompt-size and attention cost, but the available
evidence does not show that removing it is safe: the brief lets the agent judge
elapsed time and task-specific risk, especially on an idle or resumed context.
There is no matched experiment showing that a shortened brief preserves
intervention quality. The minimum justified change is therefore to suppress
unnecessary prose while retaining the task, status, liveness, recent narrative,
tool, and control evidence.

No change was made to the five-minute default, scheduler cadence, task cards,
provider-traffic logging, completion/blocker visibility, event identity, or
execution semantics. Those would address different hypotheses and would make
the observed no-op replies harder to evaluate rather than directly fixing the
missing silence instruction.

## Validation

The regression assertions exercise the actual `ConversationOrchestrator`
delivery seam in both cases: injection into an active turn and an idle hidden
turn. They assert that the model-facing assembled notification contains the
silence/no-filler direction, while the separately assembled user-facing command
row remains concise and does not expose that instruction.

Red proof: adding the assertions before the formatter edit failed two tests.
Green proof:

```text
pnpm test source/services/conversation/conversation-orchestrator.subagent-notifications.test.ts
32 passed

pnpm typecheck
passed
```

This is prompt guidance, not a guarantee about arbitrary model behavior. A
future controlled comparison should measure no-op assistant prose, useful
interventions, and missed blockers before considering any further shortening or
schedule change.
