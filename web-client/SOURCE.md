# Source ledger

Salvaged from the ChatForge checkout at
`~/chat-term2-integration/chat` (absolute:
`/home/qduc/chat-term2-integration/chat`), branch `integration/v1-chat`,
commit `ae398a4`. Everything under `components/term2/`, `components/Term2Entry.tsx`,
`components/ChatHeader.tsx`, `contexts/`, `hooks/useTerm2Session.ts`,
`lib/api/term2.ts`, `lib/term2/`, `lib/http.ts`, `lib/storage.ts`,
`lib/streaming.ts` originates there.

## Server-side ports (from ChatForge backend)

- `lib/server/term2-gateway-client.js` — verbatim port of
  `backend/src/lib/term2GatewayClient.js` (@ `ae398a4`). Deliberate deviations:
  - Config sourcing: ChatForge's `config.term2Gateway` singleton replaced by
    `lib/server/gateway-config.js` reading `TERM2_*` env vars.
  - `logger.warn` transport-failure logging dropped (no logger in this client).
  - `createAgentAssertion` no longer defaults issuer/audience/keyId from ChatForge
    config; they are always passed by `issueAssertion`.
  - Exported singleton unchanged (`term2GatewayClient`).

## Behavioral deviations from ChatForge's BFF (backend/src/routes/agentGateway.js)

Prototype scope (create-session, SSE, message send, approval) only:

- Gateway event-stream and JSON responses pass through byte/shape-identical; the
  BFF's opaque cursor HMAC rewriting is dropped — gateway cursors reach the
  browser as-is.
- The BFF's workspace-grant projection, rollout admission, telemetry, and
  multi-user auth are not ported. Identity is the single
  `TERM2_LOCAL_OWNER_USER_ID` (default `local-owner`).
- Session→workspace bindings are kept as an in-memory map
  (`lib/server/session-bindings.js`), refilled from `session_list` on miss —
  functionally equivalent to the BFF's `sessionWorkspaceStore` +
  `workspaceForSession` minus its projection dependence.
- Route validators are simplified from the BFF's (`hasOnlyKeys` checks kept for
  session create/message/interaction; length limits loosened to 1MB).
- Routes not exercised by the prototype flow are not implemented (settings,
  credentials, OAuth, commands, abort, session config, term2 local-control).

## Frontend slice deviations

- `contexts/AuthContext.tsx` — replaced with a fixed local-owner stub
  (`useAuth()` shape preserved, no login flow).
- `components/ChatHeader.tsx` — model selector, tabbed-select type, and auth
  button pruned; props kept for call-site compatibility.
- `components/term2/flags.ts` — `isTerm2UiEnabled()` defaults on (env can
  disable with `NEXT_PUBLIC_TERM2_UI_ENABLED=false`).
- `components/Term2Entry.tsx` — the legacy `ChatV2` default branch is removed;
  the app always renders the term2 session shell.
- `app/layout.tsx`, `app/page.tsx`, `package.json` — new (Next 16 app shell,
  deps pruned to slice usage).
