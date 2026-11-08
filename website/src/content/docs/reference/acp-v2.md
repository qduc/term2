---
title: Agent Client Protocol
description: Stable ACP v1 and experimental ACP v2 for editor and coding-agent clients.
---

term2's direct ACP adapter connects editors and other interactive clients to the
native Host/session protocol. It uses `@agentclientprotocol/sdk` **1.4.0**, supporting stable v1 and
`experimental/v2`. The [upstream v2 specification](https://agentclientprotocol.com/protocol/v2/overview)
is a changing draft; the v2 adapter does not claim compatibility with every draft revision.

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

## JetBrains Air and stable ACP v1

The same `term2 acp` command selects v1 when the editor initializes with
`protocolVersion: 1`; there is no version flag. It returns `agentInfo`,
`agentCapabilities` and an empty `authMethods` list. Configure provider
credentials in Term2 before launching through the editor.

For the Air plugin in JetBrains IDEs, merge this entry into
`~/.jetbrains/acp.json` (replace the executable path with your installed Term2):

```json
{
  "agent_servers": {
    "Term2": {
      "command": "/absolute/path/to/term2",
      "args": ["acp"],
      "use_idea_mcp": false,
      "use_custom_mcp": false
    }
  }
}
```

For standalone Air, use **Add ACP Agent** in the agent selector and edit the
configuration file Air opens. If Term2 uses an nvm Node installation, ensure
its `bin` directory is in the agent process's `env.PATH`, since the executable
uses Node from PATH. Provider/model overrides use the same launch flags above.

V1 supports session new/list/load/resume/close, prompts, cancellation and tool
permissions. Prompt responses wait for completion and contain `stopReason`.
History loads replay retained messages; resume omits history. Message output
uses append-only chunks, and tool permissions use v1's `toolCall` field.
Structured questions and budget pauses currently stop/decline through the
unsupported-form fallback. MCP forwarding remains unsupported.

Air's model selector uses the v1 session `configOptions` response and
`session/set_config_option`. It starts with Term2's current model and cached
catalogs, then updates as configured providers finish discovery. Model changes
apply to that session, persist across load/resume, and use Term2's own provider
credentials. They do not change your global default model.

If Air still rejects session creation with an unsupported MCP error, disable
`jetbrains_air_ide` in Air's MCP server catalog settings. Some Air builds
contribute it independently of the per-agent flags above. The catalog setting
affects all Air agents.

The sections below describe the experimental v2 exchange and its limits.

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
message/tool order and streamed-to-final identity are preserved within each
root or branch transcript. Accepted branch snapshots replay through separate
renderers using their real identities; no cross-branch chronology is inferred. Numeric replay
cursors are unsupported and rejected; do not treat a Host sequence number as an
ACP cursor.

Only one local foreground prompt is accepted at a time. Native Session admission
also rejects prompts when another client owns foreground work; inputs are not
silently queued or steered. Cancel targets the known turn ID and preserves other
clients' queued work. Close cancels known foreground work, waits for its actual
terminal and detaches this client's subscription. Background-session shutdown
semantics in newer drafts are not implemented by this attachment close operation.

## Permissions, questions and budgets

The launcher fixes `autoApprove: false`, `allowUnsandboxed: false`,
`approvalAlwaysAsks: true` and `requireSandbox: true`. Each ACP session pins
`shell.autoApproveMode: off` and `sandbox.enabled: true` in memory, including on
resume; saved user settings are not rewritten. Commands that the native tool
policy considers safe do not require a permission exchange; approval-required
calls always go to the client. ACP does not provide an automatic approval flag or
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

The verified client is the SDK **1.4.0 experimental/v2** reference client over
NDJSON stdio (Node **24.19.0**, Linux). On 2026-11-08 a tarball installed outside
the source checkout completed a live **Google Gemini 3.8 Flash** text turn,
observed `idle/end_turn`, closed its session and exited zero with protocol-only
stdout. Node environment proxy support (`NODE_USE_ENV_PROXY=1`) was required in
the cloud environment. This establishes reference-client compatibility; no GUI
editor version has been validated.

The packed installation also runs the deterministic process cases: input,
permissions, replay/resume, EOF and signals. Filesystem-backed native Host/Session
checks cover question sets, budget provenance, shared admission and cancellation
races, close and disconnect. Only the external model/tool behavior is scripted in
those native interaction checks; the process cases invoke the real shell tool.

The default agent command sandbox lacked `socat` and prohibited nested namespace
setup, providing the sandbox-unavailable refusal check. A separate managed-host
run outside that command sandbox used **Bubblewrap** and the official Debian
**socat 1.8.0.3** package, extracted locally. Both `approve` and `allow-once`
completed real sandboxed workspace writes; an outside-workspace write remained
blocked despite approval and saved `sandbox.enabled:false`. The process suite's
`TERM2_ACP_REQUIRE_SHELL_SUCCESS=1` option makes successful writes mandatory on
hosts equipped to exercise that path.
