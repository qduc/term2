# TUI control socket

Status: plan. Design only — no implementation commit. Waiting on the open decisions in the last section before any `source/` change.

## Resume here

This document is the design for a local unix socket that drives the **already running interactive TUI**, the process `cli.tsx` builds around `ConversationService` and Ink `App`. It is not a design for `term2 serve` or `term2 acp`. Those launchers create their own sessions.

Do not start by extending `Term2Gateway` or `runAcp`. The reasons are in "Why this is not the gateway" and "Rejected alternatives". The first implementation milestone is an opt-in socket in the interactive process that can submit, steer, interrupt, and report status, with an application-level receipt. Approval answering stays off.

Symbols named below were checked against this worktree. Where a behavior was not traced, the sentence says so.

## Why

Orchestrators currently drive a live term2 pane by injecting keystrokes. That fails for reasons that are properties of the terminal, not of the conversation:

- Ink can coalesce two Escape bytes into one gesture, and a paste arrives as one chunk. The `terminal-input-ownership` skill documents both. Interrupt and menu dispatch that depend on those bytes are not reliable from another process.
- The screen the orchestrator scrapes is a projection. `ConversationOrchestrator.sendUserMessage` logs `Submission routing decided` precisely because a queued row and a transcript line do not tell you whether a steer was admitted.
- Completion polling of report files is outside the turn lifecycle in contract 01.

The socket speaks the operations the session already has. The human keeps the terminal: the draft, the open menu, and the approval prompt stay theirs.

## Why this is not the gateway

`term2 serve` (`runServe`, `GatewayServer`, `Term2Gateway`, `createProductionRuntimeFactory`) is a headless session factory. Attaching that wire to a live TUI was considered and rejected.

Evidence:

- `createProductionRuntimeFactory` builds a **new** `AgentClient` graph per session and copies only `PRODUCTION_AUTHORITY_SETTING_KEYS` (keys that start with `agent.` or `webSearch.`). The hard-won rule in `docs/plans/web-client-gateway-completion.md` is that a host `shell.autoApproveMode: always` must not enter a gateway session. The live TUI is the opposite object: it is already running on the user's real `SettingsService`. Mounting gateway settings routes onto it would either fork a second session the human is not watching, or share the live settings object and reopen that leak.
- Gateway auth is an RS256 assertion plus OTP pairing (`x-term2-assertion`, `GatewayPairing`). `GatewayServer.start` listens on a unix socket and then `chmod`s it `0o660`, because a BFF in the same group must connect and cryptography tells the users apart. A control client is the same OS user. Pairing does not distinguish that user from their own agent.
- `GatewayServer.start` unlinks a stale socket at a **fixed** path whenever the inode is a socket. Two interactive processes cannot share that path. `cli.tsx` already refuses a second writer: `isConversationLocked` returns `held`, and `ConversationLogWriter` throws `LockConflictError`. Contract 12 does not claim two writers for one session.
- Gateway submit is `prepareMessage` / `commitMessage` plus a durable `clientRequestId` admission index (`isMessageBody` allows `text` up to 128_000 characters). The TUI's transcript is updated by `ConversationOrchestrator.sendUserMessage`, which the gateway never calls. A receipt from the gateway path would not be the row the human sees.
- `runAcp` is the same factory over stdio, with ACP `session/request_permission` as the approval bridge. stdout of the interactive process is the TUI. ACP sessions are not this pane.

Reuse from the gateway is the **pattern**, not the stack: an opaque client request id, a bounded final-text excerpt (the gateway projection bounds `turn_completed` text at 16_384 characters), and "a settings write is not a session control". The live session does not get a settings method at all.

## Ownership

The socket module earns a file because deleting it would push framing, directory mode, advertisement, and idempotency back into `cli.tsx` and the Ink tree.

| Concern | Owner |
| --- | --- |
| Bytes, framing, version, peer and mode checks, advertisement files, idempotency map | New `source/services/control-socket/`. Not a session policy object. |
| Submit, steer, queue, interrupt, transcript rows, system notices | `ConversationOrchestrator`, reached through a `ControlSessionPort` the interactive hook binds. |
| Steer admission and request boundaries | `ApplicationRunLoop`, unchanged. |
| Queue items and their promises | `QueueController` and `ConversationAdapter`, unchanged. |
| Approval decisions | `services/approval/` and the existing resolve methods. The socket does not decide. |
| Turn status legality | `TurnStatusMachine`. The socket does not write it. |
| Process start and stop, conversation lock | `cli.tsx`, which already constructs `ConversationService` and calls `render`. |

`ConversationService` is the wrong place for the listener. It has no draft, no menu, and no system-message line. `setEventSink` is a single slot the gateway uses (`ServerSession`) and the interactive `cli.tsx` does not call. The control path may **observe** that slot only while it is null, and must fan out instead of replacing a sink someone else set. Steer admission is not an adapter event: `steerActiveTurn` returns a boolean from the run loop, and the orchestrator logs `Steer attempt resolved`. The receipt for a steer comes from that boolean, not from the sink.

Do not add a `Runner`, `Driver`, or `Coordinator`. One server type and one port interface are the seam.

### Where it is wired

`cli.tsx` constructs the server **before** `render`, only when the enablement flag is set, and closes it after `waitUntilExit` and on the same shutdown path that already ends the process. The server starts with no port bound. Session methods return `not_ready` until `App` / `useConversation` binds a `ControlSessionPort`. Unmount unbinds the port. The listening socket stays up for the process so a React remount does not unlink the path clients already discovered.

The port implementation calls the same functions the keyboard already calls. It does not write stdin and does not use `useInput`.

Binding the port from the hook is deliberate: `sendUserMessage`, `stopProcessing`, `cancelAskUser`, and `addSystemMessage` already live there. A second call chain into `ConversationService.sendMessage` would skip the transcript (contract 01's projection rules) and the queue row.

## Capabilities

### MVP (milestone 1)

Enabled together by the flag. No other methods exist on the wire yet; unknown methods are `unknown_method`, not silent no-ops.

| Operation | Session call | Receipt means |
| --- | --- | --- |
| `submit` | `ConversationOrchestrator.sendUserMessage` with `busyMode: 'follow_up'` when a turn owns the queue, otherwise an immediate send. Same routing `Submission routing decided` already records. | The session kept the text: a turn was started, or a follow-up was queued. `messageId` is the id `sendUserMessage` already assigns. |
| `steer` | `steerActiveTurn` via `sendUserMessage` with `busyMode: 'steer'`. | The session kept the text as a pending steer (`messageId` assigned) **or** the existing fallback ran. See receipts below. This is not "the model has seen it". |
| `interrupt` | The same branch as `handleCancelApproval` in `app.tsx` (table below). | The branch ran. Idle interrupt is `accepted: false`, `reason: idle`, and must not clear the draft. |
| `status` | A read assembled by the port. | A snapshot. Does not mutate. |
| `hello` | None. | Protocol version and the capability set. |

Text only. `isMessageBody` on the gateway rejects every key except `text` and `clientRequestId`. The control body does the same. Images and attachments are `invalid_request`, not silently dropped. Text length is 1..128_000 characters, the same ceiling as `isMessageBody`.

`submit` and `steer` must call `ConversationService.previewLargeUncachedInput` and `previewInputSurge` and **refuse** when the decision is not allow. They must not mint an `inputSurgeApproval` the human did not give. The large-uncached confirmation today is React state (`pendingLargeUncachedTurn` in `use-app-keyboard-shortcuts.ts`, `largeUncachedPreview` in `app.tsx`). Bypassing it from the socket would be a guard hole. The receipt is `rejected` / `needs_confirmation`. Whether `sendMessage` also enforces that preview on its own was not fully traced; the socket refuses first either way.

The human draft in `InputBox` is not read, cleared, or concatenated. Input clearing today belongs to the editor submit path, which this port does not call.

Visible effect on every accepted submit or steer: the ordinary user row `sendUserMessage` already appends, plus one system line that names the origin and the `messageId` (for example `Control submit <id>`). The model still sees a user turn. The human can tell it from their own Enter. `UserMessage.presentation` is only `'session_rollover'` today; do not overload it.

### Receipts, steer, and idempotency

Two different facts, because conflating them is the screen-scrape bug:

1. **Receipt** (response to the request): the application accepted custody of this `clientRequestId`. Fields: `messageId`, `delivery` of `started`, `queued`, `steering`, or `rejected`, and `reason` when rejected. Returned as soon as `sendUserMessage` has assigned the id and invoked the existing path. Not held until the provider returns. `sendUserMessage` currently awaits the whole turn; the port needs a split so the turn promise stays inside the orchestrator and the receipt returns at admission. That split is the one orchestrator change MVP requires. It must not change steer policy.
2. **Admission** (later event, milestone 2; the boolean already exists in milestone 1 logs): `steerActiveTurn` resolved `true` (`admitted`) or `false` (`released`, and today's code reclassifies the row to `follow_up`). A steer can sit in `ApplicationRunLoop` until the next request boundary, or be released at turn end (contract 01, C1.5). The receipt's `delivery: steering` means "pending", not "admitted".

`clientRequestId` is required, opaque, and matches the gateway's `isOpaqueId` shape: 1..256 characters from `[A-Za-z0-9_-]`. The server stores an in-memory map from that id to the receipt and a hash of the body, for the life of the process, capped at 256 entries (drop the oldest completed entries; do not drop an entry whose steer is still pending). Same id and same body returns the original receipt with `replayed: true` and does not append a second transcript row. Same id and different body is `conflict`. The map is not durable. Contract 12 already says pending steers are not persisted, and a crashed TUI takes the socket with it. A client that retries after process death is talking to a new process and must use a new id.

The mutation lock covers only admission (the call that assigns the id and starts `sendUserMessage` / `stopProcessing`), not the turn. Otherwise `interrupt` would wait until the turn finished. Requests on one connection run in read order. Connections share one admission lock. `status` does not take that lock.

### Interrupt branch

`interrupt` calls the same decisions as Escape on the focused surface, not `ConversationService.abort()` and not synthetic keys.

| What is in front of the human | What `handleCancelApproval` does today | Socket `interrupt` |
| --- | --- | --- |
| Sandbox network prompt | Deny that prompt | Same |
| Background-subagent approval | Resolve it `no` | Same |
| Nested approval without a foreground pending approval | `stopProcessing` | Same |
| `ask_user` | `cancelAskUser` (keeps the turn record) | Same |
| Any other approval | `stopProcessing` (abort the turn, drop the pending tool) | Same |
| None of the above | Keyboard stop is `stopProcessingWithNotice` (`Stopped` system line) | Same, including the system line |

`ConversationService.interruptFromUser` aborts the turn **and** cancels background subagent runs and background shell jobs. `abort()` does not cancel those runs. `stopProcessing` on the orchestrator is the user-asked-everything-to-stop path: it calls `interruptFromUser`, marks running command rows aborted, clears the pending interaction, and drains background-subagent notifications. Use that path, not `abort()`, when the branch says `stopProcessing`.

Idle: if none of those surfaces are up and the port's phase is `idle`, return `accepted: false`, `reason: idle`. Do not call `stopProcessing` just to be sure — that method clears transient UI and drains notifications even as part of stopping.

### Status snapshot

`ConversationService` does not expose `TurnStatusMachine` (`SessionStatus` is `idle | streaming | awaiting_approval | continuing`). `queueStateKind` is documented on the service as diagnostics only: do not branch submit or steer on it. Phase is a new projection, `projectControlPhase`, tested on its own. First match wins:

| Input the port can already see, or a read MVP adds | `phase` | `waitKind` |
| --- | --- | --- |
| `getPendingInteractionSnapshot()` whose approval tool is `ask_user` | `awaiting_approval` | `question` |
| `getNestedApprovalSnapshot()` non-null, and no foreground pending interaction | `awaiting_approval` | `nested_approval` |
| Any other `getPendingInteractionSnapshot()` | `awaiting_approval` | `approval` |
| Orchestrator has an active turn, or `isQueueOwningSubmissions()` / `isQueueActive()` | `working` | null |
| Else | `idle` | null |

`queueStateKind` is included as a string field for humans and logs. Routing code ignores it.

Blind spot, left blind on purpose: the large-uncached confirmation is component state, not a pending-interaction snapshot. Phase can read `idle` or `working` while that modal is up. Milestone 1 does not scrape it. Socket submit refuses the surge instead of trying to name the modal.

Snapshot fields:

- `phase`, `waitKind`, `queueStateKind`
- `sessionId`
- `queue`: outstanding submissions `{ id, text, stage }` where `stage` is `pending_steer` or `queued`. This list does not exist as one method today. The reducer field `pendingQueuedMessages` (`conversation-ui-reducer.ts`) is what `BottomArea` draws, and contract 01 says projections can lag the domain. MVP adds `listOutstandingSubmissions()` on the orchestrator, filled from the ids `sendUserMessage` already tracks (adapter `#pendingSteerIds` / queued items), not from the reducer. Text for a pending steer is the text passed into `steerActiveTurn`. Cap the returned text per item at 500 characters in the snapshot; the full text stays in the session.
- `currentTool`: `{ callId, toolName }[]` for unsettled calls. `SessionToolTracker.unsettledToolCallIdsForCurrentTurn` and the ledger `toolName` are the domain facts. They are not on the service facade. MVP adds a read that returns those two fields and **not** arguments. Until that read exists, the field is `null`, not a guess from the status bar.
- `context`: `promptTokens` from the session usage accumulator's last usage, and `contextWindow` from `getModelContextWindow` for the active provider and model — the same inputs `StatusBar` uses. Absent tokens stay null. Do not invent a percentage.
- `cost`: `ConversationOrchestrator.getCostSummary()` (`SessionCostSummary`: `knownUsdMicros`, `pricedRequests`, `unpricedRequests`, `state`). Null when there is no accumulator.
- `model`, `provider`, `reasoningEffort` from the live settings the status bar already reads. Read-only.

### Later, each shippable without the others

- **Events (milestone 2).** Subscribe on the same connection. Events are JSON objects with `kind: "event"` and no request id. MVP event names, and only these: `turn_started`, `turn_completed`, `turn_failed`, `turn_interrupted`, `tool_started`, `tool_finished`, `approval_required`, `question_required`, `steer_admitted`, `steer_released`, `queue_changed`, `session_changed`. `turn_completed` may include `text` cut at 16_384 characters, matching the gateway final-text bound. No token deltas. `approval_required` and `question_required` carry tool name and an arguments excerpt cut at 500 characters. They are notifications. There is no answer field and no resolve method.
- **Queue edit and retract (milestone 3).** `ConversationOrchestrator` already routes `retractSubmission` / `editSubmission` by id. Expose those. Do not pop "the last item".
- **Runtime commands (milestone 4).** One method, `command`, with an allowlist. Each entry calls the existing slash command, not a parallel writer:
  - model and provider: `createModelSlashCommand` (it sets `agent.model` / `agent.provider` and `applyRuntimeSetting`, and writes a system line)
  - effort: `createEffortSlashCommand`
  - mode / profile: `createProfileCommand` / `createModeToggleCommand`
  - compact: `createCompactSlashCommand`, which calls `compactContext` and writes the system lines
  - retry and undo: `createRewindSlashCommand` (`/undo` and `/retry` are aliases of that machinery). Do **not** call `ConversationService.undoLastUserTurn` from the socket. No production UI caller of that method was found; tests call the session state facade directly. `undoLastUserTurn` would skip the rewind command's transcript and input handling.
  - Commands that call `replaceInput` (the no-argument `/model ` path does) are `rejected` / `needs_a_terminal` from the socket. The socket does not type into the editor.
- **Remote answers (milestone 5), default off, separate flag.** Resolve through `resolvePendingInteraction` / `handleApprovalDecision` / `decideNestedApproval`, including their staleness and revision checks, and update the same UI the keys update. A system line records that a control client answered, with the `messageId` or interaction id. This flag does not exist in milestones 1–4. It is not implied by the socket being on. It must not write `shell.autoApproveMode` or any other setting.

Out of scope until a later design says otherwise: settings writes, credential and OAuth routes, workspace admission, creating or resuming a session over the socket, subagent steering, and streaming the assistant's tokens to the client. The conversation log on disk remains the transcript of record.

## Wire

Newline-delimited JSON over a `SOCK_STREAM` unix socket. One JSON value per line, UTF-8, delimiter `\n`. `JSON.stringify` does not emit a raw newline, so a value produced by that encoder is one frame. The decoder rejects a frame that exceeds **256 KiB** before a newline by closing the connection. It does not keep reading. Pretty-printed input that contains a raw newline is a truncated frame and a parse error, then the connection closes. There is no second chance on a connection that violated the frame cap.

No HTTP, no SSE, no TLS, no assertion header. The gateway's HTTP machine (`MAX_REQUEST_BYTES`, content types, `x-correlation-id`) exists for a BFF. It is not used here.

Every object carries `v: 1`. A first message whose `v` is not 1 gets `unsupported_version` and the connection closes. Later additive fields are ignored by a v1 reader. Renames and type changes are a new `v`. The server's `hello` result lists `v` and `capabilities`.

A request is `{ v, id, method, params }`. `id` is a string, required, unique on that connection among requests still in flight. The response is `{ v, id, ok: true, result }` or `{ v, id, ok: false, error: { code, message } }`. Events are `{ v, kind: "event", type, ... }` and never carry a request `id`.

Clients may pipeline requests. Responses are matched by `id`, not by order, except that admission order is the order the server **started** handling the requests. One slow `status` must not reorder two submits: the admission lock is FIFO.

Error codes, closed set: `unsupported_version`, `unknown_method`, `invalid_request`, `payload_too_large`, `unauthorized`, `not_ready`, `conflict`, `rejected`, `unavailable`, `internal`. `unavailable` is how a later method is reported if a client built ahead of a milestone. `rejected` is application refusal (`reason` in the result when `ok` is true and delivery is `rejected`, or `error.message` when the request itself is refused — pick one in the implementation and test it; recommendation: admission refusals are `ok: true` with `delivery: "rejected"` so idempotent replay stays a result, and only malformed input is `ok: false`). `internal` carries a short message, not a stack.

Hello is the first request. Any earlier method is `unauthorized` and the connection closes. Hello does not take a token. Identity is the socket's mode and owner, below.

Subscriber behavior, copied in spirit from `Term2Gateway`'s slow-consumer drop (`MAX_BUFFERED_SSE_EVENTS` in `gateway.ts` is 256): if a connection's outbound buffer passes 256 unsent events, destroy that connection. Do not stall the session. A lost event is recovered by `status`, not by a replay journal. This protocol has no `after=` cursor. The gateway journal exists because a browser reconnects to a daemon; this process is the session.

Maximum concurrent connections: 8. A ninth is accepted and immediately closed with `unavailable` if a one-line write fits, otherwise destroyed. The cap is a resource guard, not a security boundary.

## Discovery

Socket path, when enabled:

```text
$XDG_RUNTIME_DIR/term2/control/<pid>.sock
$XDG_RUNTIME_DIR/term2/control/<pid>.json
```

`<pid>` is `process.pid`. The path is per process, not per session id, because `resetWithNewId` / rollover changes the session id while the process lives (`onSessionIdChange` in `cli.tsx`). Clients that connected stay connected. The advertisement's `sessionId` is rewritten, and milestone 2 emits `session_changed`.

`$XDG_RUNTIME_DIR` must be present, absolute, owned by the current uid, and mode `0700`. If it is missing or fails that check, the flag does not open a socket and the TUI still starts. One system line says control is off and why. Do not fall back to `/tmp` or to `getConversationsDir()`. `/tmp` is sticky and shared. The conversations directory (`envPaths('term2').data`, overridable by `TERM2_CONVERSATIONS_DIR`) is a durable store, including on SSH, and unix sockets there are the wrong lifetime. No `HERDR_*` variable is read anywhere under `source/` today, so the pane id is not part of the path.

Advertisement `<pid>.json`, mode `0600`, replaced atomically (write temp in the same directory, rename):

```json
{
  "v": 1,
  "pid": 0,
  "startedAt": "<process start time the reaper compares>",
  "sessionId": "<effectiveSessionId>",
  "socketPath": "<absolute path>",
  "cwd": "<process.cwd()>",
  "host": "<os.hostname()>"
}
```

`startedAt` is the kernel process start token, not `Date.now()` at listen. On Linux that token is the starttime field of `/proc/<pid>/stat`. The comm field is parenthesized and may contain spaces, so a whitespace split is wrong. The implementation confirms the field index against `man 5 proc` before trusting it. This environment's `man 5 proc` produced no starttime line, so the index is **not** pinned here.

Stale cleanup, run when an enabled TUI starts and when `term2 control list` runs:

- Parse each `*.json` in that directory.
- If `host` is this host and the pid is not alive, unlink the json and the socket path it names, and nothing else.
- If the pid is alive but the recorded start token does not match, the pid was reused: unlink both. If the start token cannot be read, leave a live pid's files alone.
- Never unlink a path that is not a socket, and never unlink outside the control directory. `GatewayServer.start`'s "if it's a socket, unlink" rule is rejected here because the path is not reserved to one process.

`term2 control list` is a subcommand beside `serve` and `acp` (`cli.tsx` already branches on `cli.input[0]`). It prints one JSON advertisement per live process and reaps as above. It does not connect. Orchestrators find a pane by pid (the process in that pane), then by `sessionId` or `cwd` if they do not have the pid. How a given multiplexer exposes that pid was not verified in herdr. The protocol does not call herdr.

### `--resume` by two processes

The second `term2 --resume <id>` exits in `cli.tsx` when `isConversationLocked` is `held`, or when `logWriter.init` throws `LockConflictError`. It never binds a socket. The live advertisement is the lock holder's. A `stale` lock is reclaimed by the existing writer path; the new process's startup reap drops the dead pid's socket. `--fork` is a new session id and a new process, so a new socket. The socket cannot attach to a session this process does not own, and it cannot break the lock.

## Security

Threat model: other OS users, and **this** user, including a YOLO agent in the session. Same-user socket access is the ability to submit prompts and to interrupt. That is code execution by way of the agent. The design does not pretend otherwise. Opt-in is what keeps an ordinary pane from being that socket.

| Control | Choice |
| --- | --- |
| Enablement | CLI flag `--control-socket`, default off. Not a persisted setting in MVP. A setting in `settings.json` is writable by the agent and would arm the next launch. The flag is visible in the process command line. |
| Directory | Created `0700`, owner uid must equal `process.getuid()`. If `chmod` does not stick, refuse to listen and leave the TUI up. |
| Socket | `0600` after `listen`, same owner check. `(mode & 0o077) !== 0` means close and unlink. `GatewayServer` uses `0o660` for a group BFF; this socket has no group peer. |
| Root | On Linux, mode `0600` does not stop uid 0 from connecting. |
| `SO_PEERCRED` | The right extra check against uid 0 and against a connection accepted in the window before `chmod`. **Node 24.19.0 in this environment does not expose it:** `net.Socket.prototype` has no peer-credential method, and the connected pipe handle's methods do not include a peer uid. Do not call a fictional `getPeerCredentials`, and do not use `process.binding`. |
| Approval | Milestones 1–4 cannot answer an approval, a question, a nested approval, or a sandbox prompt, except `interrupt` following the Escape branch above (deny / cancel / stop). That is the human's key, not a yes. |
| Settings | No write method. The gateway allowlist exists so a new session cannot inherit `shell.autoApproveMode`. This process already has the user's settings. The analogous rule is: the client cannot change them. |
| Indication | On successful bind, one system line: control is on, with the pid. A pane with no line and no flag is not controllable. |

Same-uid clients are accepted when the flag is on. Peer credentials would not tell the orchestrator from the agent. That is why the flag is the boundary.

Milestone 1 ships the mode checks and the root caveat. A native addon or a `getsockopt` helper solely for `SO_PEERCRED` is an open decision, not a hidden dependency of MVP. If it is added later, a peer uid that is not `process.getuid()` closes the connection before hello, including uid 0.

## Input ownership

Socket operations are not keystrokes. They never enter `MenuSurface`, `InputBox`, or the raw stdin bridge the `terminal-input-ownership` skill describes. Double-Escape, Ctrl-C, and bracketed paste keep today's owners. Ctrl-C stays at the application root; the socket does not emit it and does not swallow it.

| Human state | Socket effect |
| --- | --- |
| Draft in the editor | Draft stays. Submit/steer add their own user turn. |
| Menu stack non-empty (`MenuSurface` owns the keyboard) | Menu stays. Session commands still apply. The menu's transient edit buffer is not the socket's text. |
| Approval / question / nested / sandbox prompt | `interrupt` follows the Escape table. `submit` and `steer` use the normal busy routing (`follow_up` or `steer`), which already queues or steers beside an approval. They do not answer the prompt. |
| Human Enter and a socket submit close together | Both call `sendUserMessage`. The JS thread runs one admission, then the other. The second sees whatever queue ownership the first left. There is no merge of the two strings. |

Ordering that **is** guaranteed: one session admission at a time, FIFO across connections, and a receipt that names the delivery the orchestrator actually chose. Ordering that is **not** guaranteed: ordering against an in-flight keypress beyond the event loop's usual serialization, and ordering against provider streaming. Do not document a total order with the keyboard.

`queueStateKind() === 'awaiting_preflight'` and an approval pause are both states where `steerActiveTurn` has historically returned false quickly (`Steer attempt resolved` with `waitedMs ≈ 0`). The receipt must report the boolean's outcome. It must not say the steer was admitted because the client asked for steer.

## Non-interactive mode

`non-interactive.ts` does not listen. The one-shot process already takes the prompt on argv and writes the result to stdout, then exits. A socket would race discovery against exit, and a second submit channel would turn it into a daemon. That daemon is `term2 serve` or `term2 acp`, which own headless sessions and, for ACP, a permission bridge whose posture is fail-closed remote approval. Copying this protocol into the one-shot would also sit next to `NonInteractiveApprovalPolicy` and contract 11's provenance rule for non-interactive yellow commands. Not a goal of this design.

## Tests

Unit tier (`pnpm test`), colocated. No provider black-box: MVP does not change `ApplicationRunLoop`, provider continuity, or tool policy. No full suite: the new code is a new module plus a thin port, not a broadly imported contract.

| Test | What it holds |
| --- | --- |
| Framing | Split chunks, one line, oversize line closes, bad JSON closes, `v` mismatch. |
| Idempotency | Replay same body; `conflict` on a different body; cap does not drop a pending steer id. |
| Mode | Directory not `0700` or socket not `0600` refuses to serve. Temp directory, not the real runtime dir. |
| Reaper | Injected pid-alive and start-token predicates, the same seam style as the conversation lock's pid probe. Does not signal real processes. |
| Phase | `projectControlPhase` table, including "do not read `queueStateKind` for the decision". |
| Port | Fake orchestrator: `submit` uses follow-up when the queue owns the turn; `steer` passes `busyMode: 'steer'`; surge preview refusal does not call `sendUserMessage`; `interrupt` on `ask_user` calls `cancelAskUser` and not `stopProcessing`. |
| Receipt | `delivery: steering` is returned before a deferred `steerActiveTurn` boolean resolves. |

An integration test (`*.integration.*`, `pnpm test:integration`) is not part of milestone 1. Add one only when a later milestone boots `cli.tsx` as a child. A real `net` socket against an in-process server is still a unit test.

Milestone 4 commands that call `compactContext` do not by themselves justify `pnpm test:provider-black-box` if they only invoke the existing slash command. A change to compaction or the run loop does. That gate stays with the code that owns the loop.

## Milestones

Each one can merge alone. Later methods stay `unknown_method` until their milestone.

1. **Speak.** Flag, directory and socket modes, advertisement, reaper, `term2 control list`, hello, status, submit, steer, interrupt, in-memory idempotency, system line on bind and on each accepted mutation, surge refusal. Port bound from the interactive hook. Orchestrator returns a receipt at admission without waiting for the provider.
2. **Watch.** Event subscription and `session_changed` when the session id rolls. Orchestrators stop polling report files for turn completion.
3. **Correct a queue.** Retract and edit by id through the existing submission mutations.
4. **Runtime commands.** Allowlisted slash commands, no editor typing, no `undoLastUserTurn` shortcut.
5. **Answer, still opt-in.** A second flag. Off unless the user turns it on. Not started with milestone 1.

## Rejected alternatives

- **Gateway HTTP on a unix socket, plus an attach mode.** Isolated runtime, `0o660` plus assertions, fixed socket path, and `prepareMessage` that does not update the Ink transcript. The allowlist rule is load-bearing and does not survive "just share the live settings".
- **A subset of `/private/agent/v1/` routes inside the TUI process.** Keeps the HTTP and assertion machinery to avoid writing NDJSON, and adds a second admission path beside `sendUserMessage`. Two admissions is how the UI and the client disagree.
- **ACP on this process.** stdout is taken, and `runAcp` builds a different session through `createProductionRuntimeFactory`. Its permission bridge is the right design for ACP and the wrong default for a human watching an approval prompt.
- **More reliable keystroke injection.** Escape coalescing and paste chunking are terminal behavior. The skill says to treat them as such. Markers like `STEER_ACK_<hex>` exist to recover from echo, which is the thing this design stops doing.
- **A prompt file the TUI polls.** Polling and no atomic interrupt. Completion-by-file is the current completion bug.
- **TCP on localhost.** Any local user can connect, so it needs a secret, and the secret is then in the environment of a YOLO agent. The unix mode bits are the smaller door. `term2 serve` already has TLS for a remote BFF.
- **One well-known `control.sock`.** Two panes unlink each other. That is `GatewayServer.start`'s stale-socket behavior, acceptable for one daemon and not for many TUIs.
- **Server inside `ConversationService`.** Mixes transport, transcript attribution, and menu policy into the session facade.
- **Persisted `controlSocket.enabled`.** The agent can write settings. The flag cannot be persisted by `settings.set`.
- **Answer approvals because the client is local.** That removes the prompt the human is looking at. The gateway's `interaction_resolve` is a deliberate BFF feature with its own assertion purpose. It is not the default here.
- **Non-interactive listener.** Covered above.

## Open decisions

1. **Enablement flag only, or also a setting later?** Recommendation: flag only until someone has a reason to arm every pane. A setting is a follow-up, default off, and still should not be flipable from inside the session the agent is running.
2. **No `$XDG_RUNTIME_DIR`.** Recommendation: leave the socket off and start the TUI. Do not invent a home-directory socket path in MVP. SSH sessions without the variable are out of scope until a user hits them.
3. **`SO_PEERCRED` via a native helper.** Recommendation: do not add a native addon for milestone 1. Document that uid 0 can connect. Revisit if Node grows an API or if a root-bypass shows up in practice. Same-uid abuse is accepted by the flag, and peer cred does not stop it.
4. **Several clients at once.** Recommendation: up to 8 connections, one FIFO admission lock, many event subscribers. The first orchestrator is not special.
5. **`interrupt` on `ask_user`.** Recommendation: match `handleCancelApproval` (`cancelAskUser`), not a hard abort. A hard abort would drop the question record the Escape key keeps.
6. **Final-text excerpt 16_384.** Recommendation: yes, so a client can see completion without a second log parser, and so we do not invent a new bound. Clients that need the full answer read the conversation log.
7. **Threading the large-uncached modal into `status`.** Recommendation: no. Refuse the submit and leave the modal as a human UI. Add `waitKind: preflight` only after an orchestrator is actually stuck on it and a domain snapshot exists.
