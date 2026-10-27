# Discord bridge (candidate)

One bot in one private channel can speak to multiple **existing term2 terminal
sessions**. Live, explicitly opted-in sessions are addressable by their control
socket name while they run; this does not create a chatbot or a new conversation
per message. This candidate needs independent auth/session review
and authorized live Discord validation before acceptance. No live bot setup was
performed during implementation.

## Attach the actual session, not a blank replacement

Sessions must explicitly opt in to Discord input. This is intentionally not a
settings key an agent can change. Each participating session independently opts in;
no approval/auto-approve settings are copied from the coordinator.

For an already-running interactive root TUI, explicitly run `/bridge connect [name]`
(default name `coord`). This creates and advertises a control socket for that live
session; `/bridge status` reports its binding and `/bridge disconnect` removes a
runtime-created socket. Connecting is a security-sensitive action: remote human
input can reach the session, but approvals and questions remain terminal-only.
Do not opt in sessions whose unattended work you do not intend remote users to
steer. The bridge notices the new live opt-in advertisement on its next tick; no
bridge restart, journal edit or config entry is needed.

Alternatively, opt in at process launch with both flags. If your existing session
was already launched with both flags, keep it running. Otherwise, do not kill
ongoing work just to attach Discord. Checkpoint/finish its active operation, record
the exact session ID/resume command printed by term2, and exit normally when safe.
Then, from its original workspace, resume that **same ID**:

```sh
term2 --resume YOUR_EXISTING_SESSION_ID --control-socket=coord --discord-input
# In the worker's own workspace, with ITS existing session ID:
term2 --resume YOUR_EXISTING_WORKER_ID --control-socket=worker --discord-input
```

No positional prompt; that would select non-interactive mode instead of listening.
Do not use `--fork`, which would create different history. Do not start plain
`term2` as an assumed replacement. Normal persisted-history resume is supported;
this bridge cannot resurrect a killed in-flight tool or move live process state.
The runtime command is available only in an interactive root TUI; non-interactive,
ACP, web-gateway, and subagent sessions do not inherit this capability. Existing
startup sockets continue to work unchanged.

`XDG_RUNTIME_DIR` must be an absolute user-owned directory with mode 0700. Reuse the
normal runtime directory, not a shared `/tmp` directory. Verify the correct live
identities without exposing credentials:

```sh
term2 control list --status
term2 control get coord session --json
term2 control get worker session --json
```

Record the exact `sessionId` values. There is no fixed alias-to-socket map: live
opted-in sessions are the aliases. Each **admitted job** pins the socket, session ID
and process start epoch it was admitted to. Socket reuse, session rollover or
replacement never silently moves pending work into a new history.

## Discord setup (only after authorization)

Use a dedicated bot, a private channel, and only the required permissions: View
Channel, Read Message History, Send Messages. Enable Message Content Intent for
the application if required by Discord; otherwise REST may return empty message
content. Do not grant Administrator. Configure the numeric human **user ID**, not
a display name. The bridge itself does not create bots, join guilds, change channel
permissions or verify that the operator's chosen channel is private.

Keep the token out of JSON, commands saved in history, source, prompts and logs.
Enroll once with `term2 discord --save-token` on a terminal. Input is hidden;
setup exits without starting the bridge. Normal `term2 discord` never prompts.
The default config is `$XDG_CONFIG_HOME/term2/discord.json`, or
`~/.config/term2/discord.json` if XDG_CONFIG_HOME is unset (XDG must be absolute).
Both commands also accept one absolute config path; enrollment stores
`discord.token` beside that config. Explicit enrollment replaces the stored token.
The selected directory must be user-owned and private (0700); credential files
must be user-owned regular private files (0600). Symlinks and unsafe existing
permissions are refused, not repaired. Missing directories are created privately.
Protect backups too: the stored credential is plaintext under filesystem access control.

`TERM2_DISCORD_BOT_TOKEN` on the standalone bridge process takes precedence over
the stored credential. An empty/whitespace environment credential fails rather
than falling back. No token is needed for offline fixtures.
The production transport is fixed to HTTPS `discord.com/api/v10`, rejects redirects,
and does not include Discord response bodies or credentials in error messages.
Session processes need no Discord token. Same-uid local access has the existing
Unix-control threat model; this is not protection from a malicious same-uid agent
or root. Persisted session permissions and approvals are still meaningful boundaries.

Example `/absolute/private/discord.json` (replace every example ID/path):

```json
{
  "channelId": "123456789012345678",
  "humanUserId": "234567890123456789",
  "coordinator": "coord",
  "stateDir": "/home/YOU/.local/state/term2-discord/private-channel",
  "maxHops": 4
}
```

The config has **no session map**. Sessions attach live: any interactive root TUI
that explicitly opts in with `/bridge connect NAME` or the startup flags
`--control-socket NAME --discord-input` becomes addressable as `@NAME` while its
control advertisement is live and carries the `discordInput` opt-in marker. A
session that does not opt in is never discovered, even if its socket exists.
An alias is the opted-in session's control socket name: 1–64 ASCII letters,
digits, `_` or `-` (case-sensitive), the same grammar `/bridge connect` accepts. `coordinator` is only the default alias name for unaddressed human input; it
does not pin a socket, session ID or process. Unaddressed text is delivered only
while a live opted-in session with that name is attached; otherwise it is visibly
refused and no job is created. There is no queue for a future process.

`maxHops` is 1–8, default 4. `stateDir` must be absolute, owned by this OS user,
mode 0700. It is created if absent; its journal and ownership file are mode 0600.
Protect config too, e.g. mode 0600. Do not reuse a state directory for another
channel/user. A changed config is refused against the old journal rather than
silently accepting stale routing state. The previous pinned-session schema (a
`sessions` map) is rejected with an explicit error: archive the old state and use a
fresh `stateDir`. Journals are version 2 and store each admitted job's socket,
session ID and start epoch; a version 1 journal or any config-fingerprint mismatch
also fails closed. Old files are never deleted, migrated or rewritten.

```sh
term2 discord
# Or retain an explicit config:
term2 discord /absolute/private/discord.json
```

Changing `coordinator` changes the default for **newly admitted unaddressed**
messages after restarting the bridge with the edited config. Keep the same
`stateDir`: its cursor, pending jobs, outbox and reconciliation records survive.
Previously admitted jobs keep their original alias and exact process binding;
explicit `@alias` messages are unaffected. A message sent while the bridge is down
uses the default in effect when it is admitted, not when it was sent.

For an existing v2 journal from before this behavior, first start the new bridge
**once with the original unchanged config**. Only after that succeeds, stop it,
change `coordinator`, and restart using the same `stateDir`. The old journal stored
only a whole-config hash, not the original config, so changing the default before
this one-time upgrade is refused without rewriting the journal. Restore the
original config to perform the upgrade; do not delete pending work. Channel,
human user, state-directory and hop-limit changes still fail fingerprint checks.
Version 1 journals remain unsupported. Older bridge executables cannot open the
upgraded fingerprint: preserve a pre-upgrade backup for rollback, and reconcile
any work admitted since that backup rather than replaying it blindly.

Wait for `[bridge] Ready` in Discord **before sending new work**. First startup
establishes a current-channel watermark; historical messages deliberately do not
activate anything. The bridge opens successfully with no attached sessions and
reports `No sessions attached` in `!bridge status`. A session attached later is
addressable immediately without restarting the bridge. Restart with unchanged
config/state preserves the cursor, pending input and outbox. Do not delete the
journal to “fix” an uncertain delivery.

Only one bridge owns a state directory, and generic mode assumes one bridge per
runtime directory. `discord_send` from a session requires exactly one live bridge
advertisement there; with zero it is unavailable, and with two or more it is
ambiguous and unavailable rather than a guess. Ctrl-C/SIGTERM stops the bridge loop
after the current bounded operation; it does **not** stop the terminal sessions.

### Migration from the pinned-session schema

Version 1 journals pinned aliases to `{socket, sessionId}` entries. That schema is
gone. Preserve the old state directory and journal unchanged, create a new config
without `sessions`, and point `stateDir` at a fresh directory for the same channel
and human. Do not copy pending rows into the new state; reconcile them from the old
journal and terminal history first. The bridge refuses an old journal instead of
reinterpreting it.

## Mobile usage and identity

* `What is the current task and recent progress?` → coordinator's existing context.
* `@worker Inspect the current implementation` → worker's existing context.
* A session's **final answer** starting `@worker Please inspect this` explicitly
  targets that peer. The response remains visibly attributed as `[coord] ...`.
  The recipient receives `agent session coord` in an untrusted server-data envelope,
  **not** a human instruction or approval. It may reply explicitly `@coord ...`.
  When that peer route is part of a newly admitted human Discord job, the bridge
  carries the configured human ID and original Discord message ID through the
  causal job chain; the next recipient sees `human <id>, relayed via <alias>` and
  the original message ID, and admission follows the human steer path. This root
  provenance is attached by bridge ingress, not inferred from agent text or a
  self-asserted origin. Peer jobs without that bridge-recorded root remain
  `agent session <alias>` data and use queued follow-up admission.
* Ordinary finals are visible but wake nobody. Quoted/code-fenced targets and
  mentions in the middle of a reply are not routing commands. No broadcast route.
* All fetched bot and webhook messages—including the bridge's own posts—are ignored.
  Only the configured human can originate channel input. Unknown/malformed targets
  never fall back to coordinator. Other users are silently ignored, without leaking
  session details. Unexpected channel data is rejected without advancing the cursor.
* Text only; attachments, edits to previously consumed messages and message deletion
  are not queue-edit commands. Submit a new message or use normal terminal controls.

Human/peer identity is carried in the control request, terminal presentation and
actual model/history text. The provider's transport role is still `user`, as with
other server-delivered term2 notifications; the envelope explicitly distinguishes
agent data from human requests, and does not confer sender permissions. This is not
a cryptographic isolation boundary against prompt injection. Each receiving session
retains its own tool/approval posture; do not opt in a session whose autonomous
capabilities you do not want remotely reachable.

Human input uses term2's existing steer admission when a turn is busy and ordinary
submission when idle. An explicitly routed peer delivery inherits human authority
only while its bridge job retains the verified Discord human/message causal root;
that delivery also uses steer admission. Peer-agent input without that root remains
a queued follow-up. Steering does
not abort a running tool: input becomes visible at a supported request boundary,
or falls back to a queued turn if the active turn cannot take it. Each accepted
human request observes the terminal result of the turn it joined, not the steer
admission acknowledgment or a later unrelated turn. Multiple human requests that
join the same turn each receive that turn's final (not separate model turns).
Approval pauses still require the terminal; Discord input cannot answer them.
Busy sessions acknowledge `queued` and answer when admitted. Remote input—human or
peer—never answers an outstanding question/approval. The bridge visibly refuses it;
resolve or cancel through the terminal, then send a new request if wanted. Existing
large-input/surge confirmation guards can also refuse bridge input.

## Pause, stop and bounded chains

Only the configured human can issue:

* `!bridge status`: bridge running/paused state and pending count. This is not a
  real-time dump of session tools/history. Ask the session for contextual progress.
* `!bridge pause`: prevent **new dispatch**. Already accepted work continues; new
  human input is retained within the bounded inbox, and retained peer requests can
  run after resume. Excess ordinary human work is explicitly refused, not queued.
* `!bridge resume`: permit retained new work again. It grants no tool approvals.
* `!bridge stop`: persist paused state, discard bridge-owned **not-yet-dispatched**
  jobs, prohibit peer routing from existing jobs, then call the native interrupt of
  each currently attached opted-in session. This follows the same cancellation/denial semantics as that
  session's terminal control; it is not a separate queue-retraction API. Other
  terminal-origin queued work follows term2's existing interrupt policy. Subsequent
  human messages remain queued while paused only within the inbox capacity. Inspect
  each terminal if interrupt
  could not be confirmed; a crash during stop is retained as uncertain, not replayed
  as a fresh interrupt against later work. Resume is always explicit.

The work inbox admits at most 128 unsettled bridge jobs. At capacity, additional
ordinary human requests receive a refusal identifying the Discord message ID and
explicitly stating **NOT accepted**: no job is queued or sent to a session. Existing
admitted jobs and their journal evidence are untouched by overflow. The shared
channel cursor continues, so authorized status/resume/stop commands remain reachable
even after excess ordinary messages and across bridge restart. Once capacity is
available, resend wanted refused work as a new human message; it is never silently
replayed or admitted later. Refusal notifications use the existing durable outbox
and the same ambiguous-POST quarantine/non-replay policy as other output.

Each human input is one causal root. At most `maxHops` peer deliveries may follow;
on reaching the limit the bridge posts a notice and waits for a new human request.
There is no ambient agent subscription and no autonomous cross-session broadcast.

## Delivery, reconnect and explicit uncertainty

REST polling is serial: normally one GET and at most one POST per one-second cycle,
with bounded ten-second requests. Failures back off exponentially to 60 seconds;
429 `retry_after` and exhausted-bucket reset hints delay further requests. No tight
poll/retry loop and no automatic POST retransmission after an ambiguous outcome.
Final text is capped by the control wire at 16,384 characters, visibly marked if
truncated, split without breaking UTF-16 surrogate pairs, and attributed on every
chunk. Truncated finals never route to a peer. `allowed_mentions` is empty on every
POST; alias syntax is not an actual Discord mention.

The private journal is written atomically and synced before an input mutation or
Discord POST. Stable request IDs deduplicate admission in a live session (up to 256 retained
control results; pending results are never evicted). Expired results require
reconciliation rather than resubmission. Stable
nonces plus `enforce_nonce` add Discord's bounded duplicate protection. Persisted
cursor/outbox prevent ordinary replay on restart. Crash ambiguity is **not** an
exactly-once guarantee:

* Accepted input with a recoverable same-process result is read, not resubmitted.
* Unknown/expired result or changed session identity is retained with an explicit
  reconciliation notice. Original undecided input remains in the journal.
* A POST interrupted before its acknowledgement is `uncertain`, never automatically
  retried. Inspect channel history and the private outbox before deciding whether a
  manual resend is appropriate. Discord nonce dedup alone is not permanent proof.
* An admitted job keeps the socket/session/start identity captured at admission.
  Each dispatch rechecks that the live opted-in advertisement for its alias still
  matches exactly. A detached or replaced process never receives it; the job is
  retained with a visible notice. A replacement session that deliberately reuses an
  alias receives only new messages addressed to it after it attaches. Reconnecting
  the original process identity is the only automatic continuation. Automated
  cross-process exactly-once recovery is intentionally absent.

Final-feed limitation: only bridge-submitted turns and their explicit peer chains
are correlated/forwarded. Independent terminal turns, later approval continuations,
background worker completion notifications and other unsolicited session events are
**not** an ambient Discord feed. A mobile query still runs in the real current session
and sees its available context/history; it does not manufacture a separate chatbot.

## Explicit proactive notifications

It does not automatically collect finals from arbitrary terminal turns. For explicit
proactive notifications, an opted-in interactive root gets `discord_send` when its
effective profile includes `discord-send`. Read-only and plan profiles suppress it;
nested/script-launched agents and non-interactive roots do not inherit the root
callback. The normal registry projection exposes it through `tools.discord_send`
in `run_code` (including Bare), not a new JavaScript global. No bridge need be
running when the agent is constructed.

The input is `{action:"send",requestId,text}` or `{action:"status",requestId}`.
Request IDs contain 1–64 ASCII letters, digits, `_` or `-`; text is nonblank and at
most 16,384 UTF-16 units, never silently truncated. Use a fresh key for a new
notification. Reuse the same key only to reconcile that notification. The bridge resolves
`[alias]` attribution and channel by matching the caller's full socket/session/start
binding against a currently live opted-in session; there is no separate identity map. Text beginning `@worker` is literal notification text, not peer routing.
Explicit sends and automatic Discord-job finals are separate intentional outputs.

Discovery is a private Unix RPC under `$XDG_RUNTIME_DIR/term2-discord`: directory
0700, socket and advertisement 0600, no credentials or payloads in advertisements.
The stable endpoint name hashes the absolute state directory. Discovery selects the
unique live bridge advertisement and never retries a mutation after its frame may
have been written; zero or multiple live bridges fail closed. The bridge itself
rechecks the exact session identity before every control call. Status and identical
replay reconcile records while the caller's exact identity is still live; after a
disconnect or replacement the bridge answers `identity_changed` rather than exposing
another process's records. This is the existing
same-uid trust model, not cryptographic authentication against another local process.

`queued` means index and all chunks were atomically persisted, **not delivered**.
`sent` means all chunks were acknowledged by Discord. `uncertain` means an ambiguous
POST, retained without automatic resend; chunk counts expose partial outcomes.
`unknown` means the send RPC may have reached the bridge before disconnection:
inspect status using the **same request ID**, never automatically invent a new ID.
`unavailable` means no mutation frame was attempted; `missing` is not delivery
proof. `rejected` means no new admission (invalid input, changed identity, pause,
key conflict or capacity). Identical send replay returns the existing status;
changed text with the same key conflicts. Restart never automatically replays tool
calls, and any durable `sending` chunk becomes `uncertain`.

New proactive admissions are limited to 128 queued requests (the existing inbox
scale) and a projected 16 MiB serialized journal. There is **no 512-lifetime-send
ceiling**: accepted indexes and associated sent/uncertain chunks are retained,
including beyond ordinary settled-output trimming. Capacity reports kind, usage
and effective limit. It affects only new proactive admission; duplicate/status
reconciliation, ingress recovery and already-accepted output remain available.
These conservative local-resource bounds are not measured workload limits. A
long-lived journal can reach the byte budget: the operator must reconcile and
archive it before deliberately provisioning fresh state. Never delete uncertainty
or replay pending records to regain capacity. No automatic eviction, TTL or retry
is added. Existing version 1 journals are refused with a fresh-`stateDir` message;
incompatible new shapes fail closed without rewriting the file. Preserve the old
journal on rollback; do not run an older bridge executable against a version 2
journal, and do not run this bridge against a version 1 journal.

## Offline evidence and optional authorized live smoke

```sh
pnpm typecheck
pnpm test:integration -- source/services/discord/discord-bridge.integration.test.ts
pnpm test:provider-black-box
```

The integration fixture uses a loopback fake Discord HTTP API, real Unix sockets,
real ConversationService/Orchestrator/AgentClient and a provider-boundary fixture.
No tokens, production provider calls or external Discord traffic.

After independent review and authorized bot/channel access, verify **on mobile**:

1. Record both existing session IDs and a harmless terminal-only context fact in each.
   Attach/resume explicitly as above, verify the same IDs, then wait for Ready.
2. Ask an unaddressed question about the coordinator fact; target `@worker` for its
   different fact. Compare actual persisted history and visible `[alias]` responses.
3. Ask coordinator to finalize `@worker ...`; worker explicitly targets coordinator
   back. Observe attribution in both sessions and bounded cycles, not bot echo wakes.
4. Send an ordinary untargeted reply, unknown alias, unauthorized-user message and
   message in another channel. Confirm only intended accepted inputs appear.
5. Exercise busy queue, terminal approval refusal, pause/resume and native stop.
6. Disconnect/reconnect bridge network and restart bridge against the same live
   sessions. Check no duplicate accepted requests or duplicate acknowledged outputs.
   Review uncertain windows rather than inferring success. Deliberate session restart
   must refuse stale attachment. Inspect chunking/mention suppression on mobile.
7. Revoke/rotate token only with authorization; confirm safe errors, no raw token in
   source/log/journal, and correct recovery with the same non-secret config.

Live compatibility, Message Content Intent availability, true Discord pagination and
rate-limit behavior, actual mobile rendering and actual AI-to-AI reasoning remain
unverified until this authorized exercise is performed. Offline fixtures do not
establish them.

Routine started/queued receipts are not posted for accepted human or peer jobs.
Final replies, readiness and meaningful refusals/errors remain. Previously persisted
receipt outbox entries may drain once; upgrading does not rewrite the journal.
