import crypto from 'node:crypto';
import { createGatewayAssertion } from './assertion.js';
import { GatewayLifecycle } from './lifecycle.js';
import {
  loadGatewayManifest,
  WorkspaceAdmission,
  WorkspaceAdmissionError,
  type WorkspaceBoundaryProbe,
} from './workspace-admission.js';
import {
  assertProviderBrokerReady,
  composeGatewaySession,
  type GatewaySessionCompositionOptions,
  type WorkerBoundaryProbe,
} from './worker-boundary.js';
import type {
  GatewayAssertionClaims,
  GatewayManifest,
  GatewaySafeLogMetadata,
  ProviderBrokerCapability,
  SessionBinding,
} from './contracts.js';
import { createSafeLogMetadata, GatewayAuditLog } from './safe-log.js';
import { AssertionVerifier } from './assertion.js';
import { SqliteReplayLedger } from './replay-ledger.js';
import { GatewayServer } from './server.js';
import type { RuntimeFactory } from './runtime-factory.js';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import { FROZEN_AGENT_EVENT_TYPES, GatewayPersistenceError } from './persistence/contracts.js';
import {
  createSessionProjectionSource,
  type PendingInteractionDto,
  type SessionProjectionSource,
} from './persistence/projection.js';
import {
  decideInteraction,
  InteractionProtocolError,
  projectPendingInteraction,
  validatePendingInteractionDto,
  type PendingInteractionDto as InteractionDto,
} from './interaction-protocol.js';
import { GatewayAdmissionPersistence } from './persistence/admission-persistence.js';
import {
  GATEWAY_EVENT_HEARTBEAT_INTERVAL_MS,
  GATEWAY_EVENT_STREAM_CONTENT_TYPE,
  GATEWAY_EVENT_STREAM_HEARTBEAT,
  type GatewayRpcResult,
} from './server.js';
import { ServerSession } from './server-session.js';
import type { GatewayPersistenceCoordinator, GatewayPersistedSession } from './persistence/coordinator.js';
import { ServerSessionError } from './server-session.js';

const MAX_BUFFERED_SSE_EVENTS = 256;
const NONCRITICAL_RUNTIME_EVENT_TYPES = new Set<ConversationEvent['type']>(['text_delta', 'reasoning_delta']);

const isCriticalRuntimeEvent = (event: ConversationEvent): boolean => !NONCRITICAL_RUNTIME_EVENT_TYPES.has(event.type);

const INTERACTION_METRICS = [
  'interaction_presented',
  'interaction_updated',
  'interaction_resolved',
  'interaction_stale',
  'interaction_duplicate',
  'interaction_sanitization_rejected',
  'interaction_continuation_failed',
] as const;
type InteractionMetric = (typeof INTERACTION_METRICS)[number];
const PUBLIC_EVENT_PAYLOAD_KEYS = new Set([
  'turnId',
  'clientRequestId',
  'messageId',
  'delta',
  'callId',
  'toolName',
  'message',
  'interaction',
  'interactionId',
  'outcome',
  'reason',
  'variant',
  'revision',
  'text',
  'usage',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'version',
  'kind',
  'descriptor',
  'choices',
  'askUser',
  'questions',
  'answers',
  'currentQuestionIndex',
  'index',
  'question',
  'options',
  'multiSelect',
  'label',
  'description',
  'destructive',
  'id',
  'role',
  'agentName',
  'argumentsText',
  'checkIn',
  'display',
  'target',
  'scope',
  'warning',
  'displayPath',
  'displayParent',
  'sensitive',
  'llmAdvisory',
  'reasoning',
  'approved',
  'model',
  'riskLevel',
  'deniedRead',
  'runBudgetEvidence',
]);

export type GatewayLaunchConfig = {
  enabled: boolean;
  socketPath: string;
  manifestPath: string;
  manifestSha256?: string;
  replayDbPath: string;
  issuer: string;
  audience: string;
  publicKeys: ReadonlyMap<string, string | Buffer> | Record<string, string | Buffer>;
  providerBroker?: ProviderBrokerCapability;
  providerProbe?: WorkerBoundaryProbe;
  workerSandboxAvailable?: boolean;
  workspaceBoundaryProbe?: WorkspaceBoundaryProbe;
  tmpDir?: string;
  sshEnabled?: boolean;
  allowWrite?: boolean;
  autoApprove?: boolean;
  allowUnsandboxed?: boolean;
  auditWriter?: (record: GatewaySafeLogMetadata) => Promise<void>;
  /** Required for production admission; retained optional for legacy control-plane fixtures. */
  runtimeFactory?: RuntimeFactory;
  /** Optional plan-03 durable index/log/journal owner. */
  persistence?: GatewayPersistenceCoordinator;
};

export class GatewayStartupError extends Error {
  constructor() {
    super('gateway prerequisites unavailable');
    this.name = 'GatewayStartupError';
  }
}

export function assertGatewayStartup(config: GatewayLaunchConfig, manifest?: GatewayManifest): GatewayManifest {
  if (!config.socketPath.startsWith('/') || !config.issuer || !config.audience || !config.replayDbPath)
    throw new GatewayStartupError();
  if (
    !config.publicKeys ||
    (config.publicKeys instanceof Map ? config.publicKeys.size === 0 : Object.keys(config.publicKeys).length === 0)
  )
    throw new GatewayStartupError();
  if (!manifest) throw new GatewayStartupError();
  if (!config.manifestSha256 || !/^[a-f0-9]{64}$/i.test(config.manifestSha256)) throw new GatewayStartupError();
  if (!config.providerBroker || !config.providerProbe?.available || !config.providerProbe.secretFree)
    throw new GatewayStartupError();
  if (config.workerSandboxAvailable !== true || typeof config.workspaceBoundaryProbe !== 'function')
    throw new GatewayStartupError();
  if (config.sshEnabled || config.autoApprove || config.allowUnsandboxed) throw new GatewayStartupError();
  if (typeof config.auditWriter !== 'function') throw new GatewayStartupError();
  assertProviderBrokerReady(config.providerBroker, config.providerProbe);
  if (!config.tmpDir?.startsWith('/')) throw new GatewayStartupError();
  return manifest;
}

/** Gateway control plane. Runtime/session protocols remain private RPC consumers. */
export class Term2Gateway {
  readonly #config: GatewayLaunchConfig;
  readonly #manifest: GatewayManifest;
  readonly #replay: SqliteReplayLedger;
  readonly #admission: WorkspaceAdmission;
  readonly #verifier: AssertionVerifier;
  readonly #lifecycle = new GatewayLifecycle();
  readonly #audit: GatewayAuditLog;
  readonly #sessions = new Map<string, ReturnType<typeof composeGatewaySession> | ServerSession>();
  readonly #persisted = new Map<string, GatewayPersistedSession>();
  readonly #admissions: GatewayAdmissionPersistence | null;
  readonly #interactionBindings = new Map<string, InteractionBinding>();
  readonly #interactionCounters = new Map<InteractionMetric, number>();
  readonly #eventPersistenceTails = new Map<string, Promise<void>>();
  #shutdownInProgress = false;
  readonly #server: GatewayServer;

  private constructor(config: GatewayLaunchConfig, manifest: GatewayManifest) {
    this.#config = config;
    this.#manifest = manifest;
    this.#replay = new SqliteReplayLedger(config.replayDbPath);
    this.#admission = new WorkspaceAdmission(manifest, {
      allowWrite: config.allowWrite === true,
      boundaryProbe: config.workspaceBoundaryProbe,
    });
    this.#verifier = new AssertionVerifier({
      issuer: config.issuer,
      audience: config.audience,
      publicKeys: config.publicKeys,
      replayLedger: this.#replay,
    });
    this.#audit = new GatewayAuditLog(config.auditWriter!);
    this.#admissions = config.persistence ? new GatewayAdmissionPersistence(config.persistence.index) : null;
    this.#server = new GatewayServer({
      socketPath: config.socketPath,
      verifier: this.#verifier,
      lifecycle: this.#lifecycle,
      handler: (input) => this.#handleRpc(input),
    });
  }

  async #handleRpc(input: {
    claims: GatewayAssertionClaims;
    body: unknown;
    request: import('node:http').IncomingMessage;
    url: URL;
    correlationId?: string;
  }): Promise<GatewayRpcResult> {
    const { claims, url } = input;
    const route = matchPrivateRoute(input.request.method ?? 'GET', url.pathname);
    if (!route || (route.legacy && claims.purpose !== 'session_create')) {
      return publicError(404, 'not_found', 'gateway route not found');
    }
    if (!route.legacy && route.sessionId && route.sessionId !== claims.sessionId)
      return publicError(400, 'protocol_conflict', 'gateway path and assertion session do not match');
    if (!route.legacy && route.purpose !== claims.purpose)
      return publicError(400, 'protocol_conflict', 'gateway purpose does not match route');
    try {
      if (claims.purpose === 'workspace_list') {
        await this.#audit.write(
          createSafeLogMetadata({
            operation: 'workspace_list',
            outcome: 'allowed',
            reasonCode: 'accepted',
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }),
        );
        const limit = parseQueryLimit(url.searchParams.get('limit')) ?? 20;
        if (limit < 1 || limit > 50 || url.searchParams.get('cursor') !== null)
          return publicError(400, 'invalid_cursor', 'workspace cursor is invalid');
        return {
          status: 200,
          body: { workspaces: this.#admission.listAliases(claims.sub).slice(0, limit), nextCursor: null },
        };
      }
      if (claims.purpose === 'session_create') {
        if (hasDeferredModelSelectionField(input.body))
          return publicError(422, 'model_selection_deferred', 'Model selection is not available');
        if (!isSessionCreateBody(input.body, claims.workspaceId, route.legacy))
          return publicError(400, 'validation_error', 'session request is invalid');
        const session = await this.createSession(claims, undefined, input.correlationId);
        if (this.#config.persistence) {
          const projection = await this.#projectionFor(claims.sub, session.sessionId);
          return { status: 201, body: { session: toSessionProjection(projection) } };
        }
        return {
          status: 201,
          body: { sessionId: session.sessionId, workspaceId: session.binding.workspaceId, accepted: true },
        };
      }
      if (claims.purpose === 'session_list') {
        if (!this.#config.persistence)
          return publicError(503, 'gateway_unavailable', 'gateway persistence unavailable', true);
        const limit = parseQueryLimit(url.searchParams.get('limit'));
        const cursor = url.searchParams.get('cursor') ?? undefined;
        try {
          return { status: 200, body: this.#config.persistence.index.list(claims.sub, { limit, cursor }) };
        } catch (error) {
          if (error instanceof GatewayPersistenceError && error.code === 'cursor_invalid')
            return publicError(400, 'invalid_cursor', 'session cursor is invalid');
          throw error;
        }
      }
      if (!claims.sessionId) return publicError(400, 'protocol_conflict', 'session assertion is incomplete');
      if (claims.purpose === 'session_read') {
        const projection = await this.#projectionFor(claims.sub, claims.sessionId);
        return { status: 200, body: { session: toSessionProjection(projection) } };
      }
      if (claims.purpose === 'message_submit') return await this.#submitMessage(claims, input.body);
      if (claims.purpose === 'abort') return await this.#abortSession(claims, input.body);
      if (claims.purpose === 'interaction_resolve')
        return await this.#resolveInteraction(claims, route.interactionId!, input.body);
      if (claims.purpose === 'events_connect') return await this.#eventsResponse(claims, url, input.request);
      return publicError(403, 'gateway_unavailable', 'gateway operation is unavailable');
    } catch (error) {
      return this.#mapError(error);
    }
  }

  #interactionBindingFor(
    sessionId: string,
    snapshot: { interactionId: number; approval: unknown },
    turnId: string,
  ): InteractionBinding {
    const current = this.#interactionBindings.get(sessionId);
    if (current && current.expectedInteractionId === snapshot.interactionId) return current;
    const publicInteractionId = crypto.randomUUID();
    const dto = projectPendingInteraction(snapshot.approval as Record<string, unknown>, publicInteractionId, 1);
    const binding: InteractionBinding = {
      publicInteractionId,
      expectedInteractionId: snapshot.interactionId,
      continuationGeneration: crypto.randomUUID(),
      revision: 1,
      turnId,
      variant: dto.variant,
      dto,
    };
    this.#interactionBindings.set(sessionId, binding);
    this.#countInteraction('interaction_presented');
    return binding;
  }

  #countInteraction(metric: InteractionMetric): void {
    this.#interactionCounters.set(metric, (this.#interactionCounters.get(metric) ?? 0) + 1);
  }

  async #ensurePersistedSession(ownerUserId: string, sessionId: string): Promise<GatewayPersistedSession> {
    const existing = this.#persisted.get(sessionId);
    if (existing) {
      if (existing.record.ownerUserId !== ownerUserId) throw new GatewayPersistenceError('owner_mismatch');
      return existing;
    }
    const persistence = this.#config.persistence;
    if (!persistence) throw new GatewayPersistenceError('not_found', 'session not found');
    const record = persistence.index.getForOwner(ownerUserId, sessionId);
    const grantVersion = Number(record.grantVersion);
    if (!Number.isSafeInteger(grantVersion))
      throw new GatewayPersistenceError('readonly', 'session grant version is invalid');
    let binding: SessionBinding;
    try {
      binding = this.#admission.restore(sessionId, ownerUserId, record.workspaceId, grantVersion);
    } catch {
      throw new GatewayPersistenceError('not_found', 'session not found');
    }
    try {
      const reopened = await persistence.open(binding);
      this.#persisted.set(sessionId, reopened);
      return reopened;
    } catch (error) {
      this.#admission.remove(sessionId);
      throw error;
    }
  }

  async #projectionFor(ownerUserId: string, sessionId: string): Promise<SessionProjectionSource> {
    const persistence = this.#config.persistence;
    const persisted = await this.#ensurePersistedSession(ownerUserId, sessionId);
    if (!persistence) throw new GatewayPersistenceError('not_found', 'session not found');
    return await createSessionProjectionSource({
      index: persistence.index,
      layout: persistence.layout,
      ownerUserId,
      sessionId,
      journal: persisted.persistence.journal,
      liveInteraction: () => {
        const session = this.#sessions.get(sessionId);
        if (!(session instanceof ServerSession)) return null;
        const snapshot = session.service.getPendingInteractionSnapshot();
        if (!snapshot) return null;
        if (!session.activeTurnId) return null;
        const binding = this.#interactionBindingFor(sessionId, snapshot, session.activeTurnId);
        return Promise.resolve({
          state: 'pending' as const,
          interaction: interactionDtoFromSnapshot(snapshot, binding.publicInteractionId, binding.revision),
          turnId: binding.turnId,
        });
      },
    });
  }

  async #submitMessage(claims: GatewayAssertionClaims, body: unknown): Promise<GatewayRpcResult> {
    if (hasAttachments(body)) return publicError(422, 'attachments_not_enabled', 'Attachments are not available');
    if (!this.#admissions || !this.#config.persistence)
      return publicError(503, 'persistence_unavailable', 'gateway persistence unavailable', true);
    if (!isMessageBody(body)) return publicError(400, 'validation_error', 'message request is invalid');
    const session = this.#sessions.get(claims.sessionId!);
    const persisted = this.#persisted.get(claims.sessionId!);
    if (!(session instanceof ServerSession) || !persisted)
      return publicError(409, 'session_not_admitting', 'session is not admitting messages');
    const turnId = crypto.randomUUID();
    try {
      const result = await this.#admissions.admit({
        ownerUserId: claims.sub,
        sessionId: claims.sessionId!,
        clientRequestId: body.clientRequestId,
        body,
        turnId,
        runtime: session,
        persistence: persisted.persistence.critical,
        term2Fact: { type: 'user_message', message: { id: turnId, sender: 'user', text: body.text } },
        acceptedEvent: {
          sessionId: claims.sessionId!,
          type: 'user_message_accepted',
          payload: { turnId, clientRequestId: body.clientRequestId, messageId: turnId },
        },
        beforeCommit: () =>
          this.#enqueueEventPersistence(claims.sessionId!, async () => {
            await persisted.persistence.critical.appendJournalCritical({
              sessionId: claims.sessionId!,
              type: 'assistant_started',
              payload: { turnId },
            });
          }),
      });
      if (result.kind === 'rejected') {
        return result.reason === 'queue_full'
          ? publicError(429, 'queue_full', 'message queue is full', true)
          : publicError(409, 'session_not_admitting', 'session is not admitting messages');
      }
      return {
        status: 202,
        body: {
          sessionId: claims.sessionId,
          clientRequestId: body.clientRequestId,
          turnId: result.record.turnId,
          accepted: true,
          replayed: result.replayed,
        },
      };
    } catch (error) {
      return this.#mapError(error);
    }
  }

  async #abortSession(claims: GatewayAssertionClaims, body: unknown): Promise<GatewayRpcResult> {
    if (!isTurnBody(body)) return publicError(400, 'validation_error', 'abort request is invalid');
    const session = this.#sessions.get(claims.sessionId!);
    if (!(session instanceof ServerSession))
      return publicError(409, 'session_not_admitting', 'session is not admitting');
    const outcome = await session.abort(body.turnId);
    if (outcome.kind === 'aborted') {
      const persisted = this.#persisted.get(claims.sessionId!);
      if (persisted) {
        await this.#enqueueEventPersistence(claims.sessionId!, async () => {
          const admissions = this.#config.persistence?.index.listAdmissions(claims.sub, claims.sessionId!) ?? [];
          for (const discardedTurnId of outcome.discardedTurnIds) {
            const admission = admissions.find((candidate) => candidate.turnId === discardedTurnId);
            await persisted.persistence.journal.append(
              {
                sessionId: claims.sessionId!,
                type: 'user_message_rejected',
                payload: {
                  turnId: discardedTurnId,
                  ...(admission ? { clientRequestId: admission.clientRequestId } : {}),
                  reason: 'queue_discarded',
                },
              },
              { durability: 'critical' },
            );
            if (admission) {
              this.#config.persistence?.index.updateAdmission(
                claims.sub,
                claims.sessionId!,
                admission.clientRequestId,
                {
                  state: 'rejected',
                  result: 'queue_discarded',
                },
              );
            }
          }
          await persisted.persistence.journal.append(
            {
              sessionId: claims.sessionId!,
              type: 'turn_aborted',
              payload: { turnId: body.turnId, outcome: 'aborted' },
            },
            { durability: 'critical' },
          );
        });
      }
      return { status: 202, body: { sessionId: claims.sessionId!, turnId: body.turnId, accepted: true } };
    }
    if (outcome.kind === 'already_settled' || outcome.kind === 'no_op')
      return {
        status: 200,
        body: { sessionId: claims.sessionId, turnId: body.turnId, accepted: false, alreadySettled: true },
      };
    return publicError(409, 'session_not_admitting', 'session is interrupted');
  }

  async #resolveInteraction(
    claims: GatewayAssertionClaims,
    interactionId: string,
    body: unknown,
  ): Promise<GatewayRpcResult> {
    if (!isInteractionResolveRequest(body))
      return publicError(400, 'validation_error', 'interaction request is invalid');
    const projection = await this.#projectionFor(claims.sub, claims.sessionId!);
    if (projection.interaction?.state === 'recovered')
      return publicError(409, 'interaction_not_resolvable', 'interaction is not resolvable');
    const session = this.#sessions.get(claims.sessionId!);
    if (!(session instanceof ServerSession)) return publicError(404, 'not_found', 'session not found');
    const binding = this.#interactionBindings.get(claims.sessionId!);
    if (projection.resolvedInteractionIds.has(interactionId)) {
      this.#countInteraction('interaction_duplicate');
      return publicError(409, 'interaction_already_resolved', 'interaction is already resolved');
    }
    if (!binding || binding.publicInteractionId !== interactionId) {
      this.#countInteraction('interaction_stale');
      return publicError(409, 'stale_interaction', 'interaction is stale');
    }
    const snapshot = session.service.getPendingInteractionSnapshot();
    const resolutionCode = classifyInteractionResolution(projection.interaction, snapshot !== null);
    if (resolutionCode) {
      this.#countInteraction(
        resolutionCode === 'interaction_already_resolved' ? 'interaction_duplicate' : 'interaction_stale',
      );
      return publicError(
        409,
        resolutionCode,
        resolutionCode === 'interaction_not_resolvable'
          ? 'interaction is not resolvable'
          : 'interaction is already resolved',
      );
    }
    if (!snapshot) {
      this.#countInteraction('interaction_duplicate');
      return publicError(409, 'interaction_already_resolved', 'interaction is already resolved');
    }
    if (body.revision !== binding.revision) {
      this.#countInteraction('interaction_stale');
      return publicError(409, 'stale_interaction', 'interaction revision is stale');
    }
    const continuationAbortGeneration = session.abortGeneration;
    let decision: ReturnType<typeof decideInteraction>;
    try {
      decision = decideInteraction(binding.dto, body);
    } catch (error) {
      if (error instanceof InteractionProtocolError) {
        this.#countInteraction('interaction_sanitization_rejected');
        return publicError(400, 'validation_error', 'interaction decision is invalid');
      }
      throw error;
    }
    try {
      const result = session.resolvePendingInteraction({
        expectedInteractionId: binding.expectedInteractionId,
        answer: decision.answer,
        rejectionReason: decision.rejectionReason,
        approvalAnswer: decision.approvalAnswer,
      });
      if (result.kind === 'awaiting_next_question') {
        binding.revision += 1;
        binding.dto = projectPendingInteraction(
          result.snapshot.approval as unknown as Record<string, unknown>,
          binding.publicInteractionId,
          binding.revision,
          result.snapshot.askUserAnswers,
          result.snapshot.currentAskUserQuestionIndex,
        );
        await this.#enqueueEventPersistence(claims.sessionId!, async () => {
          const persisted = this.#persisted.get(claims.sessionId!);
          if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
          persisted.persistence.interactionCheckpoint.save({
            turnId: binding.turnId,
            interaction: binding.dto,
            revision: binding.revision,
            generation: binding.continuationGeneration,
          });
          await persisted.persistence.journal.append(
            {
              sessionId: claims.sessionId!,
              type: 'interaction_updated',
              payload: { turnId: binding.turnId, interaction: binding.dto },
            },
            { durability: 'critical' },
          );
        });
        this.#countInteraction('interaction_updated');
        return { status: 200, body: { accepted: false, interaction: binding.dto } };
      }
      if (result.kind === 'none')
        return publicError(409, 'interaction_already_resolved', 'interaction is already resolved');
      if (result.kind === 'stale_interaction') return publicError(409, 'stale_interaction', 'interaction is stale');
      await this.#enqueueEventPersistence(claims.sessionId!, async () => {
        const persisted = this.#persisted.get(claims.sessionId!);
        if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
        await persisted.persistence.journal.append(
          {
            sessionId: claims.sessionId!,
            type: 'interaction_resolved',
            payload: {
              turnId: binding.turnId,
              interactionId: binding.publicInteractionId,
              outcome: decision.outcome,
              variant: binding.variant,
            },
          },
          { durability: 'critical' },
        );
        persisted.persistence.interactionCheckpoint.clear();
      });
      this.#interactionBindings.delete(claims.sessionId!);
      this.#countInteraction('interaction_resolved');
      try {
        if (session.abortGeneration !== continuationAbortGeneration || session.activeTurnId !== binding.turnId) {
          throw new ServerSessionError('interrupted');
        }
        await session.service.handleApprovalDecision(decision.answer, decision.rejectionReason, {
          approvalAnswer: decision.approvalAnswer,
        });
      } catch (error) {
        this.#countInteraction('interaction_continuation_failed');
        await this.#recordContinuationFailure(claims.sessionId!, binding);
        throw error;
      }
      return {
        status: 202,
        body: {
          sessionId: claims.sessionId!,
          turnId: binding.turnId,
          interactionId: binding.publicInteractionId,
          accepted: true,
        },
      };
    } catch (error) {
      if (error instanceof ServerSessionError && error.code === 'stale_interaction')
        return publicError(409, 'stale_interaction', 'interaction is stale');
      throw error;
    }
  }

  async #eventsResponse(
    claims: GatewayAssertionClaims,
    url: URL,
    request: import('node:http').IncomingMessage,
  ): Promise<GatewayRpcResult> {
    const queryCursor = url.searchParams.get('after');
    const headerCursor = typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null;
    if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor)
      return publicError(400, 'protocol_conflict', 'event cursors do not match');
    const after = parseEventCursor(queryCursor ?? headerCursor);
    if (after.error) return publicError(400, after.error, 'event cursor is invalid');
    const source = await this.#projectionFor(claims.sub, claims.sessionId!);
    let activeResponse: import('node:http').ServerResponse | null = null;
    let closed = false;
    let buffered: import('./persistence/contracts.js').AgentEventEnvelope[] = [];
    let unsubscribe: () => void = () => undefined;
    const closeSlowSubscriber = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      if (activeResponse && !activeResponse.writableEnded) activeResponse.destroy();
    };
    const writeEvent = (
      response: import('node:http').ServerResponse,
      event: import('./persistence/contracts.js').AgentEventEnvelope,
    ): void => {
      if (!isPublicEventEnvelope(event)) return closeSlowSubscriber();
      const accepted = response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      if (!accepted) closeSlowSubscriber();
    };
    const live = source.subscribeFrom(after.value, (event) => {
      if (closed) return;
      if (!activeResponse) {
        if (buffered.length >= MAX_BUFFERED_SSE_EVENTS) return closeSlowSubscriber();
        buffered.push(event);
        return;
      }
      writeEvent(activeResponse, event);
    });
    if (live.kind === 'reload_required') {
      const status = live.reason === 'cursor_compacted' ? 410 : 503;
      const code = live.reason === 'cursor_compacted' ? 'cursor_compacted' : 'gateway_unavailable';
      return publicError(status, code, 'event replay requires a session reload', true, {
        reloadRequired: true,
        session: toSessionProjection(source),
        latestSequence: live.latestSequence,
      });
    }
    unsubscribe = live.unsubscribe;
    if (live.replay.some((event) => !isPublicEventEnvelope(event))) {
      live.unsubscribe();
      return publicError(503, 'gateway_unavailable', 'event stream is unavailable', true);
    }
    return {
      status: 200,
      body: null,
      headers: {
        'content-type': GATEWAY_EVENT_STREAM_CONTENT_TYPE,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
      stream: {
        start: async (response: import('node:http').ServerResponse, request: import('node:http').IncomingMessage) => {
          activeResponse = response;
          for (const event of live.replay) {
            if (closed) break;
            writeEvent(response, event);
          }
          const queued = buffered;
          buffered = [];
          for (const event of queued) {
            if (closed) break;
            writeEvent(response, event);
          }
          const heartbeat = setInterval(() => {
            if (!response.writableEnded) {
              const accepted = response.write(`${GATEWAY_EVENT_STREAM_HEARTBEAT} ${new Date().toISOString()}\n\n`);
              if (!accepted) closeSlowSubscriber();
            }
          }, GATEWAY_EVENT_HEARTBEAT_INTERVAL_MS);
          heartbeat.unref?.();
          await new Promise<void>((resolve) => {
            const close = () => {
              clearInterval(heartbeat);
              unsubscribe();
              activeResponse = null;
              closed = true;
              resolve();
            };
            request.once('close', close);
            response.once('close', close);
          });
        },
      },
    };
  }

  async #recordContinuationFailure(sessionId: string, binding: InteractionBinding): Promise<void> {
    try {
      await this.#enqueueEventPersistence(sessionId, async () => {
        const persisted = this.#persisted.get(sessionId);
        if (!persisted) throw new GatewayPersistenceError('not_found', 'session persistence is unavailable');
        await persisted.persistence.journal.append(
          {
            sessionId,
            type: 'turn_failed',
            payload: { turnId: binding.turnId, outcome: 'failed', reason: 'interaction_continuation_failed' },
          },
          { durability: 'critical' },
        );
        persisted.persistence.interactionCheckpoint.clear();
      });
    } catch {
      // If the truthful terminal fact cannot be appended, retain a sanitized
      // checkpoint so restart recovery does not lose the interaction entirely.
      try {
        this.#persisted.get(sessionId)?.persistence.interactionCheckpoint.save({
          turnId: binding.turnId,
          interaction: binding.dto,
          revision: binding.revision,
          generation: binding.continuationGeneration,
        });
      } catch {
        // The gateway owns this persistence failure boundary; admission
        // remains fail-closed rather than fabricating a recovery fact.
      }
    }
  }

  #enqueueEventPersistence(sessionId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#eventPersistenceTails.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#eventPersistenceTails.set(sessionId, next);
    void next.then(
      () => {
        if (this.#eventPersistenceTails.get(sessionId) === next) this.#eventPersistenceTails.delete(sessionId);
      },
      () => {
        if (this.#eventPersistenceTails.get(sessionId) === next) this.#eventPersistenceTails.delete(sessionId);
      },
    );
    return next;
  }

  async #persistConversationEvent(
    sessionId: string,
    event: ConversationEvent,
    context: { readonly turnId?: string; readonly discardedTurnIds: readonly string[] },
  ): Promise<void> {
    return this.#enqueueEventPersistence(sessionId, async () => {
      const persisted = this.#persisted.get(sessionId);
      if (!persisted) return;
      const admissions = this.#config.persistence?.index.listAdmissions(persisted.record.ownerUserId, sessionId) ?? [];
      for (const discardedTurnId of new Set(context.discardedTurnIds)) {
        const admission = admissions.find((candidate) => candidate.turnId === discardedTurnId);
        await persisted.persistence.journal.append(
          {
            sessionId,
            type: 'user_message_rejected',
            payload: {
              turnId: discardedTurnId,
              ...(admission ? { clientRequestId: admission.clientRequestId } : {}),
              reason: 'queue_discarded',
            },
          },
          { durability: 'critical' },
        );
        if (admission)
          this.#config.persistence?.index.updateAdmission(
            persisted.record.ownerUserId,
            sessionId,
            admission.clientRequestId,
            { state: 'rejected', result: 'queue_discarded' },
          );
      }
      if (!context.turnId) return;
      const session = this.#sessions.get(sessionId);
      const snapshot = session instanceof ServerSession ? session.service.getPendingInteractionSnapshot() : null;
      const binding =
        event.type === 'approval_required' && snapshot
          ? this.#interactionBindingFor(sessionId, snapshot, context.turnId)
          : undefined;
      // An ask_user answer can advance the live binding before the original
      // awaitable approval sink reaches this queue. Do not republish that
      // old presentation as a second approval after interaction_updated.
      if (event.type === 'approval_required' && binding?.revision && binding.revision > 1) return;
      const mapped = mapConversationEvent(event, context.turnId, sessionId, binding, snapshot ?? undefined);
      if (!mapped) return;
      if ((mapped.type === 'approval_required' || mapped.type === 'interaction_updated') && binding) {
        persisted.persistence.interactionCheckpoint.save({
          turnId: binding.turnId,
          interaction: mapped.payload.interaction as PendingInteractionDto,
          revision: binding.revision,
          generation: binding.continuationGeneration,
        });
      }
      await persisted.persistence.journal.append(mapped, {
        durability: mapped.type === 'text_delta' || mapped.type === 'reasoning_delta' ? 'stream' : 'critical',
      });
    });
  }

  #mapError(error: unknown): GatewayRpcResult {
    if (error instanceof WorkspaceAdmissionError) {
      return publicError(
        error.code === 'workspace_session_exists' ? 409 : 403,
        error.code === 'workspace_session_exists' ? 'protocol_conflict' : 'workspace_forbidden',
        'workspace access denied',
      );
    }
    if (error instanceof GatewayPersistenceError) {
      if (error.code === 'not_found' || error.code === 'owner_mismatch')
        return publicError(404, 'not_found', 'session not found');
      if (error.code === 'cursor_invalid') return publicError(400, 'invalid_cursor', 'cursor is invalid');
      if (error.code === 'conflict')
        return publicError(409, 'idempotency_conflict', 'request conflicts with an existing admission');
      return publicError(503, 'persistence_unavailable', 'gateway persistence unavailable', true);
    }
    if (error instanceof ServerSessionError) {
      if (error.code === 'stale_interaction') return publicError(409, 'stale_interaction', 'interaction is stale');
      return publicError(409, 'session_not_admitting', 'session is not admitting');
    }
    return publicError(503, 'gateway_unavailable', 'gateway unavailable', true);
  }

  static create(config: GatewayLaunchConfig): Term2Gateway {
    let manifest: GatewayManifest;
    try {
      manifest = loadGatewayManifest(config.manifestPath, config.manifestSha256);
    } catch {
      throw new GatewayStartupError();
    }
    assertGatewayStartup(config, manifest);
    return new Term2Gateway(config, manifest);
  }

  get server(): GatewayServer {
    return this.#server;
  }
  get admission(): WorkspaceAdmission {
    return this.#admission;
  }
  get lifecycle(): GatewayLifecycle {
    return this.#lifecycle;
  }
  get manifestVersion(): number {
    return this.#manifest.version;
  }
  get interactionMetrics(): Readonly<Record<InteractionMetric, number>> {
    return Object.freeze(
      Object.fromEntries(
        INTERACTION_METRICS.map((metric) => [metric, this.#interactionCounters.get(metric) ?? 0]),
      ) as Record<InteractionMetric, number>,
    );
  }

  async start(): Promise<void> {
    if (!this.#config.enabled) return;
    // Prove the audit path before binding the socket; a non-awaitable or
    // failing writer must never leave a seemingly-ready gateway behind.
    await this.#audit.write(
      createSafeLogMetadata({ operation: 'startup', outcome: 'allowed', reasonCode: 'accepted' }),
    );
    await this.#server.start();
  }

  async createSession(
    claims: GatewayAssertionClaims,
    options?: Omit<GatewaySessionCompositionOptions, 'binding' | 'providerBroker' | 'providerProbe'>,
    correlationId?: string,
  ): Promise<ReturnType<typeof composeGatewaySession> | ServerSession> {
    this.#lifecycle.assertAccepting();
    if (!this.#config.enabled) throw new GatewayStartupError();
    const binding = this.#admission.admit(claims);
    if (this.#config.runtimeFactory) {
      let persisted: GatewayPersistedSession | undefined;
      try {
        persisted = await this.#config.persistence?.open(binding);
        const session = await this.#config.runtimeFactory.create(binding, {
          eventSink: (event, context) => {
            const persistence = this.#persistConversationEvent(binding.sessionId, event, context);
            if (isCriticalRuntimeEvent(event)) return persistence;
            // Streaming deltas remain observationally non-blocking, but their
            // persistence failure must be consumed so it cannot become an
            // unhandled rejection. A later critical event observes the
            // journal's failure latch and is awaited by the runtime.
            void persistence.catch(() => undefined);
            return undefined;
          },
        });
        if (persisted) {
          this.#persisted.set(binding.sessionId, persisted);
          session.addDisposeHook(async () => {
            await persisted!.persistence.close();
            this.#persisted.delete(binding.sessionId);
            this.#interactionBindings.delete(binding.sessionId);
            await this.#config.persistence?.close(
              binding.sessionId,
              this.#shutdownInProgress ? 'interrupted' : 'closed',
            );
          });
        }
        const release = this.#lifecycle.registerWorker({ close: () => session.dispose() });
        session.addDisposeHook(() => {
          release();
          this.#admission.remove(binding.sessionId);
          this.#sessions.delete(binding.sessionId);
          this.#persisted.delete(binding.sessionId);
          this.#interactionBindings.delete(binding.sessionId);
        });
        this.#sessions.set(binding.sessionId, session);
        await this.#audit.write(
          createSafeLogMetadata({
            operation: 'session_create',
            outcome: 'allowed',
            reasonCode: 'accepted',
            sessionId: binding.sessionId,
            workspaceId: binding.workspaceId,
            grantVersion: binding.grantVersion,
            access: binding.access,
            ...(correlationId ? { correlationId } : {}),
          }),
        );
        return session;
      } catch (error) {
        try {
          await persisted?.persistence.close();
          await this.#config.persistence?.close(binding.sessionId, 'interrupted');
        } catch {
          // Preserve the admission failure; persistence keeps its evidence.
        }
        this.#admission.remove(binding.sessionId);
        throw error;
      }
    }
    const providerProbe = this.#config.providerProbe;
    if (!providerProbe) throw new GatewayStartupError();
    const providerBroker = assertProviderBrokerReady(this.#config.providerBroker, providerProbe);
    const session = composeGatewaySession({
      binding,
      providerBroker,
      providerProbe,
      tmpDir: options?.tmpDir ?? this.#config.tmpDir!,
      env: options?.env,
      sandboxAvailable: options?.sandboxAvailable ?? this.#config.workerSandboxAvailable,
      createRuntime: options?.createRuntime,
    });
    const release = this.#lifecycle.registerWorker({ close: () => session.dispose() });
    const originalDispose = session.dispose;
    session.dispose = () => {
      release();
      originalDispose();
      this.#admission.remove(binding.sessionId);
      this.#sessions.delete(binding.sessionId);
    };
    this.#sessions.set(binding.sessionId, session);
    await this.#audit.write(
      createSafeLogMetadata({
        operation: 'session_create',
        outcome: 'allowed',
        reasonCode: 'accepted',
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        grantVersion: binding.grantVersion,
        access: binding.access,
        ...(correlationId ? { correlationId } : {}),
      }),
    );
    return session;
  }

  async shutdown(graceMs = 5_000): Promise<void> {
    this.#shutdownInProgress = true;
    await this.#server.shutdown(graceMs);
    await Promise.all([...this.#sessions.values()].map((session) => Promise.resolve(session.dispose())));
    this.#sessions.clear();
    this.#replay.close();
    await this.#audit.write(
      createSafeLogMetadata({ operation: 'shutdown', outcome: 'interrupted', reasonCode: 'shutdown' }),
    );
  }
}

type InteractionBinding = {
  publicInteractionId: string;
  expectedInteractionId: number;
  continuationGeneration: string;
  revision: number;
  turnId: string;
  variant: string;
  dto: InteractionDto;
};

type PrivateRoute = {
  purpose: GatewayAssertionClaims['purpose'];
  legacy?: boolean;
  sessionId?: string;
  interactionId?: string;
};

function matchPrivateRoute(method: string, pathname: string): PrivateRoute | null {
  if (method === 'POST' && pathname === '/') return { purpose: 'session_create', legacy: true };
  // GET is canonical for workspace_list; POST is a tested compatibility alias for the pinned BFF wire.
  if ((method === 'GET' || method === 'POST') && pathname === '/private/agent/v1/workspaces')
    return { purpose: 'workspace_list' };
  if (method === 'POST' && pathname === '/private/agent/v1/sessions') return { purpose: 'session_create' };
  if (method === 'GET' && pathname === '/private/agent/v1/sessions') return { purpose: 'session_list' };
  const match = pathname.match(
    /^\/private\/agent\/v1\/sessions\/([A-Za-z0-9_-]{1,256})(?:\/(messages|abort|events|interactions\/([A-Za-z0-9_-]{1,256})))?$/,
  );
  if (!match) return null;
  const sessionId = match[1]!;
  if (method === 'POST' && !match[2]) return { purpose: 'session_read', sessionId };
  if (method === 'POST' && match[2] === 'messages') return { purpose: 'message_submit', sessionId };
  if (method === 'POST' && match[2] === 'abort') return { purpose: 'abort', sessionId };
  if (method === 'GET' && match[2] === 'events') return { purpose: 'events_connect', sessionId };
  if (method === 'POST' && match[2]?.startsWith('interactions/'))
    return { purpose: 'interaction_resolve', sessionId, interactionId: match[3] };
  return null;
}

export function classifyInteractionResolution(
  interaction: SessionProjectionSource['interaction'],
  hasLiveSnapshot: boolean,
): 'interaction_not_resolvable' | 'interaction_already_resolved' | null {
  if (interaction?.state === 'recovered') return 'interaction_not_resolvable';
  return hasLiveSnapshot ? null : 'interaction_already_resolved';
}

function hasDeferredModelSelectionField(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body as Record<string, unknown>).some((key) => ['model', 'reasoningEffort', 'mode'].includes(key));
}

function isSessionCreateBody(body: unknown, workspaceId: string | undefined, legacy = false): boolean {
  if (legacy && body === null) return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.some((key) => key !== 'workspaceId')) return false;
  const requested = (body as Record<string, unknown>).workspaceId;
  return typeof requested === 'string' && requested === workspaceId;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function hasAttachments(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return Object.keys(body as Record<string, unknown>).some((key) =>
    ['images', 'attachments', 'attachmentIds'].includes(key),
  );
}

function isMessageBody(body: unknown): body is { text: string; clientRequestId: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => key === 'text' || key === 'clientRequestId') &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= 128_000 &&
    isOpaqueId(value.clientRequestId)
  );
}

function isTurnBody(body: unknown): body is { turnId: string } {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body as Record<string, unknown>).length === 1 &&
    isOpaqueId((body as Record<string, unknown>).turnId)
  );
}

export type InteractionResolveRequest = {
  revision: number;
  answer: string;
  rejectionReason?: string;
  approvalAnswer?: string;
};

export function isInteractionResolveRequest(body: unknown): body is InteractionResolveRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return (
    Object.keys(value).every((key) => ['revision', 'answer', 'rejectionReason', 'approvalAnswer'].includes(key)) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    typeof value.answer === 'string' &&
    value.answer.length <= 16_384 &&
    (value.rejectionReason === undefined || typeof value.rejectionReason === 'string') &&
    (value.approvalAnswer === undefined || typeof value.approvalAnswer === 'string')
  );
}

function parseQueryLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^[0-9]{1,3}$/.test(value)) throw new GatewayPersistenceError('cursor_invalid', 'limit is invalid');
  return Number(value);
}

function parseEventCursor(value: string | null): { value: number | null; error?: 'cursor_invalid' } {
  if (value === null) return { value: null };
  if (!/^(?:0|[1-9][0-9]{0,14})$/.test(value)) return { value: null, error: 'cursor_invalid' };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? { value: parsed } : { value: null, error: 'cursor_invalid' };
}

function publicError(
  status: number,
  code: string,
  message: string,
  retryable?: boolean,
  details?: Record<string, unknown>,
): GatewayRpcResult {
  return {
    status,
    body: {
      error: { code, message, ...(retryable === undefined ? {} : { retryable }), ...(details ? { details } : {}) },
    },
  };
}

function isPublicEventEnvelope(event: import('./persistence/contracts.js').AgentEventEnvelope): boolean {
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.id) ||
    !isOpaqueId(event.sessionId) ||
    !(FROZEN_AGENT_EVENT_TYPES as readonly string[]).includes(event.type) ||
    typeof event.occurredAt !== 'string' ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  )
    return false;
  try {
    if (
      event.type === 'approval_required' ||
      event.type === 'interaction_updated' ||
      event.type === 'interaction_recovered'
    ) {
      if (
        !event.payload.interaction ||
        typeof event.payload.interaction !== 'object' ||
        !validatePendingInteractionDto(event.payload.interaction)
      )
        return false;
      if (
        event.type === 'interaction_recovered' &&
        !['daemon_restart', 'forced_shutdown', 'persistence_recovery'].includes(String(event.payload.reason))
      )
        return false;
    }
    if (event.type === 'interaction_resolved') {
      const keys = Object.keys(event.payload).sort();
      if (keys.join(',') !== 'interactionId,outcome,turnId,variant') return false;
      if (
        !isOpaqueId(event.payload.interactionId) ||
        !['approved', 'rejected', 'cancelled', 'continued'].includes(String(event.payload.outcome))
      )
        return false;
    }
  } catch {
    return false;
  }
  const visit = (value: unknown, depth = 0): boolean => {
    if (depth > 8) return false;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      return typeof value !== 'string' || value.length <= 32_000;
    if (Array.isArray(value)) return value.length <= 512 && value.every((item) => visit(item, depth + 1));
    if (typeof value !== 'object') return false;
    return Object.entries(value).every(([key, child]) => PUBLIC_EVENT_PAYLOAD_KEYS.has(key) && visit(child, depth + 1));
  };
  return visit(event.payload);
}

function boundedText(value: unknown, max = 8_192): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function interactionDtoFromApproval(
  approval: Record<string, unknown>,
  interactionId: string,
  revision: number,
): PendingInteractionDto {
  return projectPendingInteraction(approval, interactionId, revision);
}

function interactionDtoFromSnapshot(
  snapshot: {
    interactionId?: number;
    approval: unknown;
    askUserAnswers: readonly unknown[];
    currentAskUserQuestionIndex: number;
  },
  interactionId: string,
  revision: number,
): PendingInteractionDto {
  return projectPendingInteraction(
    snapshot.approval as Record<string, unknown>,
    interactionId,
    revision,
    snapshot.askUserAnswers,
    snapshot.currentAskUserQuestionIndex,
  );
}

function sanitizePublicInteraction(value: Record<string, unknown>): PendingInteractionDto {
  return validatePendingInteractionDto(value);
}

function toSessionProjection(source: SessionProjectionSource): Record<string, unknown> {
  const transcript = source.transcript;
  const messages = (transcript?.messages ?? []).slice(-200).map((message) => ({
    id: boundedText(message.id, 256),
    role: boundedText(message.sender ?? (message as unknown as { role?: unknown }).role, 32),
    text: boundedText((message as unknown as { text?: unknown }).text, 16_384),
  }));
  const interaction = source.interaction
    ? {
        ...source.interaction,
        interaction: sanitizePublicInteraction(source.interaction.interaction),
      }
    : null;
  return {
    id: source.session.id,
    workspaceId: source.session.workspaceId,
    status: source.session.status === 'initializing' ? 'idle' : source.session.status,
    createdAt: source.session.createdAt,
    updatedAt: source.session.updatedAt,
    latestSequence: source.latestSequence,
    earliestReplayableSequence: source.earliestReplayableSequence,
    projectionSequence: source.projectionSequence,
    transcript: { messages, ...(transcript?.updatedAt ? { updatedAt: transcript.updatedAt } : {}) },
    interaction,
  };
}

function mapConversationEvent(
  event: ConversationEvent,
  turnId: string,
  sessionId: string,
  interactionBinding?: InteractionBinding,
  interactionSnapshot?: { approval: unknown; askUserAnswers: readonly unknown[]; currentAskUserQuestionIndex: number },
): import('./persistence/contracts.js').DurableEventCandidate | null {
  const base = { sessionId, payload: { turnId } };
  switch (event.type) {
    // The gateway-owned assistant_started admission marker is appended before
    // runtime commit in #submitMessage. ConversationEvent still has no provider
    // first-token signal, so this mapper never invents one from a delta.
    case 'text_delta':
      return { ...base, type: 'text_delta', payload: { turnId, delta: boundedText(event.delta) } };
    case 'reasoning_delta':
      return { ...base, type: 'reasoning_delta', payload: { turnId, delta: boundedText(event.delta) } };
    case 'tool_started':
      return {
        ...base,
        type: 'tool_started',
        payload: { turnId, callId: event.toolCallId, toolName: boundedText(event.toolName, 256) },
      };
    case 'command_message':
      return {
        ...base,
        type: 'command_message',
        payload: {
          turnId,
          message: {
            id: boundedText(event.message.id, 256),
            role: boundedText(event.message.sender ?? (event.message as unknown as { role?: unknown }).role, 32),
            text: boundedText((event.message as unknown as { text?: unknown }).text, 16_384),
          },
        },
      };
    case 'approval_required': {
      if (!interactionBinding) return null;
      return {
        ...base,
        type: 'approval_required',
        payload: {
          turnId,
          interaction: interactionSnapshot
            ? interactionDtoFromSnapshot(
                interactionSnapshot,
                interactionBinding.publicInteractionId,
                interactionBinding.revision,
              )
            : interactionDtoFromApproval(
                event.approval as unknown as Record<string, unknown>,
                interactionBinding.publicInteractionId,
                interactionBinding.revision,
              ),
        },
      };
    }
    case 'usage_update':
      return {
        ...base,
        type: 'usage_update',
        payload: {
          turnId,
          usage: { inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens },
        },
      };
    case 'final':
      return {
        ...base,
        type: 'turn_completed',
        payload: { turnId, outcome: 'completed', text: boundedText(event.finalText, 16_384) },
      };
    case 'error':
      return { ...base, type: 'turn_failed', payload: { turnId, outcome: 'failed', reason: 'runtime_error' } };
    default:
      return null;
  }
}

export { createGatewayAssertion, interactionDtoFromSnapshot, isPublicEventEnvelope };
export type { SessionBinding };
