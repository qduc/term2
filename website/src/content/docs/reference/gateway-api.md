---
title: Web Gateway API Reference
description: Authentication, routes, events, and wire formats for term2's private Web Gateway.
---

This is the wire reference for the private gateway served by `term2 serve`. The API is
currently versioned at `/private/agent/v1`. The gateway is a local control plane, not a
public web API: in a browser deployment the browser talks to your backend-for-frontend
(BFF), and the BFF talks to this API. Keep the private key and paired key material in
the BFF; never ship them to browser JavaScript.

The source of truth for this page is the live gateway implementation (`source/gateway/`),
including `contracts.ts`, `assertion.ts`, `server.ts`, `gateway.ts`,
`interaction-protocol.ts`, and the persistence contracts. Response projections can
contain provider- or settings-specific values; clients should preserve unknown fields
and should not assume that every provider exposes the same model/settings fields.

## Transports

The same HTTP routes work over either transport:

- **Unix socket (default):** `term2 serve --socket /absolute/path/gateway.sock ...`.
  The server creates the socket with mode `0660`. In Node, pass the socket path to
  `http.request({ socketPath, path, ... })`.
- **TLS TCP:** `term2 serve --listen host:port --tls-cert cert.pem --tls-key key.pem ...`.
  Use an HTTPS client. The gateway defaults to loopback; non-loopback listening is an
  explicit deployment choice. TLS client certificates are configured by the server,
  separately from the JWT assertion.

All URLs below are paths, not origins. The gateway does not provide CORS or browser
authentication. A BFF should proxy only the application operations it intends to expose.

## Request envelope and limits

Every route except pairing requires:

```http
x-term2-assertion: <JWT>
accept: application/json
content-type: application/json       # all non-GET requests with a body
x-correlation-id: optional-client-id
```

`x-correlation-id`, when present, must match `[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}`.
Non-GET request bodies are JSON and are limited to 1 MiB. A non-JSON content type is
rejected with `415 unsupported_media_type`; invalid JSON is `400 validation_error`.
Message text is non-empty and limited to 128,000 characters. Opaque IDs (session,
turn, request, candidate, and interaction IDs) contain 1–256 characters from
`A-Z a-z 0-9 _ -`.

Successful JSON responses use the status documented below. Errors always have this
shape (the `retryable` and `details` members are optional):

```json
{
  "error": {
    "code": "validation_error",
    "message": "human-readable description",
    "retryable": false,
    "details": {}
  }
}
```

Retry only when `retryable: true`, after applying client backoff. A `409` conflict
that is explicitly non-retryable (for example `settings_conflict` or a stale
interaction) requires refreshing state or changing the request.

## Authentication and pairing

### Pair a client key (one time)

When the gateway was started with `--pairing`, it prints a six-digit OTP. Generate an
RSA key pair in the BFF, then call the unauthenticated pairing route:

```http
POST /private/agent/v1/pairing/register
content-type: application/json

{"publicKeyPem":"-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----\\n","otp":"123456"}
```

The body must contain exactly those two strings; the public key is at most 16,384
characters. A successful `200` response is:

```json
{"paired":true,"kid":"paired-key-id","fingerprint":"sha256-fingerprint"}
```

Persist the returned `kid` and the matching private key. Pairing is not available
after a trusted key already exists (`401 pairing_required`), and an expired or wrong
OTP is `401 pairing_invalid`. Pairing is `503 pairing_unavailable` when the trust
store cannot be updated. The register route never accepts an assertion.

### Sign every request

The `x-term2-assertion` value is a compact JWT signed with RS256. The header is exactly:

```json
{"alg":"RS256","typ":"JWT","kid":"<kid>"}
```

Claims are:

| Claim | Meaning |
| --- | --- |
| `iss`, `aud` | Exactly the gateway's configured `--issuer` and `--audience`. |
| `sub` | Calling principal. For a BFF this is the application user ID. |
| `purpose` | One operation purpose from the table below. |
| `iat`, `nbf`, `exp` | Numeric seconds. `nbf` is `iat - 5`; `exp` is at most 60 seconds after `iat`. |
| `jti` | Unique per request. The gateway consumes it through its replay ledger. |
| `ver` | Integer `1`. |
| `workspaceId` | Required for the canonical session-create assertion. |
| `sessionId` | Required for session-scoped routes and must equal the path ID. |

The verifier checks the signature, key `kid`, issuer, audience, claim validity,
clock skew (5 seconds by default), replay, and expected purpose. Do not reuse a JWT
for two requests. The purpose must match the route; mismatches are
`400 protocol_conflict`.

This small Node helper uses the same base64url JSON and RSA-SHA256 rules as the gateway:

```js
import { createSign, randomUUID } from 'node:crypto';

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function assertion({ privateKey, kid, issuer, audience, subject, purpose,
  workspaceId, sessionId }) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const claims = { iss: issuer, aud: audience, sub: subject, purpose,
    iat, nbf: iat - 5, exp: iat + 60, jti: randomUUID(), ver: 1 };
  if (workspaceId !== undefined) claims.workspaceId = workspaceId;
  if (sessionId !== undefined) claims.sessionId = sessionId;
  const input = `${b64(header)}.${b64(claims)}`;
  const sign = createSign('RSA-SHA256');
  sign.update(input); sign.end();
  return `${input}.${sign.sign(privateKey).toString('base64url')}`;
}
```

The local-owner principal is required for global settings and credential/OAuth
operations: `settings_read`, `settings_write`, `credential_write`,
`credential_delete`, `oauth_login`, `oauth_select`, and `oauth_delete` must use the
`--local-owner` value as `sub`. Other operations are scoped to the caller's grants.

## Route index

For every route below, sign with the listed purpose. A `sessionId` in the assertion
is required wherever the path contains `:sessionId`; `workspaceId` is required on the
canonical create route.

| Method and path | Purpose | Success |
| --- | --- | --- |
| `POST /private/agent/v1/pairing/register` | (none; pairing only) | `200` |
| `GET /private/agent/v1/workspaces` | `workspace_list` | `200` |
| `POST /private/agent/v1/workspaces` | `workspace_list` compatibility alias | `200` |
| `POST /private/agent/v1/workspace/candidates/validate` | `workspace_candidate_validate` | `200` |
| `POST /private/agent/v1/workspace/candidates/browse` | `workspace_candidate_browse` | `200` |
| `POST /private/agent/v1/workspace/candidates/select` | `workspace_candidate_select` | `200` |
| `GET /private/agent/v1/models` | `model_list` | `200` |
| `GET /private/agent/v1/settings` | `settings_read` | `200` |
| `PUT /private/agent/v1/settings` | `settings_write` | `200` |
| `POST /private/agent/v1/credentials/:credentialId` | `credential_write` | `200` |
| `DELETE /private/agent/v1/credentials/:credentialId` | `credential_delete` | `200` |
| `POST /private/agent/v1/oauth/:provider/login` | `oauth_login` | `200` |
| `POST /private/agent/v1/oauth/:provider/select` | `oauth_select` | `200` |
| `DELETE /private/agent/v1/oauth/:provider/accounts/:accountId` | `oauth_delete` | `200` |
| `POST /private/agent/v1/sessions` | `session_create` | `201` |
| `GET /private/agent/v1/sessions` | `session_list` | `200` |
| `POST /private/agent/v1/sessions/:sessionId` | `session_read` | `200` |
| `POST /private/agent/v1/sessions/:sessionId/config` | `session_update` | `200` |
| `POST /private/agent/v1/sessions/:sessionId/messages` | `message_submit` | `202` |
| `POST /private/agent/v1/sessions/:sessionId/abort` | `abort` | `202` or `200` |
| `POST /private/agent/v1/sessions/:sessionId/commands` | `command_invoke` | `200` |
| `POST /private/agent/v1/sessions/:sessionId/interactions/:interactionId` | `interaction_resolve` | `202` or `200` |
| `GET /private/agent/v1/sessions/:sessionId/events` | `events_connect` | SSE `200` |

There is also a legacy `POST /` session-create route for older pinned clients. It
uses `session_create` and a `null` body, but new clients should use the versioned
route. A path may contain only the URL-safe opaque ID alphabet described above.

## Workspaces and models

`GET /workspaces` accepts `limit` (default 20, 1–50) and currently only supports a
null cursor (passing `cursor` is `400 invalid_cursor`). It returns:

```json
{"workspaces":[{"workspaceId":"...","label":"Project","access":"read"}],"nextCursor":null}
```

Workspace discovery is an explicit three-step flow. Validate with
`{"absolutePath":"/absolute/path"}`. A valid response contains
`{valid:true,candidateId,displayName,expiresAt,checks:[...]}`; invalid responses
contain `valid:false`, `checks`, `reasonCode`, and `reason`. Browse with
`{"candidateId":"..."}` or with a returned `childToken` as `child`:

```json
{"candidateId":"...","entries":[{"name":"src","type":"directory","selectable":true,"childToken":"..."}],"truncated":false}
```

Entry `type` is `directory`, `file`, `symlink`, or `other`; entries may include
`rejectionReason` and `targetDisplay`. Select with
`{"candidateId":"...","access":"read"}` or `read_write`. The response contains
`workspaceId`, `displayName`, and `binding` (`sessionId`, `ownerUserId`,
`workspaceId`, `grantVersion`, `canonicalRoot`, `access`). Candidate and browse
tokens expire; a missing/expired token is `404 not_found` and an escape or ownership
failure is `403 workspace_forbidden`.

`GET /models` returns `{"models":[...]}`. Each item has `provider` and `id`, and may
have `name`, `default_reasoning_level`, and `contextWindow`. Providers that cannot
load their catalog are omitted. If the catalog is unavailable, the route returns
`503 model_catalog_unavailable` with `retryable:true`.

## Settings, credentials, and OAuth

`GET /settings` returns a secret-free projection with `schemaVersion`, `revision`,
`defaultsRevision`, and `settings`. `settings.safeDefaults` is keyed by the safe
settings names and contains `{value?,source,scope,confirmRequired,persistable}`;
`settings.credentials` and `settings.providers` expose status only (never secrets),
`oauthAccounts` lists account IDs/labels and selection flags, and `safety` describes
sandbox, approval, network, and workspace access. Treat the projection as extensible.

`PUT /settings` accepts exactly:

```json
{"expectedRevision":"<revision>","changes":[{"key":"logging.logLevel","value":"debug"}]}
```

At most 100 changes are accepted, values are null, scalar JSON values, or arrays of
strings, and only the persistable safe surface is writable (currently
`logging.logLevel`). A successful response is
`{committed:true,revision,projection}`. A stale revision is `409 settings_conflict`
with `details.currentRevision` and a current `details.projection`; disallowed keys
are `403 settings_forbidden`.

Credential IDs are `openai`, `openrouter`, `tavily`, and `exa` in the current
implementation. `POST /credentials/:credentialId` accepts `{"value":"..."}` and
returns `{status:"saved",configured,source}`. `DELETE` returns one of these exact
secret-free shapes:

```json
{"status":"deleted","configured":false}
{"status":"unchanged","configured":true,"source":"environment"}
```

Environment-owned credentials cannot be deleted by the gateway, so the second shape
is returned with `source:"environment"`. The value is never echoed.

For OAuth, `:provider` is `codex` or `grok`. Login is a `POST` with a null body and
returns either `{status:"completed",configured:<boolean>}` or
`{status:"not_completed"}` when the provider login did not finish. Select accepts
`{"accountId":"..."}` and returns `{ok,isSelected,isInUse}`. Delete an account with
the `DELETE` route; it returns `{ok}`.

## Sessions

Create with `POST /sessions` and `{"workspaceId":"..."}`. The assertion's
`workspaceId` must match. Model/reasoning/mode fields are deliberately not accepted
at creation; select them with the config route. With persistence enabled the response
is `{session:<session projection>}`; the projection-free compatibility response is
`{sessionId,workspaceId,accepted:true}`.

List with optional `limit` and opaque `cursor`; the response is
`{sessions:[{id,workspaceId,status,createdAt,updatedAt,latestSequence}],nextCursor}`.
Read returns `{session:<projection>}`. A projection has `id`, `workspaceId`,
`status` (`idle`, `running`, `awaiting_interaction`, `interrupted`, or `closed`),
`createdAt`, `updatedAt`, `latestSequence`, `earliestReplayableSequence`,
`projectionSequence`, `transcript`, and `interaction`. `transcript.messages` are
bounded `{id,role:"user"|"bot",text,commands?}` entries; a command entry has
`callId`, `toolName`, and `status` (`completed`, `failed`, `aborted`, or `unknown`).
`interaction` is `null`, pending, or a recovered non-resolvable interaction (see
below).

Update a non-busy session with any subset of:

```json
{"model":"model-id","reasoningEffort":"medium","mode":"standard"}
```

`reasoningEffort` is `default`, `none`, `minimal`, `low`, `medium`, `high`, or
`xhigh`; `mode` is `standard`, `lite`, `plan`, `mentor`, or `orchestrator`. The
response is a session config projection containing `sessionId`, `providerId`,
`modelId`, `reasoningEffort`, `mode`, `toolPolicy`, `configRevision`, and
`defaultsRevision`. Busy sessions return `409 session_busy`.

Submit a message with a unique idempotency key:

```http
POST /private/agent/v1/sessions/<sessionId>/messages

{"text":"Explain this project","clientRequestId":"request-1"}
```

The `202` response is `{sessionId,clientRequestId,turnId,accepted:true,replayed:false}`;
repeating the same body and key returns `replayed:true`. A different body with the
same key is `409 idempotency_conflict`; a full admission queue is `429 queue_full`
(`retryable:true`). Attachments are not enabled (`422 attachments_not_enabled`).

Abort with `{"turnId":"..."}`. A newly accepted abort is `202` with
`{sessionId,turnId,accepted:true}`. If already settled, the gateway returns `200`
with `accepted:false,alreadySettled:true`. An interrupted/non-admitting session is
`409 session_not_admitting`.

## Commands

`POST /sessions/:sessionId/commands` accepts exactly
`{"commandId":"...","clientRequestId":"..."}`. The current allowlist is:

| ID | Result body |
| --- | --- |
| `compact` | `{commandId:"compact",outcome:"completed"|"not_reduced"|"nothing_to_retry"|"failed",reason?,tokensBefore?,tokensAfter?}` |
| `retry-tool` | `{commandId:"retry-tool",outcome:"accepted"|"nothing_to_retry",turnId? ,replayed?}` |
| `retry-turn` | `{commandId:"retry-turn",outcome:"accepted"|"nothing_to_retry",turnId? ,replayed?}` |

Commands are idempotent by `(sub,sessionId,clientRequestId)` and the normalized body.
The session must be idle; running or approval-waiting sessions return `409
session_busy`. Unknown IDs are `422 command_not_allowed`. Compaction replay can
return non-retryable `409 compact_failed` or `compact_interrupted`; command
admission may return `429 queue_full`.

## Interaction resolution

When an approval or question is pending, the session projection and SSE event carry a
sanitized `PendingInteractionDto`:

```json
{
  "version":1,"interactionId":"...","kind":"tool_approval",
  "variant":"ordinary_tool","descriptor":{"agentName":"root","toolName":"shell","argumentsText":"..."},
  "choices":[{"id":"approve","label":"Allow"},{"id":"reject","label":"Reject"}],
  "revision":1
}
```

`kind` is `tool_approval`, `ask_user`, or `check_in`. `variant` is one of
`ordinary_tool`, `folder_read`, `outside_workspace_edit`, `denied_read`,
`docker_host_control`, `sandbox_network_access`, `post_execute`, `max_turns`,
`run_budget`, or `ask_user`. The descriptor can include `callId`, safe display
fields, `llmAdvisory`, `checkIn`, `deniedRead`, and `runBudgetEvidence`. Ask-user
DTOs additionally include `askUser.questions`, `answers`, and
`currentQuestionIndex`.

Resolve at `POST /sessions/:sessionId/interactions/:interactionId` with:

```json
{"revision":1,"answer":"approve","approvalAnswer":"optional answer"}
```

`answer` is required (maximum 16,384 characters); `rejectionReason` is optional.
An intermediate ask-user answer returns `200 {accepted:false,interaction:<next DTO>}`
with an incremented revision. A final answer returns `202` with
`{sessionId,turnId,interactionId,accepted:true}`. Stale revisions/IDs are
`409 stale_interaction`; recovered interactions are `409 interaction_not_resolvable`
and already settled interactions are `409 interaction_already_resolved`.

## Event stream (SSE)

Connect with an `events_connect` assertion:

```http
GET /private/agent/v1/sessions/<sessionId>/events?after=42
accept: text/event-stream
x-term2-assertion: <JWT>
```

The cursor may instead be `Last-Event-ID: 42`. If both are supplied they must match.
The cursor is a non-negative decimal integer (or omit it for the current replay floor).
The response is `200 text/event-stream` with `cache-control: no-cache`, keep-alive,
and proxy buffering disabled. Each event is two SSE lines followed by a blank line:

```text
id: 43
data: {"schemaVersion":1,"id":43,"sessionId":"...","type":"text_delta","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"turnId":"...","delta":"hello"}}

```

The `id` line is the durable event sequence. Persist it and reconnect with that value
after the last event processed. The server sends a comment heartbeat every 15 seconds:
`: heartbeat <ISO timestamp>`. Reconnect with backoff after a dropped connection.
The server buffers at most 256 events for a subscriber that has not begun reading;
an excessively slow subscriber can be disconnected.

If the cursor was compacted, the initial HTTP response is `410 cursor_compacted` with
`retryable:true`, `details.reloadRequired:true`, `details.latestSequence`, and a
fresh `details.session` projection. Other journal/generation failures return
`503 gateway_unavailable` with the same reload hint. Reload the session projection,
then reconnect from that projection's `projectionSequence`. This cursor is the
projection-covered boundary and avoids replaying events already represented by the
reloaded projection. Omitting `after` means start live from the current high-water
mark; it does not mean “replay from the retention floor”.

### Frozen event types and payloads

Every data event has `schemaVersion:1`, integer `id`, `sessionId`, ISO `occurredAt`,
and `payload` containing `turnId` unless noted. The following is the complete frozen
allowlist. Fields marked `?` are optional; payloads may gain fields in a compatible
version, so ignore fields you do not need.

| `type` | Payload fields |
| --- | --- |
| `session_created` | `{}` (the envelope identifies the session; creation metadata is available from the session projection) |
| `user_message_accepted` | `turnId`, `clientRequestId`, `messageId` |
| `user_message_rejected` | `turnId`, `clientRequestId?`, `reason` |
| `assistant_started` | `turnId`, `clientRequestId?` |
| `text_delta` | `turnId`, `delta` |
| `reasoning_delta` | `turnId`, `delta` |
| `tool_started` | `turnId`, `callId`, `toolName` |
| `command_message` | `turnId`, `callId`, `toolName`, `status`, `output?`, `error?`, `message:{id,role:"command",text}` |
| `approval_required` | `turnId`, `interaction` (`PendingInteractionDto`) |
| `interaction_updated` | `turnId`, `interaction` (`PendingInteractionDto`) |
| `interaction_resolved` | `turnId`, `interactionId`, `outcome`, `variant` |
| `interaction_recovered` | `turnId`, `interaction` (`PendingInteractionDto`), `reason` |
| `usage_update` | `turnId`, `inputTokens`, `outputTokens`, `totalTokens`, `usage` with the same three fields. Root-turn requests only; subagent usage is not published |
| `retry` | `turnId`, `agentId?`, `toolName`, `attempt`, `maxRetries`, `errorMessage`, `retryType?`, `errorKind?`, `delayMs?`, `retryAfterMs?` |
| `retry_exhausted` | `turnId`, `provider?`, `errorKind`, `attempts`, `maxAttempts`, `message`, `canRetry` |
| `subagent_started` | `turnId`, `agentId`, `name?`, `role`, `task`, `async?` |
| `subagent_tool_started` | `turnId`, `agentId`, `role`, `toolCallId`, `toolName`, `commandMessages?` |
| `subagent_text_turn` | `turnId`, `agentId`, `role`, `text` |
| `subagent_command_message` | `turnId`, `agentId`, `role`, `callId`, `toolName`, `status`, `output?`, `error?`, `message:{id,role:"command",text}` |
| `subagent_approval_required` | `turnId`, `agentId`, `role`, `interaction` |
| `subagent_completed` | `turnId`, `agentId`, `name?`, `role`, `status`, `finalText`, `finalTextTruncated?`, `toolsUsed`, `usage?`, `error?`, `terminalCause?`, `async?` |
| `subagent_interrupted` | `turnId`, `agentId`, `role`, `finalText` |
| `subagent_question` | `turnId`, `agentId`, `runId`, `messageId`, `role`, `name?`, `question`, `async`, `interaction` (required `PendingInteractionDto`) |
| `context_compaction_started` | `turnId`, `provider`, `sessionId`, `inputTokensBefore?`, `strategy?` |
| `context_compaction_completed` | `turnId`, `provider`, `sessionId`, `inputTokensBefore?`, `inputTokensAfter?`, `durationMs`, `strategy?` |
| `context_compaction_failed` | `turnId`, `provider`, `sessionId`, `errorCategory`, `durationMs`, `strategy?` |
| `turn_completed` | `turnId`, `outcome:"completed"`, `text` |
| `turn_failed` | `turnId`, `outcome:"failed"`, `reason`, `finalText?` |
| `turn_aborted` | `turnId`, `outcome:"aborted"` |

`toolsUsed` is an array of `{toolName,count}` and `usage`, when present, is a
provider-normalized token object. Command messages are sanitized and bounded for
replay; do not treat them as raw provider transcripts. Terminal event types are
`turn_completed`, `turn_failed`, and `turn_aborted`.

## Common status codes and recovery

| Status / code | Meaning and client action |
| --- | --- |
| `400 validation_error` | Body/query/interaction is malformed; fix it. |
| `400 invalid_cursor` | Use a valid decimal cursor or session cursor. |
| `400 protocol_conflict` | Route, assertion, correlation, or duplicate cursor disagrees; regenerate the request. |
| `401 authentication_required` | Missing/invalid assertion. In pairing mode this is `pairing_required`; pair or sign correctly. |
| `403 settings_forbidden` / `workspace_forbidden` | Principal lacks local-owner or workspace authority. |
| `404 not_found` | Route, session, or candidate is not visible to this principal. |
| `409 session_busy` / `session_not_admitting` | Wait for the current turn or refresh session state. |
| `409 idempotency_conflict` | Reused a request ID with a different body; use a new ID only when the original result is not desired. |
| `409 stale_interaction`, `interaction_not_resolvable`, `interaction_already_resolved` | Refresh the projection/SSE state; do not replay the old answer. |
| `409 retry_failed` | A replayed retry command already failed; this is non-retryable. |
| `409 provider_unavailable` | The selected provider cannot be started; choose an available model/provider. |
| `409 settings_conflict` | Reload the projection and retry with its revision. |
| `413 request_too_large` / `415 unsupported_media_type` | Correct the HTTP body/content type. |
| `422 command_not_allowed`, `model_selection_deferred`, `attachments_not_enabled` | The operation is outside the current v1 contract. |
| `429 queue_full`, `resource_exhausted`, `candidate_registry_full` | Back off and retry when `retryable:true`; the latter two are capacity limits. |
| `410 cursor_compacted` | Reload the session projection before reconnecting to SSE. |
| `500 compact_invalid_state` | A persisted compaction result has an unknown state; this is non-retryable. |
| `500 session_snapshot_invalid` | A persisted session settings snapshot is unreadable or malformed; this is non-retryable. |
| `503 gateway_unavailable`, `persistence_unavailable`, `settings_unavailable`, `snapshot_unwritable`, `model_catalog_unavailable`, `pairing_unavailable` | Transient gateway/dependency failure when `retryable:true`; back off and retry. |

Messages and commands are idempotent only when the same client request ID is used
with the same body. Assertions are never idempotent: each request needs a fresh `jti`.

## Minimal Node request and stream helpers

The following helper works with either a Unix socket or TLS. It signs per request and
parses one JSON response; for SSE, use the same assertion and retain each `id`.

```js
import http from 'node:http';
import https from 'node:https';

export function request({ socketPath, host, port, tls, path, method = 'GET', body,
  assertion: token }) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const options = socketPath
    ? { socketPath, path, method, headers: { 'x-term2-assertion': token, ...(data ? {'content-type':'application/json'} : {}) } }
    : { hostname: host, port, path, method, headers: { 'x-term2-assertion': token, ...(data ? {'content-type':'application/json'} : {}) }, ...tls };
  return new Promise((resolve, reject) => {
    const transport = socketPath ? http : https;
    const req = transport.request(options, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
```

For streaming, set `accept: text/event-stream`, parse records separated by `\n\n`,
JSON-decode the `data:` line, and save the numeric `id:` before processing the event.
On reconnect use `Last-Event-ID` (and a fresh JWT). A BFF should translate this
stream to its own browser-safe subscription rather than exposing the private socket,
TLS credentials, or assertion key.
