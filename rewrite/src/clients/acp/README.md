# Direct ACP client boundary

This subtree implements experimental ACP v2 against the published direct
protocol through `3628ef322046211c122eb5612f4fefb1e9a59ba5` and its native
Session checkpoint, staged together on candidate `1e78bb50`. Imports target
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

Unmatched tool results are retained by execution ID, without a made-up name. Fresh
replay requires their real position in snapshot.timeline as well. The published
projection can retain unmatchedToolResults without such timeline entries; this
specific owner seam still fails explicitly rather than silently dropping output
or appending it after unrelated messages. Ordinary mixed replay now uses the
native timeline; it no longer waits on a parallel metadata facade.

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
- Store/Host list title/updatedAt and unmatched-result timeline position still
  need real owner data. No old-conversation title or fabricated timestamp/order.
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
