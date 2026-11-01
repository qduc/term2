# Direct ACP client boundary

This subtree implements experimental ACP v2 against the published direct
protocol through `82d37ded91705090bc6b253301c7411ac5d5e389` (including
`77bca90b`/`5451b43c`) and native keyed-command Session `f14c9baa`. Imports target
`protocol/direct-wire.ts` and `host/in-process-direct-types.ts`, not bridge types.
Shared owner commits were inspected read-only, not copied/cherry-picked into this
worker's older base. This is implementation, not M6 acceptance.

## App integration and security

The app composes `DirectHost`, an authenticated `Principal`, a diagnostic logger,
and `AcpWorkspaces`, then calls `createAcpBackend`. Pass that backend and the app
version to `createAcpAgent` or `serveAcp`. `createStdioAcpIo` adapts Node stdio;
`serveAcp` uses SDK 1.4.0 experimental-v2 `ndJsonStream`. JSON-RPC framing,
transport IDs and schema validation remain SDK-owned. Initialize, session
new/list/resume/prompt/close, cancellation, permissions and session updates retain
their ACP v2 method names.

`AcpWorkspaces.authorize` resolves canonical cwd to an admitted workspace grant.
`cwd(sessionId)` supplies canonical **direct** session workspace metadata under
the same principal as Host. Resume checks cwd, but the connection snapshot has no
workspace field. Neither callback may construct an adopted runtime or read old
logs. List metadata comes only from Host; optional title/updatedAt remain omitted
because the published direct-store list contract does not expose them.

The app owner's published launcher (`19ec1b69`) calls these real entry points with
`surface: () => ({autoApprove:false,interactive:true,allowUnsandboxed:false})`
and `approvalAlwaysAsks:true`. Its runtime pins per-session
`shell.autoApproveMode` to `off`, without writing user settings. Lead `1451f8f8`
now declares and forwards `allowUnsandboxed` into source tool assembly, intersected
with workspace read-only/remote authority. Those are the actual published
composition seams, not policies manufactured by ACP's workspace grant. Combined
approval/sandbox behavior remains unverified under the after-M6 deferral.

App keeps diagnostics off stdout, supplies process shutdown signals and disposes
Host after serving returns. No production factory, global signal handler,
default flip or runtime fallback lives in this subtree. ACP still never offers
unsandboxed permission grants, even if a wrongly composed Session advertises one.

## Admission, content and interactions

- Prompts send one UUID-keyed `submit`, with `origin:acp` and explicit
  **`delivery:reject_if_busy`**. The published protocol calls native
  `Session.submitWithDelivery`; no app capability injection is required. ACP has
  no auto-delivery fallback, submit-then-retract workflow or speculative retry.
  A queued/steering receipt violates this mode and raises an integration error.
- The local ACP slot rejects simultaneous prompts before sending; shared Session
  owns cross-client admission. Acknowledgements and the output ordering gate do
  not acknowledge engine work or prove completion. Started work waits for its
  exact real terminal. Real input message/turn identities correlate admission;
  no client sequence replaces durable seq.
- Text, resource links and text resources retain existing interpretation. Images
  use image/* MIME and raw padded RFC4648 base64, never a fetched path/URL or data
  URI. Representation is checked before admission without adding a size cap or
  provider permission policy. Image-only prompts and text after images retain
  block order. Audio/blob resources remain unsupported.
- Each permission, question or budget request owns a separate cancellable client
  exchange; it never blocks the event pump. Answers target exact request IDs.
  Known client actions send `provenance:{source:'user'}`; unsupported methods,
  malformed responses and local error fallbacks send `source:'system'`. Missing
  provenance is never treated as evidence of a human decision.
- Approvals retain approve/reject option IDs and the allow-once alias. Recognized
  scoped/Docker options are offered only from actual `supportedGrants`, sent as
  exact grant decisions, never collapsed to allow or cached. Unknown selections,
  cancellation and unsupported permission methods deny. Session owns real scope
  validation; no absent grant capability is invented.
- Questions use ACP v2 `elicitation/create` form mode. Known stable-ID question
  sets preserve single/multiple choices, descriptions where supported, and custom
  text. The entire answer set is sent once; Session owns canonical serialization.
  Explicit decline differs from cancel/invalid/unsupported responses, which send
  decline plus stopAfterApprovalResolution rather than fabricated approval denial.
- Real `budget_opened` and snapshot pendingBudgets use a **separate** form showing
  public accepted evidence/snapshot, with extend or stop choices. Only explicit
  extend requests `{kind:'extend',grantedBy:'human'}` with user provenance. Decline
  or cancel stops; malformed/unsupported exchanges stop with system provenance.
  ACP grants no budget itself, applies no threshold, offers no parent/steer bypass
  and never turns auto-approval into a human grant. Session owns actual extension,
  closure and terminal behavior. Resolved/ended/detached requests cannot answer a
  different owner.

## Keyed Session commands and additive wire data

ACP currently sends only `submit`, `answer`, `answer_budget` and turn-targeted
`cancel`. Session new/list/resume use Host methods; close detaches after observing
known foreground cancellation. ACP has no retry/compact/configure/rewind/rollover,
command-status or command-receipt endpoint. Prompt text (including slash text) is
not converted into one of those operations. No new command key or private ACP
extension is needed for the existing surface.

Protocol `82d37ded` requires stable per-invocation `commandId` on those keyed
operations and exposes typed pending/finished/refusal/interrupted replies,
snapshot.commands and command_started/command_finished events. None of ACP's
four outgoing command shapes changed. Those receipt events and snapshot fields
are not ACP prompt outcomes and are intentionally not translated into success,
idle, an execution retry or a synthetic transcript item. In particular, even a
finished retry receipt is not the retried turn's terminal. ACP still settles only
its observed real turn terminal; it does not execute/status-query someone else's
receipt, fabricate a command-kind key or retry an outcome_unobserved operation.
The typed receipt API remains protocol-owned, not exposed as a lossy ACP facade.

Ancestor `77bca90b` adds accepted physical request-cost records; ACP does not
synthesize an aggregate price or legacy cost stream from them. `5451b43c` adds
legacyCommandMessages for actual source-formatted tool-finish display DTOs,
which are distinct from keyed Session receipts. ACP retains public display in
tool rawOutput and text/image tool content; it does not call that legacy helper
or infer command IDs, status, blank success or legacy command-event parity.

## Display, terminals and replay

Live and fresh-snapshot messages consume actual `replacesDraftId`, turn/model-step
metadata and accepted mixed `snapshot.timeline`. Stream-to-final replacement stays
on the real draft display identity; no tagged/legacy ID formula is guessed.
Append-compatible finals send only a suffix; full-message upserts preserve
corrections and images. Reasoning consumes actual full/delta message IDs and
snapshot reasoningIdentity; only genuinely identity-less deltas use a coarse
per-turn thought ID, without inventing a model step.

Tools use execution IDs, not repeatable provider call IDs. Text/image content and
public JSON display survive live/nested/snapshot output; opaque provider frames
never reach ACP. Progress accumulates because ACP content updates replace rather
than append. Finished tools use actual accepted name/input when supplied, and
otherwise remain unnamed output updates. Tool result messages do not duplicate
execution display. Branch renderers are isolated by supplied branch/agent identity;
a child snapshot or terminal cannot replace root renderer/foreground state.

Unmatched tool results are retained by execution ID, without a made-up name. The
native accepted reducer and public fold now add a `kind:tool` timeline slot at
the first actual call/start **or result** for that execution. Repeated finish/item
result evidence keeps that original slot; it does not append output after later
messages. Native snapshot synchronization preserves this accepted order. ACP's
existing replay resolves an unnamed slot from `unmatchedToolResults`, sending an
output update without inventing a start, name, input, timestamp or call ID.
Fresh attachment still needs the real accepted prefix to recover result content;
a timeline entry alone cannot supply missing output. Null/incomplete timelines
continue to fail explicitly rather than guess chronology. No new accepted fact,
wire event, sequence, journal or ACP extension is involved.

Snapshots use real activeTurnId, drafts, terminal and historical turnResults.
Observed terminal outcomes, not submit/cancel receipts or queue disappearance,
settle foreground work. Only actual terminalCause:budget_exhausted selects the
budget-exhausted stop reason. Explicit cancel/close sends expectedTurnId for the
observed turn and discardQueue:false; native admission performs the comparison.
A no-op/abort receipt is not proof physical cleanup finished. Close observes a
known terminal before detach. EOF/shutdown only detach subscriptions/requests;
Host owns shared Session/background lifetime. There is no client shutdown timeout.

ACP replayFrom:start means **fresh atomic snapshot plus subsequent live events**.
Previously hidden history remains hidden on resume without replay; snapshot
upserts retain observed display order and aliases. Null/malformed timeline data
is never interpreted as all messages preceding all tools.

Host numeric cursor attachment is distinct: snapshot:null, retained-state tail,
then authoritative cut-state snapshot and live events. It must not reset to
current state before the historical tail. SDK ACP v2 has no agreed numeric cursor
variant/retained-state contract here. ACP accepts standard replayFrom:start,
rejects unknown variants and does not invent a cursor extension or client seq.

## Remaining seams and verification limits

- Coordinator must assemble the actual shared dependency set with this owned
  delta. This worker intentionally did not pull shared owner files into its base.
- Store/Host list title/updatedAt still need real owner data. No old-conversation
  title or fabricated timestamp/order.
- A numeric ACP cursor extension requires an agreed retained-state/watermark
  contract if that transport feature is required. Host tail and fresh replay are
  not interchangeable.
- Budget/history/response/branch wire data is not legacy private provider history
  or an aggregate settled price. Events without an ACP display equivalent remain
  telemetry, not invented transcript entries or control capabilities.
- No tests, probes, typechecks/lint/guards, builds, reviews or cold reads ran, per
  user direction. Author source/type inspection is implementation work, not
  behavioral evidence. End-of-M6 verification must exercise this direct backend
  and stdio entry, including native busy admission, mixed replay/aliases,
  provenance, budget pauses, approval/sandbox enforcement, nested output,
  cancellation/terminal observation, close and EOF. Legacy passes do not establish
  direct acceptance.
