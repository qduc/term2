# Session rollover — agent-triggered handoff as the compaction alternative

Concept validated by a live experiment 2026-08-30 (see "Evidence" below), and by the overnight A/B
benchmark 2026-08-31 (see "Overnight benchmark results" below): the rollover
arm matched the human fix's blind-judge quality at ~2.2x lower cost. This doc
maps the concept onto the existing code and records the design decisions that
remain. The M1/M2 slice (milestone reminder + `session_rollover` tool) is
implemented on branch `session-rollover`, left unpushed pending user review;
nothing here is merged to main.

## Overnight benchmark results (2026-08-31, run by the rollover session)

Task `r-ws-session-lifetime` (rewound origin dbb0c47f, hidden evaluator =
that commit's own 8 tests, typecheck gate on). Same harness (term2
interactive in herdr), same model (`z-ai/glm-5.3-flash` via openrouter,
effort high — both arms resolved their effort the same way), same workspace
shape. One variable: arm 1 (full-session-ix) got the raw 12-line task;
arm 2 (rollover-session-ix) got a ~2.3KB rollover brief whose diagnosis
section externalized what the source session had already learned.

| metric | arm 1 full-session | arm 2 rollover |
| --- | --- | --- |
| deterministic evaluator | **FAIL** 7/8 | **PASS** 8/8 |
| blind judge (pooled, 3 samples, opus) | 4.33 ±0.58 | **9.67 ±0.58** |
| wall time | 4594 s (76.6 min) | 2331 s (38.9 min) |
| model calls | 128 | 84 |
| tokens (in-new / cached / out) | 168k / 11.0M / 157k | 95k / 4.4M / 75k |
| metered cost (provider-reported) | $0.2143 | $0.0964 |
| context at finish | 134k | 82k |

A human calibration candidate (the real dbb0c47f diff) scored 9.67 ±0.58 —
identical to arm 2, sample for sample. Arm 1's gap is concrete: its lifetime
fix lives outside the pool, so the hidden acquire-time retirement test fails
(evaluator FAIL), and it expanded scope into `retry-classifier` (6 files
touched vs arm 2's 3).

Caveats, stated honestly:

- **Single task, single sample of task shape.** This is one data point where
  the task's diagnosis could be cleanly externalized in prose. Tasks whose
  remaining work is mostly exploration (diagnosis NOT transferable in a
  brief) would shrink the rollover's advantage; the direction of the result
  should generalize, the magnitude should not be quoted.
- **The brief is doing real work.** Arm 2's quality is partly the departing
  session's diagnosis, paid for in the source session (excluded from both
  arms' meters). Rollover cost should be read as "continuation cost", not
  whole-task cost.
- Both arms ran concurrently on one machine, and cost was attributed by
  sessionId from the provider-traffic log (time-window attribution would
  have mixed three overlapping term2 sessions; `collect-cost.py`'s window
  mode was not used).
- Both arms used YOLO auto-approval; arm 1 hit its 60-minute run budget at
  102% and was harvested at its natural settle.
- Retrieval-tuning capture (for SessionBrowser): arm 2 issued exactly ONE
  session call — `session_search "session lifetime worktree commits"`
  (limit 3, maxChars 1200); zero session_list, zero session_read. The brief
  was ~fully self-sufficient. Arm 1, with no affordance, made zero calls
  (by design). Feeds the brief-self-sufficiency threshold and default page
  budgets noted in `session-retrieval-tuning-data` memory.

Verdict: **rollover holds up on this task** — quality parity with the human
fix, roughly half the wall time, ~2.2x lower metered cost, and a session
that ends at 82k context instead of growing past 130k. Proceed to the M1/M2
slice (milestone reminder + `session_rollover` tool) unpushed for review.

## The idea (user's proposal, 2026-08-30)

Instead of compacting a growing session, the agent itself can end it:

1. The harness injects a reminder system message when the context crosses
   token milestones (e.g. 200k, 300k) telling the agent to *start thinking
   about handing off*.
2. The agent calls a tool (e.g. `session_rollover`) passing a short handoff
   message: what was done, what is open, where durable state lives, how to
   retrieve anything that lives only in this session.
3. The harness ends the current session and starts a fresh one, injecting the
   handoff message as the new session's briefing so the agent resumes.

If it works correctly it replaces traditional compaction: no full-history
summarization request, no context floor — the new session starts at ~0 and
re-grows from what it actually retrieves on demand.

## Evidence (experiment, 2026-08-30)

A fresh term2 session (herdr tab, glm-5.3-flash) was given a ~40-line handoff
file pointing at repo docs + this session. It recovered the complete work
state — status, open decisions, recommendation — using **targeted doc reads
only** (it read one 50-line range of one doc), **zero transcript reads**, and
finished at **30k context / $0.0054, 97% cached** vs the source session's
209k. Full record: project memory `session-handoff-feature-experiment-2026-08-30`.

Two conditions made it work, and the design must protect both:

- **Durable state was already externalized** (repo docs). Reliability of a
  rollover scales with how much state the departing agent externalizes before
  firing; the briefing protocol must push that.
- **Session retrieval tools exist** (`session_list/search/read` via
  `SessionBrowser`). They make "point back at the old session" cheap and
  paginated instead of a blob re-read. This is the enabling substrate, not a
  nice-to-have.

## What already exists (code map, verified 2026-08-30)

The big discovery: **in-process session rotation is already built** for
`/clear`.

- `handleClearConversation` (`source/app.tsx:271`): `generateId()` →
  `onRotateWriter(newId)` → `conversationService.resetWithNewId(newId)` →
  `setSessionId` → `onSessionIdChange`. The log writer's `rotate()`
  (`conversation-log-writer.ts:492`) closes the old session log (with a
  `session_cleared` settling record) and opens a new one. New session id, new
  log, same process — exactly the "terminate + start" the idea needs, minus
  process teardown risk.
- **Agent-driven handoff precedent**: the existing model-handoff flow
  (`HandoffSession`, `source/services/handoff/handoff-session.ts`) already
  does capture-text → clear → compose message → `sendUserMessage` as the
  continuation. The rollover is the same shape, triggered by the agent
  instead of the user, with a briefing instead of a task re-send. Note the
  **naming collision**: `/handoff` already means model-switch handoff. This
  doc proposes `session_rollover` as the distinct name.
- **Token estimates at every request boundary**: `estimateContext` +
  `resolveCompactionThreshold` run in `agent-client.ts` (`#maybeCompactContext`,
  line ~170) for compaction policy. The milestone reminder can hang off the
  same estimate — no new measurement machinery.
- **System-message injection pipeline**: mode notices
  (`queueModeNotice`/`mode-notices.ts`), mid-turn injection vocabulary
  (Segment/Request Boundary/Injection, `docs/plans/mid-turn-injection.md`),
  `SubagentNotificationStore` active-turn injection, and the
  `large-uncached-input-guard` warning precedent. A "milestone reminder" is
  one more producer into this lane.
- **Tool registration**: `session-browser-tools.ts` shows the pattern for
  no-approval tools wired to a service (`needsApproval: () => false`); tools
  are registered in `agent.ts`.
- **Session retrieval across sessions**: `SessionBrowser`
  (`source/services/conversation/session-browser.ts`) lists/searches/reads
  persisted conversations for the project; `session_list` already surfaces
  `firstUserMessage`, which is where the briefing should live so the next
  generation finds it without reading anything.

## Design

### Tool: `session_rollover`

Registered in `agent.ts` like the session-browser tools. Parameters
(zod-strict): `brief` (required string, bounded — e.g. ≤ 8k chars),
`reason` (optional enum: `context_pressure` | `task_boundary` | other).
`needsApproval: () => false` — ending your own session is not a destructive
act; the harness, not the user, arbitrates (but see "When is it allowed").

Execution path (the one genuinely new orchestration piece):

1. **Marker on the old session**: append a terminal record to the old log —
   new log event `session_rollover` (`{ reason, brief }` or a pointer to
   where the brief is stored) so `--resume` of the old session and the audit
   trail both show how it ended. Precedent: `session_cleared` settles the
   turn; rollover should settle + mark.
2. **Rotate**: reuse the `handleClearConversation` sequence. Architectural
   question flagged below: that sequence lives in `app.tsx` (UI layer); the
   tool executes inside the session runtime. The rotation policy belongs in
   the session layer (`SessionRuntime` gains `rollover(brief)`, composed in
   `session-composition.ts`), with the UI subscribing to a
   session-rotated event to update `sessionId`/banner state — inverting the
   current UI-owned flow, which is the right ownership per the architecture
   skill (lifecycle policy with the domain owner).
3. **Briefing injection**: start the new session's first turn from the brief,
   composed by a protocol template so every rollover carries the same
   skeleton: state summary, durable-state pointers, old session id
   (`session_read` target), retrieval budget ("search/read specific records;
   never replay the whole transcript"), and the bounded next step. Send it
   through the normal turn path (it is a real user-visible turn, matching the
   model-handoff precedent) but marked so the UI can present it as a
   rollover, not a user message.

### Reminder injection (milestones)

Where: alongside the existing compaction estimate at the request boundary in
`agent-client.ts` — when `renderedInputTokens` crosses a configured milestone
and has not been reminded for that milestone yet, queue a system reminder
via the existing injection lane. Copy: *"Context is at N tokens. If the
current task has reached a natural boundary, externalize state (docs/memory)
and consider calling `session_rollover` with a handoff brief. Compaction will
trigger automatically at T."* Settings: `agent.sessionRollover.enabled`,
`agent.sessionRollover.milestones` (default e.g. [200k, 300k, 400k...]),
`agent.sessionRollover.autoBrief` — the reminders are advice; the tool call
remains the agent's decision. The reminder must dedupe per milestone
(`shouldDeferAutomaticCompaction` is the dedupe precedent).

### Guard conditions (when the tool is allowed to fire)

The tool must refuse (with a clear tool-error, not a crash) when:

- A turn is actively executing — rollover is an idle-boundary operation.
  (The tool call itself arrives during a turn; the rotation must be deferred
  to that turn's settlement, like background-event injection defers to
  turn boundaries — defer-to-idle, not abort-the-turn.)
- Background work is live: background shell jobs and unadopted subagent runs
  do not survive a session end (`conversation-replay.ts:881` already carries
  this exact warning for interrupted sessions). Either block rollover while
  `backgroundTaskControl` shows live items, or require the brief to name
  them; blocking is the honest default for v1.
- A pending approval / pending interaction exists.

### Provider/cache implications (favorable)

A new session id means a fresh `providerHistoryKey`, so provider continuity
starts clean — no `previous_response_id` to drop, no chain recovery, and the
briefing turn is a tiny request. The old session's server-side state/cache is
simply abandoned (writes were already paid; nothing is re-billed). Compare
compaction: it pays a full-history summarization request *and* rebuilds the
prefix. Rollover's only mandatory cost is writing the brief. Follow-up: check
whether the per-session WebSocket transport (keyed by
`providerHistoryKey ?? sessionId`) closes the stale socket on rotation or
leaks it until dispose — implementation detail for the slice.

## Decisions still open

1. **Rotation ownership** — chosen for M2: the narrower bridge. The tool
   records one rollover request in the session client; the app consumes it
   after turn settlement, logs the marker, reuses the existing
   `handleClearConversation` sequence, and sends the brief as the new
   session's first user turn. Rotation is deliberately not lifted into
   `SessionRuntime` in this slice because `app.tsx` already owns the
   writer/session-id/UI reset sequence; the broader inversion (still open
   for later) would move that sequence behind `SessionRuntime` + UI
   subscribers.
   Decision shapes the slice's size.
2. **Where the brief lives**: (a) as the new session's first turn only
   (searchable via `firstUserMessage`), (b) also written to a file under the
   runtime dir, (c) embedded in the `session_rollover` log event. Recommend
   (a) + (c); (b) only if briefs grow large.
3. **Naming**: `session_rollover` vs keeping "handoff" (collides with the
   model-handoff flow). The user's word is "handoff"; the codebase's is
   taken.
4. **Auto-rollover policy**: should the harness ever fire rollover itself
   (e.g. at hard context pressure, replacing auto-compaction), or is it
   strictly agent-triggered advice? v1: agent-triggered only; auto mode is a
   later experiment that must clear the real-run-comparison bar.
5. **Validation plan** (standing rule: no efficiency claim ships on
   inference): rerun the herdr experiment as a *continuation* test (new
   session keeps working productively, not just reporting state), then a
   mid-task compaction-vs-rollover cost/quality comparison on a real long
   task. The prototype can be built before this but the comparison gates any
   default-on behavior.

## Minimal slice proposal

- M1: milestone reminder injection (settings + reminder producer + tests) —
  small, independent, immediately useful.
- M2: `session_rollover` tool + idle-boundary rotation + briefing turn +
  `session_rollover` log event. The core. Needs decision 1.
- M3: guard refinements (background-work blocking), UI presentation
  (rollover banner), docs (`CONTEXT.md` vocabulary), then the validation
  runs from decision 5.
