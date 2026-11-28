/** Direct private server composition. The app supplies one DirectHost and global authorities;
 * this module never constructs a Session/store, drives a turn, or writes conversation state.
 */
import { randomUUID } from 'node:crypto';
import type { DirectConnection, Principal } from './in-process-direct-types.js';
import type {
  ServerHostDependencies,
  ServerRequest,
  ServerResult,
  ServerTransportOptions,
} from './server-contracts.js';
import type { ServerAuthentication } from './server-auth.js';
import { DirectServerTransport } from './server-transport.js';
import { ServerGlobalRoutes } from './server-global.js';
import { matchPrivateRoute } from './server-routes.js';
import type { PrivateRoute } from './server-routes.js';
import { ServerInteractions } from './server-interactions.js';
import { handleSessionRoute } from './server-session.js';
import { projectServerSession, sessionListItem } from './server-projection.js';
import { DIRECT_WIRE_V2, agentWireV2EventStream, directEventStream, directWireV2EventStream } from './server-sse.js';
import { AGENT_WIRE_V2_RUNTIME_AVAILABLE, encodeAgentWireV2 } from './server-wire-v2.js';
import { mapServerError, publicError, ServerHttpError, unavailable } from './server-errors.js';
import * as validate from './server-validation.js';
import { sessionListEventStream } from './daemon/session-list-sse.js';
import {
  CLIENT_API_HTTP_VERSION,
  CLIENT_API_MIN_SUPPORTED_VERSION,
  negotiateCapabilities,
  negotiateSingleProtocolVersion,
} from '../protocol/client-api/version-negotiation.js';
import { CLIENT_API_HTTP_CAPABILITIES } from '../protocol/client-api/client-api-schema.js';

export type {
  ServerHostDependencies,
  ServerTransportOptions,
  ServerConfiguration,
  ServerWorkspaces,
  ServerSessionPresentation,
  SettingsProjection,
  SessionMetadata,
  SessionConfiguration,
  ServerResult,
  ServerRequest,
  ModelCatalogEntry,
} from './server-contracts.js';
export { ServerHttpError } from './server-errors.js';
export { createServerAuthentication } from './server-auth.js';
export type { ServerAuthentication, ServerAuthenticationOptions } from './server-auth.js';

const LOCAL_OWNER_PURPOSES = new Set([
  'daemon_status',
  'settings_read',
  'settings_write',
  'credential_write',
  'credential_delete',
  'oauth_login',
  'oauth_select',
  'oauth_delete',
  'provider_presets',
  'provider_write',
  'provider_delete',
  'skills_list',
]);
export type DirectServerOptions = {
  transport: ServerTransportOptions;
  authentication: ServerAuthentication;
};
/** Start/stop attach/detach the transport only. App owns Host.dispose and assertion-ledger close.
 * Use new direct-only socket/trust/replay paths; never point this server at old gateway data.
 */
export function createDirectServerHost(
  dependencies: ServerHostDependencies,
  options: DirectServerOptions,
): DirectServerTransport {
  return new DirectServerTransport({
    ...options.transport,
    authentication: options.authentication,
    handler: createDirectServerHandler(dependencies),
  });
}
/** Embeddable authenticated RPC handler; normally called only by DirectServerTransport. */
function createDirectServerHandler(
  dependencies: ServerHostDependencies,
): (input: ServerRequest) => Promise<ServerResult> {
  const globals = new ServerGlobalRoutes(dependencies);
  const interactions = new ServerInteractions();
  const daemonId = dependencies.daemonId ?? `dmn_${randomUUID().replaceAll('-', '')}`;
  const daemonVersion = dependencies.daemonVersion ?? '0.0.0-dev';
  const daemonStartedAt = dependencies.daemonStartedAt ?? new Date().toISOString();
  return async (input) => {
    const { claims } = input;
    const route = matchPrivateRoute(input.request.method ?? 'GET', input.url.pathname);
    if (!route || (route.legacy && claims.purpose !== 'session_create'))
      return publicError(404, 'not_found', 'gateway route not found');
    if (!route.legacy && route.sessionId && route.sessionId !== claims.sessionId)
      return publicError(400, 'protocol_conflict', 'gateway path and assertion session do not match');
    if (route.workspaceId && route.workspaceId !== claims.workspaceId)
      return publicError(400, 'protocol_conflict', 'gateway path and assertion workspace do not match');
    if (!route.legacy && route.purpose !== claims.purpose)
      return publicError(400, 'protocol_conflict', 'gateway purpose does not match route');
    if (LOCAL_OWNER_PURPOSES.has(claims.purpose) && claims.sub !== dependencies.localOwnerUserId)
      return publicError(403, 'settings_forbidden', 'local owner authorization is required');
    const versionCheck = negotiateRequestVersion(
      input,
      daemonVersion,
      dependencies,
      claims.sub === dependencies.localOwnerUserId,
    );
    if ('error' in versionCheck) return versionCheck.error;
    const principal: Principal = { userId: claims.sub, via: 'assertion' };
    try {
      await dependencies.audit?.({
        operation: route.purpose,
        principal,
        outcome: 'allowed',
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      });
      if (route.purpose === 'protocol_hello') {
        const capabilities = negotiateCapabilities(dependencies.sessionIndex ? ['session_list_stream'] : []);
        return {
          status: 200,
          headers: { 'x-term2-client-api-version': versionCheck.version, 'x-term2-daemon-id': daemonId },
          body: { protocolVersion: versionCheck.version, daemonId, daemonVersion, capabilities },
        };
      }
      if (route.purpose === 'daemon_status') {
        const counts = dependencies.sessionIndex?.counts() ?? {
          activeSessionCount: 0,
          activeTurnCount: 0,
          activeBackgroundTaskCount: 0,
        };
        return {
          status: 200,
          headers: { 'x-term2-client-api-version': versionCheck.version, 'x-term2-daemon-id': daemonId },
          body: {
            daemonId,
            daemonVersion,
            protocolVersion: versionCheck.version,
            pid: process.pid,
            startedAt: daemonStartedAt,
            ...counts,
            attachedClientCount: 0,
            supportedCapabilities: [...CLIENT_API_HTTP_CAPABILITIES],
          },
        };
      }
      if (route.purpose === 'session_list_events') {
        return sessionListEvents(dependencies, input, principal, daemonId, versionCheck.version);
      }
      const global = await globals.handle(route, input, principal);
      if (global) return global;
      if (route.purpose === 'session_create')
        return await createSession(dependencies, input, principal, route, interactions);
      if (route.purpose === 'session_list') return await listSessions(dependencies, input, principal);
      if (!claims.sessionId) return publicError(400, 'protocol_conflict', 'session assertion is incomplete');
      return await withSession(dependencies, input, principal, route, interactions);
    } catch (error) {
      return mapServerError(error);
    }
  };
}

function negotiateRequestVersion(
  input: ServerRequest,
  daemonVersion: string,
  dependencies: ServerHostDependencies,
  isOwner: boolean,
): { readonly version: string } | { readonly error: ServerResult } {
  const rawHeader = input.request.headers['x-term2-client-api-version'];
  if (rawHeader !== undefined && typeof rawHeader !== 'string') {
    return { error: publicError(400, 'validation_error', 'client API version header is invalid') };
  }
  const queryVersion = input.url.searchParams.get('apiVersion');
  if (rawHeader !== undefined && queryVersion !== null && rawHeader !== queryVersion) {
    return { error: publicError(400, 'protocol_conflict', 'client API version header and query do not match') };
  }
  const requested = rawHeader ?? queryVersion;
  if (requested === null || requested === undefined) return { version: CLIENT_API_HTTP_VERSION };
  const negotiated = negotiateSingleProtocolVersion(
    requested,
    CLIENT_API_MIN_SUPPORTED_VERSION,
    CLIENT_API_HTTP_VERSION,
  );
  if (!negotiated.ok) {
    const counts = isOwner ? dependencies.sessionIndex?.counts() : undefined;
    return {
      error: publicError(400, 'protocol_incompatible', negotiated.reason, false, {
        daemonProtocolVersion: CLIENT_API_HTTP_VERSION,
        daemonMinSupportedVersion: CLIENT_API_MIN_SUPPORTED_VERSION,
        daemonVersion,
        ...(counts ? { activeTurnCount: counts.activeTurnCount } : {}),
      }),
    };
  }
  return { version: negotiated.version };
}

function sessionListEvents(
  dependencies: ServerHostDependencies,
  input: ServerRequest,
  principal: Principal,
  daemonId: string,
  negotiatedVersion: string,
): ServerResult {
  if (!dependencies.sessionIndex) return unavailable('session list stream');
  const workspaceId = input.url.searchParams.get('workspaceId') ?? undefined;
  if (workspaceId !== undefined && !validate.isOpaqueId(workspaceId)) {
    return publicError(400, 'validation_error', 'workspace filter is invalid');
  }
  const rawLimit = input.url.searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/u.test(rawLimit)) return publicError(400, 'validation_error', 'limit is invalid');
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return publicError(400, 'validation_error', 'limit must be between 1 and 500');
    }
  }
  return sessionListEventStream(dependencies.sessionIndex, principal, {
    ...(workspaceId ? { workspaceId } : {}),
    ...(limit !== undefined ? { limit } : {}),
    daemonId,
    negotiatedVersion,
  });
}
async function createSession(
  dependencies: ServerHostDependencies,
  input: ServerRequest,
  principal: Principal,
  route: PrivateRoute,
  interactions: ServerInteractions,
): Promise<ServerResult> {
  if (validate.hasDeferredModelSelectionField(input.body))
    return publicError(422, 'model_selection_deferred', 'Model selection is not available');
  if (!validate.isSessionCreateBody(input.body, input.claims.workspaceId, route.legacy))
    return publicError(400, 'validation_error', 'session request is invalid');
  if (!dependencies.workspaces) return unavailable('workspace admission');
  const grant = await dependencies.workspaces.resolveGrant(principal, input.claims.workspaceId!);
  if (grant.workspaceId !== input.claims.workspaceId || !['read', 'read_write'].includes(grant.access))
    return publicError(403, 'workspace_forbidden', 'workspace access denied');
  const connection = await dependencies.host.createSession(principal, grant);
  try {
    if (dependencies.presentation && connection.snapshot.seq !== null)
      return {
        status: 201,
        body: {
          session: await projectServerSession(connection.snapshot, principal, dependencies.presentation, interactions),
        },
      };
    // This is the gateway's existing no-projection create receipt, not a fabricated empty transcript.
    return { status: 201, body: { sessionId: connection.sessionId, workspaceId: grant.workspaceId, accepted: true } };
  } finally {
    connection.close();
  }
}
async function withSession(
  dependencies: ServerHostDependencies,
  input: ServerRequest,
  principal: Principal,
  route: PrivateRoute,
  interactions: ServerInteractions,
): Promise<ServerResult> {
  let fromSeq: number | undefined;
  if (route.purpose === 'events_connect') {
    // Durable task/compaction evidence, cursors/timestamps and direct rotation now exist.
    // Canonical still needs faithful consumer mappings plus supported aggregate queue,
    // rotation/reset and transient replay contracts. Omitting a boundary is not parity.
    const format = input.url.searchParams.get('format');
    if (format !== null && format !== 'direct' && format !== 'agent-wire-v2' && format !== DIRECT_WIRE_V2)
      return publicError(400, 'validation_error', 'event format is invalid');
    const rawFormat = input.request.headers['x-term2-event-format'];
    if (rawFormat !== undefined && typeof rawFormat !== 'string')
      return publicError(400, 'validation_error', 'event format header is invalid');
    if (rawFormat !== undefined && rawFormat !== 'agent-wire-v2' && rawFormat !== DIRECT_WIRE_V2)
      return publicError(400, 'validation_error', 'event format header is invalid');
    if (rawFormat !== undefined && rawFormat !== format)
      return publicError(400, 'protocol_conflict', 'event format negotiation does not match');
    if (format === 'agent-wire-v2' && !AGENT_WIRE_V2_RUNTIME_AVAILABLE)
      return publicError(
        503,
        'agent_wire_v2_unavailable',
        'agent-wire-v2 requires the shared v2 artifact and combined consumer migration',
        true,
        {
          reloadRequired: true,
          requiredFormat: 'agent-wire-v2',
          requiredDependencies: ['shared-wire-v2-artifact', 'browser-v2-migration'],
        },
      );
    const query = input.url.searchParams.get('after');
    const raw = input.request.headers['last-event-id'];
    const header = typeof raw === 'string' ? raw : null;
    if (raw !== undefined && typeof raw !== 'string')
      return publicError(400, 'cursor_invalid', 'event cursor is invalid');
    if (query !== null && header !== null && query !== header)
      return publicError(400, 'protocol_conflict', 'event cursors do not match');
    const cursor = validate.parseEventCursor(query ?? header);
    if (cursor.error) return publicError(400, cursor.error, 'event cursor is invalid');
    fromSeq = cursor.value ?? undefined;
    if (format === null)
      return publicError(
        400,
        'protocol_upgrade_required',
        'Upgrade the browser and BFF together and request events with format=agent-wire-v2; unqualified events are not supported',
        false,
        { requiredFormat: 'agent-wire-v2' },
      );
  }
  const connection =
    fromSeq === undefined
      ? await dependencies.host.connect(principal, input.claims.sessionId!)
      : await dependencies.host.connect(principal, input.claims.sessionId!, fromSeq);
  let transferred = false;
  try {
    if (route.purpose === 'events_connect') {
      const requested = input.url.searchParams.get('format');
      const result =
        requested === 'agent-wire-v2'
          ? agentWireV2EventStream(connection, (event) => encodeAgentWireV2(event, interactions))
          : requested === DIRECT_WIRE_V2
          ? directWireV2EventStream(connection, interactions) ?? unavailable('direct-wire-v2 publication batches')
          : directEventStream(connection);
      transferred = true;
      return result;
    }
    if (!connection.snapshot) return unavailable('session snapshot');
    interactions.observe(connection.snapshot);
    return await handleSessionRoute(
      route,
      { ...input, principal, connection: connection as DirectConnection, interactionId: route.interactionId },
      dependencies,
      interactions,
    );
  } finally {
    if (!transferred) connection.close();
  }
}

type ListCursor = { ownerUserId: string; updatedAt: string; id: string };
/** The host list has no limit parameter. Walk its pages, project real direct metadata, and paginate
 * the HTTP view in the gateway's updatedAt-desc/id-asc order. The cursor is data, not server state.
 */
async function listSessions(
  dependencies: ServerHostDependencies,
  input: ServerRequest,
  principal: Principal,
): Promise<ServerResult> {
  if (dependencies.sessionIndex) {
    const requestedLimit = validate.parseQueryLimit(input.url.searchParams.get('limit')) ?? 20;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const cursor = input.url.searchParams.get('cursor') ?? undefined;
    const workspaceId = input.url.searchParams.get('workspaceId') ?? undefined;
    if (workspaceId !== undefined && !validate.isOpaqueId(workspaceId)) {
      return publicError(400, 'validation_error', 'workspace filter is invalid');
    }
    const page = await dependencies.sessionIndex.list(principal, {
      limit,
      ...(cursor ? { cursor } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    });
    return { status: 200, body: page };
  }
  const presentation = dependencies.presentation;
  if (!presentation) return unavailable('direct session list metadata');
  const requestedLimit = validate.parseQueryLimit(input.url.searchParams.get('limit')) ?? 20;
  const limit = Math.max(1, Math.min(50, requestedLimit));
  const requestedCursor = input.url.searchParams.get('cursor');
  const after = requestedCursor ? decodeListCursor(requestedCursor, principal.userId) : undefined;
  const items: ReturnType<typeof sessionListItem>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await dependencies.host.listSessions(principal, cursor);
    for (const session of page.sessions) {
      let connection: DirectConnection | undefined;
      try {
        connection = await dependencies.host.connect(principal, session.id);
        if (connection.snapshot.seq === null)
          return publicError(
            503,
            'projection_unavailable',
            'gateway session list requires a durable Session cursor',
            true,
          );
        const metadata = await presentation.metadata(principal, connection.snapshot);
        items.push(sessionListItem(connection.snapshot, metadata));
      } finally {
        connection?.close();
      }
    }
    cursor = page.cursor;
    if (cursor && seen.has(cursor)) return unavailable('consistent direct session pagination');
    if (cursor) seen.add(cursor);
  } while (cursor);
  items.sort((a, b) =>
    a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const remaining = after
    ? items.filter(
        (item) => item.updatedAt < after.updatedAt || (item.updatedAt === after.updatedAt && item.id > after.id),
      )
    : items;
  const sessions = remaining.slice(0, limit);
  const last = sessions[sessions.length - 1];
  const nextCursor =
    remaining.length > limit && last
      ? Buffer.from(
          JSON.stringify({
            ownerUserId: principal.userId,
            updatedAt: last.updatedAt,
            id: last.id,
          }),
        ).toString('base64url')
      : null;
  return { status: 200, body: { sessions, nextCursor } };
}
function decodeListCursor(cursor: string, owner: string): ListCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ListCursor | null;
    if (!value || value.ownerUserId !== owner || typeof value.updatedAt !== 'string' || !validate.isOpaqueId(value.id))
      throw new Error();
    return value;
  } catch {
    throw new ServerHttpError(400, 'invalid_cursor', 'session cursor is invalid');
  }
}
