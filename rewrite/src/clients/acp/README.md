# Direct ACP client boundary

This subtree implements experimental ACP v2 client encoding against the real
protocol/Host contracts through `0a27e1345abff53e45c781f59e95a176db309d16`.
Imports target `protocol/direct-wire.ts` and `host/in-process-direct-types.ts`,
not the bridge's unprefixed types. Shared files were inspected read-only, not
copied/cherry-picked into this worker checkout. This is implementation, not
runtime acceptance or a tested M6 parity claim.

## App integration

The app composes `DirectHost`, an authenticated `Principal`, a diagnostic logger,
and `AcpWorkspaces`, then calls `createAcpBackend`. Pass that backend and the app
version to `createAcpAgent` or `serveAcp`. `createStdioAcpIo` adapts Node stdio;
`serveAcp` uses SDK 1.4.0 experimental-v2 `ndJsonStream`, as the existing ACP
executable does. JSON-RPC framing, batches, transport IDs and schema validation
remain SDK-owned. Initialize, session new/list/resume/prompt/close, cancellation,
permission requests and session updates retain their ACP v2 method names.

`AcpWorkspaces.authorize` resolves canonical cwd to an admitted workspace grant.
`cwd(sessionId)` supplies canonical **direct** session workspace metadata under
the same principal as Host. It is a narrow remaining injection: ACP resume checks
cwd, but the direct connection snapshot has no workspace field. Neither callback
may construct an adopted Session/runtime or read old logs.

Host/tool composition must preserve ACP's security posture: authorized write
workspaces, `autoApprove:false`, `allowUnsandboxed:false`, and real sandbox/tool
authority. The client cannot manufacture those policies from a workspace grant.
The app must keep diagnostics off stdout, supply process shutdown signals to
`serveAcp`, and dispose its Host after serving returns. No production factory,
CLI dispatch/default flip, global signal handler or runtime fallback lives here.

The app owner published `app/direct-launch-acp.ts` in `fd13b572`, calling these
entry points with the real Host and canonical workspace callbacks. Its launcher
passes `autoApprove:false` and `allowUnsandboxed:false`, but that commit's
`ToolSurfaceOptions` does not yet declare the latter option. The launcher alone
is not evidence that tool authority enforces it. Also, its
`applicationCapabilities` installs only `reset`, not `submitWithDelivery`.
These remain app/Session/tool-owner integration work, not client fallbacks.

## Admission, content and interactions

- Each prompt sends exactly one UUID-keyed `submit`, with `origin:acp` and explicit
  **`delivery:reject_if_busy`**. This requires the actual `submitWithDelivery`
  capability while Session's native facade lacks delivery. Unavailable fails
  explicitly; there is no auto-delivery fallback, queue-then-retract workflow,
  queue edit endpoint or speculative retry. A queued/steering receipt violates
  this requested mode and raises an integration error, not a fictional start.
- The local ACP slot rejects simultaneous prompts before sending; shared Session
  still owns cross-client admission. Acknowledgement and the output-only ordering
  gate do not acknowledge engine work or prove completion. Started work waits for
  its exact real terminal. The single `turn_started` event may include admission;
  its input message identity also provides start correlation when the receipt
  omits turnId. No client sequence is substituted for durable seq.
- Prompt text, resource links and text resources retain existing interpretation.
  Images are mapped to image/* MIME and raw padded RFC4648 base64, never fetched
  from a path/URL or inferred from a data URI. Canonical base64 is checked before
  admission without a new size cap or provider permission policy. Image-only
  prompts and text after images are retained: wire text takes the first text
  part, and typed attachments preserve the remaining block order. Initialize
  advertises image prompt support; audio/blob resources remain unsupported.
- Every pending request has its own controller. Questions/permissions do not
  block the event pump or each other; answers target exact wire request IDs.
  Stale responses never answer another owner. Nested output/requests use their
  own identities and cannot change root foreground or settle the root terminal.
- Approvals retain approve/reject option IDs with allow_once/reject_once and the
  existing allow-once response alias. Recognized scoped/Docker options are offered
  only from `supportedGrants`, and sent as exact grant decisions, never collapsed
  into allow or cached locally. Unsandboxed choices remain excluded by ACP's
  posture. Actual M2 advertises no scoped grants. Unknown selections, cancellation
  and missing permission methods deny.
- Questions use standard ACP v2 `elicitation/create` form mode. Known questions
  map to stable-ID answer sets: single/multiple choices, descriptions where the
  schema supports them, and optional custom text. A multi-select can combine
  offered values with one additional custom answer. The complete set is sent
  once as `answers`; canonical serialization remains protocol/Session-owned.
  Without a structured question schema, the form collects a string answer.
  Explicit decline sends `decline`; cancel, unsupported elicitation, malformed
  or incomplete responses send decline plus stopAfterApprovalResolution. They
  are not approval denials, fabricated answers or silent allows.

## Display, terminals and replay

Live messages use the wire's actual draft IDs and `replacesDraftId`, preserving
model-step identities rather than inventing a naming formula. Append-compatible
final text sends only its suffix; ACP full-message upserts handle corrections and
images. Tools use execution IDs, not repeatable provider call IDs. Tool text/image
content is preserved for live, nested and snapshot output. Public JSON display is
kept alongside text in rawOutput; opaque provider frames never reach this client.
Progress is accumulated because ACP tool-content updates replace rather than
append. A result without a start is still displayed by its execution ID, without
a duplicate transcript tool message. Reasoning uses its supplied messageId when
known, otherwise an explicitly coarse per-turn identity; null modelStep does not
become an invented step.

Snapshots now use real activeTurnId/drafts/reasoning/terminal data. Restored and
live terminal outcomes share completed/cancelled/failed/interrupted mappings.
No budget stop reason is inferred from a generic failure or command receipt;
M3's real budget contract remains feature-owner work. Explicit cancel targets
foreground work. Explicit close cancels and observes a known foreground terminal
before detach. Transport EOF/shutdown only detach client subscriptions/requests;
Host owns shared Session/background lifetime. There is no shutdown deadline or
runtime cap.

ACP `replayFrom:start` uses a **fresh atomic snapshot plus subsequent live events**.
Fresh mixed message/tool replay requires authoritative `snapshot.timeline`; null
must not be interpreted as "all messages happened before all tools." Such a mixed
replay fails explicitly while that metadata is unavailable. Live snapshot upserts
preserve the order of previously observed IDs and do not unexpectedly expose old
history hidden by resume-without-replay. Newly observed mixed snapshot items also
require a timeline. Existing stream-to-final aliases survive in-place refresh.

The direct Host's numeric cursor overload is now concrete and distinct:
`DirectReplayConnection` has `snapshot:null`, `replay:{fromSeq,toSeq}` and accepted
`(fromSeq,toSeq]` events followed by live updates. That path requires retained state
at fromSeq and must never be treated as a fresh snapshot/reset. This ACP SDK defines
only the standard `replayFrom:start` cursor plus implementation-specific extension
variants; no numeric ACP cursor format has been agreed. This client therefore
keeps the normal no-fromSeq attach above and explicitly rejects unknown cursor
variants. It neither claims Host cursor replay is unavailable nor invents an ACP
cursor extension, client seq counter, or snapshot-then-old-tail fallback.

## Remaining owner work and verification limits

- Integrate the real shared protocol/Host implementation and its M2 dependencies,
  including enriched Session state/store; shared direct imports intentionally do
  not resolve in this worker's older base. The published app launcher must receive
  actual reject_if_busy admission and tool security authority as described above.
  No bridge implementation is an integration substitute.
- Supply authoritative mixed snapshot.timeline. If committed IDs differ from live
  draft IDs, preserve their replacement/display relation across fresh snapshots;
  event-only replacesDraftId cannot guarantee cross-reconnect ACP identity.
- Direct list metadata lacks optional ACP title/updatedAt. IDs/canonical cwd and
  the direct page cursor are returned; no timestamps or old-log titles invented.
- Agree an ACP numeric cursor extension if that transport feature is required.
  Standard fresh snapshot replay and Host tail replay are not interchangeable.
- No tests, probes, typechecks/lint/guards, builds, independent review or cold reads
  ran, per user direction. Source/SDK/type inspection and write-only formatting
  are implementation aids, not behavioral evidence. End-of-M6 verification must
  target this backend/new stdio entry rather than count legacy passes as direct
  acceptance, including image/question/grant errors, busy rejection, nested output,
  replay ordering/identity, terminal observation, close and EOF.
