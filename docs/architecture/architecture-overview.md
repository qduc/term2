# Architecture overview

Term2 clients send commands and render events. The host connects a client to the
right session. A session records what happened and applies Term2 policy, while
`@qduc/agent-core` runs the model and tool loop.

## Where the host runs

| Launch path | Where the session lives |
| --- | --- |
| In-process | The launcher uses the host built by `createDirectApplication` in [application.ts](../../src/app/application.ts). This is the default path. |
| Daemon-backed | `startTerm2Daemon` builds the same host in a separate local process. TUI, headless and ACP clients connect over the Unix Client API. HTTP, named control sockets and Discord use daemon-owned listeners or connections scoped to the launcher. |

The daemon path is opt-in. The launcher selects it for eligible invocations.
The [source layers](layers.md#host-paths) identify the launchers and transport
entry points. The [Client API specification](../plans/daemon/spec/client-api.md)
defines the local RPC and stream boundary.

Both paths use the same native session. Detaching a client from a daemon session
leaves the session with the daemon. A listener lease, such as the one for
`term2 serve`, instead ends when its owning launcher disconnects.

## How a turn runs

1. The host sends a native command through `applyDirectCommand` in
   [commands.ts](../../src/protocol/commands.ts). A daemon client sends that
   command to the host over RPC first.
2. The [conversation](../../src/session/conversation.ts) admits the input.
   [conversation-turn.ts](../../src/session/conversation-turn.ts) appends
   admission and accepted turn facts to the native JSONL log.
3. `startTurn` in [harness.ts](../../src/session/harness.ts) starts
   `@qduc/agent-core`. The [portable turn engine](https://github.com/qduc/agent-runtime/tree/main/packages/core/src/engine)
   runs the loop using the model registry and tool capabilities Term2 supplies.
   The conversation records each accepted event before advancing the turn's
   acceptance boundary.
4. The host projects session updates through `DirectProjection` in
   [projection.ts](../../src/protocol/projection.ts). Local attachments share
   that projection. Transports can wrap or translate it for their clients. On
   reopen, [replay.ts](../../src/session/replay.ts) rebuilds durable state from
   the conversation log.

When a tool needs permission or the model asks a question, the engine waits
for an answer. The session applies approval policy and records any human
decision before releasing the wait. The [native conversation contract](../contracts/09-rewrite-native-conversation.md)
covers durable ordering and shutdown.

Child agents use the same portable harness through `startNestedTurn`. The
session owns their branches through `createDirectBranchDriver` in
[branches.ts](../../src/session/branches.ts). The [delegation boundary](../../src/delegation/README.md)
covers launch, role and workspace policy.

## Earlier designs

The prior conversation core and loop described the runtime removed in #197.
Their reasoning about model execution, durable acceptance and cancellation is
available in [the earlier design notes](https://github.com/qduc/term2/tree/c455d16c5/docs/architecture).
The [original output recovery design](assistant-output-recovery-architecture.md)
also belongs to that earlier runtime.
