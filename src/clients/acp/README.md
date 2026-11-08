# Direct ACP client boundary

This subtree implements experimental ACP v2 against the published direct
protocol through `82d37ded91705090bc6b253301c7411ac5d5e389` (including
`77bca90b`/`5451b43c`) and native keyed-command Session `f14c9baa`. Imports target
`protocol/wire.ts` and `host/in-process-direct-types.ts`.
The app composes this implementation directly; see the public ACP reference for the supported SDK contract and remaining release acceptance limits.

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
`shell.autoApproveMode` to `off` and `sandbox.enabled` to `true`, without writing
user settings. `requireSandbox:true` closes the saved `sandbox.enabled:false`
bypass: an explicit permission cannot grant a default shell call unsandboxed
execution. Native safe-command policy still determines which calls need consent. Lead `1451f8f8`
now declares and forwards `allowUnsandboxed` into source tool assembly, intersected
with workspace read-only/remote authority. Those are the actual published
composition seams, not policies manufactured by ACP's workspace grant. The launcher pins these policies; real-tool and editor acceptance remain distinct from adapter-level verification.

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
- Text and resource links are baseline input. Embedded text resources are advertised
  through prompt.embeddedContext and read from resource.text (there is no nested
  resource.type discriminator). Images
  use image/\* MIME and raw padded RFC4648 base64, never a fetched path/URL or data
  URI. Representation is checked before admission without adding a size cap or
  provider permission policy. Image-only prompts and text after images retain
  block order. Audio/blob resources remain unsupported.
- Each permission, question or budget request owns a separate cancellable client
  exchange; it never blocks the event pump. Answers target exact request IDs.
  Root and task-owned native answers retain that provenance in their accepted
  resolution facts and Host events. Known client actions send `provenance:{source:'user'}`; unsupported methods,
  malformed responses and local error fallbacks send `source:'system'`. Missing
  provenance is never treated as evidence of a human decision.
- Approvals retain approve/reject option IDs and the allow-once alias. Recognized
  scoped/Docker options are offered only from actual `supportedGrants`, sent as
  exact grant decisions, never collapsed to allow or cached. Unknown selections,
  cancellation and unsupported permission methods deny. Session owns real scope
  validation; no absent grant capability is invented.
- Questions use ACP v2 `elicitation/create` form mode only when the initialized
  client explicitly advertises a non-null elicitation.form capability. Budget
  forms use the same gate; unsupported clients receive native system fallbacks
  without an outbound elicitation request. Known stable-ID question
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
execution display. Fresh attachment and snapshot refresh also consume accepted `snapshot.branches`
through renderers keyed by real branch identity. They preserve each branch
transcript order without inventing a total root/branch chronology. Branch
renderers are isolated by supplied branch/agent identity;
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
budget-exhausted stop reason. Explicit cancel/close waits for any in-flight submission admission, captures
that prompt ownership, and sends expectedTurnId for the observed turn and discardQueue:false; native admission performs the comparison.
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

- Store/Host list title/updatedAt still need real owner data. No old-conversation
  title or fabricated timestamp/order.
- A numeric ACP cursor extension requires an agreed retained-state/watermark
  contract if that transport feature is required. Host tail and fresh replay are
  not interchangeable.
- Budget/history/response/branch wire data is not legacy private provider history
  or an aggregate settled price. Events without an ACP display equivalent remain
  telemetry, not invented transcript entries or control capabilities.
- Process cases in `tests/clients/acp/spec.integration.test.ts` and
  `tests/clients/acp-v2/serve.integration.test.ts` cover SDK stdio, image/embedded
  input, rejected extensions, replay, real shell permissions, EOF and signals.
  Native filesystem-backed SDK suites in `tests/clients/acp/` cover question
  sets, budgets, provenance and lifecycle races; no permanent unit suite is added.
- A packed npm installation outside the checkout passed the process cases and a
  live Gemini 3.8 Flash turn through the SDK 1.4.0 experimental/v2 reference
  client on Node 24.19.0/Linux (2026-11-08). No GUI editor was validated.
- The default agent command sandbox lacks `socat` and prevents nested namespace
  setup. Those runs verify approved shell calls fail closed. A second run on
  the managed host, outside that command sandbox with a locally extracted
  official Debian socat 1.8.0.3, requires successful workspace writes for both
  `approve` and `allow-once` and verifies outside-workspace writes remain blocked.
  Use `TERM2_ACP_REQUIRE_SHELL_SUCCESS=1` on a sandbox-capable host to make the
  success path mandatory rather than accepting sandbox refusal.

## Draft comparison and current activity

The online v2 draft evolves independently of SDK 1.4.0. Preserve this pinned
SDK's empty prompt acknowledgement, exact-v2 initialization and tool_call
announcement shapes until a coordinated SDK/client migration. These differ
from the current online draft and are not claims of full draft compliance.

Every attachment sends a current state snapshot even without history replay.
Native interaction events do not require a separate status_changed event: the
shared protocol reducer supplies foreground state, including concurrent
interactions and background task distinctions. The adapter reports
requires_action while blocked and running when progress resumes. Historical
stop reasons are not re-announced as new completions during attachment.

Build with `pnpm build`, then run
`pnpm test:integration tests/clients/acp tests/clients/acp-v2/serve.integration.test.ts`.
The live packed reference-client turn used Node environment proxy support
(`NODE_USE_ENV_PROXY=1`) for the configured Google endpoint.
