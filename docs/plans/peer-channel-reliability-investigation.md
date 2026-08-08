# Peer channel dropped-reply investigation

Status: Codex wake bridge implemented; durable logical-mailbox work remains
deferred. Do not interrupt the current UI/business layer separation work for
the remaining protocol redesign.

## Resume here

The 2026-08-08 wake-path investigation established that the generic APC helper
only journals inbound frames; it cannot wake a harness without a harness-owned
bridge. For Codex Desktop, the non-invasive bridge is a dedicated low-cost task
that keeps `agent_peer.py follow` attached and forwards each record through the
app-owned `send_message_to_thread` tool. Background subagents cannot be assumed
to have that tool. Do not substitute private desktop IPC, `codex exec resume`,
or a second app-server owner. `follow` now leases one record at a time and
replays its stable delivery ID until the bridge explicitly acknowledges it
after Codex accepts the task injection.

Term2 can support native delivery later by reusing its existing active-turn
injection boundary and the idle background-notification wake pattern. That work
still needs an APC listener, peer provenance in the UI, deduplication, durable
receipt semantics, and approval-boundary tests; it was not implemented as part
of the Codex bridge work. In particular, Term2's existing background shell only
emits a completion event when its process exits; an indefinitely running
`follow` process therefore cannot provide per-message wake events without a new
line/listener event source.

The original dropped-reply/restart questions below remain open. The leased
`follow` path closes the bridge's read-before-acceptance loss window and provides
at-least-once forwarding with a stable ID. It does not make acceptance and
acknowledgement atomic, nor turn APC v1 into a durable logical mailbox.

## Incident

During coordination around menu redesign Phase 5, `codex-ui-boundary` asked a
Claude peer whether `.worktrees/menu-redesign-phase5` was still active and
owned. The peer researched the worktree and sent a full ownership/status reply,
but delivery failed with:

```text
connect ENOENT ... the peer process may have restarted
```

The failed sender could no longer discover the destination through
`ListAgents`, so it had no current address for a safe retry. The requester saw
only a bounded `ask` timeout and therefore could not distinguish a lost reply
from deliberate silence.

After the requester started a fresh socket, it asked whether the Phase 5 work
could be superseded. The worktree was actually still in flight and contained
uncommitted changes. No work was discarded, but the dropped reply removed the
ownership fact that would have prevented a destructive interpretation of
silence.

The durable recovery was commit `291fd64e`, which records the Phase 5 ownership
and downstream dependency in `docs/plans/menu-system-redesign.md`.

## Safety lesson

Peer-channel silence must not be treated as abandonment or permission. When a
reply contains a fact another agent needs in order to avoid a merge,
supersession, deletion, or other destructive action, publish the fact in the
relevant repository plan as well as sending it over the channel. Repository
state is the durable coordination source; peer messages are an acceleration
path.

## Questions for investigation

- Can `ask` distinguish an unanswered request from a reply that was composed
  but failed because the requester's socket disappeared?
- Should a peer reply be durably queued by logical inbox identity and delivered
  after that inbox restarts, rather than bound only to an ephemeral socket?
- Can the sender receive an explicit `destination-restarted` result containing
  a newly discoverable address or a safe retry token?
- Should critical coordination messages support acknowledgement and bounded
  retry without risking duplicate delivery?
- Can the helper warn when an ownership/status response is not durably recorded
  and suggest updating the relevant plan?
- What stale-record cleanup or restart race caused `ListAgents` to omit the
  requester after the `ENOENT` failure?

## Reproduction outline

1. Start a named requester inbox and issue a bounded `ask` to another harness.
2. Let the receiver prepare a reply.
3. Restart or replace the requester's socket before the reply is sent.
4. Observe the sender's `connect ENOENT`, the requester's timeout, discovery
   state, and whether either side can recover the reply.
5. Repeat with a one-way `send` using a persistent `--from` inbox and compare
   acknowledgement/retry behavior.

Do not use real ownership or destructive-operation approval as the test
payload. Use an inert fixture message and temporary peer names.

## Exit criteria

- A requester can distinguish no reply from a delivery failure.
- A receiver has a documented safe recovery path after requester restart.
- Duplicate retries cannot create contradictory ownership actions.
- The `agent-peer-channel` skill documents the durable repository fallback for
  safety-critical coordination facts.
- A regression test covers the socket-restart/late-reply sequence.
