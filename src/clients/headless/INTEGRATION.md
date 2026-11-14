# Direct headless client integration

`runDirectHeadless(connection, options)` is the M5 headless path. It is
aligned with the updated contract commit `0a27e134` (typed delivery,
structured questions/answers, base64 images, admission identity, cursor replay
and nested output). It consumes only `DirectConnection` from
`host/in-process-direct-types.ts` and `protocol/wire.ts`; it never
imports Session, Engine or adopted code, and never opens conversation storage.

## App wiring

1. The app resolves the workspace grant, creates or opens the direct session
   through `DirectHost`, and passes the returned connection. The client does not
   choose a store, model or workspace.
2. `--resume <id>` passes the exact connected `sessionId` as
   `expectedSessionId`. A different attached session is refused with
   `not_found` before submit. The client never looks up the latest, a prefix or
   old conversation data.
3. Pass `io` (defaults to `process.stdout/stderr`), `autoApprove` from
   `--auto-approve`, `quiet` from `-q/--quiet`, `showReasoning` from
   `--show-reasoning`, `output` (`plain` or `json`), and the CLI's abort
   signal. The app keeps ownership of the signal-to-exit-code mapping: a
   `cancelled` result under SIGINT is 130 (SIGTERM 143); without a signal it
   is 1. `context_paused`, `blocked` and `budget_paused` are exit 2. The app/CLI
   maps `blocked` already and must add `budget_paused`. On every exit code
   the CLI waits for stdout and stderr to drain before `process.exit`
   (`src/shared/lib/exit-after-drain.ts`): on a pipe, exiting first discarded
   the queued tail, and a slow reader got a `final` record cut mid-line with
   no `run_summary` or `completed`. A SIGINT or SIGTERM during the drain exits at once
   with the already-settled code, so the tail may be lost but the result is
   not overridden. `exitAfterDrain` installs its own temporary handlers for
   this, so it holds on exits before a run starts (a usage error) as well as
   after the run's handlers exist. `attachments` are passed
   through as raw padded base64
   image parts; `delivery` is omitted by default, and an explicit non-`auto`
   mode needs the real `submitWithDelivery` capability or is reported
   unavailable. Pass `backgroundWaitTimeoutMs` from
   `agent.backgroundWaitTimeoutMs` (default one hour) so the drain/wait bound
   stays app-configured.
4. Pass `decideApproval` when the app can supply the exact
   `NonInteractiveApprovalPolicy` decision (including shell safety and the
   yellow-command evaluator) for a wire interaction. Without it the built-in
   conservative policy applies: deny without `--auto-approve`; with it allow
   ordinary tools and low/unknown-risk shell, deny medium/high-risk shell and
   report that rejection. A question has no headless answerer: the default is
   the selected resolution `{kind:'answer', answer:'', stopAfterApprovalResolution:true}`,
   which settles the source canonical no-answer result and suppresses later
   work; it is not cancellation and must not pre-cancel the selected body. A
   custom decider may return structured `answers`, `decline` or a supported
   `grant`; the client forwards it unchanged and the protocol/Session validates
   question IDs, shapes and grant scope.
5. After the run the app must dispose the host. `closeConnection` (default
   true) only detaches; it does not cancel a Session.

## Behaviour

- `submit` carries a client request ID, `{kind:'cli'}` origin and optional
  attachments/delivery. Command acknowledgement is admission only: the run
  waits for the submitted turn's `turn_ended`. Queued/steering admissions wait
  for the matching `turn_started` or `admission` frame by message ID, including
  the admission embedded in `turn_started` (never a second same-seq frame).
- Plain stdout streams answer deltas and writes only the suffix a completed
  message did not stream. A completed turn ends stdout with one newline; a
  failed or cancelled turn leaves partial output unterminated.
- Plain stderr matches the old headless wording where the wire carries it:
  `[tool] name: preview` on a root planned call (before approval or
  dispatch), `[approval required] tool`,
  `[question] tool summary`, `[retry] ...`, `Approval Rejected: reason`, and
  `error message`. Retry lines use the newly supplied `toolName`,
  `maxRetries`, `retryType` and nested `agentId` when present, with the old
  `service_tier` form; otherwise the explicit fallback includes attempt/delay.
  Physical `run_code` child calls do not produce root `[tool]` lines.
  Subagent tool lines use the supplied role; if absent they use `[subagent]`,
  never an invented role. Reasoning goes to stderr only with `showReasoning`.
- Accepted `goal` events carry their actual change `source`. Only an achieved
  `goal_check` change prints the shared multiline goal/criteria/closure summary
  on stderr, including in JSON/quiet mode as in the source client. An achieved
  tool acknowledgement or status alone is not completion evidence; manual goal
  changes must not be described as model-accepted completion.
- `quiet` suppresses plain non-error diagnostics (`[tool]`, `[approval
  required]`, `[question]`, retry and notice lines); errors, `Approval
  Rejected` verdicts and reasoning (when enabled) remain. JSON mode is
  unaffected.
- `json` emits the exact old records the native/public data actually supplies:
  `text_delta`, `reasoning_delta`, `tool_call_streaming_delta`, `tool_started`,
  `tool_dispatched`, `retry`, `error` (message and exact kind), `cost_update`,
  `command_message`, `run_budget` and the authoritative `final` from
  `WireTerminal.finalWindow`. In log version 2, every root terminal window is
  rebuilt read-only from the accepted fact prefix when that turn has a preceding
  `turn_started`; this is current-format projection, not `legacyDerived` output.
  The stored terminal contains no window and is never rewritten. Without
  that prefix the client emits `legacy_final_window_unavailable` and exits 1
  rather than presenting a partial final. Provider history, private items and
  the remaining unavailable families are never synthesized from raw wire events.
- A stale interaction answer after abort is expected (Session closes pending
  interactions). The client keeps the ordered stream and lets the cancelled
  terminal decide instead of reporting a failure. A stale `closed` failure is
  treated the same way; other failures remain failures.
- `budget_opened` for the submitted turn, or a pending budget in the attach
  snapshot, is reported as `run_budget_paused`/exit 2 without answering it.
  `--auto-approve` never grants run budget or turns. Today Session disposal and
  crash replay close the pending check-in as a system stop, so the diagnostic
  deliberately does not promise a resumable budget review. A real Session park
  is required before the old review wording can return.
- Exit codes: completed 0; failed, interrupted, cancelled or a command/stream
  error 1; native `context_overflow` and resumable context failures (`request_input_limit`,
  `context_compaction_hard_fit`, `provider_context_overflow`, `context_paused`)
  and the accepted terminal causes `goal_check_unresolved` /
  `completion_verification_blocked` return 2 (`context_paused` / `blocked`).
  Bare verification unavailability is blocked too, never a successful unattended
  soft skip. Plain verification-blocked output retains the model answer and adds
  the accepted host notice on stdout; unresolved-goal diagnostics use stderr.
  JSON retains the accepted terminal cause and the final response text; earlier
  responses remain in turnItems rather than being concatenated into finalText.
  A pending/opened run-budget check-in returns `budget_paused`/exit 2 with
  truthful terminal wording; headless never grants budget. The app must map `blocked`
  and `budget_paused` to exit 2.
- An abort before the turn starts detaches without cancelling another turn;
  the app's host disposal owns a queued admission. An abort after it starts
  sends one `cancel` and still waits for `turn_ended`.
- Pending interactions in the attach snapshot are answered by policy before
  submit. A failed answer (for example stale) is reported, a best-effort
  foreground cancel is sent, and the run fails; it is never reported as
  resolved.
- `runDirectHeadless` requires an ordinary snapshot connection. A
  `DirectReplayConnection` (`snapshot:null`) is for a client retaining state at
  `replay.fromSeq`; headless one-shot resume uses `connect(principal, id)` and
  does not reset or replay client state.

## `run_summary` (JSON only)

A `--json` run that reaches the headless driver's result writes at most one
`{"type":"run_summary","version":1,...}` record: on success immediately before
`completed` (which stays the last line), otherwise as the last line after the
error/terminal records. A run refused before the driver starts (argument,
settings or session-open failures) writes no JSON at all, and a process killed
or exited by a second signal may never reach it. Plain output has no summary;
there is no existing place for it. It adds a record and changes no
existing one. `run-summary.ts` computes it only from accepted wire events the run
already receives: `request_cost_recorded`, `usage`, `tool_finished`,
`compaction_*`, `task_changed` and `subagent`. The driver passes every event of
the session to `observe` before its turn filter, because a background child's
requests can settle between the run's turns. Only request trees rooted in a turn
this run drove (`turnIds`) count, so a resumed run does not recount history.

Measurement never affects the run. `output.ts` catches any failure to observe an
event, build the record or serialize it; the run then writes the error variant
`{"type":"run_summary","version":1,"sessionId":…,"outcome":…,"error":"<message>"}`
instead of partial numbers, and `completed` and the exit code are unchanged. The
accumulator keeps per request its cost record and per settled tool call only its
name, error flag, rejection class and the normalized read path/range or trimmed
shell command, never tool output; building is linear in requests and tool calls
(150k requests build in well under a second).

Fields (unknown is `null`, never `0`; `version` 1):

- `sessionId`, `outcome` (the run's `DirectHeadlessOutcome`), `turnIds`.
- `cost`: `usd`/`usdMicros` (sum of priced requests; `null` when none is
  priced), `state` (`exact`/`estimated`/`partial`/`unavailable`, as
  `summarizeCost`), `pricedRequests`, `unpricedRequests`.
- `requests`: `total`, `completed`, `failed`, `cancelled`, `compaction`.
- `tokens`: `input` (all input incl. cache read and write), `fresh`
  (`input - cacheRead - cacheWrite`), `cacheRead`, `cacheWrite` (`null` when no
  request reported one), `output`, `reasoning` (`null` when no request reported
  it), `requestsWithUsage`, `requestsWithReasoning`. Requests without usage add
  nothing; compare `requestsWithUsage` to `requests.total`. When no request
  reported usage, `input`, `fresh`, `cacheRead` and `output` are `null` too
  (here and per agent). A reported cache read of zero cannot be told from an
  unreported one: providers' adapters default it to `0`.
- `cacheHitRatio`: `overall` = cacheRead / input; `rootAfterFirst` the same over
  the root agent's model requests after its first (compaction requests excluded).
  4 decimals; `null` with no input.
- `contextGrowth`: root model requests' total input in order: `rootRequests`,
  `first`, `last`, `max`, and the full `inputTokens` list only up to 64 requests
  (a request without usage is `null` in the list).
- `agents`: `root` first, then each subagent by task id with `role` (from the
  task or subagent frame; `null` for root or when unknown), `mode`, the
  `models` its requests actually used, and its own `requests`, `cost`, `tokens`
  and `toolCalls`.
- `tools`: settled tool results (`tool_finished`, root, run_code children and
  subagents): `calls`, `byName`, `errors` (`isError`), `rejections` split by the
  host's own refusal text (`invalidInput`: the schema diagnostic of
  `runToolInputDiagnostics`; `unknownTool`: agent-core's `Unknown tool:` result),
  `repeatedReads` and `repeatedShellCommands`. Calls that never settled
  (cancelled before a result) are not counted.
  - `repeatedReads.sameRange`: a `read_file` whose path and `start_line`/
    `end_line` (both absent for a whole-file read) equal those of an earlier
    successful `read_file` in the run. This is the clear waste signal.
    `repeatedReads.otherRange`: the path was read successfully before, but only
    with other ranges; it may be legitimate paging. The path is the model's
    argument after `path.normalize` (so `./a.txt` equals `a.txt`), not resolved
    against a working directory: the wire carries no per-agent cwd, so a child
    working in another worktree that reads the same relative path counts as a
    repeat of the root's read. Repeats are counted run-wide, across agents.
  - `repeatedShellCommands`: a `shell` command whose trimmed string equals an
    earlier one in the run; outcome and description are ignored.

Reasoning tokens: agent-core's `Usage` has no reasoning field and its cost record
copies named fields only, so `toUsage` (`model/provider-items.ts`) keeps the
provider's count on the same object. It is persisted on the accepted `usage`
fact and published as `WireUsage.reasoningTokens`. The summary pairs a turn's
latest `usage` with that turn's next cost record (they are emitted in that order
for one request) and only when the output counts match. The legacy
`usage_update`, `cost_update` and `final` records are unchanged and still have no
reasoning count. Providers that report it: OpenAI Responses and Codex
(`output_tokens_details`), chat completions including OpenRouter
(`completion_tokens_details` or a top-level `reasoning_tokens`), and AI SDK
adapters that expose `outputTokens.reasoning`. Anthropic Messages reports none,
so it is `null` there.

## Internal ownership

`runDirectHeadless` in `direct.ts` owns admission matching, the ordered event
iterator, cancellation and background notice/task drain scheduling. It does not
own legacy JSON accumulation or approval policy state.

`createHeadlessOutput` in `output.ts` owns streamed/final text
reconciliation, legacy request IDs, deferred tool-start/usage records, output
errors and terminal diagnostics. `endTurn` reports whether an accepted final
window was available; only the driver chooses the resulting run outcome. Output
state remains run-local, including across silent delivery turns.

`createHeadlessAnswerer` in `approvals.ts` deduplicates snapshot/live
interaction requests and sends the policy decision. A false result means a
failed answer with best-effort cancellation, not a terminal outcome.
`decideHeadlessApproval` remains exported from `direct.ts` for existing callers.
Its automatic shell-denial reasons identify the risk without repeating the
command, which remains available in the original interaction and tool call.
An injected approval decider's reason is passed through unchanged.
The driver still owns signal handling and waits for accepted terminals.

## Background drain timing

`runDirectHeadless` keeps one overall background deadline. `driveBackground`
may wait only until the next notification-drain poll when Session is still busy
settling the previous turn. Expiring that shorter wait must re-enter the driver,
not cancel work as if the overall deadline had expired. A completed child and
an enqueued notice do not establish that the delivery turn has been admitted.
Keep an outstanding iterator read until its event is consumed, including when
a drain command is awaited between polling windows; clearing it on resolution
can discard the first delivery frame. Keep the deadline check in the driver;
increasing the configured timeout cannot
repair a poll/deadline mix-up. The event wait during an active delivery turn uses
the actual remaining deadline and still fails when that expires. An explicit
background abort retains the `cancelled` outcome after the same cleanup, so the
app can map SIGINT/SIGTERM to their signal exit codes rather than ordinary error.

## Remaining shared contract gaps

- **Host assembly:** `app/launch-headless.ts` runs every headless
  prompt through this client on a connection from `createDirectInProcessHost`
  (`host/in-process-direct.ts`). The host delivers the attach snapshot and
  ordered live events atomically, acks commands without implying completion,
  and disposes sessions on shutdown.
- **`--json` schema:** the direct client emits `session_start`, exact live slices
  (`text_delta`, `reasoning_delta`, `tool_call_streaming_delta`,
  `tool_started`/`tool_dispatched` when the wire call ID is present, `retry`
  when required metadata is present, `cost_update`, `command_message`,
  `run_budget`), the authoritative `final` from `WireTerminal.finalWindow`, and
  the non-legacy `run_summary` described above.
  `session_start` preserves the old profile metadata shape without an added
  capability declaration. The final preserves per-turn public `turnItems`, usage,
  root-tree costs, ordered result items and terminal cause; command messages
  already emitted live are excluded. Legacy cost IDs/tier/unpriced presentation
  and zero-cache omission stay at this projection boundary; coverage limits are
  documented in `protocol/mapping.md` rather than added to the old DTO.
  Version-2 terminal windows are projected read-only from the accepted prefix
  when a preceding `turn_started` exists (not marked `legacyDerived`); otherwise
  the explicit `legacy_final_window_unavailable` path remains. Provider history,
  private/opaque items, approval descriptors and the remaining legacy live
  event families are not projected; this is not complete old `--json` parity.
  Never emit raw wire events as legacy JSON.
- **Approval policy inputs:** the wire exposes `toolName`, `input`, `summary`,
  `detail`, `risk`, typed `questions` and `supportedGrants` (empty under the
  current M2 request contract), but not the old safety classification, the
  yellow command evaluator, MCP allowlists or `propose_goal` policy. The app
  must inject the exact policy through `decideApproval`. Run-budget check-ins
  have real `budget_opened`/`pendingBudgets` wire evidence; headless pauses and
  exits 2 rather than granting them.
- **Questions:** typed questions and structured `answers` are available to an
  app-injected decider, but headless itself has no interactive presenter. The
  default declines. Old ask_user parity still needs the app to choose answers,
  and grants need a real scope-validating capability before any non-empty
  `supportedGrants` appears.
- **Background work:** Session now owns durable notices/deliveries and the
  atomic silent drain. The client watches `snapshot.notifications`,
  `background_notice_enqueued`/`background_notices_delivered` and `task_changed`;
  after the submitted turn it drains pending batches through
  `drain_background_notifications` (stable request ID); an empty authoritative
  drain retires only notices captured before that request, preserving notices
  that arrive concurrently. It follows each silent
  `turn_started` to its terminal, answers task interactions, and waits until no
  notice or active task remains. The total wait is bounded by
  `backgroundWaitTimeoutMs` (old `agent.backgroundWaitTimeoutMs`, default one
  hour). Timeout/signal cancel the active silent turn and active tasks through
  `cancel`/`task_control`, then exit 1 with the outstanding IDs; requests and task settlement are not confirmed. It never
  synthesizes notice text, delivery identity or completion.
- **Generation guards:** the old app wrapped provider streams in
  `GenerationGuard`; deadline/idle caps remain app/model policy, not client
  state.
