# Responses WebSocket `response.processed` Extension

**Status**: Internal Codex extension (not part of the public OpenAI Responses API WebSocket protocol).

**Owner**: Codex client + backend Responses team.

This document is the canonical specification for the `response.processed` client-to-server notification. It is intended to be used by any party implementing support for Codex clients (e.g., a backend that terminates the Responses WebSocket) or by alternative Codex-like clients that wish to emit the same signal.

## 1. Overview

`response.processed` is a **client-to-server** lifecycle notification sent over the Responses API WebSocket transport.

It informs the server that:

- The client has received a `response.completed` for a given `response_id`.
- Local turn processing for that response has completed successfully.
- The client has "recorded" or acted upon the response (e.g., updated session state, history, token counts, UI, etc.).

It is **not** a server-to-client event. The public Responses API only defines server→client events (`response.created`, `response.in_progress`, `response.completed`, output deltas, etc.).

## 2. Wire Format

The message is sent as a single JSON object on the WebSocket (same framing as `response.create` requests).

```json
{
  "type": "response.processed",
  "response_id": "resp_abc123"
}
```

### Schema (language-agnostic)

```ts
interface ResponseProcessedRequest {
  type: "response.processed";
  response_id: string;   // The response.id from the corresponding response.completed
}
```

- `type` is a literal discriminator (the enum is tagged with `#[serde(tag = "type")]` in the Rust reference).
- `response_id` must be the exact `id` returned in the `response.completed` event for the response being acknowledged.
- No other fields are currently defined. Unknown fields should be ignored by receivers for forward compatibility.

### Rust Reference Types (from `codex-api`)

```rust
#[derive(Debug, Serialize)]
pub struct ResponseProcessedWsRequest {
    pub response_id: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ResponsesWsRequest {
    #[serde(rename = "response.create")]
    ResponseCreate(ResponseCreateWsRequest),
    #[serde(rename = "response.processed")]
    ResponseProcessed(ResponseProcessedWsRequest),
}
```

These types live in `codex-rs/codex-api/src/common.rs` and are re-exported from `codex_api`.

## 3. When the Client Sends It

The notification is **only** sent when **all** of the following are true:

1. The client feature flag `responses_websocket_response_processed` is enabled for the session.
2. A `ResponseEvent::Completed { response_id, ... }` was received and processed.
3. The overall turn / sampling operation succeeded (`outcome.is_ok()` or equivalent).
4. A valid `response_id` is available.

### 3.1 Normal Turn Sampling

After the client finishes processing a normal `response.create` stream:

- The stream delivers a `response.completed` (with optional `end_turn`).
- The client performs all local post-processing (token recording, history updates, emitting `TurnComplete` / UI events, etc.).
- If the above succeeded and the feature is on, the client sends `response.processed` using the `response_id` from that completion.

The send occurs **after** the `try_run_sampling_request` (or equivalent) result has been handled and local effects committed, not inside the streaming loop itself.

### 3.2 Remote Compaction v2

After a successful v2 remote compaction:

- The client receives a compaction response (via `response.create` for the compaction operation).
- It installs the compacted history.
- It emits the corresponding turn item completed events.
- If the feature is enabled, it then sends `response.processed` for the compaction response's `response_id`.

See `run_inline_remote_auto_compact_task_v2` / equivalent for the exact sequencing.

### 3.3 Other Cases

- **Pre-warm / warmup responses**: Usually do not trigger `response.processed` (the client only sends it for the "real" user turn responses).
- **Error / failure paths**: If the turn fails before or during completion, or if no `response_id` was captured, no `response.processed` is sent for that attempt.
- **Cancellation**: Aborted turns generally do not send the notification.
- **Follow-up responses** (when `end_turn: false`): A `response.processed` may still be sent for the intermediate completed response if local processing succeeded.

## 4. Feature Flag Control

- **Key**: `responses_websocket_response_processed`
- **Stage**: `UnderDevelopment` (subject to change; not enabled by default)
- **Default**: `false`
- **How clients enable it**: Via their configuration / feature system (e.g., `config.features.enable(...)` in Codex).

Clients **must** gate emission on this flag (or an equivalent configuration). Servers **must** be prepared to receive the message from any client that has the flag enabled, and should treat the message as optional / best-effort from the protocol perspective.

## 5. Transport and Connection Semantics

- Sent on the **same WebSocket connection** that was used for the corresponding `response.create`.
- The Codex client reuses a single WebSocket across multiple turns (with pre-warm + per-turn `response.create` messages) when possible.
- The `response.processed` is sent **after** the server has sent the matching `response.completed` on that connection.
- Ordering: The client sends it only after it has finished its local work for that response. There is no strict requirement on the server to wait for it before processing the next `response.create` on the same connection.

## 6. Server-Side Expectations (for Implementers)

When a backend receives `{"type": "response.processed", "response_id": "..."}`:

- It may use this as a signal that the Codex client has successfully consumed and acted on the response (useful for telemetry, session state machines, rate-limit accounting, compaction coordination, A/B metrics, etc.).
- The server should **not** treat absence of this message as an error. Many clients (or clients without the feature) will never send it.
- The server should validate that the `response_id` corresponds to a response it previously delivered on the same connection/session.
- Duplicates are possible in edge cases (retries, reconnects); servers should be idempotent with respect to `response_id`.
- The message is fire-and-forget from the client's point of view.

### Recommended Server Behavior

- Log at info/debug level on receipt (correlate with the original response).
- Update any internal "client acknowledged" state for that `response_id`.
- Do **not** block the WebSocket read loop or subsequent `response.create` handling while processing this notification.
- If the `response_id` is unknown or stale, silently ignore (or log at debug).

## 7. Error Handling and Reliability

From the Codex client reference implementation:

- The send is best-effort.
- Failures (serialization error, connection closed, timeout) are logged at `debug!` level only:  
  `"failed to send response.processed websocket request: {err}"`
- A failed send does **not** fail the user turn, does not surface to the user, and does not prevent the next turn.
- The client does not retry `response.processed` on its own.

Servers should therefore treat the signal as a hint, not a required part of the response lifecycle.

## 8. Test Scenarios (Reference)

A conforming implementation should be able to pass scenarios equivalent to those in `codex-rs/core/tests/suite/client_websockets.rs`:

1. **Happy path with feature enabled**  
   - Client connects, pre-warms, sends `response.create`, receives completion for `resp-1`.  
   - After local processing, client emits `response.processed` with `response_id: "resp-1"` as the next client→server frame on the connection.

2. **Feature disabled**  
   - Same flow, but no `response.processed` frame is ever sent by the client.

3. **Remote compaction v2**  
   - After a successful compaction response (`resp-compact`), the client sends `response.processed` for the compaction response id (requires both `remote_compaction_v2` and the processed feature).

4. **Multiple responses on one connection**  
   - The client correctly associates each `response.processed` with the correct preceding `response.create` / completion.

## 9. Stability and Versioning

- This is currently an **experimental / under-development** extension.
- The shape (`type` + `response_id`) is expected to be stable, but additional fields may be added in the future under the same `type`.
- Receivers should ignore unknown fields.
- If the extension graduates or changes, the feature flag name or a new variant may be introduced.
- Do not rely on the presence of this message for critical correctness unless you control both client and server.

## 10. Related

- Public Responses API WebSocket events: `response.created`, `response.completed`, `response.output_item.done`, deltas, etc. (server → client only).
- Feature definition: `Feature::ResponsesWebsocketResponseProcessed`.
- Primary client emission sites (Codex reference):
  - Normal turns: `codex-rs/core/src/session/turn.rs` (post-`try_run_sampling_request` success path).
  - Compaction: `codex-rs/core/src/compact_remote_v2.rs`.
- Sender implementation: `codex-rs/codex-api/src/endpoint/responses_websocket.rs`.
- Model types: `codex-rs/codex-api/src/common.rs`.

---

**End of specification.**

This document is derived from the verified behavior in the openai/codex repository as of the latest source inspection. Implementations in other codebases should treat the sections above as the contract.
