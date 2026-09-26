# TUI control socket

Status: Milestone 1 implemented (2026-09-26: M1a read surface merged `2bf3d9c3`, M1b mutations merged `facee0f3`, both live-smoke-tested in a real TUI). Milestones 2–4 not started. Decisions D1–D9 below were recorded 2026-09-26.

## Resume here

This document is the design for a local unix socket that drives the **already running interactive TUI**, the process `cli.tsx` builds around `ConversationService` and Ink `App`. It is not a design for `term2 serve` or `term2 acp`.

Two use cases are the spine. UC1 is an external orchestrator controlling worker panes. UC2 is later: term2 peers talking to each other. Milestone 1 is UC1 speak-and-read. Peer acceptance is a second flag and a later milestone. Do not start by extending `Term2Gateway` or `runAcp`.

Symbols named below were checked against this worktree. Where a behavior was not traced, the sentence says so.

## Use cases

### UC1 — an orchestrator drives worker panes

A script or another harness launches one interactive term2 per worker, then talks to that process. It does not inject keystrokes and it does not answer approvals. The human keeps the terminal.

End to end, with the wire method and the shell equivalent. Every `term2 control` command connects, sends `hello`, performs one call, prints, and exits. `hello` is not a separate command.

| Step | Wire | Shell |
| --- | --- | --- |
| Launch, socket named by the launcher | Process flag only | `term2 --control-socket=<name>` with no positional prompt. A positional prompt selects non-interactive mode, which does not listen. |
| Wait until the port is bound | `status` until the call is not `not_ready` | `term2 control status <name> --json`, retried by the script |
| Submit the brief | `submit` | `term2 control submit <name> --id <clientRequestId> --json` with the brief on stdin |
| Receipt | Response `delivery` of `started`, `queued`, `steering`, or `rejected` | Same process prints the result and exits. The receipt is not the model answer. |
| Watch progress | `status`, and `get` for `pending`, `tools`, `background` | `term2 control status <name> --json` and `term2 control get <name> <topic> --json` |
| Steer or interrupt | `steer`, `interrupt` | `term2 control steer <name> --id <clientRequestId> --json` (stdin); `term2 control interrupt <name> --json` |
| See the turn finish and take the answer | Milestone 1: `wait` is a client poll of `status` (see CLI). Milestone 2: subscribe until `turn_completed` whose `messageId` is the receipt's id, `text` cut at 16_384 characters | `term2 control wait-turn <name> --message-id <id> --json` |
| Approvals | No resolve method | The command set has no answer subcommand. `interrupt` is the Escape branch, which denies, cancels, or stops. It is not a yes. |
| Shut down and release the name | No socket method | The launcher stops the process the way it started it. Process exit drops the socket. The reaper unlinks a dead pid's files. A `shutdown` method would let the in-session agent kill the pane the human is watching, and neither use case needs it. |

`submit` and `steer` require the caller to choose `clientRequestId`. The CLI does not mint one. A generated id would make a retry a second submission.

### UC2 — peers, later

A term2 agent discovers other live term2 sessions and exchanges messages with them. Full design is "Peers" (milestone 4). Milestone 1 must already reject `origin.kind: "peer"` on `submit` and `steer` so a peer payload is not stored as a human turn. The fields that exist for that rejection are in "Wire".

An unattended worker that should talk to peers is launched with the socket and `--control-peers=auto`. Bare `--control-peers` and `--control-peers=ask` still prompt before each send (D9). Example: `term2 --control-socket=<name> --control-peers=auto`, with no positional prompt. `--auto-approve` is not that switch. `cli.tsx` passes `autoApprove` only into `runNonInteractive`, and a positional prompt never binds this socket.

Checked against both use cases and left off the milestone list: queue retract/edit, slash-command runtime controls, a settings export, a diagnostics topic, and a socket shutdown. The reasons are under "Not required by these use cases" and "Rejected alternatives".

## Decisions

Recorded 2026-09-26. These are no longer open.

| Id | Decision | Why |
| --- | --- | --- |
| D1 | Enablement is the CLI flag only. No settings key. | A key in `settings.json` is writable by the agent and would arm the next launch. `--control-peers` is a second flag, same rule, not a setting. Its `ask` / `auto` value is D9. |
| D2 | Missing or unsafe `$XDG_RUNTIME_DIR`: socket stays off, TUI still starts. | Do not invent a home-directory or `/tmp` path. `/tmp` is sticky and shared. `getConversationsDir()` is a durable store. |
| D3 | No native `SO_PEERCRED` in milestone 1. Document that mode `0600` does not stop uid 0. | Node 24.19.0 in this environment exposes no peer-credential method on `net.Socket.prototype` or the connected pipe handle. Same-uid access is accepted by the flag. Peer credentials would not tell an orchestrator from the agent. |
| D4 | Up to 8 connections. One FIFO admission lock. | The first client is not special. The cap is a resource guard, not a security boundary. |
| D5 | `interrupt` while `ask_user` is pending calls `cancelAskUser`. | That is what `handleCancelApproval` does. A hard abort would drop the question record Escape keeps. |
| D6 | `turn_completed` text excerpt is 16_384 characters. | Same bound as the gateway final-text projection. The client reads the conversation log when it needs the rest. |
| D7 | The large-uncached modal is not a `status` field. Socket `submit` refuses. | The modal is React state (`pendingLargeUncachedTurn`, `largeUncachedPreview`), not a pending-interaction snapshot. Naming it from the socket would scrape the component. |
| D8 | The accepted forms are bare `--control-socket` and `--control-socket=<name>` only. | `term2 --control-socket fixbug` is ambiguous with a positional prompt, and a positional prompt is the non-interactive launcher. The space-separated form is not a name. |
| D9 | Peer sends prompt unless the process was launched with `--control-peers=auto`. Bare `--control-peers` means `ask`. | Unattended workers have nobody to answer a prompt. `shell.autoApproveMode` is a setting, so tying peer sends to `always` would let the session arm them after launch, including on a pane the launcher did not mark. `auto` is argv for this process only. It does not answer the recipient's approvals. Hop and rate limits still apply. |

D9 does not revise D1–D8. Peer accept stays a flag. Peer discovery uses the name D8 already binds.

## Why

Orchestrators currently drive a live term2 pane by injecting keystrokes. That fails for reasons that are properties of the terminal, not of the conversation:

- Ink can coalesce two Escape bytes into one gesture, and a paste arrives as one chunk. The `terminal-input-ownership` skill documents both.
- The screen the orchestrator scrapes is a projection. `ConversationOrchestrator.sendUserMessage` logs `Submission routing decided` because a queued row and a transcript line do not tell you whether a steer was admitted.
- Completion polling of report files is outside the turn lifecycle in contract 01.

The socket speaks the operations the session already has.

## Why this is not the gateway

`term2 serve` (`runServe`, `GatewayServer`, `Term2Gateway`, `createProductionRuntimeFactory`) is a headless session factory. Attaching that wire to a live TUI was considered and rejected.

- `createProductionRuntimeFactory` builds a **new** `AgentClient` graph per session and copies only `PRODUCTION_AUTHORITY_SETTING_KEYS` (keys that start with `agent.` or `webSearch.`). The hard-won rule in `docs/plans/web-client-gateway-completion.md` is that a host `shell.autoApproveMode: always` must not enter a gateway session. The live TUI is the opposite object: it is already running on the user's real `SettingsService`.
- Gateway auth is an RS256 assertion plus OTP pairing (`x-term2-assertion`, `GatewayPairing`). `GatewayServer.start` listens on a unix socket and then `chmod`s it `0o660`, because a BFF in the same group must connect. A control client is the same OS user.
- `GatewayServer.start` unlinks a stale socket at a **fixed** path whenever the inode is a socket. Two interactive processes cannot share that path. `cli.tsx` already refuses a second writer: `isConversationLocked` returns `held`, and `ConversationLogWriter` throws `LockConflictError`.
- Gateway submit is `prepareMessage` / `commitMessage`. The TUI's transcript is updated by `ConversationOrchestrator.sendUserMessage`, which the gateway never calls.
- `runAcp` is the same factory over stdio. stdout of the interactive process is the TUI.

Reuse from the gateway is the pattern, not the stack: an opaque client request id, a bounded final-text excerpt (16_384 characters, D6), and "a settings write is not a session control".

## Ownership

The socket module earns a file because deleting it would push framing, directory mode, advertisement, and idempotency back into `cli.tsx` and the Ink tree.

| Concern | Owner |
| --- | --- |
| Bytes, framing, version, mode checks, advertisement files, idempotency map | New `source/services/control-socket/`. Not a session policy object. |
| Submit, steer, queue, interrupt, transcript rows, system notices | `ConversationOrchestrator`, reached through a `ControlSessionPort` the interactive hook binds. |
| Reads | The same port. A read never takes the admission lock and never calls a mutation, a renderer, or `useInput`. |
| Steer admission and request boundaries | `ApplicationRunLoop`, unchanged. |
| Queue items and their promises | `QueueController` and `ConversationAdapter`, unchanged. |
| Approval decisions | `services/approval/` and the existing resolve methods. The socket answers an approval only in milestone 3, and only when that flag is on. |
| Turn status legality | `TurnStatusMachine`. The socket does not write it. |
| Process start and stop, conversation lock | `cli.tsx`, which already constructs `ConversationService` and calls `render`. |

`ConversationService` is the wrong place for the listener. It has no draft, no menu, and no system-message line. `setEventSink` is a single slot. `ServerSession` (the gateway) sets it for the life of a gateway session. `non-interactive.ts` also sets it for the one-shot turn when `supportsPersistentEventSink` is true, and clears it with `setEventSink(null)` when that turn ends. Interactive `cli.tsx` does not call it. The control path may observe the slot only while it is null, and must fan out instead of replacing a sink someone else set. Steer admission is not an adapter event: `steerActiveTurn` returns a boolean from the run loop, and the orchestrator logs `Steer attempt resolved`.

Do not add a `Runner`, `Driver`, or `Coordinator`. One server type and one port interface are the seam.

### Where it is wired

`cli.tsx` constructs the server **before** `render`, only when the enablement flag is set, and closes it after `waitUntilExit` and on the same shutdown path that already ends the process. The server starts with no port bound. Session methods, including `get` and `status`, return `not_ready` until `App` / `useConversation` binds a `ControlSessionPort`. Unmount unbinds the port. The listening socket stays up for the process so a React remount does not unlink the path clients already discovered.

The port implementation calls the same functions the keyboard already calls. It does not write stdin and does not use `useInput`.

Binding the port from the hook is deliberate: `sendUserMessage`, `stopProcessing`, `cancelAskUser`, and `addSystemMessage` already live there. A second call chain into `ConversationService.sendMessage` would skip the transcript (contract 01's projection rules) and the queue row.

## Capabilities

### Milestone 1

Enabled together by `--control-socket`. No other methods exist on the wire yet. Unknown methods are `unknown_method`.

| Operation | Session call | Receipt means |
| --- | --- | --- |
| `submit` | `ConversationOrchestrator.sendUserMessage` with `busyMode: 'follow_up'` when a turn owns the queue, otherwise an immediate send. Same routing `Submission routing decided` already records. | The session kept the text: a turn was started, or a follow-up was queued. `messageId` is the id `sendUserMessage` already assigns. |
| `steer` | `steerActiveTurn` via `sendUserMessage` with `busyMode: 'steer'`. | The session kept the text as a pending steer (`messageId` assigned) **or** the existing fallback ran. Not "the model has seen it". |
| `interrupt` | The same branch as `handleCancelApproval` in `app.tsx` (table below). | The branch ran. Idle interrupt is `accepted: false`, `reason: idle`, and must not clear the draft. |
| `status` | A read assembled by the port. | A snapshot. Does not mutate. Does not take the admission lock. |
| `get` | A read of one topic, below. | A snapshot. Does not mutate. Does not take the admission lock. Does not render. |
| `hello` | None. | Protocol version, the capability set, and the topic set this process will answer. |

One read method, `get`, with `params.topic`. Separate read methods per topic would freeze the method list before the topic list is known, and `status` is already the UC1 progress poll (phase, queue, the few fields a waiter checks every second). Folding that poll into `get` would make the hot path a topic parameter and would not shrink the lock rule. `get` is everything else. Topic `status` is `invalid_request`; the client calls `status`.

Text only on `submit` and `steer`. `isMessageBody` on the gateway rejects every key except `text` and `clientRequestId`. The control body allows those plus the optional `origin` object in "Wire". Images and attachments are `invalid_request`. Text length is 1..128_000 characters, the same ceiling as `isMessageBody`.

`submit` and `steer` must call `ConversationService.previewLargeUncachedInput` and `previewInputSurge` and **refuse** when the decision is not allow (D7). They must not mint an `inputSurgeApproval` the human did not give. The receipt is `rejected` / `needs_confirmation`. Whether `sendMessage` also enforces that preview on its own was not fully traced; the socket refuses first either way.

The human draft in `InputBox` is not read, cleared, or concatenated.

Visible effect on every accepted orchestrator submit or steer: the ordinary user row `sendUserMessage` already appends, plus one system line that names the origin and the `messageId` (for example `Control submit <id>`). The model still sees a user turn. The human can tell it from their own Enter. `UserMessage.presentation` is only `'session_rollover'` today; do not overload it. A peer origin does not take this path in milestone 1.

### Reads (`get`)

`params` is `{ topic, limit?, before? }`. `limit` and `before` are honored only for `transcript`. Any other topic that receives them is `invalid_request`.

Unknown topic strings are `invalid_request`. A topic this document assigns to a later milestone is `unavailable`, and `hello.topics` does not list it yet. Reads never include a settings dump.

Redaction, all milestones: API keys, OAuth tokens, and other credential-bearing settings never leave the process. Do not use `SettingsService.isSensitive` as that oracle. `SENSITIVE_SETTING_KEYS` is `app.shellPath`, `agent.openrouter.baseUrl`, `agent.openrouter.referrer`, and `agent.openrouter.title`. `settings-service` tests record that `isSensitive('agent.openai.apiKey')` is false, while `apiKey` fields on the schema are `.meta({ secret: true })`. The rule is the schema mark and the key shape (`apiKey`, or a path segment of `token`, `oauth`, or `credential`), not `isSensitive`. There is no settings topic, so this rule is a ban on copying those values into any result, event, advertisement, or system line. Do not add a scanner that tries to redact secrets inside model output or tool arguments. The conversation log is already readable by the same uid. A scanner would pretend otherwise.

| Topic | Milestone | Fields | Source | Bound |
| --- | --- | --- | --- | --- |
| `session` | 1 | `sessionId`, `socketName`, `pid`, `host`, `cwd`, `workspaceRoot`, `version`, `createdAt`, `startedAt`, `logPath`, `profileId` | `ConversationService.sessionId`. Socket name, `process.pid`, `os.hostname()`, `process.cwd()`. `getActiveWorkspaceRoot()`. Version: the `package.json` `version` string `term2 --version` prints through `meow` in `cli.tsx` (no `APP_VERSION` export; copy it once at listen). `createdAt`: `effectiveCreatedAt` in `cli.tsx`, the value passed as `sessionStartedAt` into `ConversationService`. There is no public getter on the service today; the server is constructed in `cli.tsx`, which already updates that variable on rollover. `startedAt`: the advertisement's kernel starttime token, not wall clock. `logPath`: `logPath` in `conversation-log-writer.ts` (`path.join(dir, sessionId + '.jsonl')` with `getConversationsDir()`). `profileId`: `SettingsService.get('app.activeProfileId')`, or null when unset. Do not substitute the status bar's `'builtin:standard'` display default. | Small. No title field: no session-title symbol exists. `SessionInitEvent` has `id`, `createdAt`, `projectPath`, `activeProfileId`, model, provider, effort. It has no title. |
| `model` | 1 | `provider`, `model`, `reasoningEffort`, `autoApproveMode` | `SettingsService.get` of `agent.provider`, `agent.model`, `agent.reasoningEffort`, `shell.autoApproveMode`. Read-only. The status bar reads the same keys via `useSetting`. | Four strings. No API keys, no custom `providers[]` entries (those objects carry `apiKey` on `CustomProviderSchema`). |
| `usage` | 1 | `cumulative`, `contextWindow`, `cost`, `lastRequest` | `cumulative`: `UsageAccumulator.get()` on the orchestrator's `usageAccumulator` (`NormalizedUsage` totals). Include `prompt_tokens`, `completion_tokens`, `cache_read_tokens`, `cache_creation_tokens` only. `contextWindow`: `getModelContextWindow` for the active provider and model. `cost`: `ConversationOrchestrator.getCostSummary()` (`SessionCostSummary`). `lastRequest`: null in milestone 1. | The last request figure the status bar shows is reducer state `lastUsage` (`conversation-ui-reducer.ts`), filled from `UIPort.onUsageUpdate`. That is a projection. `createUsageAccumulator` only sums. `SessionCostAccumulator.getModelUsageBreakdown` sums per model. `AssistantTurnEvent.displayUsage` is the footer figure, and it is on the log after the turn settles, not a live getter. Milestone 2 may add an orchestrator getter that stores the last `NormalizedUsage` passed to `onUsageUpdate` inside `applyServiceResult`. Until that getter exists, the field stays null. Do not read the reducer. |
| `pending` | 1 | One foreground object or null, plus `nested` or null | `ConversationService.getPendingInteractionSnapshot()` (`PendingInteractionSnapshot`: `interactionId`, `revision`, `approval`, `askUserAnswers`, `currentAskUserQuestionIndex`). `approval` is a `PendingApproval` / `ApprovalDescriptor`. `nested`: `getNestedApprovalSnapshot()` (`NestedApprovalSnapshot`). | Foreground: `interactionId`, `revision`, `toolName`, `callId`, `checkIn`, `currentAskUserQuestionIndex`, `argumentsExcerpt` (500 characters of `approval.argumentsText`), and for `toolName === 'ask_user'` (`TOOL_NAME_ASK_USER`) the current question parsed the same way `getAskUserQuestions` parses `approval.argumentsText` (`questions[]` of `question`, `options[].label`, `is_multi_select`). Option labels cut at 80 characters, at most 8, matching `askUserSchema`. Omit `rawInterruption`, `deniedRead.command` past the excerpt, `postExecute`, and the answer the human has typed. Nested: `requestId`, `nestedCallId`, `toolName`, `argumentsExcerpt` 500 from `approval.argumentsText`. Omit `preparedArguments`, `authorityContext`, and `revalidateAuthority`. |
| `tools` | 1 | `calls`: `{ callId, toolName, status }[]` | `SessionToolTracker.unsettledToolCallIdsForCurrentTurn` joined to `SavedToolExecution.toolName` and `status` on the ledger. Not on the service facade. Milestone 1 adds this read. | No `arguments`. The ledger stores them (`SavedToolExecution.arguments`). Leave them off. Empty array when the read is wired and nothing is unsettled. `null` only if the tracker read is not wired yet, never a guess from the status bar. |
| `background` | 1 | `tasks`: `{ kind, id, status, startedAt, labelExcerpt }[]` | `BackgroundTaskControl.listDetails` (`BackgroundTaskControlDetails`), reached from `ConversationService.backgroundTaskControl`. | At most 32 entries, live before terminal, the order `listDetails` already sorts. `labelExcerpt` is `taskPreview` for a subagent and `command` for a shell, cut at 500 characters. Omit `output`, `error`, `currentText`, `toolCounts`, `latestUsage`, and `recentTools`. Those carry command output. |
| `transcript` | 2 | `messages`: `{ kind, id, excerpt }[]`, `oldestOffset` | Settled log events only: `UserMessageEvent` (`type: 'user_message'`, `message.text`) and `AssistantTurnEvent` (`type: 'assistant_turn'`). Assistant excerpt is the concatenation of `AssistantTextItem.text` (`type: 'assistant_text'`) inside `PersistedAssistantTurn.items`. | `limit` default 20, maximum 50. Excerpt 500 characters each. `before` is the previous result's `oldestOffset`, a byte offset in the session jsonl. Absent means the tail. Do not read the delta sidecar (`DELTA_SIDECAR_SUFFIX`, `assistant_journal_delta`). Do not read `MessagePort.getMessages` or the reducer. Contract 01 says projections can lag. In-progress assistant text is not this topic; UC1 takes the answer from `turn_completed`. |

`status` stays the poll. Its fields are unchanged from the table below, except the context correction: `promptTokens` follows the same rule as `usage.lastRequest` (null until the milestone 2 getter). `contextWindow` and `cost` are populated in milestone 1. Putting the last-request figure on `status` by reading the reducer would make the poll a projection, which is the screen-scrape bug.

Dropped candidates:

- **Diagnostics.** No domain snapshot for "last error" or "retry state". `ErrorLogEvent` is a log line. `ConversationService.retryLastFailedTurn` is a mutation, not a status. Codex rate limits arrive as `CodexRateLimitInfo` through `UIPort.onRateLimitUpdate` and are stored as reducer `lastCodexRateLimit`. `RunBudgetEvent` shown as a warning is reducer `runBudgetNotice`. When a stall or budget pause is actually holding the turn, it is already on `pending` via `PendingApproval.runBudgetEvent` (`type: 'tool_stall'` or `type: 'budget_stage'`). Report that there, with `argumentsText` cut at 500. Do not scrape the reducer for a diagnostics topic.
- **Settings.** UC1's model read is the `model` topic. A settings export would re-open credential bytes. `/settings` can show those bytes on purpose (`settings-command` tests); this socket must not.

### Receipts, steer, and idempotency

Two different facts:

1. **Receipt** (response to the request): the application accepted custody of this `clientRequestId`. Fields: `messageId`, `delivery` of `started`, `queued`, `steering`, or `rejected`, and `reason` when rejected. Returned as soon as `sendUserMessage` has assigned the id and invoked the existing path. Not held until the provider returns. `sendUserMessage` currently awaits the whole turn; the port needs a split so the turn promise stays inside the orchestrator and the receipt returns at admission. That split is the one orchestrator change milestone 1 requires. It must not change steer policy.
2. **Admission** (later event, milestone 2; the boolean already exists in milestone 1 logs): `steerActiveTurn` resolved `true` (`admitted`) or `false` (`released`, and today's code reclassifies the row to `follow_up`). The receipt's `delivery: steering` means "pending", not "admitted".

`clientRequestId` is required, opaque, and matches the gateway's `isOpaqueId` shape: 1..256 characters from `[A-Za-z0-9_-]`. The server stores an in-memory map from that id to the receipt and a hash of the body, for the life of the process, capped at 256 entries (drop the oldest completed entries; do not drop an entry whose steer is still pending). Same id and same body returns the original receipt with `replayed: true` and does not append a second transcript row. Same id and different body is `conflict`. The map is not durable. A client that retries after process death is talking to a new process and must use a new id.

The mutation lock covers only admission (the call that assigns the id and starts `sendUserMessage` / `stopProcessing`), not the turn. Otherwise `interrupt` would wait until the turn finished. Requests on one connection run in read order. Connections share one admission lock. `status` and `get` do not take that lock. A slow `get` of `transcript` must not sit in front of `submit`.

### Interrupt branch

`interrupt` calls the same decisions as Escape on the focused surface, not `ConversationService.abort()` and not synthetic keys.

| What is in front of the human | What `handleCancelApproval` does today | Socket `interrupt` |
| --- | --- | --- |
| Sandbox network prompt | Deny that prompt | Same |
| Background-subagent approval | Resolve it `no` | Same |
| Nested approval without a foreground pending approval | `stopProcessing` | Same |
| `ask_user` | `cancelAskUser` (keeps the turn record) | Same (D5) |
| Any other approval | `stopProcessing` (abort the turn, drop the pending tool) | Same |
| None of the above | Keyboard stop is `stopProcessingWithNotice` (`Stopped` system line) | Same, including the system line |

`ConversationService.interruptFromUser` aborts the turn **and** cancels background subagent runs and background shell jobs. `abort()` does not cancel those runs. `stopProcessing` on the orchestrator is the user-asked-everything-to-stop path: it calls `interruptFromUser`, marks running command rows aborted, clears the pending interaction, and drains background-subagent notifications. Use that path, not `abort()`, when the branch says `stopProcessing`.

Idle: if none of those surfaces are up and the port's phase is `idle`, return `accepted: false`, `reason: idle`. Do not call `stopProcessing` just to be sure. That method clears transient UI and drains notifications even as part of stopping.

### Status snapshot

`ConversationService` does not expose `TurnStatusMachine` (`SessionStatus` is `idle | streaming | awaiting_approval | continuing`). `queueStateKind` is documented on the service as diagnostics only: do not branch submit or steer on it. Phase is a new projection, `projectControlPhase`, tested on its own. First match wins:

| Input the port can already see, or a read milestone 1 adds | `phase` | `waitKind` |
| --- | --- | --- |
| `getPendingInteractionSnapshot()` whose approval tool is `ask_user` | `awaiting_approval` | `question` |
| `getNestedApprovalSnapshot()` non-null, and no foreground pending interaction | `awaiting_approval` | `nested_approval` |
| Any other `getPendingInteractionSnapshot()` | `awaiting_approval` | `approval` |
| Orchestrator has an active turn, or `isQueueOwningSubmissions()` / `isQueueActive()` | `working` | null |
| Else | `idle` | null |

`queueStateKind` is included as a string field for humans and logs. Routing code ignores it.

The large-uncached confirmation stays out of this snapshot (D7). Phase can read `idle` or `working` while that modal is up. Socket submit refuses the surge instead of naming the modal.

Snapshot fields:

- `phase`, `waitKind`, `queueStateKind`
- `sessionId`
- `queue`: outstanding submissions `{ id, text, stage }` where `stage` is `pending_steer` or `queued`. Milestone 1 adds `listOutstandingSubmissions()` on the orchestrator, filled from the ids `sendUserMessage` already tracks (adapter `#pendingSteerIds` / queued items), not from the reducer field `pendingQueuedMessages`. Text for a pending steer is the text passed into `steerActiveTurn`. Cap the returned text per item at 500 characters.
- `currentTool`: the same read as `get` topic `tools`, or `null` until that read is wired.
- `context`: `contextWindow` from `getModelContextWindow`. `promptTokens` is null until the milestone 2 last-request getter. Do not invent a percentage. Do not copy reducer `lastUsage`.
- `cost`: `ConversationOrchestrator.getCostSummary()`. Null when there is no accumulator.
- `model`, `provider`, `reasoningEffort` from `SettingsService.get` of the keys the status bar reads. Read-only. `autoApproveMode` is on `get model`, not on this poll.

### Events (milestone 2)

Subscribe on the same connection. Events are JSON objects with `kind: "event"` and no request id. Names, and only these: `turn_started`, `turn_completed`, `turn_failed`, `turn_interrupted`, `tool_started`, `tool_finished`, `approval_required`, `question_required`, `steer_admitted`, `steer_released`, `queue_changed`, `session_changed`.

`turn_completed`, `turn_failed`, and `turn_interrupted` carry `messageId`, the id from the receipt of the user turn that started that turn. UC1's `wait-turn` and UC2's `ask_peer` correlate on it. Without that field a subscriber cannot tell its turn from the one already running when the message was queued. `turn_completed.text` is the assistant text cut at 16_384 characters (D6): concatenation of `AssistantTextItem.text` for that turn, not reasoning items and not tool arguments. No token deltas.

`approval_required` and `question_required` carry tool name and an arguments excerpt cut at 500 characters. They are notifications. There is no answer field and no resolve method.

`get transcript` in this milestone is the catch-up for a client that was not subscribed. It is not the completion signal. Completion is the event.

### Remote answers (milestone 3), default off

UC1 leaves approvals with the human. A later flag may resolve through `resolvePendingInteraction` / `handleApprovalDecision` / `decideNestedApproval`, including their staleness and revision checks, and update the same UI the keys update. A system line records that a control client answered. This flag does not exist in earlier milestones. It is not implied by the socket being on, or by `--control-peers`. It must not write `shell.autoApproveMode` or any other setting.

### Out of scope

Settings writes, credential and OAuth routes, workspace admission, creating or resuming a session over the socket, subagent steering, streaming the assistant's tokens to the client, and stopping the process. The conversation log on disk remains the transcript of record.

## Peers (milestone 4)

UC2. Ships only with `--control-peers`, and only when `--control-socket` also bound a name. The peer flag without a socket does not register tools and does not listen. One system line says peers are off and why. The flag is not a setting (D1). It is visible on the command line, same as the socket flag.

Accepted forms, pre-scanned the same way as `--control-socket` so `meow` does not consume the next token:

| Argv | `peerSends` |
| --- | --- |
| absent | off |
| `--control-peers` | `ask` |
| `--control-peers=ask` | `ask` |
| `--control-peers=auto` | `auto` |

Any other value (`--control-peers=always`, empty, `yes`) leaves peers off and starts the TUI. `--control-peers ask` is the bare flag plus a positional `ask`, which is the non-interactive launcher and does not listen. Use the equals form.

`ask` is the default because a human watching the pane should see each send. `auto` exists so an orchestrator can launch unattended workers that talk to each other. It is not implied by `shell.autoApproveMode: always` and not implied by `--auto-approve`.

The flag does both directions. The sender needs a socket name so the recipient can attribute the message and so a reply has an address. A send-only mode would queue replies the sender then refuses. `ask` and `auto` both accept inbound peer origin. The value changes only whether this process prompts before `send_peer` and `ask_peer`.

On successful peer enablement, one system line names the mode (`peers ask` or `peers auto`). Milestone 4 adds `peerSends` to the advertisement when the flag is on. Milestone 1's advertisement has no peer field.

### Tools

Registered from `agent.ts` only when the flag is set, the same kind of gate as the other optional tools there. Names:

| Tool | Effect |
| --- | --- |
| `list_peers` | Read the control directory the way `term2 control list` does. Keep advertisements whose `host` is `os.hostname()`. Drop this process's pid. For each remaining live advertisement, connect and call `status`. Return `name`, `cwd`, `sessionId`, `phase`, `waitKind`. No title. `list` without a status call cannot show phase; the advertisement does not carry it, and rewriting the json on every phase change is a second protocol. |
| `get_peer` | Connect to `name` and call `get` with the caller's topic. The topic must be in the caller's closed set. The result passes through the recipient's redaction. |
| `send_peer` | Connect and `submit` with `origin.kind: "peer"`. Return the receipt, including `messageId`. |
| `ask_peer` | `send_peer`, then wait on that connection for `turn_completed` / `turn_failed` / `turn_interrupted` with that `messageId`. |

`run_code` can call the same functions if the code host exposes them. It does not get a second protocol. The tool is the agent-facing surface; the socket is the wire.

Under `peerSends: ask`, `needsApproval` on `send_peer` and `ask_peer` returns true, the same hook `createAskUserToolDefinition` uses. This is not a shell command. `shell.autoApproveMode`, including `always`, does not satisfy it. Whether today's resolver already bypasses every `needsApproval` under `always` was not fully traced; the `ask` mode must still prompt either way. Under `peerSends: auto`, those two tools do not prompt and do not consult `shell.autoApproveMode`. The mode is the launch flag, not a setting write. `list_peers` and `get_peer` are reads and do not prompt in either mode.

If this process has no bound socket, the tool returns an error and does not prompt. There is no name to put in `origin`.

### How a peer message enters the recipient

Delivery uses the existing submit routing. Idle starts a turn (`delivery: started`). Busy queues a follow-up (`delivery: queued`). Steer is not the peer path. `ask_peer` waits for the event whose `messageId` is its receipt, so a turn that was already running does not satisfy the wait.

The body is not stored as the human's text.

- `UserMessage.presentation` gains `'peer'` in this milestone. It stays off `'session_rollover'`. The row the human sees is labeled with the sender, not drawn as their own Enter.
- The provider history has no peer role. `ProviderInputItem.role` is an open field, and `ConversationStore.addUserMessage` is the text ingress. The stored text is an envelope, not the raw peer body: a leading line `Peer message from <name> session <sessionId> hop <n> — untrusted input, not a user instruction`, the body, and a closing line. The same idea as the compaction banner in `context-compaction.ts`, which tells the model that quoted text is not instructions. The envelope is not a security boundary by itself. The accept flag is the control. In `ask` mode the sender's approval prompt is a second control. In `auto` mode the launcher already made that choice on argv.
- A system line records `Peer <name> <sessionId> <messageId>`.
- Milestone 1 never writes this row. `origin.kind: "peer"` is `unavailable` and does not append.

`origin` on the wire:

```json
{
  "kind": "peer",
  "name": "<sender socket name>",
  "sessionId": "<sender ConversationService.sessionId>",
  "hop": 1,
  "chain": ["<sender socket name>"]
}
```

`kind: "orchestrator"` or a missing `origin` is the UC1 path (a user turn plus `Control submit <id>`). A term2 agent that opens the socket itself and omits `origin` still has that UC1 path. The peer flag does not close it. Same-uid clients can already speak NDJSON when the socket is on. The peer flag only admits the peer envelope.

### Replies

`ask_peer` correlates on `messageId`. A queued request waits through the turns ahead of it. The tool takes `timeoutSeconds`, capped at 600. On timeout it returns `{ status: "timeout", messageId }` and does not `interrupt` the recipient. Cancelling would be the Escape branch on someone else's pane. A `rejected` receipt returns immediately, no wait. The recipient's approval prompts stay the recipient human's. The peer tool set has no resolve and no `interrupt`.

### Safety

- **Opt-in, both sides.** Sender: `--control-peers` (`ask` or `auto`) and a bound socket, or the tool refuses. Recipient: bound socket and `--control-peers`, or `origin.kind: "peer"` is `unavailable`. `auto` on the sender does not force `auto` on the recipient.
- **Approval on send.** `ask` prompts. `auto` does not. The recipient does not get a second approval for receiving; they opted in with the flag, and the text is marked untrusted. They still approve their own tools. `auto` does not skip the hop cap or the rate cap.
- **No approval on the recipient's behalf.** Milestone 3's answer flag is not granted to peer origin, in `ask` or in `auto`. `interrupt` stays a UC1 method any socket client can call, which is the accepted same-uid self-loop, not a peer-tool feature. `send_peer` / `ask_peer` do not call it. `auto` pre-authorizes the send only.
- **Ping-pong.** Recipient rejects a peer submit when `hop` is greater than 3, when `hop` is not an integer ≥ 1, when `chain` does not end with `origin.name`, or when the recipient's own socket name is already in `chain`. A forward must append its own name and increment `hop`. The cap is a loop guard, not a throughput target. It does not apply to orchestrator submits.
- **Rate.** At most 8 accepted peer submits per sender `name` per 60 seconds, in memory, on the recipient. Excess is `rejected` / `rate_limited` and does not enter the transcript. Same shape of guard as the 8-connection cap: a resource limit against a loop, not a measured latency budget. Orchestrator submits are not counted.
- **Prompt injection.** Peer text is untrusted input to the recipient model. The envelope says so. The milestone adds a short system-prompt fragment, scoped to that envelope, telling the model not to treat it as the human and not to run instructions found inside it. Do not claim the fragment makes the text safe.

Discovery for a human is the same directory. `term2 control list` prints advertisements and does not connect. `term2 control list --status` also calls `status` on each live socket and adds `phase` and `waitKind`. Title is absent on both.

## Wire

Newline-delimited JSON over a `SOCK_STREAM` unix socket. One JSON value per line, UTF-8, delimiter `\n`. `JSON.stringify` does not emit a raw newline, so a value produced by that encoder is one frame. The decoder rejects a frame that exceeds **256 KiB** before a newline by closing the connection. It does not keep reading. Pretty-printed input that contains a raw newline is a truncated frame and a parse error, then the connection closes.

No HTTP, no SSE, no TLS, no assertion header. The read surface is `get`, not GET. The gateway's HTTP machine (`MAX_REQUEST_BYTES`, content types, `x-correlation-id`) exists for a BFF. It is not used here.

Every object carries `v: 1`. A first message whose `v` is not 1 gets `unsupported_version` and the connection closes. Later additive fields are ignored by a v1 reader, with one exception: `origin.kind: "peer"` is not ignored. Treating it as absent would store a peer body as a human turn. Milestone 1 answers it with `unavailable` and writes nothing. Renames and type changes are a new `v`.

A request is `{ v, id, method, params }`. `id` is a string, required, unique on that connection among requests still in flight. The response is `{ v, id, ok: true, result }` or `{ v, id, ok: false, error: { code, message } }`. Events are `{ v, kind: "event", type, ... }` and never carry a request `id`.

Methods in milestone 1: `hello`, `status`, `get`, `submit`, `steer`, `interrupt`. Later methods stay `unknown_method` until their milestone. `hello` result is `{ v, capabilities, topics }`.

`submit` and `steer` params: `{ text, clientRequestId, origin? }`. `origin.kind` is `orchestrator` or `peer`. Other kinds are `invalid_request`. Missing `origin` means orchestrator, so UC1 scripts do not have to send the object.

Clients may pipeline requests. Responses are matched by `id`, not by order, except that admission order is the order the server **started** handling the requests. One slow `get` must not reorder two submits: the admission lock is FIFO, and reads do not take it.

Error codes, closed set: `unsupported_version`, `unknown_method`, `invalid_request`, `payload_too_large`, `unauthorized`, `not_ready`, `conflict`, `rejected`, `unavailable`, `internal`. `unavailable` is how a later method, a later topic, or peer origin is reported before its milestone. `rejected` is application refusal (`reason` in the result when `ok` is true and delivery is `rejected`; recommendation: admission refusals are `ok: true` with `delivery: "rejected"` so idempotent replay stays a result, and only malformed input is `ok: false`). `internal` carries a short message, not a stack.

Hello is the first request. Any earlier method is `unauthorized` and the connection closes. Hello does not take a token. Identity is the socket's mode and owner.

Subscriber behavior, copied in spirit from `Term2Gateway`'s slow-consumer drop (`MAX_BUFFERED_SSE_EVENTS` in `gateway.ts` is 256): if a connection's outbound buffer passes 256 unsent events, destroy that connection. Do not stall the session. A lost event is recovered by `status` and, from milestone 2, `get transcript`, not by a replay journal. This protocol has no `after=` cursor on the event stream. `transcript.before` is a byte offset into the jsonl the client already received, not a journal id. The gateway journal exists because a browser reconnects to a daemon; this process is the session.

Maximum concurrent connections: 8 (D4). A ninth is accepted and immediately closed with `unavailable` if a one-line write fits, otherwise destroyed.

## Discovery

The client that launches the pane chooses the endpoint name. It does not look the pane up afterwards.

The orchestrator that launches these panes reports that `herdr pane list --workspace <id>` returns `pane_id`, `tab_id`, `cwd`, `foreground_cwd`, `terminal_id`, `terminal_title`, and agent fields, and does not return a pid. The process in the pane is the shell, not term2. Two panes often share a cwd. A directory scan by pid or cwd cannot tell that launcher which socket it just started. The name is known because the launcher passed it. This repo does not read `HERDR_*` and does not call herdr. `terminal_title` in that pane list is a herdr field, not a term2 session title.

Flag forms (D8). Do not register `--control-socket` as a `meow` string flag. `cli.tsx` builds its CLI with `meow`, and a string flag consumes the next argv token. That consumption is the ambiguity D8 removes. Pre-scan argv, strip only a bare `--control-socket` and `--control-socket=<name>`, then let `meow` see the rest.

- Bare `--control-socket` uses the decimal pid as the name.
- `--control-socket=<name>` uses that name. The name matches `[A-Za-z0-9_-]{1,64}`. Anything else (empty, too long, slash, dot, space, `=`) does not open a socket. The TUI still starts. One system line says the name was rejected.
- `--control-socket <name>` does not set the name. The following token stays a positional. `term2 --control-socket fixbug` is bare enablement (pid name) plus a positional prompt, which takes the non-interactive path and therefore does not listen. Launchers that want a stable name use the equals form and no positional prompt.

`--control-peers` is the milestone 4 flag in "Peers". It does nothing unless a socket bound. Do not register it as a `meow` string flag.

Paths, when the socket actually binds:

```text
$XDG_RUNTIME_DIR/term2/control/<name>.sock
$XDG_RUNTIME_DIR/term2/control/<name>.json
```

The name is not the session id. `resetWithNewId` / rollover changes the session id while the process lives (`onSessionIdChange` in `cli.tsx`). Clients that connected stay connected. The advertisement's `sessionId` is rewritten in place, and milestone 2 emits `session_changed`. The socket path does not change.

`$XDG_RUNTIME_DIR` must be present, absolute, owned by the current uid, and mode `0700` (D2). If it is missing or fails that check, the flag does not open a socket and the TUI still starts. One system line says control is off and why. Do not fall back to `/tmp` or to `getConversationsDir()`. No `HERDR_*` variable is read anywhere under `source/` today, and the pane id is not part of the path.

Advertisement `<name>.json`, mode `0600`, replaced atomically (write temp in the same directory, rename):

```json
{
  "v": 1,
  "name": "<name>",
  "pid": 0,
  "startedAt": "<starttime token>",
  "sessionId": "<effectiveSessionId>",
  "socketPath": "<absolute path>",
  "cwd": "<process.cwd()>",
  "host": "<os.hostname()>"
}
```

No phase and no title in this file. Phase is a `status` call. Title does not exist.

`startedAt` is the kernel starttime, not `Date.now()` at listen. proc(5) defines `starttime` as field 22 (1-based) of `/proc/<pid>/stat`. Parse it by taking the substring after the **last** `)` (the comm field is parenthesized and may contain spaces and parentheses), then the 20th whitespace-separated token of what remains (fields 3 through 22). A split of the whole line on whitespace is wrong. The unit-test seam feeds fixture lines, including a comm that contains spaces and a `)`, and does not read a live `/proc` unless a test asks it to.

Bind order:

1. Run stale cleanup (below).
2. If an advertisement for this name remains, and its pid is alive on this host with the same start token, the name is held. Do not unlink that socket. Do not listen. The TUI still starts. One system line names the holder pid and the name.
3. If the start token cannot be read, treat a live pid as live and leave its files alone (same as cleanup). The new process then sees the name held and refuses the socket.
4. If `<name>.sock` exists and is not a socket, refuse to listen and do not unlink it.
5. If `<name>.sock` exists, is a socket, and no live advertisement owns the name, unlink that socket and bind. This is only the crash window after `listen` and before the advertisement rename, or a reap that removed the json and left the socket. It is not `GatewayServer.start`'s rule of unlinking every socket at a fixed path.
6. Listen, `chmod 0600`, write the advertisement.

Stale cleanup, run when an enabled TUI starts and when `term2 control list` runs:

- Parse each `*.json` in that directory.
- If `host` is this host and the pid is not alive, unlink the json and the socket path it names, and nothing else.
- If the pid is alive but the recorded start token does not match, the pid was reused: unlink both. If the start token cannot be read, leave a live pid's files alone.
- Never unlink a path that is not a socket, and never unlink outside the control directory.

`term2 control list` is a subcommand beside `serve` and `acp` (`cli.tsx` already branches on `cli.input[0]`). It prints one JSON advertisement per live process, including `name`, and reaps as above. It does not connect. `term2 control list --status` connects and adds `phase` and `waitKind`. The launcher does not need list to find the pane it started.

### `--resume` by two processes

The second `term2 --resume <id>` exits in `cli.tsx` when `isConversationLocked` is `held`, or when `logWriter.init` throws `LockConflictError`. It never binds a socket. The live advertisement is the lock holder's. A `stale` lock is reclaimed by the existing writer path; the new process's startup reap drops the dead pid's socket. `--fork` is a new session id and a new process. It gets a socket only under its own name. The socket cannot attach to a session this process does not own, and it cannot break the lock.

## CLI

`term2 control` subcommands. Each connecting command speaks `hello` then one call. Exit 0 prints the result. Exit 1 is connection failure, protocol error, `not_ready`, or `ok: false`. The process does not retry. Scripts loop on exit 1 when they are waiting for the port to bind.

| Command | Call |
| --- | --- |
| `term2 control list [--status]` | Reap and print. `--status` adds a `status` call per live socket. |
| `term2 control status <name> [--json]` | `status` |
| `term2 control get <name> <topic> [--json]` | `get`. Optional `--limit` and `--before` only with `transcript`. |
| `term2 control submit <name> --id <clientRequestId> [--json]` | `submit`. Brief on stdin, so it is not on the command line. Empty stdin is exit 1 and does not connect. |
| `term2 control steer <name> --id <clientRequestId> [--json]` | `steer`. Stdin, same rule. |
| `term2 control interrupt <name> [--json]` | `interrupt` |
| `term2 control wait-turn <name> --message-id <id> [--timeout <seconds>] [--json]` | See below. |

`--json` prints one JSON result value. Without it, print a single human line (`phase=working`, `delivery=started messageId=…`). Scripts that parse output pass `--json`.

`wait-turn` default timeout is 600 seconds, a property of this client process, not of the session. There is no server-side wait method in milestone 1.

- If `hello.capabilities` does not include the event subscription, poll `status` about once a second. Exit 0 when `phase` is `idle` and `messageId` is not in `queue`. Exit 3 when `phase` is `awaiting_approval` (the human still has the prompt; this is not a socket failure). Exit 2 on timeout. This poll is racy if another turn starts and finishes between samples, or if the target id is queued behind work that returns to idle for a reason other than that id. Milestone 1 scripts that need a hard correlation wait for milestone 2.
- If events are advertised, subscribe and exit 0 on `turn_completed` for that `messageId` (the result includes `text`), exit 1 on `turn_failed`, exit 3 on `turn_interrupted` or on `approval_required` / `question_required` for that turn, exit 2 on timeout. Do not `interrupt` on timeout.

## Security

Threat model: other OS users, and **this** user, including an agent in the session. Same-user socket access is the ability to submit prompts and to interrupt. That is code execution by way of the agent. Opt-in is what keeps an ordinary pane from being that socket.

The agent is an intended client in two different ways, and they must stay distinct.

- **UC1 self-loop.** When the flag is on, the session's own agent can connect. Its shell inherits `$XDG_RUNTIME_DIR`, and `/proc/self/cmdline` shows `--control-socket` and the name. It can submit, steer, or interrupt, including the Escape-equivalent interrupt. That was accepted before UC2, and UC2 does not remove it. A path variable exported into the tool environment would only make the address easier to find; do not export one. A shared secret in argv or in the `0600` advertisement is readable by the same uid. The flag plus the system line is the mitigation for this path.
- **UC2 peer tool.** The supported way for an agent to address another term2 is `list_peers` / `get_peer` / `send_peer` / `ask_peer`, which always send `origin.kind: "peer"`. The recipient accepts that origin only with `--control-peers`. This is additional opt-in, not a replacement for the self-loop paragraph.

| Control | Choice |
| --- | --- |
| Enablement | `--control-socket` or `--control-socket=<name>`, default off (D1, D8). Not a persisted setting. |
| Peers | `--control-peers` / `=ask` / `=auto`, default off, milestone 4 (D9). Requires a bound socket. |
| Directory | Created `0700`, owner uid must equal `process.getuid()`. If `chmod` does not stick, refuse to listen and leave the TUI up. |
| Socket | `0600` after `listen`, same owner check. `(mode & 0o077) !== 0` means close and unlink. `GatewayServer` uses `0o660` for a group BFF; this socket has no group peer. |
| Root | On Linux, mode `0600` does not stop uid 0 from connecting (D3). |
| `SO_PEERCRED` | Not in milestone 1 (D3). Do not call a fictional `getPeerCredentials`, and do not use `process.binding`. |
| Approval | Only milestone 3 has a resolve method, behind its own flag. `interrupt` follows the Escape branch. Peer tools do not call `interrupt` or that resolve method. `peerSends: auto` does not either. |
| Settings | No write method and no settings topic. |
| Indication | On successful bind, one system line: control is on, with the name and the pid. A pane with no line and no flag is not controllable. Peers on is a second line. |

## Input ownership

Socket operations are not keystrokes. They never enter `MenuSurface`, `InputBox`, or the raw stdin bridge the `terminal-input-ownership` skill describes. Double-Escape, Ctrl-C, and bracketed paste keep today's owners. Ctrl-C stays at the application root; the socket does not emit it and does not swallow it.

| Human state | Socket effect |
| --- | --- |
| Draft in the editor | Draft stays. Submit/steer add their own turn. |
| Menu stack non-empty (`MenuSurface` owns the keyboard) | Menu stays. Session commands still apply. The menu's transient edit buffer is not the socket's text. |
| Approval / question / nested / sandbox prompt | `interrupt` follows the Escape table. `submit` and `steer` use the normal busy routing. They do not answer the prompt. |
| Human Enter and a socket submit close together | Both call `sendUserMessage`. The JS thread runs one admission, then the other. There is no merge of the two strings. |

Ordering that **is** guaranteed: one session admission at a time, FIFO across connections, and a receipt that names the delivery the orchestrator actually chose. Ordering that is **not** guaranteed: ordering against an in-flight keypress beyond the event loop's usual serialization, and ordering against provider streaming.

`queueStateKind() === 'awaiting_preflight'` and an approval pause are both states where `steerActiveTurn` has historically returned false quickly (`Steer attempt resolved` with `waitedMs ≈ 0`). The receipt must report the boolean's outcome.

## Non-interactive mode

`non-interactive.ts` does not listen. The one-shot process already takes the prompt on argv and writes the result to stdout, then exits. A socket would race discovery against exit. That daemon is `term2 serve` or `term2 acp`. A positional prompt together with the control flag is this mode, which is why D8 refuses to treat the next token as a socket name.

## Tests

Unit tier (`pnpm test`), colocated. No provider black-box: milestone 1 does not change `ApplicationRunLoop`, provider continuity, or tool policy. No full suite: the new code is a new module plus a thin port, not a broadly imported contract.

| Test | What it holds |
| --- | --- |
| Framing | Split chunks, one line, oversize line closes, bad JSON closes, `v` mismatch. |
| Idempotency | Replay same body; `conflict` on a different body; cap does not drop a pending steer id. |
| Mode | Directory not `0700` or socket not `0600` refuses to serve. Temp directory, not the real runtime dir. |
| Reaper | Injected pid-alive and start-token predicates. Fixture `/proc` stat lines include a comm with spaces and a `)`, and the parser asserts field 22 via the last-`)` rule. |
| Name | Rejects a name outside `[A-Za-z0-9_-]{1,64}` without killing the process. Bare flag uses the pid. Equals form uses the name. A following argv token after a bare flag is not consumed as the name. An advertisement whose pid is alive and whose start token matches makes the new process refuse that name and leave the holder's socket in place. |
| Phase | `projectControlPhase` table, including "do not read `queueStateKind` for the decision", and "do not report the large-uncached modal". |
| Port | Fake orchestrator: `submit` uses follow-up when the queue owns the turn; `steer` passes `busyMode: 'steer'`; surge preview refusal does not call `sendUserMessage`; `interrupt` on `ask_user` calls `cancelAskUser` and not `stopProcessing`. |
| Receipt | `delivery: steering` is returned before a deferred `steerActiveTurn` boolean resolves. |
| Reads | `get` and `status` do not take the admission lock and do not call `sendUserMessage`. `session` / `model` / `usage` / `pending` / `tools` / `background` match the source fields above, including `usage.lastRequest: null` and `promptTokens: null`. Unknown topic is `invalid_request`. `transcript` is `unavailable`. A fixture `agent.openai.apiKey` value does not appear in any milestone 1 result. |
| Origin | `origin.kind: "peer"` on `submit` is `unavailable` and does not append a user row. Missing `origin` still submits. |
| CLI | `get` exits non-zero when the server returns `ok: false`. Argument parsing only: equals name versus a following positional. Do not spawn a live TUI in the unit tier. |
| Peer ask | With `peerSends: ask` (bare `--control-peers` and `--control-peers=ask`), `send_peer` still prompts when `shell.autoApproveMode` is `always`. |
| Peer auto | With `--control-peers=auto`, `send_peer` and `ask_peer` do not prompt. They still refuse a hop over 3 and a rate-limit excess, and they still do not resolve the recipient's pending approval. A value other than `ask` or `auto` leaves peers off without exiting. A following argv token after a bare `--control-peers` is not consumed as the mode. |

An integration test is not part of milestone 1. Add one only when a later milestone boots `cli.tsx` as a child.

The peer tests belong with the peer tools, still unit tier, unless they force a change to the shared approval resolver. A change to that resolver's contract is a broader test decision at the time, not a provider black-box by itself.

## Milestones

Each one can merge alone. Later methods stay `unknown_method` until their milestone. Later topics stay `unavailable`.

1. **Speak and read (UC1).** Flag forms from D8, directory and socket modes, named advertisement, reaper, `term2 control list`, `status`, `get`, `submit`, `steer`, `interrupt`, the connecting CLI commands including the polling `wait-turn`, in-memory idempotency, system line on bind and on each accepted mutation, surge refusal, peer origin rejected. A held name leaves the TUI up and the socket down. Port bound from the interactive hook. Orchestrator returns a receipt at admission without waiting for the provider. `get` topics: `session`, `model`, `usage`, `pending`, `tools`, `background`.
2. **Watch.** Event subscription, `messageId` on the terminal events, `turn_completed` text at 16_384 characters, `get transcript`, last-request usage getter, `session_changed` when the session id rolls. `wait-turn` uses the event when `hello` advertises it.
3. **Answer, still opt-in.** The remote-answer flag. Off unless the user turns it on. Not started with milestone 1. Peer origin cannot use it.
4. **Peers (UC2).** `--control-peers` (`ask` by default, `auto` when the launcher passes it), the four tools, the peer envelope and `'peer'` presentation, hop and rate limits, `list --status`, `peerSends` on the advertisement.

Queue edit and slash commands are not numbered. They are not required by either use case.

## Rejected alternatives

- **Gateway HTTP on a unix socket, plus an attach mode.** Isolated runtime, `0o660` plus assertions, fixed socket path, and `prepareMessage` that does not update the Ink transcript.
- **HTTP GET, or a subset of `/private/agent/v1/` routes, inside the TUI.** The read surface is `get` on the NDJSON socket. HTTP would keep the assertion machinery to avoid a method name.
- **ACP on this process.** stdout is taken, and `runAcp` builds a different session. Its permission bridge is the wrong default for a human watching an approval prompt.
- **More reliable keystroke injection.** Escape coalescing and paste chunking are terminal behavior.
- **A prompt file the TUI polls.** Polling and no atomic interrupt.
- **TCP on localhost.** Any local user can connect. The unix mode bits are the smaller door.
- **One well-known `control.sock`.** Two panes unlink each other.
- **Discover the pane by pid, cwd, or session title.** The launcher's pane list has no pid, the pane's process is the shell, a shared cwd matches more than one worker, and term2 has no session title to match. The launcher already knows the name it put on the command line.
- **Space-separated `--control-socket <name>`.** Ambiguous with a positional prompt (D8). A `meow` string flag would implement that ambiguity by consuming the next token.
- **Server inside `ConversationService`.** Mixes transport with the session facade.
- **Persisted `controlSocket.enabled` or `controlPeers.enabled`.** The agent can write settings. The flags cannot be persisted by `settings.set`.
- **Treat `--auto-approve` or `shell.autoApproveMode: always` as permission to send to peers.** `--auto-approve` is handed to `runNonInteractive` only, and that process does not listen. The setting is writable during the session and would also arm a watched pane whose launcher asked for `ask`. D9 is a separate argv value.
- **A settings `get` topic.** UC1 does not need it. `isSensitive` does not cover `apiKey`. `/settings` is allowed to display credential bytes; this socket is not.
- **A diagnostics topic fed from the reducer.** `lastUsage`, `lastCodexRateLimit`, and `runBudgetNotice` are UI state. The domain facts that hold a turn are already on `pending`.
- **Answer approvals because the client is local.** That removes the prompt the human is looking at.
- **Non-interactive listener.** Covered above.
- **A `shutdown` method.** The launcher owns process lifetime. The in-session agent must not get a socket call that exits the TUI.
- **Peer text stored as a bare user turn.** That gives the sender the human's authority in `ConversationStore`. The envelope and the `'peer'` presentation exist so the row and the model input both say otherwise.
- **Export `TERM2_CONTROL_SOCKET` into the tool environment.** The same uid can already read the command line. The variable only makes the self-loop easier.

## Not required by these use cases

Kept so the next reader does not re-derive them as milestone work.

- **Queue edit and retract.** `ConversationOrchestrator` already routes `retractSubmission` / `editSubmission` by id. UC1 submits, steers, interrupts, and waits. It does not edit a queued row. If a later design adds it, address by id. Do not pop "the last item".
- **Slash commands over the socket** (model, effort, profile, compact, rewind). The launcher passes `--model`, `--provider`, and `--reasoning` on the worker command line. UC2 does not retune the peer's model. `createRewindSlashCommand` is the rewind path (`/undo` and `/retry` are aliases). Do not call `ConversationService.undoLastUserTurn` from a future socket command. No production UI caller of that method was found. Commands that call `replaceInput` (the no-argument `/model ` path does) need a terminal. The socket does not type into the editor.
