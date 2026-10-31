# Direct ACP client boundary

This subtree implements the experimental ACP v2 client encoding over the **direct**
Host/Connection contract published in `53d0bc767adab83fe91fd78f6c9da463ad7cd1f8`.
It imports `protocol/direct-wire.ts` and `host/in-process-direct-types.ts`, not the
bridge's unprefixed protocol/Host types. Those shared files are intentionally not
copied into this worker's checkout. Integrate the real shared contracts before
compiling this client. This is implementation, not a claim of tested M6 parity.

## App integration

The app composes a `DirectHost`, an authenticated `Principal`, a diagnostic logger,
and `AcpWorkspaces`, then calls `createAcpBackend`. Pass that backend and the app
version to `createAcpAgent` or `serveAcp`. `createStdioAcpIo` adapts Node's actual
stdio; `serveAcp` uses the same SDK 1.4.0 experimental-v2 `ndJsonStream` as the
existing ACP executable. JSON-RPC framing, batch messages, request IDs and schema
validation remain SDK-owned. The adapter retains `initialize`, session new/list/
resume/prompt/close, cancellation notifications, permission requests and updates.

`AcpWorkspaces.authorize` resolves a canonical cwd to an admitted workspace grant.
`cwd(sessionId)` supplies canonical workspace metadata under the same principal
as Host access checks. It must query **direct** sessions only. The latter is the
remaining injected metadata seam: the direct connection snapshot has no workspace
field, while ACP resume requires checking the requested cwd against the session.
Neither callback may construct an adopted Session/runtime or import old logs.

Host/tool composition must preserve ACP's security posture: write-capable admitted
workspaces where authorized, `autoApprove:false`, and `allowUnsandboxed:false`.
The client cannot enforce those tool settings by replacing the workspace grant or
caching approvals; the app must supply the actual direct tool authority. No
client flag weakens them. The app must also keep provider/log diagnostics off
stdout, wire process shutdown signals to `serveAcp`'s optional signal, and dispose
the Host after `serveAcp` returns. No CLI dispatch, production factory, process
signal ownership, main entry or default flip is installed in this subtree.

## Data and lifecycle

- New/resumed session IDs come directly from Host. Resume connects without a
  historical cursor and replaces only this ACP client's subscription. `replayFrom:
  start` emits the current public transcript/tool snapshot, then strictly subsequent
  events. Other replay cursor variants fail explicitly; `seq:null` is not replaced
  with a client counter. No old-conversation discovery or import occurs.
- Each prompt submits once with a UUID client request ID and `origin:acp`.
  Admitted receipts are distinct from completion. A local prompt slot rejects
  concurrent ACP prompts before submission, preserving the existing busy error;
  Session still owns actual shared admission. The output-only gate preserves the
  existing acknowledgement-before-stream ordering without blocking Host progress.
- Started work waits for its exact `turn_ended`. Queued work is correlated using
  receipt message ID and `turn_started.input[].id`. Queued cancellation uses
  `queue_retract`, never an unrelated foreground cancellation; an unavailable
  capability returns an error. Successful retraction must mean the unstarted
  message was removed; a racing start must reject retraction. No retry/fallback
  is performed. Steering receipts need their owning `turnId`; missing identity
  throws an explicit integration error, not an invented successful turn.
- Streaming uses wire message IDs and tool **execution** IDs, never provider call
  IDs. Completed messages honor `replacesDraftId` so a final durable record does
  not duplicate its streamed draft. ACP v2 full-message upserts support corrections
  and image display; normal append-compatible text uses chunks. Tool progress is
  accumulated because ACP tool content updates replace rather than append.
  Nested wire events are rendered through the same encoder.
- Every pending interaction has its own permission request and cancellation
  controller; a slow permission UI does not block the event pump or other
  approvals. Answers target the exact wire request ID. Another client's already
  resolved request is stale, not a reason to answer a different owner.
- The direct contract currently supports only allow/deny. ACP offers the existing
  `approve`/`reject` option IDs with `allow_once`/`reject_once` kinds and retains
  the old `allow-once` response alias. Unknown selections, cancelled requests and
  missing client methods deny. No remembered/scoped `allow_always` is advertised
  or cached until Session actually supports it. Question interactions are
  explicitly denied with `stopAfterApprovalResolution:true`; structured question
  elicitation is not implemented and is not misrepresented as tool approval.
- Explicit cancel sends a foreground command (or retracts this client's unstarted
  queued message). Explicit close cancels, observes a known foreground terminal,
  then detaches. Transport EOF/shutdown only detach subscriptions and pending ACP
  requests; they do not silently cancel shared Session work. Host disposal is the
  app's separate responsibility. There is no shutdown deadline or runtime cap.

## Exact remaining contracts and limits

1. **Integration dependency:** the shared direct contracts above require M2
   `46bf7f77f1b8e0e57aa0b8fdea75414f0f686615`, followed by actual direct host,
   protocol projection/commands and Session implementations. The old host/runtime
   is not a substitute. The app launcher and workspace authority are still owed
   by their owners. This subtree is not wired into an executable here.
2. **Admission/settlement:** started/queued receipts without turn IDs need the
   documented message-ID correlation. Steering without a turn ID cannot be
   observed to completion. An error detected after an incomplete admitted receipt
   does not undo that admission. M4 must supply turn ownership/settlement, and
   race-safe queue retraction, before claiming those ACP paths work.
3. **Snapshot/replay fidelity:** C4's current M2 facade lacks active foreground
   identity, per-step drafts and some display state, as recorded in the coordinator's
   `protocol-session-adjustments.md`. This client cannot reconstruct absent state.
   Close cancellation when the snapshot says running but supplies no observable
   foreground ID reports an integration error rather than fake completion.
   If durable message IDs differ from draft IDs, snapshots must retain their
   display identity/replacement relation for cross-reconnect identity parity;
   `replacesDraftId` is presently event-only. ACP resume does not delete arbitrary
   pre-existing client UI state; snapshot replay upserts the IDs Host supplies.
4. **List metadata:** DirectHost list currently supplies IDs/workspaces/models,
   not title or updatedAt. ACP returns valid session IDs/cwds and the direct
   cursor, omitting the optional title/time instead of fabricating them. Exact
   old list metadata requires a shared-host DTO extension.
5. **Media/termination:** direct messages expose text/images, and tools expose
   text output. Structured/media tool result replay needs a richer public tool
   DTO before ACP can preserve it. Reasoning lacks per-model-step identity and
   is grouped per wire turn. Budget exhaustion maps to `max_turn_requests` only
   when the terminal error kind explicitly identifies it; otherwise the actual
   completed/cancelled/failed/interrupted outcome is used.
6. **Verification is deferred:** no tests, typecheck/lint, builds, independent
   review or cold reads were run for this worker, at the user's direction.
   SDK/type/source inspection and formatting are implementation aids, not runtime
   compatibility evidence. The final M6 phase must exercise this new backend and
   real stdio entry, not count the unchanged legacy ACP suite as direct coverage.
