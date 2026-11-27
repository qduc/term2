# Step 11 Zoom-In: Web Client (`web-client/`) — Session-List Stream Seam

Status: completed 2026-11-27.

This design note specifies the sub-module seams inside `web-client/` to wire the live **session-list stream** (Step 2 / Step 13) without violating `web-shell-rules.mjs` or breaking existing browser flows.

---

## 1. BFF Route & Gateway SSE Pass-Through

- **New route:** `web-client/app/api/agent/sessions/events/route.ts` (`GET /api/agent/sessions/events`, alongside existing `sessions/route.ts` and `sessions/[sessionId]/events/route.ts`; static `events/` takes precedence over `[sessionId]/`).
  - `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`.
  - Validates optional `workspaceId` (`validateOpaqueId`) and `limit` (`1..500`, default `200`).
  - Streams unbuffered via `term2GatewayClient.stream({ userId: LOCAL_OWNER_USER_ID, purpose: 'session_list_events', rpcPath: rpc.sessionListEvents, query, signal: request.signal })` + `attachAbortCleanup` + `Readable.toWeb(upstream)`.
  - Forwards `x-term2-client-api-version` and `x-term2-daemon-id` headers when present.
  - Protected automatically by `web-client/proxy.ts` (`matcher: '/api/:path*'`) Host-header check.
- **`web-client/lib/server/proxy.ts`:** Add `sessionListEvents: '/private/agent/v1/sessions/events'` to `rpc`.
- **`web-client/lib/server/term2-gateway-client.js`:**
  - Add `'session_list_events'` and `'protocol_hello'` to `ASSERTION_PURPOSES` and `isList` in `createAgentAssertion()`.
  - Allow `'session_list_events'` in `#streamOnce()` with purpose-specific query validation (`workspaceId`, `limit`) and send `x-term2-client-api-version: '1.0'`.
  - Add Client API `1.0` error codes (`protocol_incompatible`, `stale_revision`, `stale_interaction`, `cursor_out_of_range`, `env_disconnected`, `busy`, `unavailable`, `closed`) to `SAFE_ERROR_CODES` / `SAFE_ERROR_MESSAGES`.

---

## 2. Browser API Client & Stream Reader

- **`web-client/lib/api/term2.ts`:**
  - Add `openSessionListEvents(options?: { workspaceId?: string; limit?: number }, signal?: AbortSignal)` calling `httpClient.get<Response>('/agent/sessions/events' + query, { signal, skipAuth: true, skipRetry: true, headers: { Accept: 'text/event-stream' } })`.
  - Export `validateSessionItem` and allow optional additive fields (`awaitingKind`, `pendingInteractionCount`, `activeBackgroundTaskCount`) while continuing to reject `FORBIDDEN_KEYS` (including `workspaceRoot`).
- **`web-client/lib/term2/data/session-list-stream.ts` (new):**
  - Reuses `decodeSseText` / `parseFrame` from `web-client/lib/term2/sse.ts`.
  - Dispatches `session.list.snapshot` → `onSnapshot(sessions, nextCursor)`, `session.list.upsert` → `onUpsert(session)`, `session.list.remove` → `onRemove(sessionId, reason)`, `session.list.resync_required` → reconnect immediately, `daemon.draining` → expect EOF and reconnect; ignores unknown event names.
  - Exponential reconnect backoff (`500ms` → `10_000ms`), stops retrying on terminal auth/protocol errors (`401`, `403`, `400 protocol_incompatible`), and wires `AbortSignal` into backoff sleep for React StrictMode `start() -> stop() -> start()` safety.

---

## 3. Store & Shell Runtime Integration

- **`web-client/lib/term2/data/server-data.ts`:**
  - Keep `chats: Resource<ChatList>` and add canonical comparator `compareSessions` (`updatedAt DESC`, then `id ASC`).
  - Add `applySnapshot(sessions, nextCursor)` using `chats.replace(...)` (incrementing `latest` so stale HTTP fetches cannot overwrite a fresher stream snapshot).
  - Add `upsertSession(session)` and `removeSession(sessionId)` using `chats.update(...)`, preserving `nextCursor` and canonical order.
  - Retain `loadMoreChats()`, `chatCreated()`, and `chatTitled()` for pagination and instant local optimistic updates until the authoritative `upsert` arrives.
- **`web-client/lib/term2/shell/shell-runtime.ts`:**
  - Instantiate `sessionListStream` in `createShellRuntime()`, call `sessionListStream.start()` alongside `session.start()` and `sessionListStream.stop()` alongside `session.stop()`.
  - Remove the old trigger-based `data.chats.refresh()` workarounds on open-session status changes (`shell-runtime.ts:83-92`), sidebar open (`shell-runtime.ts:105`), folder changes (`shell-operations.ts:188`), and handoff (`shell-operations.ts:401`).
  - Keep `reloadLists()` calling `data.chats.loadOrFail()` for manual retry / initial fallback while stream connects (preserving `loadingSessions` UX and avoiding breaking `shell-hazards.flow.ts:119-137`).
- **`web-client/components/term2/Term2SessionList.tsx`:** Add `id` ascending tie-breaker to its sort comparator so sidebar row order matches canonical order.

---

## 4. Gates & Browser Flow Coordination

- **`scripts/gates/web-shell-rules.mjs`:** Stays green — zero React effects added, `lib/api/term2` stays out of `components/` and `hooks/`.
- **`tests/web-client/browser/shell-hazards.flow.ts:184`:** Tighten `url.pathname.endsWith('/events')` to `/^\/api\/agent\/sessions\/[^/]+\/events$/u` so it intercepts the per-session stream rather than `/api/agent/sessions/events`.
- **`tests/web-client/browser/sidebar.flow.ts` & `bff-guards.flow.ts` & `tests/host/gateway/bff-stream-abort.integration.test.ts`:** Extend to prove live cross-session sidebar updates (including a background/second session changing status while another chat is open!), abort-before-headers on `session_list_events`, and query validation.
