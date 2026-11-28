# Runtime contracts

Start with the [source layers](../architecture/layers.md) when you need to
locate the owner of a behavior.

## Live interfaces

| Boundary | Reference |
| --- | --- |
| Native session, durable command receipts, queue, replay and shutdown | [Native conversation session](09-rewrite-native-conversation.md) |
| Daemon startup, launch ownership, attach and lease lifetime | [Daemon and native session ownership](15-daemon-session-ownership.md) |
| HTTP assertion and negotiation, hydration, SSE and configuration | [Agent-wire v2 server transport](14-agent-wire-v2-server.md) |
| Local RPC vocabulary and framing | [Client API](../plans/daemon/spec/client-api.md), [Unix binding](../plans/daemon/spec/transport-unix.md) |
| Shared browser and terminal fold types | [Wire fold surface](wire-fold.api.txt) |

## Historical seam records

The ROADMAP Phase 1 records preserve the reasons for past contract decisions
and the failures that led to them. Most originated in the pre-rewrite tree.
Some have notes about replacement owners. Use the live source and current
test tiers when verifying behavior today. The recorded counts, source paths
and test commands describe their original checkouts.

- [01 Conversation submission and lifecycle](01-conversation-submission-and-turn-lifecycle.md)
- [02 Provider continuity and effect settlement](02-provider-input-continuity-and-effect-settlement.md)
- [03 Child-run authority and lifecycle](03-child-run-identity-authority-and-lifecycle.md)
- [04 Settings consumption](04-settings-consumption.md)
- [05 Runtime guards and retention](05-runtime-guards-and-retention.md)
- [06 SSH transport lifecycle](06-ssh-transport-lifecycle.md)
- [07 Logging and provider traffic](07-logging-and-provider-traffic.md)
- [08 Conversation durability and recovery](08-conversation-durability-and-recovery.md)
- [09 Execution-root authority and workspace lease](09-execution-root-authority-and-workspace-lease.md)
- [10 Settings durability, migration and sensitive bytes](10-settings-durability-migration-and-sensitive-bytes.md)
- [11 Destructive approval authority](11-destructive-approval-authority.md)
- [12 Queue persistence and recovery](12-queue-persistence-and-recovery.md)
- [13 Gateway wire inventory](13-gateway-web-wire.md)

Phase 1 found that Vitest could return success after silently matching only a
subset of the requested test files. When using a focused check, compare the
files it ran with the expected set. The original baseline correction and
historical test counts remain available in [the Phase 1 index](https://github.com/qduc/term2/blob/c455d16c5/docs/contracts/README.md).
