# Direct control / Discord boundary

Control owns a dedicated Host snapshot/live attachment and v1 socket transport;
it does not own Session execution, admission, persistence or a second writer.
Discord remains a socket-only client. The app owns process lifecycle, real
Session creation/switching, metadata and root-tool injection.

## Identity and retries

The direct transport adapts the clean v1 framing, private files and process
identity leaves. Its receipt caches are transport optimizations, not durable
admission authority. Generic and bridge keys include Session ID and request ID;
body fingerprints include requested delivery, unchanged text and canonical
origin fields. Session still validates original content/attachments, delivery
and structured origin after cache loss. Edits must not change that original
fingerprint. Do not replace the direct request layer with the source text-only
cache: that conflates submit/steer/origin and can replay a predecessor Session's
receipt after rebind. Equivalent origin property ordering must not conflict.

Discord origin is the public flat discriminant, not serialized authority in an
opaque ID. Human input requests steer; agent/reaction input requests follow-up.
Trust labels in model-visible text do not replace native Session classification.
No remote message answers an interaction. New bridge admission blocks on pending
terminal interaction; a known original request may recover its actual receipt.

## Completion and lifecycle

`WireSubmissionRecord` supplies original admission, current stage, owning turn,
outcome and correlated final text. Retracted/discarded/cancelled work settles
from those facts, never from disappearance from a pending array. Null finalText
stays unknown/pending. `bridge_result` prefers this public record to a local
pending/uncertain cache. Live and recovered text use the same existing v1
16,384-character bound and truncation marker; full accepted evidence remains
Session-owned, not a second result store here.

`createSessionDiscordSend(getServer,runtimeDir,sessionId)` is the app's root-tool
capability. Its invocation requires matching Session identity and
`socket.discordSendEnabled`: explicit opt-in, attached, listening, unpaused and
not closed. `.discordInputEnabled` alone is only the process opt-in flag, not
liveness. Work already sent before a pause is not retroactively revoked.
Ordinary final responses are not automatically posted.

Rebind pauses/drains admission, connects through Host authorization, replaces
the attachment and refreshes the advertisement. Failure closes control rather
than continuing to advertise the predecessor after an actual Session change.
The app must keep its UI on the real successor and detach/report a failed
control rebind; there is no domain reset rollback here. Interrupt uses real
Session untargeted foreground stop/second-stop manual queue semantics, or an
unambiguously identified background task. Failure/recovery pauses require
explicit queue action; unknown task ownership is unavailable, not guessed.

## Integration status

Implementation is unverified pending the user-deferred post-M6 checks. Requires
the protocol's structured origins, submission records, queue pause reasons and
rich task metadata, and the actual Session/queue/replay operations behind them.
The external task handoff records exact commits and remaining owner gaps;
this document makes no runtime acceptance claim.

## Native command receipts (protocol 82d37ded)

`status.commands` and `get(pending).commands` retain the native per-invocation
`commandId`, original request/revision and actual typed receipt. The control
projection distinguishes pending, finished, negative rejection and unknown
outcome-unobserved interruption. Pending commands count as working in the v1
phase, not as success. Finished retry means admission of its exact turnId, not
model/tool completion; rolled_over only names the actual accepted successor.
An absent command projection is null; absence of an ID is not permission to
execute. The shared protocol reducer folds command_started/command_finished.

The v1 control/Discord mutation methods remain submit, steer and interrupt;
they do not issue retry/compact/configure/rewind/rollover commands or translate
slash text into them. Submit keeps its clientRequestId (not a native commandId),
and foreground interrupt keeps Session's untargeted/second-stop behavior. App
owns keyed native command invocation: allocate a fresh commandId once per human
invocation, preserve it for that invocation's receipt lookup, and use the read-only
command_status operation to recover after a lost acknowledgement. Pending,
not_found and outcome_unobserved are not grants to rerun an unknown effect.
No client command-kind cache, automatic resend or successor creation belongs
in this adapter. The pure exported controlCommandState can also classify an
actual command receipt returned to app code without changing that ownership.
