# Review: staged run-budget and stall sensors (2026-08-14)

First-cut review of the implementation later committed as `5436679c` on
`run-budget-stall-escalation`. 5 bugs, 8 suggestions.

**All 13 are resolved.** Each carries its disposition below. Two regressions the
review did not catch were found while verifying and are recorded at the end.

## Summary

This is a substantial, coherent first cut of staged run budgets and stall evidence: `RunBudget` correctly separates priced USD from unpriced tokens, pauses the clock across approval waits, latches stages, and re-arms critical after a finite grant. The main interactive path (loop interruption → `max_turns_exceeded` prompt → orchestrator grant → resume or wrap-up) is wired through the existing approval and notification surfaces rather than a new channel. The dominant risks are that “continue” is implemented in the UI orchestrator instead of the continuation path (so auto-approve/non-interactive resume becomes unbounded), that subagent warning/stall cannot actually be judged, and that every child inherits the full settings envelope with no `resolveLimits` clamp.

## Issues

### Issue 1 -- Severity: bug
- File: source/services/conversation/conversation-orchestrator.ts:807
- Description: A finite extension is granted only in `ConversationOrchestrator.handleApprovalDecision`. `ContinuationPlanApplier` treats a budget “continue” as a bare `approve()`, and non-interactive mode calls `session.handleApprovalDecision('y')` directly. After that resume, stages stay latched, so `evaluate()` emits nothing and the main run proceeds past an exhausted envelope with no further check-in. `--auto-approve` therefore turns the first warning into an unbounded run.
- Suggestion: Apply `grantExtension()` in the continuation path when a `run_budget_interaction` is accepted (applier or `state.approve`), and refuse continue when the grant is exhausted. Keep the orchestrator prompt as presentation, not the only grant owner.
- Status: resolved

### Issue 2 -- Severity: bug
- File: source/services/agent-stream.ts:51
- Description: `projectProviderItems` strips `cost_update` and other non-history events but not `run_budget`. `selectAgentStreamItems` therefore returns budget events as if they were provider items. Mentor continuation feeds that list into `SubagentSession.appendOutput`, so a fired stage can be written into the next request’s history despite the stream contract saying these events stay out of provider history.
- Suggestion: Treat `run_budget` like `cost_update` in `projectProviderItems` (return `[]`). Add a regression that `selectAgentStreamItems` drops budget events.
- Status: resolved

### Issue 3 -- Severity: bug
- File: source/services/subagents/subagent-notification-store.ts:532
- Description: Every `subagent_run_budget` event becomes a parent `budget` notification, including `soft`. The parent prompt then asks it to “continue only with a finite extension, steer, or stop.” Soft is supposed to be a one-shot wrap-up nudge in the child’s tool output, not an escalation.
- Suggestion: Enqueue only `warning`, `critical`, and `tool_stall`. Leave soft exclusively on `takeSoftEvidence` / `injectRunBudgetWarning`.
- Status: resolved

### Issue 4 -- Severity: bug
- File: source/services/agent-runtime/application-run-loop.ts:1465
- Description: Subagents set `wrapUpOnCriticalRunBudget`, so warning and stall never park the child. The parent is still told to grant a finite extension, but there is no child-targeted `grantRunBudgetExtension`, and a foreground child’s events are forced onto the background notification lane (`subagent-bridge.ts:167`) which only delivers after the parent tool returns. By then the child has either kept spending or already auto-wrapped. Steer/stop can still work for live background runs; continue-with-extension cannot.
- Suggestion: Park the child at warning/stall, deliver evidence to the parent, and resume only after an explicit finite grant, steer, or stop. For foreground children, surface the evidence on the in-flight parent tool rather than a post-hoc notification. Do not instruct the parent to grant an extension until that API exists.
- Status: resolved

### Issue 5 -- Severity: bug
- File: source/services/agent-runtime/permission-resolver.ts:203
- Description: `resolveLimits` still clamps only `AgentLimits` (turns/tokens/cost/timeout/children/depth/concurrency). Staged USD, unpriced tokens, and active time are read from process settings (`readRunBudgetPolicy`) and attached independently to every nested, async, and mentor run. A parent cannot tighten a child’s envelope, and N children each get the full $5 / 500k / 1h budget. Role `maxTurns` is also inert once `runBudget` is present, so the old parent→child turn clamp no longer contains those runs.
- Suggestion: Put the new dimensions on `AgentLimits` (or a sibling policy object), clamp them in `resolveLimits` the same way as turns, and pass the resolved policy into each child run instead of the raw settings snapshot.
- Status: resolved

### Issue 6 -- Severity: suggestion
- File: source/services/agent-runtime/agent-handle.ts:205
- Description: The `maxCost` preflight still rejects with “reliable provider-neutral pricing is unavailable,” and `AgentLimits.maxCost` is still documented as unsupported. Per-request `usdMicros` already exists and this change uses it for the settings-backed envelope, so the rejection is still the stale gate the plan called out.
- Suggestion: Enforce `maxCost` through the same priced-USD + unpriced-token fallback, or remove the rejection and point callers at `agent.runBudget`. Update the contract comment on `AgentLimits`.
- Status: resolved

### Issue 7 -- Severity: suggestion
- File: source/services/agent-runtime/application-run-loop.ts:1402
- Description: `MAX_IDENTICAL_TOOL_FAILURES` was removed entirely. Stall evidence now fires once and, for subagents, does not stop the child. A subagent can keep submitting the same failing call until the envelope hits critical. That matches “harness senses, judges choose” only if a judge can actually intervene in time (see Issue 4).
- Suggestion: Keep a local retry suppressor after the evidence has been emitted, or pause the child on stall until the parent/human answers.
- Status: resolved

### Issue 8 -- Severity: suggestion
- File: source/components/prompt/ApprovalPrompt.tsx:526
- Description: The shared decision vocabulary is continue-with-extension / steer / stop, and the orchestrator already handles `answer === 'steer'`. The prompt only offers Continue and Stop, so the steer path is dead for humans.
- Suggestion: Add a steer option that collects corrective text, or drop the unused `'steer'` branch until the UI exists.
- Status: resolved

### Issue 9 -- Severity: suggestion
- File: source/lib/agent-client.ts:844
- Description: `AgentClient` always attaches `readRunBudgetPolicy(...)`, which disables `MaxTurnsExceededError`. `agent.maxTurns` (default 100, still in settings/UI) no longer check-ins or terminates on this path; only `turnBackstop` (default 150) can fire, and only as critical. Existing configs that set `agent.maxTurns: 10` silently stop doing what they used to do.
- Suggestion: Either retire `agent.maxTurns` on the adopted path with a settings migration note, or seed `turnBackstop` from it so the live setting still means something.
- Status: resolved

### Issue 10 -- Severity: suggestion
- File: source/services/agent-runtime/run-budget.ts:211
- Description: `maxParentExtensions` caps every grant, including the human’s. For the main agent the parent *is* the human, so the planned “two parent grants, third goes to the human” path is unreachable: the third Continue only re-prompts “all extensions used” and cannot grant. The same cap is unused for subagents because they have no grant path.
- Suggestion: Count parent grants separately from a final human grant, or document that the human is hard-capped at two and change the prompt copy so Continue is not offered after the cap.
- Status: resolved

### Issue 11 -- Severity: suggestion
- File: source/services/agent-runtime/application-run-loop.ts:1505
- Description: `effect?: 'mutating'` was added to tool types but no production tool sets it. Stall reset depends on a name denylist (`apply_patch` / `create_file` / `search_replace`). A new write tool, or a mutating `shell`, will not reset the sequence; a TDD loop that edits via an unnamed tool can still look like a stall.
- Suggestion: Mark the write tools with `effect: 'mutating'` now and drop the name fallback once they all declare it. Keep the denylist only as a temporary bridge.
- Status: resolved

### Issue 12 -- Severity: suggestion
- File: source/services/agent-runtime/execution-budget.ts:17
- Description: Tree-aggregate `ExecutionBudget` (tokens/children/depth/concurrency) and per-run `RunBudget` are still separate and do not report into each other. That is not a third owner — `RunBudget` lives on `RunState` — but the tree still cannot see USD/time stages, and a child can exhaust $5 while the tree token budget still looks healthy (or the reverse).
- Suggestion: Have the run loop report priced/unpriced usage into `ExecutionBudget`, or give the tree budget staged USD/time limits, so the two views cannot disagree about containment.
- Status: resolved

### Issue 13 -- Severity: suggestion
- File: source/services/agent-runtime/application-run-loop.ts:1505
- Description: The `toolEffect` comment narrates a future factory migration instead of stating the non-obvious constraint (why these three names count as mutations).
- Suggestion: Replace it with a one-line why, or delete it once tools declare `effect`.
- Status: resolved

## Dispositions (2026-08-14)

1. **Grant moved into the run loop.** `state.approve` on a `run_budget_interaction`
   now charges the extension itself, so the continuation applier, non-interactive
   mode, and `--auto-approve` are bounded by construction. The interactive prompt
   still takes its grant up front — it must show a refusal rather than stop
   silently — and marks it consumed so it is not charged twice.
2. **`run_budget` stripped** in `projectProviderItems`, with `agent-stream.test.ts`
   added (the file had no test at all).
3. **Soft no longer escalates.** The notification store drops it; soft reaches the
   child through its own tool output only.
4. **Stopped promising an unreachable action.** No child-targeted grant API exists,
   so the parent notification now offers steer or stop and says that doing nothing
   is a valid judgement. Parking the child pending judgement was not built; it is
   recorded as open below.
5. **Clamped where a parent is actually reachable.** `clampRunBudgetPolicy` holds a
   child to the tighter envelope, fed by `RunBudget.remainingPolicy()` through the
   parent's tool context. This covers nested subagents — the depth × children path
   the plan calls the sharpest risk. Mentor and async runs have no parent tool
   context and still take the settings envelope; see open items.
6. **Rejection kept, reason corrected.** Pricing exists; what is missing is a route
   from a per-handle `maxCost` to the run envelope. Silently accepting an
   unenforced ceiling would be worse than refusing, so the message now points at
   `agent.runBudget.maxUsdMicros`. Contract comments updated in three places.
7. **Stall evidence re-arms for the run itself.** It now fires on every further
   multiple of the threshold into the child's own tool output — the nearest judge
   that can act mid-stream — while the parent's copy stays exact-once. No silent
   suppressor was reinstated.
8. **Dead `steer` branch removed.** Nothing produces `answer === 'steer'`;
   collecting corrective text needs an input surface this prompt does not own.
9. **`agent.maxTurns` means something again.** `turnBackstop` is the tighter of the
   policy value and the live setting.
10. **Parent and human grants counted separately.** `maxParentExtensions` caps
    unattended and parent grants; the human is the terminal judge and is uncapped,
    which is what makes the plan's "route the third past the parent" reachable.
11. **Write tools declare `effect: 'mutating'`** (`apply_patch`, `create_file`,
    `search_replace`) and the name denylist is gone.
12. **Not addressed by design.** `ExecutionBudget` and `RunBudget` remain separate
    views; reconciling them is still an Open item in the plan.
13. **Comment replaced** — the helper it narrated no longer exists.

### Found while verifying, not in the review

- **`event.event` broke the stream-boundary guard.** `application-stream-boundary`
  forbids that shape in the canonical consumers because it reads as a retired SDK
  envelope. The payload is now `evidence`, which is also the better name.
- **The branch made an unrelated breaking settings change, now reverted.**
  `agent.maxModelRequestDurationMs` went from `nonnegative().default(0)` to
  `positive().default(300_000)`, which threw on any config still holding the old
  default — failing the whole settings file and refusing to start. The branch's
  premise was that 0 was unusable because it reaches `setTimeout(…, 0)`. That
  was true when the branch was cut and is no longer: main has since added
  `if (timeoutMs <= 0) return` to `GenerationDeadline`, so 0 deliberately means
  "no deadline" and is covered by a test. Main's schema stands.

### Still open after this pass

- No child-targeted grant API, so a subagent cannot be resumed with a finite
  extension; warning and stall reach the parent as information only.
- Mentor and async subagent runs are not clamped to a parent envelope.
- Sibling children can still sum past a parent's remainder; only per-child
  containment is restored.
