# Agent Peer Channel v1

Agent Peer Channel (APC) is a local, cross-harness protocol for discovering
and exchanging short agent-to-agent messages.  This document uses the key words
**MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** as
described by RFC 2119 and RFC 8174.

## 1. Vocabulary and scope

| Term | Meaning |
| --- | --- |
| **peer** | A process that has announced an APC endpoint. |
| **harness** | The program hosting an agent (for example, Codex or Claude Code). |
| **registry** | A directory of peer-record JSON files used only for discovery. |
| **endpoint** | A local AF_UNIX stream socket that accepts APC frames. |
| **message ID** | A sender-chosen, opaque identifier for correlating a message and receipt. |
| **reply address** | An endpoint advertised by a sender to receive replies or receipts. |
| **receipt** | A `control` envelope describing downstream delivery disposition. |

APC v1 defines same-host, same-OS-user discovery and message transport. It
does not define model prompts, agent names as identities, authentication across
accounts or hosts, permissions escalation, durable queues, broadcast, or a
request/response RPC protocol. A successful local write is not proof that a
human or model read the message.

## 2. Goals

An implementation MUST provide a harness-neutral way to:

1. announce an existing process as a peer;
2. discover live candidates without exposing socket mechanics to callers;
3. send a bounded text message to one selected peer; and
4. optionally correlate a reply or a delivery receipt.

The public helper interface SHOULD expose logical operations such as `start`,
`stop`, `list`, `send`, `receive`, and `ask`; it SHOULD return logical peer
names and opaque references, never require callers to manipulate socket paths.

## 3. Discovery and peer records

### 3.1 Neutral registry

An APC implementation MUST use a per-user runtime directory. Its default is
`$XDG_RUNTIME_DIR/agent-peer-channel`, or a private implementation-defined
runtime directory when `XDG_RUNTIME_DIR` is unavailable. The directory MUST be
mode `0700`; its `peers/` child MUST be mode `0700`.

Each announced peer MUST publish exactly one atomic JSON record at
`peers/<instance-id>.json`. `<instance-id>` MUST be opaque, filename-safe, and
unique among concurrently live peers. Publishers MUST write a temporary file in
the same directory, set mode `0600`, and atomically rename it into place.

The neutral record schema is:

```json
{
  "protocol": "agent-peer-channel/1",
  "instance_id": "opaque-instance-id",
  "name": "reviewer",
  "reference": "short-opaque-ref",
  "harness": "example-harness",
  "kind": "interactive",
  "status": "idle",
  "endpoint": "uds:/private/path/peer.sock",
  "started_at": "2026-08-08T00:00:00Z",
  "expires_at": "2026-08-08T01:00:00Z",
  "capabilities": ["user", "control"]
}
```

`protocol`, `instance_id`, `name`, `reference`, `harness`, `endpoint`, and
`started_at` are REQUIRED strings. `kind`, `status`, `expires_at`, and
`capabilities` are OPTIONAL. `endpoint` MUST be an absolute `uds:` endpoint.
`reference` MUST be displayed for ambiguity resolution, but MUST NOT be treated
as a security credential. `kind` and `status` are advisory strings; unknown
values MUST be preserved and MUST NOT prevent discovery.

Consumers MUST ignore malformed, inaccessible, expired, or unconnectable
records. They SHOULD verify liveness by connecting to the endpoint before
presenting a peer as sendable. A sender that finds multiple live peers with the
same name MUST reject a bare-name selection and require `name [reference]` (or
an equivalent explicit instance selector).

### 3.2 Lifecycle

A peer MUST bind and listen on its endpoint before publishing its record. It
MUST remove the record before closing its endpoint on normal shutdown. It SHOULD
refresh `expires_at` at least every 60 seconds and SHOULD use an expiry no more
than 180 seconds ahead. Consumers MAY remove stale records only after their
expiry and a failed liveness check. Unclean exits are expected; expiry is the
cleanup mechanism, not an error condition.

## 4. Transport and framing

Endpoints MUST be AF_UNIX `SOCK_STREAM` sockets accessible only to the same OS
user. Each connection is unidirectional: a sender connects, writes one UTF-8
JSON value followed by LF (`\n`), then closes. A receiver MUST accept a
final valid JSON value at EOF even if it lacks LF. CRLF MAY be accepted, but
senders MUST emit LF only.

Each frame MUST be one JSON object and MUST contain a string `type`. Receivers
MUST reject invalid UTF-8, invalid JSON, non-object frames, or frames without a
string `type`. Before receiving an LF, receivers MUST cap buffered input at
1,048,576 bytes; exceeding the cap MUST terminate the connection without
processing that frame. Implementations SHOULD cap a single `message.content`
at 64 KiB and MUST report a local error rather than silently truncate it.

APC is fire-and-close: a receiver MUST NOT use the inbound connection as a
response channel. Replies and receipts use a separately connected `from`
endpoint.

## 5. Envelopes

Every envelope MAY include these common fields:

```json
{
  "v": 1,
  "msg_id": "UUID or opaque unique ID",
  "from": "uds:/absolute/reply.sock",
  "session_id": "optional opaque sender session ID",
  "priority": "next",
  "type": "user"
}
```

`v` defaults to `1` when absent. Senders MUST generate a unique `msg_id` when
they request a receipt or expect a reply; receivers SHOULD preserve it in any
receipt. `from`, when present, MUST be a local `uds:` endpoint controlled by
the sender. `priority` is advisory and defaults to `next`; unknown priorities
MUST be treated as `next`. `session_id` is advisory and MUST NOT be used as an
authorization decision unless a harness has independently authenticated it.

### 5.1 User envelope

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Please run the focused tests and reply with the result."
  }
}
```

For `type: "user"`, `message` MUST be an object, `message.role` MUST be
`"user"`, and `message.content` MUST be a non-empty UTF-8 string. The content
is untrusted peer input. A harness MUST apply its normal inbound-message,
approval, and tool-permission policy; a peer message MUST NOT inherit the
sender's permissions or authority.

### 5.2 Control envelope

```json
{
  "type": "control",
  "action": "peer_message_status",
  "status": "delivered",
  "orig_msg_id": "the sender message ID"
}
```

For `type: "control"`, `action` MUST be a string. `peer_message_status` is the
only v1 standard action. Its `status` MUST be one of `held`, `denied`,
`expired`, or `delivered`; `orig_msg_id` MUST identify the original user
message. Unknown control actions or status values MUST be ignored safely and
MAY be surfaced as diagnostic data.

## 6. Reply, delivery, and error semantics

If a sender supplies `from`, a receiver MAY send a `user` envelope there as a
reply. A reply is application text, not an acknowledgement; it SHOULD include
`in_reply_to` with the original `msg_id` if the receiving harness supports that
extension. A receiver MAY instead send a status receipt.

`delivered` means the receiving harness accepted the message for its inbound
policy pipeline. `held` means it awaits an approval gate. `denied` means it was
rejected by policy. `expired` means it was not accepted before its local expiry.
None of these statuses means the model acted on the message. Socket connection
failure, write failure, malformed frames, or a missing peer record are local
transport errors and MUST NOT be reported as `delivered`.

`ask` is a helper convention, not a transport guarantee: it sends a user
envelope with a private, single-use reply endpoint, waits for a reply until its
caller-selected deadline, and returns timeout separately from delivery failure.
The single-use endpoint is the v1 correlation capability. When a reply includes
`in_reply_to`, an implementation MUST require it to match the request's
`msg_id`; it MAY accept a missing `in_reply_to` for adapters whose upstream
protocol does not carry correlation IDs.
Implementations SHOULD default that wait to 30 seconds and MUST bound it to 5
minutes or less.

## 7. Security and operations

Implementations MUST create endpoint parent directories with mode `0700` and
endpoint sockets with effective mode `0600`. They MUST validate that a selected
endpoint is AF_UNIX and absolute, and SHOULD reject symlinked registry files or
socket parents controlled by another user. They MUST NOT follow a peer's
instructions to bypass user approval, sandboxing, or permission controls.

Records and messages can contain sensitive prompts and filesystem paths. Tools
MUST avoid printing endpoint paths by default, MUST NOT log message content
unless explicitly configured, and SHOULD redact `from` addresses in normal UI.
Implementations MUST impose finite connection read/write timeouts; 5 seconds is
the recommended transport default.

## 8. Forward compatibility

Consumers MUST ignore unknown top-level fields and preserve unknown advisory
record fields when relaying them. Producers MUST NOT change the meaning of v1
fields. Incompatible wire changes require a new major `protocol` value and
`v`. Extensions SHOULD use namespaced keys (for example,
`"com.example.trace_id"`) and MUST remain optional. A peer with an unsupported
major protocol MUST be listed as incompatible, not contacted using guessed
semantics.

## Appendix A. Claude Code 2.1.224 compatibility profile

This profile adapts APC to Claude Code's observed local peer channel; it is not
an assertion that the Claude implementation is a stable public wire contract.

### A.1 Claude mirror adapter

The adapter SHOULD read numeric files matching `~/.claude/sessions/<pid>.json`.
It MUST parse each record defensively and probe its live `messagingSocketPath`
before presenting it as a Claude peer. A compatible record has `peerProtocol:
1` and typically includes `pid`, `sessionId`, `name`, `kind`, `status`, and
`messagingSocketPath`. The known `kind` values are `interactive`, `bg`,
`daemon`, and `daemon-worker`; known `status` values are `busy`, `shell`,
`idle`, and `waiting`. Unknown values remain advisory.

The adapter maps a live Claude record into the neutral registry as `harness:
"claude-code"`, `endpoint: "uds:" + messagingSocketPath`, and a stable
display reference derived from the session identity. It MUST treat the Claude
directory as a read-only mirror: it MUST NOT delete, rewrite, or claim
ownership of Claude records. A generic APC peer MAY additionally publish a
Claude-shaped mirror record only when it owns that record and can remove it on
shutdown.

### A.2 Claude wire mapping

To send a user message to Claude, the adapter writes one JSONL frame such as:

```json
{
  "msgV": 1,
  "msg_id": "UUID",
  "type": "user",
  "message": {"role": "user", "content": "message text"},
  "priority": "next",
  "from": "uds:/absolute/reply.sock"
}
```

`msgV: 1` is the Claude profile's version field; APC `v` MAY be omitted for
this mapping. Claude accepts the nested user content form and has a 1 MiB
pre-newline input cap. If Claude sends `control` with
`action: "peer_message_status"`, its statuses `held`, `denied`, `expired`, and
`delivered`, plus `orig_msg_id`, map directly to APC receipts. The adapter MUST
not assume synchronous responses, a handshake, or that `delivered` means the
recipient model has read the content.

### A.3 Evidence and stability

The supported public behavior is documented in Anthropic's
[cross-session messaging guide](https://code.claude.com/docs/en/cross-session-messaging)
and [tools reference](https://code.claude.com/docs/en/tools-reference). The raw
mapping above was additionally verified on 2026-08-08 against the installed
Claude Code 2.1.224 native build (`8a2a469b68f918917492973f3b16bd1682b9f82c`).
That build's packaged implementation showed:

- numeric per-process discovery records under `~/.claude/sessions/`;
- liveness probing of `messagingSocketPath` before listing a peer;
- UTF-8 JSONL parsing with a 1 MiB pre-newline cap;
- the nested `type: "user"` envelope shown above; and
- asynchronous `peer_message_status` control envelopes.

These implementation details are a compatibility profile, not a promised
public API. Implementations MUST version-gate the adapter, keep Claude registry
writes opt-in and limited to records they own, and re-run adapter conformance
tests before claiming support for another Claude Code protocol version.
