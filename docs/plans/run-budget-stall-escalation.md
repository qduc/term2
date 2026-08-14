# Run budgets as staged escalation, and stall evidence instead of turn caps

Status: **implementation in progress** on `run-budget-stall-escalation`
(`5436679c`). First-cut review is in
`docs/plans/run-budget-stall-escalation-review.md` — 5 open bugs, 8 open
suggestions. Fix those before merge.

## Resume here

A first-cut implementation is on this branch. Start from the review, not by
re-deriving the sensors: `docs/plans/run-budget-stall-escalation-review.md`.
Priority bugs: grant extensions on the continuation path (not only the UI
orchestrator), clamp child envelopes in `resolveLimits`, keep `run_budget` out
of provider history, park subagents at warning/stall so a parent can judge, and
do not escalate soft-stage events to the parent.

The change this plan makes: **the harness detects mechanically and escalates
evidence; an agent with broader context decides what to do about it.** Today the
turn budget conflates those two jobs — `ApplicationRunLoop` counts turns and, on
overrun, throws (`application-run-loop.ts:684`), which unwinds the run and
discards its work. The count is a bad proxy for "too much work" and the throw is
a bad response to it.

Replace it with two triggers feeding one escalation surface:

1. **Staged budgets** on dimensions that actually mean something — tokens, USD,
   wall clock — with three latched stages: nudge, escalate, terminate.
2. **Deterministic stall evidence** — identical tool call and arguments repeated
   with no intervening mutation — reported as evidence, never as a verdict.

Both produce the same event with the same decision vocabulary: *continue with a
finite extension*, *steer*, *stop*. One emitter (the run loop), one judgment
surface.

Decisions already taken, so they are not re-litigated:

- **Only subagents auto-terminate.** The main agent never does. Killing a
  foreground turn mid-edit is worse than overspending, and a human is present to
  act. Main agent at critical stage gets a blocking prompt; the subagent gets
  forced wrap-up. This asymmetry is the point of the design, not an oversight.
- **Termination means summarize-then-stop, not abort.** A subagent's partial
  work is most of its value. At critical, it gets exactly one more model call
  with tools disabled and a terminal instruction to report what it completed and
  what remains. Hard abort only if that call itself overruns.
- **Extensions are finite and countable.** A parent granting "continue" grants a
  specific additional amount, never open-ended permission. Cap grants per run
  (two), and route the third past the parent to the human. Without this, the
  approval loop silently becomes the unbounded thing the turn cap was there to
  prevent.
- **Turn count survives as a backstop only.** Set it high enough that it never
  fires in normal operation (100–200). It is the infinite-loop tripwire, not the
  operating limit, and it should emit the same evidence rather than throwing.
- **Anomaly detection does not replace a cost ceiling.** It catches an agent
  doing the *same* thing forever; it is blind to an agent doing *different*
  things forever. Those are independent failure modes and both need coverage.

Premises that were checked against the code and turned out to be wrong — do not
rebuild the plan on them:

- **"Cost accounting would have to be built."** It exists. `RunState.costRecords`
  (`application-run-loop.ts:196`) accumulates one `ModelRequestCost` per request
  and is preserved across continuation, so an approval round-trip does not reset
  it. Each record carries normalized usage and `usdMicros`
  (`services/cost/model-cost.ts:34`). Token and USD budgets are readable from
  state the loop already keeps.
- **"`maxCost` cannot be enforced — there is no provider-neutral pricing."**
  That premise is stale and is currently encoded in two places: the preflight
  rejection at `agent-handle.ts:209` and the contract comment at
  `agent-runtime/types.ts:82`. The vendored pricing catalog behind
  `ModelRequestCost.usdMicros` postdates it. Enforcement is now possible for
  priced requests; the real remaining gap is *unpriced* requests
  (`unpricedReason`), which must fall back to tokens rather than silently
  counting as zero.
- **"Repeated-failure detection has to be built from scratch."** A narrow version
  already runs: `countRepeatedFailure` keys on tool name + params + error message
  and, past `MAX_IDENTICAL_TOOL_FAILURES = 2` (`application-run-loop.ts:1169`),
  stops inviting retries. It is a silent local intervention with no escalation
  and no evidence. This plan generalizes and surfaces it; it does not invent it.
- **"`ExecutionBudget` already covers subagent limits."** Partly. It tracks
  aggregate tokens, children, depth, and concurrency across the tree
  (`execution-budget.ts:17`) and the subagent runners do call `recordUsage`
  (`nested-runner.ts:665`, `execution-runner.ts:381`). But `maxTurns` never
  reaches it — the runners pass `definition.maxTurns` straight through to the
  client (`nested-runner.ts:366`, `execution-runner.ts:228`), which lands on the
  run loop's own counter. There are two budget owners, and they do not know
  about each other.

## Destination

A long-running agent is bounded by what it spends and by whether it is making
progress, not by how many times it called a model. When either bound is
approached, someone with enough context to judge — the parent agent, or the
human — is shown concrete evidence and given a finite decision. Runs that must
end, end with a report rather than an exception.

## Decided

- **A budget is a containment envelope, not a workload estimate.** Defaults are
  set deliberately generous: a healthy run rarely reaches Warning and almost
  never reaches Critical. The envelope answers "what would be alarming?", never
  "what should this task cost?" Anyone tuning defaults by measuring typical runs
  and adding margin has misread the purpose — that produces a limit that fires on
  ordinary long work, which trains everyone to wave escalations through.
- **Therefore stages trigger on remaining absolute headroom, not on percentages.**
  A wrap-up nudge at 60% of a generous envelope arrives while the run is nowhere
  near done, so it is noise. Each stage is defined by how much room is left —
  enough to wrap up, and not much more.

  | Stage | Trigger | Who acts | Effect |
  | --- | --- | --- | --- |
  | Soft | Headroom left is roughly one wrap-up's worth | The run itself | Wrap-up nudge injected into tool output. No escalation, nobody interrupted. |
  | Warning | Headroom left is roughly one more work segment | Parent agent (or human, for the main agent) | Evidence notification; decision is continue-with-extension / steer / stop. |
  | Critical | Envelope exhausted, including granted extensions | Harness | Subagent: forced summarize-then-terminate. Main agent: blocking prompt. |

  Each stage fires once per run, latched. A run hovering at a threshold must not
  notify its parent every turn.
- **Reaching Warning is itself evidence.** Because the envelope is generous, the
  arrival is abnormal by construction, and the notification should say so rather
  than presenting a neutral percentage. Reaching Critical is closer to a defect
  report than a routine outcome and should be logged at a level that makes it
  findable after the fact.

- **Soft stage reuses what exists.** `injectTurnLimitWarning`
  (`utils/inject-warning-into-tool-output.ts:32`) already does exactly this,
  hardcoded to turns with a threshold of 5. Generalize it to report the nearest
  exhausted dimension. Note the current failure mode this fixes: when `maxTurns`
  is undefined the function silently becomes a no-op, so removing turn budgets
  today would quietly delete the wrap-up behavior too.
- **The run loop owns both counters, so it owns both detectors.** It already
  exposes the budget to tools through the `toolContext.turn` getter
  (`application-run-loop.ts:562`) — deliberately a getter, because the context
  object outlives every turn. Budget state generalizes along the same seam.
- **Evidence is emitted, not thrown.** A stage transition is a run event; the run
  keeps going while judgment happens. Only critical-stage termination ends a run,
  and it does so through the wrap-up path.
- **Delivery reuses the existing notification lane.** Background subagent
  completion and question notifications already reach the main agent through
  `SubagentNotificationStore`
  (`services/subagents/subagent-notification-store.ts`), which injects at a
  request boundary or opens a hidden model-only turn while idle. A budget or
  stall escalation is a third member of `BackgroundSubagentNotification`, not a
  new channel. Read `docs/plans/mid-turn-injection.md` before touching it.
- **The main agent's escalation target is the human.** "Escalate to the parent"
  has no answer when the main agent is the one overrunning, which is the common
  case. That path already has UI: the `max_turns_exceeded` approval prompt
  (`conversation-orchestrator.ts:675`, resolved at `:726`/`:731`). Reuse it,
  carrying evidence and granting a finite extension instead of today's bare
  "Please continue with your previous task."
- **Wall clock excludes time blocked on approval.** A background subagent paused
  waiting on a human must not burn its budget doing nothing.
- **Parent→child clamping extends to whatever replaces turns.** `resolveLimits`
  (`permission-resolver.ts:214`) already clamps every dimension of `AgentLimits`
  so a child can be more restrictive but never less. Nested amplification across
  depth × children is the sharpest subagent risk; the new budget must be clamped
  the same way.
- **Stall detection starts with the unambiguous signal only.** Byte-identical
  tool name and arguments, N times, with no mutating call in between. The wider
  signals — "no observable state change", "bouncing between a small set of
  actions" — need a definition of observable state that does not exist yet.
- **A red test run repeatedly is not a stall.** "Same command failed 5 times with
  3 intervening edits" is the normal TDD loop seen from outside. Distinguishing
  it needs to know whether the edits touched anything the failure depends on,
  which is a semantic judgment the detector must not attempt. This is precisely
  why evidence goes to an agent instead of triggering an action. A detector that
  fires on real work gets ignored, and then it protects nothing.

## Open

- **Budget denominator** — Tokens, USD, or both. Unpriced requests must degrade
  to token accounting rather than counting as zero cost.
- **What "one wrap-up's worth" and "one work segment" are in absolute units** —
  the stage triggers are defined in headroom, so they need concrete numbers per
  dimension. These are the only figures that should come from observing real
  runs; the envelope itself must not.
- **Testing machinery that rarely runs** — a generous envelope means extension
  grants and forced wrap-up almost never execute in practice, so they will rot
  unless exercised deliberately. Decide whether that is a test-only injectable
  budget or a debug setting before building the grant path.
- **Reconciling the two budget owners** — `ExecutionBudget` holds tree-aggregate
  tokens; `RunState` holds per-run cost records. Staged budgets need a per-run
  view *and* a tree view. Decide whether `ExecutionBudget` gains stages or
  whether the run loop reports into it, before writing either.
- **Whether `MAX_IDENTICAL_TOOL_FAILURES` stays as a local intervention** once
  the same signal escalates. Two mechanisms on one signal risks the loop
  suppressing the retry before the evidence ever gets judged.
- **Where a foreground subagent's warning lands** when its parent is mid-turn and
  the user is watching — the parent's judgment costs a model call the user did
  not ask for.

## Fog

- Whether the parent agent is actually good at this judgment. The design assumes
  broader context produces a better call than a threshold does; nothing has
  tested that, and a parent that always answers "continue" makes the whole
  mechanism theater.
- Whether soft-stage nudges change subagent behavior at all, or just add tokens.
- How stall evidence should read for a model versus for a human. The same
  payload probably cannot serve both.

## Out of scope

- Predicting cost before a request. Accounting stays post-hoc.
- A new notification channel, a new approval surface, or a second decision
  vocabulary.
- Cross-session or per-day spend caps. This is per-run.
- Changing provider wire formats or usage normalization.

## Found in the territory

- 2026-08-11: The turn budget is not really a limit on the main agent — it is a
  check-in. Overrun becomes a y/n prompt that resumes with a canned "continue"
  message. Removing it costs the check-in and the wrap-up nudge, not a ceiling.
- 2026-08-11: On subagents it *is* the only termination guarantee. Default 20
  from `ROLE_MAX_TURNS_DEFAULT` (`services/subagents/role-loader.ts:18`), clamped
  against the parent at `permission-resolver.ts:220`.
- 2026-08-11: Per-request USD is already recorded and already survives
  continuation. The `maxCost` "unsupported" rejection is now the stale part, not
  the missing capability.
- 2026-08-11: Identical-failure detection already exists in the run loop, but as
  a silent retry suppressor rather than as evidence.
