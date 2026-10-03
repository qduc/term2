# @qduc/agent-wire

Dependency-free agent event and interaction wire contracts shared by Term2 and
ChatForge. Requires Node.js 20 or later. This is an ESM-only package with
TypeScript declarations.

```ts
import { parseAgentEventEnvelope } from '@qduc/agent-wire';

const event = parseAgentEventEnvelope({
  schemaVersion: 1,
  id: 1,
  sessionId: 'session-1',
  type: 'turn_completed',
  occurredAt: '2026-10-03T00:00:00Z',
  payload: {},
});
```

Exports include `AGENT_EVENT_TYPES`, `AgentEventEnvelope`,
`parseAgentEventEnvelope`, `validatePendingInteractionDto`, and `AgentWireError`.
Envelope parsing validates the envelope structure and event identity, not the
event-specific payload schema. Applications still own payload validation,
authentication, authorization, and transport behavior.

The `0.1.x` API is preliminary. Release preparation and publication instructions
are in
[`docs/release-agent-wire.md`](https://github.com/qduc/term2/blob/main/docs/release-agent-wire.md).
