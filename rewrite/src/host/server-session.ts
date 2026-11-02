/** Session HTTP operations use only the attached direct connection and typed protocol commands. */
import type { WireAdmission, WireCommand } from '../protocol/direct-wire.js';
import type { ServerHostDependencies, ServerResult, ServerSessionRequest } from './server-contracts.js';
import type { PrivateRoute } from './server-routes.js';
import { commandFailure, publicError, unavailable } from './server-errors.js';
import type { ServerInteractions } from './server-interactions.js';
import { parseWireCommand } from '../protocol/direct-parse.js';
import { projectServerSession } from './server-projection.js';
import { invokeServerCommand, projectServerNativeCommand, safeNativeCommandResult } from './server-commands.js';
import { AGENT_WIRE_V2_RUNTIME_AVAILABLE, encodeAgentConfigureResultV2 } from './server-wire-v2.js';
import * as validate from './server-validation.js';

/** Does not own Session lifetime; its caller closes every non-streaming attachment. */
export async function handleSessionRoute(
  route: PrivateRoute,
  input: ServerSessionRequest,
  dependencies: ServerHostDependencies,
  interactions: ServerInteractions,
): Promise<ServerResult> {
  const { connection, body, claims, principal } = input;
  switch (route.purpose) {
    case 'session_read': {
      if (input.url.searchParams.get('format') === 'agent-wire-v2') {
        const rawFormat = input.request.headers['x-term2-event-format'];
        if (rawFormat !== undefined && (typeof rawFormat !== 'string' || rawFormat !== 'agent-wire-v2'))
          return invalid('session hydration format header is invalid');
        if (!AGENT_WIRE_V2_RUNTIME_AVAILABLE)
          return publicError(
            503,
            'agent_wire_v2_unavailable',
            'agent-wire-v2 hydration requires the shared v2 artifact and combined consumer migration',
            true,
            {
              reloadRequired: true,
              requiredFormat: 'agent-wire-v2',
              requiredDependencies: ['shared-wire-v2-artifact', 'browser-v2-migration'],
            },
          );
        if (!dependencies.presentation) return unavailable('direct session metadata projection');
        if (connection.snapshot.seq === null)
          return publicError(503, 'hydration_unavailable', 'session has no accepted hydration cursor', true, {
            reloadRequired: true,
          });
        const metadata = await dependencies.presentation.metadata(principal, connection.snapshot);
        const pending = connection.snapshot.pendingInteractions[0];
        const budget = connection.snapshot.pendingBudgets?.[0];
        // Same snapshot cut as the raw public interaction records. The DTO is the
        // existing resolver contract, not a second attachment or a guessed revision.
        const interaction = pending
          ? {
              state: 'pending' as const,
              interaction: interactions.project(connection.snapshot.sessionId, pending),
              turnId: pending.turnId,
            }
          : budget
          ? {
              state: 'pending' as const,
              interaction: interactions.projectBudget(budget),
              turnId: budget.turnId,
            }
          : null;
        // The snapshot is the current accepted projection through this seq, not a replay event.
        // Consumers must open the v2 SSE with after=seq and never re-apply this snapshot.
        return {
          status: 200,
          headers: {
            'x-term2-hydration-format': 'agent-wire-v2',
            'x-term2-hydration': 'current-accepted',
          },
          body: {
            schemaVersion: 2,
            kind: 'snapshot',
            sessionId: connection.snapshot.sessionId,
            seq: connection.snapshot.seq,
            snapshot: connection.snapshot,
            interaction,
            earliestReplayableSequence: metadata.earliestReplayableSequence,
          },
        };
      }
      return dependencies.presentation
        ? {
            status: 200,
            body: {
              session: await projectServerSession(
                connection.snapshot,
                principal,
                dependencies.presentation,
                interactions,
              ),
            },
          }
        : unavailable('direct session metadata projection');
    }
    case 'message_submit': {
      const direct = input.url.searchParams.get('format') === 'direct';
      if (!direct && validate.hasAttachments(body))
        return publicError(422, 'attachments_not_enabled', 'Attachments are not available');
      const message = directMessage(body, direct);
      if (!message) return invalid('message request is invalid');
      const command = parseWireCommand({
        type: 'submit',
        requestId: message.clientRequestId,
        text: message.text,
        origin: { kind: 'api', id: claims.sub },
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(message.delivery !== undefined ? { delivery: message.delivery } : {}),
      });
      const result = await connection.send(command);
      if (!result.ok) return commandFailure(result);
      if (result.kind !== 'admitted') return unavailable('message admission receipt');
      const admission = originalAdmission(result.admission);
      if (admission.kind === 'rejected') return rejectedAdmission(admission.reason);
      if (direct) return { status: 202, body: result };
      if (!admission.turnId)
        return publicError(
          503,
          'admission_receipt_unavailable',
          'message was durably admitted but Session did not supply its turn identity; retry only with the same clientRequestId',
          false,
          { accepted: true, sessionId: connection.sessionId, clientRequestId: message.clientRequestId, admission },
        );
      return {
        status: 202,
        body: {
          sessionId: connection.sessionId,
          clientRequestId: message.clientRequestId,
          turnId: admission.turnId,
          accepted: true,
          replayed: result.admission.kind === 'duplicate',
        },
      };
    }
    case 'interaction_resolve': {
      const direct = input.url.searchParams.get('format') === 'direct';
      if (!direct && !validate.isInteractionResolveRequest(body)) return invalid('interaction request is invalid');
      const interaction = connection.snapshot.pendingInteractions.find(
        (entry) => entry.requestId === route.interactionId,
      );
      if (!interaction) {
        const budget = connection.snapshot.pendingBudgets?.find((entry) => entry.requestId === route.interactionId);
        if (!budget) return publicError(409, 'stale_interaction', 'interaction is stale');
        return resolveBudget(input, budget, direct, interactions);
      }
      let command: WireCommand;
      if (direct) {
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some((key) => key !== 'decision')
        )
          return invalid('interaction request is invalid');
        command = parseWireCommand({
          type: 'answer',
          requestId: interaction.requestId,
          decision: (body as { decision?: unknown }).decision,
          provenance: { source: 'user', automaticApproval: false },
        });
      } else {
        const resolution = interactions.resolve(
          connection.sessionId,
          interaction,
          body as import('./server-contracts.js').InteractionResolveBody,
        );
        if (resolution.kind === 'next')
          return { status: 200, body: { accepted: false, interaction: resolution.interaction } };
        command = {
          type: 'answer',
          requestId: interaction.requestId,
          decision: resolution.decision,
          provenance: { source: 'user', automaticApproval: false },
        };
      }
      if (
        command.type === 'answer' &&
        command.decision.kind === 'grant' &&
        !interaction.supportedGrants.includes(command.decision.grant)
      )
        return invalid('interaction grant is not supported');
      const result = await connection.send(command);
      if (!result.ok) return commandFailure(result);
      if (result.kind !== 'accepted') return unavailable('interaction receipt');
      interactions.forget(connection.sessionId, interaction.requestId);
      return {
        status: 202,
        body: {
          sessionId: connection.sessionId,
          turnId: interaction.turnId,
          interactionId: interaction.requestId,
          accepted: true,
        },
      };
    }
    case 'session_update':
      return configureSession(input, dependencies);
    case 'command_invoke': {
      if (!validate.isCommandBody(body)) return invalid('command request is invalid');
      return invokeServerCommand(input, body);
    }
    case 'abort': {
      if (!validate.isTurnBody(body)) return invalid('abort request is invalid');
      // The expected identity is checked by the Session capability under admission ownership.
      // Never read the foreground and then send an untargeted cancel: it may hit a successor.
      const result = await connection.send({
        type: 'cancel',
        target: { kind: 'foreground' },
        expectedTurnId: body.turnId,
        discardQueue: true,
      });
      if (!result.ok) return commandFailure(result);
      if (result.kind !== 'abort') return unavailable('turn abort receipt');
      if (result.result.kind === 'not_admitting')
        return publicError(409, 'session_not_admitting', 'session is interrupted', false, {
          abortStatus: 'not_admitting',
        });
      if (result.result.kind === 'no_op') {
        // Accepted terminal evidence is not proof of physical cleanup. Never infer
        // this discriminator from a possibly older/newer attachment snapshot.
        return result.result.status === 'terminal_accepted'
          ? {
              status: 200,
              body: {
                sessionId: connection.sessionId,
                turnId: result.result.turnId,
                accepted: false,
                alreadySettled: true,
                abortStatus: result.result.status,
              },
            }
          : publicError(409, 'session_not_admitting', 'turn cancellation was not admitted', false, {
              turnId: result.result.turnId,
              abortStatus: result.result.status,
            });
      }
      return {
        status: 202,
        body: { sessionId: connection.sessionId, turnId: result.result.turnId, accepted: true },
      };
    }
    default:
      return publicError(403, 'gateway_unavailable', 'gateway operation is unavailable');
  }
}
/** Budget decisions go through the non-tool answer capability with authenticated user provenance. */
async function resolveBudget(
  input: ServerSessionRequest,
  budget: import('../protocol/direct-wire.js').WireBudgetRequest,
  direct: boolean,
  interactions: ServerInteractions,
): Promise<ServerResult> {
  const { body, connection } = input;
  let command: WireCommand;
  if (direct) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'decision'))
      return invalid('budget request is invalid');
    command = parseWireCommand({
      type: 'answer_budget',
      requestId: budget.requestId,
      decision: (body as { decision?: unknown }).decision,
      provenance: { source: 'user', automaticApproval: false },
    });
    if (
      command.type === 'answer_budget' &&
      command.decision.kind === 'extend' &&
      command.decision.grantedBy !== 'human'
    )
      return invalid('HTTP budget extensions require human authority');
  } else {
    command = {
      type: 'answer_budget',
      requestId: budget.requestId,
      decision: interactions.resolveBudget(budget, body as import('./server-contracts.js').InteractionResolveBody),
      provenance: { source: 'user', automaticApproval: false },
    };
  }
  const result = await connection.send(command);
  if (!result.ok) return commandFailure(result);
  if (result.kind !== 'accepted') return unavailable('budget answer receipt');
  return {
    status: 202,
    body: { sessionId: connection.sessionId, turnId: budget.turnId, interactionId: budget.requestId, accepted: true },
  };
}
async function configureSession(
  input: ServerSessionRequest,
  dependencies: ServerHostDependencies,
): Promise<ServerResult> {
  const { connection, body, principal } = input;
  const format = input.url.searchParams.get('format');
  if (format !== null && format !== 'direct' && format !== 'agent-wire-v2')
    return invalid('session config format is invalid');
  const rawFormat = input.request.headers['x-term2-event-format'];
  if (rawFormat !== undefined && typeof rawFormat !== 'string')
    return invalid('session config format header is invalid');
  if (rawFormat !== undefined && rawFormat !== 'agent-wire-v2')
    return invalid('session config format header is invalid');
  if (rawFormat === 'agent-wire-v2' && format !== 'agent-wire-v2')
    return publicError(400, 'protocol_conflict', 'session config negotiation does not match');
  if (validate.requiresSessionUpdateKeys(body))
    return publicError(
      400,
      'protocol_upgrade_required',
      'Upgrade the browser and BFF together and use format=agent-wire-v2 with clientRequestId and the original expectedRevision for every config mutation; do not auto-key, rebase or retry the old patch',
      false,
      { requiredFormat: 'agent-wire-v2', requiredFields: ['clientRequestId', 'expectedRevision'] },
    );
  if (!validate.isSessionUpdateBody(body)) return invalid('session config is invalid');
  const v2 = format === 'agent-wire-v2';
  const presentation = dependencies.presentation;
  if (!presentation?.configuration)
    return publicError(503, 'settings_unavailable', 'direct session config projection unavailable', true);
  if (Object.keys(body).length === 0) {
    // App observes installed settings and native commandRevision together. Do not
    // combine this attachment's old snapshot selection with a later revision query.
    return {
      status: 200,
      body: await presentation.configuration(principal, connection.snapshot),
      ...(v2 ? { headers: { 'x-term2-config-format': 'agent-wire-v2' } } : {}),
    };
  }
  if (v2 && !AGENT_WIRE_V2_RUNTIME_AVAILABLE)
    return publicError(
      503,
      'agent_wire_v2_unavailable',
      'agent-wire-v2 configure requires the shared v2 artifact and combined consumer migration',
      true,
      {
        reloadRequired: true,
        requiredFormat: 'agent-wire-v2',
        requiredDependencies: ['shared-wire-v2-artifact', 'browser-v2-migration'],
      },
    );
  if (!presentation.prepareConfiguration)
    return publicError(503, 'session_config_unavailable', 'session configuration preparation unavailable', true);
  let command: ReturnType<NonNullable<typeof presentation.prepareConfiguration>>;
  try {
    command = presentation.prepareConfiguration(principal, connection.snapshot, body);
  } catch (error) {
    // Validation failures are safe400s; ownership/authority failures retain their
    // existing host error mapping instead of being mislabeled as invalid input.
    if (error instanceof Error && (error.name === 'ZodError' || ('code' in error && error.code === 'invalid_command')))
      return invalid('session config is invalid');
    throw error;
  }
  if (
    command.type !== 'configure' ||
    command.commandId !== body.clientRequestId ||
    command.expectedRevision !== body.expectedRevision ||
    command.admission !== 'idle'
  )
    return unavailable('stable prepared configuration command');
  // The pinned success projection cannot represent native pending/replayed or
  // original accepted output. Direct opts into receipts; v2 wraps the same native
  // result in the explicit versioned envelope. Canonical remains closed.
  if (format !== 'direct' && format !== 'agent-wire-v2')
    return publicError(
      503,
      'session_config_unavailable',
      'canonical configuration mutation receipt contract unavailable',
      true,
    );
  const result = await connection.send(command);
  if (format === 'agent-wire-v2') {
    // Native non-receipt results are still versioned results; pre-dispatch validation/
    // authorization failures use the normal safe HTTP error path.
    const projected = projectServerNativeCommand(result);
    return {
      status: projected.status,
      headers: { 'x-term2-config-format': 'agent-wire-v2' },
      body: encodeAgentConfigureResultV2(connection.sessionId, safeNativeCommandResult(result)),
    };
  }
  return projectServerNativeCommand(result);
}
function invalid(message: string): ServerResult {
  return publicError(400, 'validation_error', message);
}
function originalAdmission(admission: WireAdmission): Exclude<WireAdmission, { kind: 'duplicate' }> {
  return admission.kind === 'duplicate' ? admission.original : admission;
}
function rejectedAdmission(reason: string): ServerResult {
  if (reason === 'queue_full') return publicError(429, 'queue_full', 'message queue is full', true);
  if (reason === 'request_conflict')
    return publicError(409, 'idempotency_conflict', 'request conflicts with an existing admission');
  return publicError(409, 'session_not_admitting', 'session is not admitting messages');
}

function directMessage(
  body: unknown,
  direct: boolean,
): { text: string; clientRequestId: string; attachments?: unknown; delivery?: unknown } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const allowed = direct ? ['text', 'clientRequestId', 'attachments', 'delivery'] : ['text', 'clientRequestId'];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    typeof value.text !== 'string' ||
    value.text.length > 128_000 ||
    !validate.isOpaqueId(value.clientRequestId) ||
    (!value.text.length && (!direct || !Array.isArray(value.attachments) || !value.attachments.length))
  )
    return null;
  return {
    text: value.text,
    clientRequestId: value.clientRequestId,
    ...(value.attachments !== undefined ? { attachments: value.attachments } : {}),
    ...(value.delivery !== undefined ? { delivery: value.delivery } : {}),
  };
}
