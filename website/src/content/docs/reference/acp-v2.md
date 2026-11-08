---
title: Agent Client Protocol v2
description: The experimental ACP v2 subset for editor and coding-agent clients.
---

term2's direct ACP adapter connects editors and other interactive clients to the
native Host/session protocol. It uses `@agentclientprotocol/sdk` **1.4.0**,
`experimental/v2`. The [upstream v2 specification](https://agentclientprotocol.com/protocol/v2/overview)
is a changing draft; this is not an ACP v1 endpoint or a claim of compatibility
with every revision of v2.

## Launch

```sh
term2 acp --provider <provider> --model <exact-model-id> [--effort <effort>]
```

The launcher is `src/app/launch-acp.ts`; the adapter lives in
`src/clients/acp/`. Build a source checkout with `pnpm build`, then invoke
`node dist/cli.js acp`. Flags are parsed by `src/app/serve-args.ts`. Unknown flags,
including `--auto-approve`, fail with diagnostics on stderr. Model resolution is
noninteractive; an ambiguous model pattern is refused.

Stdin and stdout carry newline-delimited UTF-8 JSON-RPC. Diagnostics use stderr.
EOF or SIGINT/SIGTERM closes the connection, detaches subscriptions and disposes
the process-owned application. There is no fixed shutdown deadline. Detaching
an ACP subscription does not itself cancel a shared session; explicit cancel
and close have separate behavior.

## Supported exchange

Initialize with the pinned SDK's v2 client:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 2,
    "info": { "name": "example-client", "version": "1.0.0" },
    "capabilities": { "elicitation": { "form": {} } }
  }
}
```

The response advertises:

```json
{
  "protocolVersion": 2,
  "info": { "name": "term2", "title": "term2", "version": "<version>" },
  "capabilities": { "session": { "prompt": { "image": {}, "embeddedContext": {} } } }
}
```

The adapter supports `session/new`, `session/list`, `session/resume`,
`session/prompt`, `session/cancel` and `session/close`. It sends `session/update`,
`session/request_permission` and, when the client explicitly advertises
`capabilities.elicitation.form`, `elicitation/create` in form mode.

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/absolute/project"}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"<returned sessionId>","prompt":[{"type":"text","text":"Explain this project"}]}}
```

Use the actual returned session ID. Listen for updates before sending a prompt.
In this SDK revision the prompt response is an empty acknowledgement; completion
arrives separately as `state_update` with `state: "idle"`. Work reports `running`
and blocked native foreground interactions report `requires_action`, then
`running` when progress resumes. Only an observed native turn terminal settles
an admitted prompt. Runtime failures use the extension stop reason
`_term2_error`; cancellation uses `cancelled`.

Text and resource links are baseline input. Links are passed as URI references,
not fetched by the adapter. Embedded text resources use the standard
`resource: {uri, text, mimeType?}` shape; no nested `type` is required. Binary
embedded resources and audio are rejected before admission. Images require an
`image/*` MIME type and raw padded RFC4648 base64. Image-only prompts and mixed
text/image block order are preserved. Actual image processing depends on the
selected model's capabilities.

## Sessions and replay

`cwd` must resolve to an existing absolute directory. It becomes the canonical
workspace root. Resume requires the same canonical root and uses the existing
native session ID. List results use Host metadata and omit unavailable titles
and timestamps rather than inventing them.

Resume without `replayFrom` attaches without replaying old transcript entities.
Every attachment synchronizes its current foreground state. With
`replayFrom: {"type":"start"}`, retained history is replayed from an atomic
snapshot, followed by current activity and subsequent live events. Mixed
message/tool order and streamed-to-final identity are preserved. Numeric replay
cursors are unsupported and rejected; do not treat a Host sequence number as an
ACP cursor.

Only one local foreground prompt is accepted at a time. Native Session admission
also rejects prompts when another client owns foreground work; inputs are not
silently queued or steered. Cancel targets the known turn ID and preserves other
clients' queued work. Close cancels known foreground work, waits for its actual
terminal and detaches this client's subscription. Background-session shutdown
semantics in newer drafts are not implemented by this attachment close operation.

## Permissions, questions and budgets

The launcher fixes `autoApprove: false`, `allowUnsandboxed: false` and
`approvalAlwaysAsks: true`. ACP does not provide an automatic approval flag or
an unsandboxed permission option. If the shell sandbox cannot run, the launcher
warns on stderr; shell execution cannot gain an unsandboxed fallback through ACP.

Approvals use real native request/execution IDs. The base options are `approve`
(allow once) and `reject` (deny once); the older `allow-once` reply remains an
alias for approve. Recognized scoped/Docker grants are offered only when the
native interaction advertises them. Native Session owns their scope validation
and lifetime; the ACP adapter never caches permission grants or widens them to
unscoped approval. The adapter currently recognizes native remembered and
project grants too; it does not implement an independent persistent approval
store. Unsupported, malformed, cancelled or unknown replies fail closed.

Questions use structured form elicitation and map each answer to its stable
native question ID. Budget pauses use a separate form; only an explicit
`extend` answer carries human provenance. Missing form support, invalid answers,
failed requests or cancellation decline the question or stop the budget, with
system provenance for local fallbacks. An empty `elicitation: {}` does not
advertise form support. Late responses cannot resolve a different native request.

## Compatibility limits

The pinned SDK differs from the latest online v2 draft. It requires exact
protocol version 2 and one initialization per connection, returns an empty
prompt acknowledgement rather than the newer `messageId` response, and still
supports the older `tool_call` announcement alongside `tool_call_update`.
Updating these wire contracts requires a coordinated SDK/client migration.

MCP, additional workspace directories, configuration methods, authentication,
URL elicitation and numeric replay cursors are unsupported. Nonempty MCP or
additional-directory requests are rejected with `-32602`. Presence in the full
upstream schema is not evidence that term2 implements a feature.

The automated compatibility client is the pinned SDK 1.4.0. Built-CLI cases use
real stdio and a loopback model fixture for input, replay and shutdown. Question
cases use SDK NDJSON with a filesystem-backed native Session/Host and fixture
model/tool; Bare does not expose `ask_user` through the current CLI. Before the source-tree migration was incorporated, a separate SDK 1.4.0 stdio smoke
also completed a Gemini 3.8 Flash turn against the configured Google endpoint.
The cloud smoke required Node's environment proxy support (`NODE_USE_ENV_PROXY=1`).
A packed-install smoke check and editor acceptance remain separate release
requirements; these checks do not establish general editor compatibility.
