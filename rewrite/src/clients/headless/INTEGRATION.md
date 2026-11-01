# Direct headless client integration

`runDirectHeadless(connection, options)` is the M5 headless path. It is
aligned with the updated contract commit `0a27e134` (typed delivery,
structured questions/answers, base64 images, admission identity, cursor replay
and nested output). It consumes only `DirectConnection` from
`host/in-process-direct-types.ts` and `protocol/direct-wire.ts`; it never
imports Session, Engine, adopted code or the bridge runtime, and never opens
conversation storage.

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
   maps `blocked` already and must add `budget_paused`. `attachments` are passed
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
  `[tool] name: preview` on tool start, `[approval required] tool`,
  `[question] tool summary`, `[retry] ...`, `Approval Rejected: reason`, and
  `error message`. Retry lines use the newly supplied `toolName`,
  `maxRetries`, `retryType` and nested `agentId` when present, with the old
  `service_tier` form; otherwise the explicit fallback includes attempt/delay.
  Nested tool lines use the supplied role; if absent they use `[subagent]`,
  never an invented role. Reasoning goes to stderr only with `showReasoning`.
- `quiet` suppresses plain non-error diagnostics (`[tool]`, `[approval
  required]`, `[question]`, retry and notice lines); errors, `Approval
  Rejected` verdicts and reasoning (when enabled) remain. JSON mode is
  unaffected.
- `json` currently fails explicitly (exit 1) before submit because an
  authoritative final/turn-item window is still missing. Live argument-stream,
  cost and command slices exist, but alone are not the old schema. Emitting wire
  events under the old flag would misstate parity; remove the gate only when the
  protocol-owned read model is complete.
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
  error 1; resumable context failures (`request_input_limit`,
  `context_compaction_hard_fit`, `provider_context_overflow`, `context_paused`)
  and the accepted terminal causes `goal_check_unresolved` /
  `completion_verification_blocked` return 2 (`context_paused` / `blocked`).
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

## Remaining shared contract gaps

- **Host assembly:** this candidate has the `DirectHost`/`DirectConnection`
  types but no `createDirectInProcessHost`/direct store wiring. The host must
  deliver the attach snapshot and ordered live events atomically, ack commands
  without implying completion, and dispose sessions on shutdown. The app
  integration owner switches `app/run.ts`/`app/cli.ts` to this client once that
  exists.
- **`--json` schema:** old `--json` streams private `ConversationEvent`
  records (`tool_call_streaming_delta`, `cost_update`, `command_message`,
  `final` with `turnItems`/`costRecords`, ...). Protocol now provides exact
  accepted slices for live argument counts (`legacyToolCallStreamingDelta`),
  request costs (`legacyRequestCostUpdate`) and source-formatted commands
  (`legacyCommandMessages`), but an authoritative final/turn-item window is
  still absent. Those slices alone are not the legacy schema, so `--json` still
  exits 1 with a precise missing-producer error. Never emit raw wire events as
  legacy JSON.
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
  `drain_background_notifications` (stable request ID), follows each silent
  `turn_started` to its terminal, answers task interactions, and waits until no
  notice or active task remains. The total wait is bounded by
  `backgroundWaitTimeoutMs` (old `agent.backgroundWaitTimeoutMs`, default one
  hour). Timeout/signal cancel the active silent turn and active tasks through
  `cancel`/`task_control`, then exit 1 with the outstanding IDs. It never
  synthesizes notice text, delivery identity or completion.
- **Generation guards:** the old app wrapped provider streams in
  `GenerationGuard`; deadline/idle caps remain app/model policy, not client
  state.
