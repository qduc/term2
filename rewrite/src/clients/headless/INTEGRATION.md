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
   `--auto-approve`, `output` (`plain` or `json`), and the CLI's abort signal.
   The app keeps ownership of the signal-to-exit-code mapping: a
   `cancelled` result under SIGINT is 130 (SIGTERM 143); without a signal it
   is 1. `attachments` are passed through as raw padded base64 image parts;
   `delivery` is omitted by default, and an explicit non-`auto` mode needs the
   real `submitWithDelivery` capability or is reported unavailable.
4. Pass `decideApproval` when the app can supply the exact
   `NonInteractiveApprovalPolicy` decision (including shell safety and the
   yellow-command evaluator) for a wire interaction. Without it the built-in
   conservative policy applies: deny without `--auto-approve`; with it allow
   ordinary tools and low/unknown-risk shell, deny medium/high-risk shell and
   report that rejection. A question is declined (`{kind:'decline'}`), because
   headless has no interactive answerer. A custom decider may return structured
   `answers`, `decline` or a supported `grant`; the client forwards it unchanged
   and the protocol/Session validates question IDs, shapes and grant scope.
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
  `error message`. Reasoning goes to stderr only with `showReasoning`.
- `json` emits one JSON record per line: an old-style `session_start`
  (`profileMetadata` from the app), every received wire event, then
  `completed`/`error`/`context_paused`. Diagnostics do not also go to stderr.
- Exit codes: completed 0; failed, interrupted, cancelled or a command/stream
  error 1; resumable context failures (`request_input_limit`,
  `context_compaction_hard_fit`, `provider_context_overflow`, `context_paused`)
  2.
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
  `final` with `turnItems`/`costRecords`, ...). The direct wire does not carry
  those shapes, so this client emits wire events. Passing the `json-events`
  golden requires a protocol-owned public event schema equivalent to the old
  records, not a client-side guess.
- **Approval policy inputs:** the wire exposes `toolName`, `input`, `summary`,
  `detail`, `risk`, typed `questions` and `supportedGrants` (empty under the
  current M2 request contract), but not the old safety classification, the
  yellow command evaluator, MCP allowlists or `propose_goal` policy. The app
  must inject the exact policy through `decideApproval`; run-budget/check-in
  interactions still have no wire event.
- **Questions:** typed questions and structured `answers` are available to an
  app-injected decider, but headless itself has no interactive presenter. The
  default declines. Old ask_user parity still needs the app to choose answers,
  and grants need a real scope-validating capability before any non-empty
  `supportedGrants` appears.
- **Background work:** `task_changed`/`subagent` exist, but the old headless
  wait for outstanding background work, notification turns and interrupted
  background failures needs M4 Session/app policy; the client currently ends
  at the submitted turn's terminal.
- **Retry text:** the wire `retrying` payload has no tool name or max retry
  count, so the old `[retry] tool (attempt/max)` line cannot be reproduced
  exactly.
- **Generation guards:** the old app wrapped provider streams in
  `GenerationGuard`; deadline/idle caps remain app/model policy, not client
  state.
