import { Term2GatewayClient, Term2GatewayError } from './term2-gateway-client.js';
import { LOCAL_OWNER_USER_ID } from './gateway-config.js';

/**
 * In-memory sessionId -> workspaceId bindings.
 *
 * Session-scoped gateway RPCs (session_read, message_submit, command_invoke,
 * abort, interaction_resolve, events_connect) require a workspaceId binding in
 * the assertion, but the browser API identifies only the session. The gateway
 * is the binding authority; this store only remembers what session_create /
 * session_list / session_read responses already confirmed, and refills itself
 * from session_list when an unknown session is requested (thin-server
 * restarts lose the map by design).
 */
const MAX_BINDINGS = 2000;
const MAX_LOOKUP_PAGES = 20;
const PAGE_SIZE = 100;

const bindings = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function remember(sessionId, workspaceId) {
  if (typeof sessionId !== 'string' || typeof workspaceId !== 'string') return;
  bindings.set(sessionId, workspaceId);
  if (bindings.size > MAX_BINDINGS) {
    const first = bindings.keys().next().value;
    if (first) bindings.delete(first);
  }
}

export function rememberSessionBindings(payload) {
  if (!isPlainObject(payload)) return;
  if (typeof payload.sessionId === 'string' && typeof payload.workspaceId === 'string') {
    remember(payload.sessionId, payload.workspaceId);
  }
  if (
    isPlainObject(payload.session) &&
    typeof payload.session.id === 'string' &&
    typeof payload.session.workspaceId === 'string'
  ) {
    remember(payload.session.id, payload.session.workspaceId);
  }
  if (Array.isArray(payload.sessions)) {
    for (const item of payload.sessions) {
      if (isPlainObject(item) && typeof item.id === 'string' && typeof item.workspaceId === 'string') {
        remember(item.id, item.workspaceId);
      }
    }
  }
}

export async function workspaceForSession(client, sessionId) {
  const cached = bindings.get(sessionId);
  if (cached) return cached;

  let cursor = null;
  for (let page = 0; page < MAX_LOOKUP_PAGES; page += 1) {
    const query = cursor ? `?limit=${PAGE_SIZE}&cursor=${cursor}` : `?limit=${PAGE_SIZE}`;
    const response = await client.request({
      userId: LOCAL_OWNER_USER_ID,
      purpose: 'session_list',
      method: 'GET',
      rpcPath: '/private/agent/v1/sessions',
      query,
    });
    if (response.statusCode !== 200) {
      throw new Term2GatewayError('gateway_unavailable');
    }
    const output = response.body ?? {};
    rememberSessionBindings(output);
    const session = Array.isArray(output.sessions) ? output.sessions.find((item) => item.id === sessionId) : null;
    if (session) return typeof session.workspaceId === 'string' ? session.workspaceId : null;
    if (!output.nextCursor || output.nextCursor === cursor) return null;
    cursor = output.nextCursor;
  }
  return null;
}
