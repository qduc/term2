/** Logical history and physical cache identity for one Codex WebSocket request. */
import { randomUUID } from 'node:crypto';
import type { SessionTrafficContext } from '../../../shared/service-interfaces.js';
import type { StreamedModelTurnRequest } from '../../streamed-model-turn.js';

export type CodexWebSocketIdentity = {
  sessionId: string;
  threadId: string;
  turnId: string;
  windowId: string;
  turnMetadata: string;
  clientMetadata: Record<string, string>;
  headers: Record<string, string>;
};

export function buildCodexWebSocketIdentity({
  installationId,
  sessionContext,
  requestId,
  request,
  turnIds,
}: {
  installationId: unknown;
  sessionContext: SessionTrafficContext | null | undefined;
  requestId: string;
  request: Pick<StreamedModelTurnRequest, 'codex' | 'previousResponseId'>;
  turnIds: Map<string, string>;
}): CodexWebSocketIdentity | undefined {
  if (typeof installationId !== 'string' || installationId.length === 0) {
    return undefined;
  }

  const logicalSessionId = sessionContext?.providerHistoryKey ?? sessionContext?.sessionId ?? requestId;
  // A nested run must not reuse a sibling's socket: chained responses may
  // be rejected when their IDs are continued on a different connection.
  // Root rollovers still retain their physical cache affinity.
  const cacheAffinity = request.codex?.promptCacheKey ?? sessionContext?.promptCacheKey ?? logicalSessionId;
  const transportSessionId =
    sessionContext?.providerRoutingKey ??
    (sessionContext?.providerHistoryKey &&
    sessionContext.providerHistoryKey !== sessionContext.sessionId &&
    !sessionContext.rootContextCompaction
      ? logicalSessionId
      : cacheAffinity);
  const threadId = logicalSessionId;
  const hasPreviousResponseId =
    typeof request?.previousResponseId === 'string' && request.previousResponseId.length > 0;
  const turnId = hasPreviousResponseId ? turnIds.get(logicalSessionId) ?? randomUUID() : randomUUID();
  turnIds.set(logicalSessionId, turnId);
  const windowId = `${threadId}:1`;
  const turnMetadata = JSON.stringify({
    installation_id: installationId,
    session_id: logicalSessionId,
    thread_id: threadId,
    turn_id: turnId,
    window_id: windowId,
    request_kind: 'turn',
  });

  return {
    sessionId: logicalSessionId,
    threadId,
    turnId,
    windowId,
    turnMetadata,
    clientMetadata: {
      'x-codex-installation-id': installationId,
      session_id: logicalSessionId,
      thread_id: threadId,
      'x-codex-window-id': windowId,
      turn_id: turnId,
      'x-codex-turn-metadata': turnMetadata,
    },
    headers: {
      'x-client-request-id': transportSessionId,
      'session-id': transportSessionId,
      'thread-id': transportSessionId,
      'x-codex-window-id': transportSessionId + ':1',
      'x-codex-turn-metadata': turnMetadata,
    },
  };
}
