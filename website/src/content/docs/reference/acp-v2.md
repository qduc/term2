---
title: Agent Client Protocol v2
description: The implemented ACP v2 subset for editor and coding-agent clients.
---

term2 has an experimental adapter for version 2 of the
[Agent Client Protocol](https://agentclientprotocol.com/). ACP is a JSON-RPC
protocol for connecting code editors and other interactive clients to coding
agents.

## Running the launcher

`term2 acp` serves the adapter over stdio: JSON-RPC messages as
newline-delimited UTF-8 JSON on stdout, diagnostics on stderr. The process runs
until the client closes stdin or receives SIGINT/SIGTERM, then performs a
bounded shutdown (`runAcp` in `source/acp-v2/serve.ts`).

```sh
term2 acp [--provider <provider>] [--model <model>] [--effort <effort>]
```

Those are the only flags (`parseAcpArgs` in `source/acp-v2/serve-args.ts`):
any other flag is rejected as an unknown option, and any non-flag token as an
unexpected argument. In particular `--auto-approve`
exits with status 1, writes nothing to stdout, and prints a diagnostic to
stderr. There is no flag that turns on auto-approve or unsandboxed execution;
the security posture is inherited from the runtime factory, not configured.

`--model` is resolved against the model catalog non-interactively, so it needs
an exact model id or `<provider>/<model>`; an ambiguous pattern is refused
rather than consuming protocol bytes from stdin.

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

`session/request_permission` is not part of this capability blob. It is an
agent → client request sent while a prompt is running, so it requires no
advertisement — but a client that cannot answer it will see every
approval-requiring tool call fail closed.

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
| Agent → client request | `session/request_permission` | `sessionId`, tool-call subject, permission `options` | Client `outcome` with the selected `optionId` |

`cwd` is an absolute path under the ACP schema. The adapter currently rejects a
non-empty `additionalDirectories` or `mcpServers` array on `session/new` and
`session/resume` with JSON-RPC code `-32602` (invalid parameters). Omit those
members or send empty arrays.

`replayFrom` is passed to the session backend only when the client supplies it.
Omitting it resumes without inventing a replay cursor. `{ "type": "start" }`
requests replay from the start according to ACP v2 semantics.

## Writable sessions and the sandbox

ACP sessions are writable. Every session created through `session/new` binds
the client-supplied `cwd` — validated and canonicalized with `realpathSync`
by `validateCwd` in `source/acp-v2/session-backend.ts` — as the workspace
root with `read_write` access, and the launcher builds its runtime factory
with `allowWrite: true` (`runAcp` in `source/acp-v2/serve.ts`). Write and
edit tools are registered for every ACP session. Sandboxed shell writes are
rooted at the session `cwd`; file edits default to that root, and an edit
target outside it requires an approval — `allow-edit-file-session` /
`allow-edit-folder-session` extend edit access to the granted path or folder
(see the mapping table below).

`allowUnsandboxed` is false for every ACP session (the factory's session
snapshot leaves it unset; see `createProductionRuntimeFactory` in
`source/gateway/runtime-factory.ts`). A shell call that asks for
`sandbox: "unsandboxed"` is silently downgraded to the sandboxed default
(`source/tools/system/shell.ts`); if the sandbox itself is unavailable, the
shell tool refuses the unsandboxed fallback and the call fails.

## Tool approvals: `session/request_permission`

Every tool call that would require interactive approval is sent to the client
as an ACP v2 `session/request_permission` **request** — an agent-to-client
request, not a notification and not an advertised session capability. The
tool runs only if the client answers with an allow option, or if the session
already holds a matching allow grant.

The options offered are the term2 approval choices mapped by
`ACP_PERMISSION_KINDS` in `source/acp-v2/session-backend.ts`; choices without
an ACP kind are filtered out and never offered:

| term2 choice | ACP kind | Resolution sent to the session |
| --- | --- | --- |
| `approve` / `allow-once` | `allow_once` | `y` |
| `allow-folder-session` / `allow-edit-file-session` / `allow-edit-folder-session` | `allow_always` | The same choice id |
| `reject` / `deny` | `reject_once` | `n` |

The interactive-only choices `unsandboxed-once` and `allow-remember` are
never offered over ACP, and the ACP `reject_always` kind is never used, so a
client can never grant unsandboxed execution or a persistent approval.

An `allow_always` answer is recorded as a session-scoped grant keyed to the
granted file or folder (not to the tool name alone): a later call whose target
resolves inside the granted scope is approved without another round trip. Two
lifetimes are involved. The ACP bridge's short-circuit cache
(`sessionPermissionGrants`) is discarded when the prompt settles
(`clearClient`); the grant term2 itself applies
(`SessionAccessState.allowEditFile` / `allowEditFolder` / `allowReadFolder`)
lasts for the **session** and is consulted by the tools' `needsApproval` on
later prompts, so an allowed call does not re-ask. That grant is cleared on
session reset or close (`SessionLifecycle` clearing access state), not at
prompt end.

### Fail-closed behavior

The tool does not run unless an explicit allow answer is resolved. These
paths apply once the permission request settles; a client that never answers
leaves the call pending until the turn is cancelled. All of the following
deny the call:

- the client cancels the permission request, or the outcome is missing,
  malformed, or not `selected`;
- the client selects an unknown `optionId`;
- the transport fails or the client disconnects while the request is pending;
- the turn is cancelled or the session closed while approval is pending;
- the pending interaction has become stale and can no longer be resolved by
  the recorded interaction id and revision;
- a nested `run_code` approval fires without a resolvable session interaction
  to project into a permission request.

A call the client denies surfaces as a failed `tool_call_update`; the
fail-closed paths that abort the turn instead settle the prompt with the
`cancelled` stop reason.

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
