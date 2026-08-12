# Background task UI — “Waiting for provider” research

Status: research notes. No production code was changed.

## Finding

“Waiting for provider” is an honest statement that no currently observable
provider progress is available, but it is too coarse and can be effectively
unbounded. A newly created async run is initialized as `waiting` with reason
`provider` (`source/services/subagents/subagent-async-registry.ts:227-255`), and
each new segment marks the same state before execution starts
(`source/services/subagents/subagent-async-registry.ts:663-667`). The activity
normalizer returns `waiting` before it evaluates the quiet threshold
(`source/services/session/background-task-liveness.ts:33-45`), so a provider
wait never becomes `quiet` merely because its last event is old.

The state changes only when the registry receives an owned event. Streaming/text
events mark the run active, approval events mark it waiting for approval, and
command messages mark it active while pending/running or provider-waiting after
completion (`source/services/subagents/subagent-async-registry.ts:428-485`). An
orchestrator question is separately marked waiting for an answer
(`source/services/subagents/subagent-async-registry.ts:744-759`). The runtime
routes registry-owned events before the ordinary event sink
(`source/services/subagents/runtime.ts:47-62`), and the session control port
normalizes the registry status and timestamps into UI details
(`source/services/session/background-task-control.ts:286-328`).

The compact panel then renders the normalized state and age, including
`Waiting for provider · last activity … ago`
(`source/components/layout/BackgroundTasksPanel.tsx:69-110`). The manager uses
the same state vocabulary, but its list status omits activity age and its detail
view omits the activity object entirely (`source/components/layout/BackgroundTaskManager.tsx:38-88`).

## What the current contract cannot tell the user

- There is no provider-request-start, provider-response-start, retry-attempt, or
  request-id field in the subagent event union. Subagent events cover start,
  tool/text/command activity, approval, and completion
  (`source/services/conversation/conversation-events.ts:172-228`); retry events
  are generic and have no subagent identity in their declared shape
  (`source/services/conversation/conversation-events.ts:40-47`). The execution
  runner knows the selected provider and model internally, but emits only
  subagent activity events and usage/retry notifications
  (`source/services/subagents/execution-runner.ts:192-237`,
  `source/services/subagents/execution-runner.ts:269-357`). Thus “provider” does
  not currently mean “the provider accepted this request” or identify which
  provider/model is involved.
- `SubagentRunStatus` exposes timestamps, last tool, bounded text, pending tools,
  and the coarse activity fields, but no activity summary, provider, model,
  request phase, retry attempt, or request id
  (`source/services/subagents/types.ts:223-250`). The session-facing control
  union likewise has no `activitySummary` or usage field
  (`source/services/session/background-task-control.ts:24-53`).
- The planned liveness note promises `activitySummary` and manager details for
  last observed activity/source/summary (`docs/plans/background-work-control/liveness-ui.md:29-51`,
  `docs/plans/background-work-control/liveness-ui.md:89-90`), but the current
  implementation has only state, reason, and timestamp
  (`source/services/session/background-task-liveness.ts:6-13`). This is a
  documentation/implementation gap, not evidence that the provider is hung.

## Cramped layout and context usage gaps

The panel puts the task label and status in one horizontal row. The label is
allowed to shrink, while the status box is explicitly non-shrinking
(`source/components/layout/BackgroundTasksPanel.tsx:119-144`). The status itself
can contain state, total elapsed time, “last activity”, and reason
(`source/components/layout/BackgroundTasksPanel.tsx:97-110`), so narrow terminals
trade away task identity before they trade away status. The manager list has the
same unmeasured single-line shape — role, full task label, and status are emitted
in one `Text` row (`source/components/layout/BackgroundTaskManager.tsx:249-255`).
Neither component receives terminal width; the panel props are only tasks and a
clock (`source/components/layout/BackgroundTasksPanel.tsx:9-12`), and BottomArea
passes those same values without a width/layout policy
(`source/components/layout/BottomArea.tsx:320-323`).

Usage is available, but currently follows a legacy path. A subagent
`usage_update` carries an optional `agentId` (`source/services/conversation/conversation-events.ts:111-120`),
and the execution runner emits it with the subagent id
(`source/services/subagents/execution-runner.ts:323-339`). The notification store
records it on its legacy `BackgroundTask` snapshot
(`source/services/subagents/subagent-notification-store.ts:252-261`), while the
control details used by the current BottomArea do not carry usage
(`source/services/session/background-task-control.ts:24-53`). Because BottomArea
chooses control details when present (`source/components/layout/BottomArea.tsx:320-323`),
the panel’s `Ctx …` suffix is guarded to legacy tasks only
(`source/components/layout/BackgroundTasksPanel.tsx:140-142`).

`NormalizedUsage` contains token counts but no context limit
(`source/utils/ai/token-usage.ts:5-14`). A model catalog can provide a
provider/model context window when known (`source/providers/model-catalog/catalog.ts:3-15`,
`source/providers/model-catalog/catalog.ts:160-162`), but the current background
details do not carry the provider/model needed to safely join those values. The
UI should therefore show an absolute `Ctx 12.3k` when prompt usage is known; it
should show a percentage or `12.3k / 128k` only after the control seam carries a
known, matching context window. With an unknown limit, omit the percentage rather
than guessing from `maxTokens`, which is a separate catalog field
(`source/providers/model-catalog/catalog.ts:3-15`).

## The contract needs three independent axes

The current `BackgroundTaskActivity` overloads two concerns: `waiting` is a lifecycle reason, while `quiet` is an inference from the age of the last observation. `normalizeBackgroundTaskActivity()` must choose one, and it gives known waits precedence over the quiet threshold (`source/services/session/background-task-liveness.ts:16-45`). That is why an old provider wait remains simply `waiting`.

Do not make a long provider wait transition to `quiet`. Preserve both facts in a presentation-neutral control contract instead:

```ts
{
  state: 'waiting',
  reason: 'provider',
  lastObservation: { kind: 'request_dispatched', at: 1_723_456_789_000 },
  liveness: { state: 'recent' | 'quiet', ageMs: number },
}
```

This lets the UI truthfully say both `Awaiting provider response` and `No activity observed for 2m 14s`, without calling the task failed or hung. It also gives deterministic tests independent assertions: the lifecycle state has not changed, while its evidence has become old.

`lastObservation.kind` should be a closed, event-shaped union owned by the runtime/session seam, rather than a display-ready `activitySummary: string`:

```ts
type BackgroundTaskObservationKind =
  | 'request_prepared'
  | 'request_dispatched'
  | 'response_started'
  | 'text_received'
  | 'tool_started'
  | 'tool_completed'
  | 'retrying'
  | 'approval_requested'
  | 'question_asked';
```

Ink maps that stable vocabulary to words such as `Request handed to provider`, `Running read_file`, or `Retrying · attempt 2`; the source state never claims that a remote provider accepted or is processing the request. The execution runner already owns the local seam before it awaits `runtime.turns.start()` and when it receives text/tool events (`source/services/subagents/execution-runner.ts:269-357`), while the async registry remains the right owner of retained observations and the control port remains the UI boundary. A provider-specific request id or queue phase is a later optional extension, not a prerequisite.

Retry needs one small event-contract correction. The runner emits retry events with `agentId`, but the declared generic retry event does not carry that identity (`source/services/subagents/execution-runner.ts:347-357`, `source/services/conversation/conversation-events.ts:40-47`). Make `agentId` part of the declared event and retain retry attempt/backoff evidence in the registry so a retry never looks like unexplained provider silence.

## UI alternatives

| Alternative | Truthfulness | Implementation tradeoff |
| --- | --- | --- |
| **1. Rename and age the current state** — render `Awaiting provider event · 18s` (or `Waiting for provider response · 18s`) and keep `Quiet · no observed progress` for states that can be quiet. | High: explicitly says what was observed, not what the remote provider is doing. | Smallest change, but it still cannot identify provider/model, retry, or phase. It also requires deciding whether provider-wait should eventually normalize to quiet. |
| **2. Add an activity summary/phase contract** — carry bounded values such as `Submitting request`, `Waiting for first token`, `Retrying 2/3`, `Running read_file`, and optional provider/model. | High if values are emitted only at real runtime seams; “waiting for first token” remains a bounded observation. | Medium seam change across runtime events, registry status, and control details. This fulfills the existing `activitySummary` plan but needs provider-neutral event definitions and retry attribution. |
| **3. Responsive two-tier panel** — first line keeps `[role] task label · state`; second indented line carries elapsed/last-activity/summary only when width permits. Truncate the label based on measured available width, and let the manager’s detail view hold the full evidence. | High: layout changes presentation, not lifecycle meaning. | Medium Ink work. It avoids the current non-shrinking status box consuming the row, and can be tested at narrow widths without changing registry semantics. |
| **4. Context-aware detail card** — add `Ctx 12.3k` to the selected-task detail, and append `/128k (9%)` only when a catalog limit is authoritative; keep the compact row to a short `Ctx 12k` badge or omit it when unknown. | High: absolute usage is useful evidence; percentages are conditional rather than fabricated. | Medium data plumbing: retain latest `usage_update` in control details and associate the run with provider/model. No context percentage should be shown until that association is reliable. |
| **5. Separate lifecycle from liveness** — retain state/reason, the last event-shaped observation, and an independent recent/quiet liveness assessment. | High: a task can be both waiting for a provider and have no recent observed activity. | Medium contract migration, but it removes the overloaded enum and makes state-based tests deterministic. |

## Recommendation

Implement Alternative 5 first, then combine Alternatives 2 and 3 and add the
conditional context detail from Alternative 4. The control seam should expose
the event-shaped last observation, independent liveness, and the timestamp;
the panel should use a deliberate two-line hierarchy so the task identity
remains readable. Keep provider waits, approval waits, and answer waits as
lifecycle reasons; do not use `quiet` as a replacement lifecycle state.

Recommended compact form:

```text
• [Explorer] audit provider fixtures
  Awaiting provider response · sent 18s ago
  Last: Request handed to provider · Ctx 12.3k
```

After a generous UI-only threshold, retain the lifecycle line and emphasize the
evidence instead: `No activity observed for 2m 14s ⚠`. The detail copy should
say that the task may still be running. Make this threshold configurable and
test it with an injected clock; it is an attention cue, never a correctness
boundary. On a narrow terminal, use an explicit information budget (state and
age only), rather than relying on flexbox to decide what is truncated. The
manager is the source-of-truth view: it should show state, observation, age,
started time, model/provider, conditional context gauge, retry count, and last
tool. Do not call silence “hung”: the existing tests explicitly require quiet
work to remain stoppable and not be labelled hung
(`source/components/layout/BackgroundTaskManager.test.tsx:119-136`), and the
liveness plan explicitly defines quiet as “no observed progress,” not a
failure (`docs/plans/background-work-control/liveness-ui.md:60-71`).
