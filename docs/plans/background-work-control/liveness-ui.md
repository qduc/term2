# Background-task observation and liveness UI

Status: completed with adversarial-review corrections (2026-08-13); awaiting branch re-review before merge.

Research: [waiting-for-provider-ui-research.md](waiting-for-provider-ui-research.md).

## Resume here

Review correction note (2026-08-13): adversarial review found identity drift in
the live manager snapshot, presentation-observation races after cancellation,
premature tool completion, mutable foreground model resolution, pooled mentor
model ambiguity, unbounded provider-derived labels, response-stream boundary
drift, and an ineffective medium-width budget. Public-seam regressions now cover
reordered/removed stop and transfer targets; buffered subagent and shell events
after cancellation; running, successful, and failed commands; immutable
foreground launch metadata (including a later resolver failure); a two-model
mentor pool; bounded control-character-safe tool labels; three-chunk and next-
boundary text streams; and exact medium/narrow width thresholds.

Final correction verification is green: the six exact focused commands below
pass 122 tests; the expanded correction focus passes 128 tests; typecheck and
build pass; the full suite passes 6,122 tests with two skips; provider black-box
passes 166 tests with one intentional skip; lint/Prettier passes with 46 existing
warnings and no errors; and `git diff --check` passes. Merge remains gated on
review of the correction commit.

Closure note (2026-08-13): the final presentation audit also closed two sink
gaps. Manager tool-count keys are sanitized individually without changing the
raw accounting map, capped at 24 terminal cells per name, and summarized in an
80-cell aggregate with `… +N more`. The compact first line now reserves the
lifecycle phase before allocating the remaining physical terminal cells to
task identity. Ink `renderToString` regressions use matching policy and physical
widths at 40, 71, 72, 103, and 104 columns across named, foreground, shell,
retained-terminal, and wide-context rows. The complete five-member command
status union is parameterized through the registry contract; no lower-layer
behavior changed in this closure pass. The closure focus passes 100 tests;
typecheck and build pass; the full suite passes 6,133 tests with two skips;
lint/Prettier passes with the same 46 existing warnings and no errors; and
`git diff --check` passes. Provider black-box was not repeated because the
closure production diff is confined to Ink presentation and a local text-
budget helper; the registry/runtime/event implementations are unchanged.

Implementation note (2026-08-13): all six original slices are implemented. The shared observation protocol now lives in
`source/services/background-task-activity.ts`; the control port projects phase,
last observation, and derived liveness separately. Async runs retain launch-time
model metadata and latest request usage. The focused contract/registry/control/UI
suites, full test suite, typecheck, build, lint/Prettier, and provider black-box suite are green.

The first liveness delivery is already merged: the session control port projects
registry activity, the compact panel distinguishes active/waiting/quiet work,
and Ctrl+G is the task-manager shortcut. Do not repeat that shortcut migration.

The remaining defect is contractual. `BackgroundTaskActivity` represents a
lifecycle phase (`waiting` for a provider) and an evidence-age conclusion
(`quiet`) in one exclusive enum. Consequently, a long provider wait can only
remain `Waiting for provider`, even though the UI also needs to say that no
evidence has arrived recently. The compact panel then crams task identity,
phase, elapsed time, and evidence age into one row; it also misses background
subagent context usage because control details omit it.

This plan replaces that overloaded presentation contract. It does not change
the execution or cancellation lifecycle.

## Outcome

Every active background task has three independently true facts:

```ts
{
  phase: 'waiting',
  reason: 'provider',
  lastObservation: { kind: 'request_dispatched', at: 1_723_456_789_000 },
  liveness: { state: 'recent' | 'quiet', ageMs: number },
}
```

The compact panel answers “should I care?” without sacrificing the task name;
the manager answers “what exactly happened?” A long silent provider request is
visually worth attention but is never called hung or failed. Context is shown
as the most recent request's prompt tokens and gains a fraction/percentage only
when the same subagent's model has a known context window.

Example at normal width:

```text
• [Explorer] audit provider fixtures
  Awaiting provider response · sent 18s ago
  Last: Request handed to provider · Ctx 12.3k
```

After the liveness threshold:

```text
• [Explorer] audit provider fixtures
  Awaiting provider response · no activity observed for 2m 14s ⚠
  Last: Request handed to provider
```

## Decisions

- **Three axes, not a richer status string.** Preserve the existing lifecycle
  phase/reason independently from `lastObservation` and liveness. `quiet` is a
  liveness assessment, never a lifecycle replacement for `waiting/provider`.
- **Observation is a closed protocol.** Use a discriminated union, not
  `activitySummary: string`. Ink owns wording; registries own only observed
  facts. Do not retain raw provider output or unbounded tool arguments merely
  for status text.
- **Truthful provider language.** `request_dispatched` means this process
  handed a request to its model runtime; it must never imply provider
  acceptance, queue position, or remote “thinking.” Do not invent retry delay
  or request IDs when the runtime did not provide them.
- **Registry ownership stays unchanged.** `SubagentAsyncRegistry` and
  `BackgroundShellRegistry` retain observations and their executor-specific
  facts. `BackgroundTaskControl` computes the UI-safe liveness assessment and
  resolves context-window metadata. Ink only formats the resulting contract.
- **Snapshot model identity at run start.** A subagent can use a role-specific
  model/provider and settings may later change. Capture provider/model for the
  run when it is launched; never join current root settings to a live run.
- **Liveness is an attention cue.** Keep conservative, injected per-executor
  defaults. The initial implementation exposes them as an internal policy for
  testing and session composition, not a new user setting. Adding a setting
  later must use the setting-wiring workflow.
- **Information budgets are deliberate.** The panel owns width classes rather
  than depending on Flexbox's accidental truncation. Context is detail-only
  unless its known ratio crosses a decided warning threshold.

## Contract

Create one small shared background-activity vocabulary for both registries and
the session projection. A separate module earns its place: without it, the
shell registry, subagent registry, liveness policy, and Ink formatter would
each re-derive the same closed observation states.

```ts
type BackgroundTaskObservation =
  | { kind: 'request_dispatched'; at: number }
  | { kind: 'response_started'; at: number }
  | { kind: 'text_received'; at: number }
  | { kind: 'tool_started'; at: number; toolName: string }
  | { kind: 'tool_completed'; at: number; toolName?: string }
  | { kind: 'retrying'; at: number; attempt: number; maxRetries: number }
  | { kind: 'approval_requested'; at: number }
  | { kind: 'question_asked'; at: number }
  | { kind: 'shell_started'; at: number }
  | { kind: 'shell_output_received'; at: number }
  | { kind: 'stop_requested'; at: number }
  | { kind: 'settled'; at: number };

type BackgroundTaskLiveness = {
  state: 'recent' | 'quiet';
  lastObservedAt: number;
  ageMs: number;
};
```

`BackgroundTaskControlDetails.activity` carries the lifecycle phase/reason,
the latest observation, and the liveness value. Keep `startedAt` and task
elapsed time for manager details, but do not make elapsed time the primary
compact-panel signal.

For a subagent, carry separate live fields:

```ts
model?: { provider: string; id: string; contextWindow?: number };
latestUsage?: NormalizedUsage;
```

`latestUsage.prompt_tokens` is a snapshot of the most recent provider request,
not a sum across logical subagent segments. Cumulative usage remains result or
budget evidence and must not be presented as current context-window occupancy.

## Implementation slices

### 1. Establish the observation and liveness contract

Write red, clock-driven tests first for the shared activity policy and
`BackgroundTaskControl`:

- a waiting-provider phase remains waiting after the threshold while its
  liveness becomes quiet;
- active, approval, answer, cancellation, and terminal phases retain their
  current meanings;
- zero/negative clock skew never produces a negative observation age;
- the policy uses separate subagent and shell thresholds;
- stop requests replace the observation with `stop_requested` without
  prematurely settling the task.

Then add `source/services/background-task-activity.ts` (or the closest shared
service location), migrate the type/policy out of
`source/services/session/background-task-liveness.ts`, and update
`source/services/session/background-task-control.ts` to compute liveness from
the last observation without changing phase. Remove the old mutually exclusive
`quiet` activity state only after every caller uses the new contract.

Tests: add a colocated activity-policy test; extend
`source/services/session/background-task-control.test.ts` with structured
contract assertions, injected `now`, and both executor thresholds.

### 2. Record only observations the executors truly own

Add bounded `lastObservation` storage to:

- `source/services/subagents/subagent-async-registry.ts` for segment dispatch,
  first response/text, tool start/completion, approval, orchestrator question,
  cancellation, retry, and settlement;
- `source/services/shell/background-shell-registry.ts` for launch, output,
  stop request, and settlement.

Emit `request_dispatched` immediately before the execution runner starts a
model segment. The first text delta becomes `response_started` once and later
deltas become `text_received`. Preserve existing bounded `currentText`,
`lastToolName`, and shell-output behavior; observations complement them.

Correct `RetryEvent` in `source/services/conversation/conversation-events.ts`
to declare its optional `agentId`. `ExecutionSubagentRunner` already supplies
that value; remove its cast and have the async registry retain the known
attempt/max-retries observation. Do not change provider wire formats or add a
synthetic retry delay.

Tests: extend `subagent-async-registry.test.ts`,
`background-shell-registry.test.ts`, and `execution-runner.test.ts`. Assert
the observation union values and ordering through public status snapshots;
assert a root retry remains valid without `agentId`, while an async retry is
attributed to exactly its owning run.

### 3. Carry subagent context safely through the control port

At async-run launch, have the runtime composition path resolve the role's
provider/model once and supply that immutable presentation metadata to the
registry. The role loader remains the owner of role/model selection;
`runtime.ts` only wires the resolver, and the registry does not read settings.
For mentor runs, use the same resolved model path that the mentor runner uses.

Handle `usage_update` in the async registry and retain its latest value
separately from accumulated result usage. Add model metadata and `latestUsage`
to `SubagentRunStatus`, then let `BackgroundTaskControl` attach the catalog
context-window value when it recognizes the captured provider/model. An absent
usage event or unknown catalog entry remains absent in the UI—never zero or a
guessed percentage.

Tests: add registry/control cases for live usage updates, later usage replacing
the previous context snapshot, a model snapshot surviving settings changes, a
known `12.3k/128k` context value, and unknown-model absolute-token fallback.
Also retain the legacy notification-store usage tests: this change must not
break completion summaries or root usage.

### 4. Render deliberate compact width classes

Refactor `BackgroundTasksPanel.tsx` around an explicit formatter/view model and
the terminal width already available through Ink's `useStdout` convention.
Extend the shared live-row helper from [unified-subagent-ui.md](unified-subagent-ui.md)
instead of inventing a third row shape:

| Width | First line | Second line |
| --- | --- | --- |
| Wide | role + task + full phase | observation + evidence age; show context only at the high-usage threshold |
| Medium | role + truncated task + short phase | observation; omit normal context |
| Narrow | role + truncated task + short phase/age | omit second line |

Choose exact width and high-context thresholds as named constants after adding
tests; do not bury them in JSX. Do not use a non-shrinking status column. The
panel must retain the task label before optional telemetry, and retained
terminal rows remain concise.

Format lifecycle and liveness together only in presentation:
`Awaiting provider response · sent 18s ago` when recent, and `Awaiting provider
response · no activity observed for 2m 14s` when quiet. Wording for an
observation comes solely from its union discriminator/payload.

Tests: extend `BackgroundTasksPanel.test.tsx` with deterministic wide, medium,
and narrow column cases. Assert textual contracts with `toContain`, not ANSI or
flexbox layout internals; cover the quiet-provider combination, retry
observation, and low-versus-high context display.

### 5. Make the manager the diagnostic view

Update `BackgroundTaskManager.tsx` to render the active task as labeled fields,
not a compressed status suffix:

```text
State             Awaiting provider response
Last observed     18s ago
Last activity     Request handed to provider
Started           6m 42s ago
Model             gpt-5.6-sol
Provider          OpenAI
Context           12.3k / 128k (9.6%)
Retries           1 of 3
Last tool         read_file
```

Omit unavailable fields rather than showing fake defaults. The manager can
show ordinary context count even when the compact panel omits it. Refresh the
open manager from `listDetails()` on the existing background-task refresh path
so its detail card does not freeze on the snapshot captured when Ctrl+G opened
it. Preserve keyboard ownership, force-stop confirmation, foreground transfer,
and Ctrl+G close behavior.

Tests: extend `BackgroundTaskManager.test.tsx` for recent/quiet provider
states, conditional model/context/retry fields, refresh while open, and the
existing stop/transfer keyboard behavior. Use the existing Ink test helpers;
do not add DOM testing utilities.

### 6. Integrate and validate

Run focused tests after each slice, beginning with the policy/registry/control
tests and then the panel/manager tests. Before completion run:

```text
pnpm test source/services/session/background-task-control.test.ts
pnpm test source/services/subagents/subagent-async-registry.test.ts
pnpm test source/services/shell/background-shell-registry.test.ts
pnpm test source/services/subagents/execution-runner.test.ts
pnpm test source/components/layout/BackgroundTasksPanel.test.tsx
pnpm test source/components/layout/BackgroundTaskManager.test.tsx
pnpm typecheck
pnpm build
pnpm test
pnpm test:provider-black-box
```

The registry, execution-runner, and conversation-event changes are
provider-adjacent, so the provider black-box suite is mandatory. Run it during
development after the event-contract slice, not only as a release check.

## Non-goals

- Proving a remote model is thinking, accepted a request, or is healthy.
- Declaring a task hung or changing cancellation/retry behavior based on
  liveness.
- Provider wire-format changes, polling, or new request-id storage.
- New public settings, full provider transcripts, raw tool arguments, or
  unbounded output in presentation state.
- Changing the already-shipped Ctrl+G ownership/shortcut behavior.

## Acceptance criteria

- A provider wait can simultaneously display its lifecycle reason and that no
  recent observation exists.
- Every displayed observation corresponds to a local lifecycle event; no copy
  claims remote provider state that the application cannot observe.
- Compact rows preserve task identity at narrow widths and use a tested,
  explicit information budget.
- Manager details show observation age, model/provider, retry information, and
  context only when each datum is known.
- A context fraction uses the subagent's launch-time model and its most recent
  request usage, never current root settings or cumulative run usage.
- Quiet work stays cancellable and is never styled or described as failure.
- Existing stop, transfer, completion notification, retained-task, and Ctrl+G
  behavior remain covered by regression tests.
