---
title: Agent Client Protocol v2
description: The implemented ACP v2 subset for editor and coding-agent clients.
---

term2 has an experimental adapter for version 2 of the
[Agent Client Protocol](https://agentclientprotocol.com/). ACP is a JSON-RPC
protocol for connecting code editors and other interactive clients to coding
agents.

:::caution[Not yet a runnable endpoint]
The current milestone implements and tests the protocol adapter, but it does
not yet register an ACP launcher or a public CLI transport. A stock ACP client
cannot launch term2 from a released command yet. This page documents the wire
contract already implemented in `createAcpV2Agent`; the launch command will be
documented when that integration is added.
:::

This is separate from the [private Web Gateway API](/term2/reference/gateway-api/).
ACP targets editor and coding-agent integrations. The Web Gateway remains the
authenticated HTTP/SSE control plane for browser deployments.

## Version and framing

The adapter uses `@agentclientprotocol/sdk` 1.4.0's `experimental/v2` surface
and negotiates protocol version `2`. Its transport-independent tests cover the
SDK's newline-delimited JSON stream: each JSON-RPC message is UTF-8 JSON followed
by a newline.

Clients should use the ACP v2 types or schema shipped by that SDK. The upstream
v2 specification is still a draft; do not infer support for a method merely
because it exists in the full ACP schema.

## Advertised capabilities

Initialization returns only the baseline session capability:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 2,
    "info": { "name": "term2", "title": "term2", "version": "<term2 version>" },
    "capabilities": { "session": {} }
  }
}
```

The adapter does not advertise authentication methods, prompt extensions,
session configuration, MCP, or elicitation. In particular, it does not implement
`auth/login`, `auth/logout`, `session/set_config_option`, `session/fork`,
`session/delete`, or the ACP MCP and elicitation methods.

## Implemented methods

| Direction | Method | Parameters | Result |
| --- | --- | --- | --- |
| Client → agent request | `initialize` | `protocolVersion`, `info`; optional ACP client capabilities | Version `2`, term2 implementation info, and `{session:{}}` capabilities |
| Client → agent request | `session/new` | `cwd` | `sessionId` |
| Client → agent request | `session/list` | Optional `cwd` and `cursor` | ACP `sessions` array and optional `nextCursor` |
| Client → agent request | `session/resume` | `sessionId`, `cwd`, optional `replayFrom` | Empty result in the current backend contract; replay arrives through updates |
| Client → agent request | `session/prompt` | `sessionId`, ACP `prompt` content blocks | Empty acknowledgement; work continues asynchronously |
| Client → agent notification | `session/cancel` | `sessionId` | No response |
| Client → agent request | `session/close` | `sessionId` | Empty result after active work settles and backend resources close |
| Agent → client notification | `session/update` | `sessionId`, ACP `update` | No response |

`cwd` is an absolute path under the ACP schema. The adapter currently rejects a
non-empty `additionalDirectories` or `mcpServers` array on `session/new` and
`session/resume` with JSON-RPC code `-32602` (invalid parameters). Omit those
members or send empty arrays.

`replayFrom` is passed to the session backend only when the client supplies it.
Omitting it resumes without inventing a replay cursor. `{ "type": "start" }`
requests replay from the start according to ACP v2 semantics.

## Prompt lifecycle

`session/prompt` accepts the ACP v2 `PromptRequest` shape. A text-only request is:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "session-1",
    "prompt": [{ "type": "text", "text": "Explain this project" }]
  }
}
```

Once preparation succeeds, term2 sends a running notification and acknowledges
the request before execution finishes:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"state_update","state":"running"}}}
{"jsonrpc":"2.0","id":3,"result":{}}
```

Output is delivered as standard ACP `session/update` notifications. For example:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","messageId":"assistant-1","content":{"type":"text","text":"Hello"}}}}
```

After preparation succeeds, prompt execution ends with an idle state update.
Successful work carries the backend's ACP stop reason; cancellation uses
`cancelled`:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"state_update","state":"idle","stopReason":"end_turn"}}}
```

The adapter forwards the ACP session updates produced by its backend, so clients
should handle the standard `SessionUpdate` union and ignore extension fields they
do not need. A non-cancellation execution failure is logged by term2 and terminates
with the implementation-specific stop reason `_term2_error`.

## Admission, cancellation, and close

Only one foreground prompt may be admitted for a session at a time. A second
`session/prompt` for the same session is rejected with JSON-RPC code `-32000`,
including while the first prompt is still being prepared. Other sessions are
independent.

Cancel with a JSON-RPC notification:

```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": { "sessionId": "session-1" }
}
```

Cancellation aborts the adapter's active operation and asks the backend to cancel
the session. The prompt then settles with an idle `state_update` whose
`stopReason` is `cancelled`.

`session/close` performs the same cancellation for active work, waits for that
work to settle, and then closes the backend session. If backend cancellation
fails, the adapter still waits and closes the session before returning a JSON-RPC
internal error (`-32603`).

## Minimal exchange

The following is the smallest create-and-prompt sequence. Each object is one
newline-delimited JSON message:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2,"info":{"name":"example-client","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/absolute/project"}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"session-1","prompt":[{"type":"text","text":"Hello"}]}}
```

Use the `sessionId` returned by `session/new`; `session-1` is only illustrative.
Listen for `session/update` notifications before sending the prompt so the client
cannot miss the initial running state.

## Compatibility boundary

The complete wire schema comes from ACP v2, not from a term2-specific fork. This
page narrows that schema to the methods and behavior the current adapter actually
implements. When the adapter advertises more capabilities, clients may opt into
them; until then, treat unadvertised ACP methods as unsupported.
