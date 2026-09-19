import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import type { RunTerminationCause } from '../contracts/run-termination.js';
import {
  getConversationsDir,
  listConversations,
  loadConversation,
  type ConversationListEntry,
  type RestoredState,
} from '../services/conversation/conversation-persistence.js';
import type { UserTurn } from '../types/user-turn.js';
import type { RuntimeFactory } from '../gateway/runtime-factory.js';
import type { ServerSession } from '../gateway/server-session.js';
import {
  createConversationLogWriter,
  LockConflictError,
  type ConversationLogWriter,
} from '../services/logging/conversation-log-writer.js';
import { LoggingService } from '../services/logging/logging-service.js';
import type { ILoggingService } from '../services/service-interfaces.js';
import { describeError } from '../utils/error-helpers.js';
import type { AcpV2EmitUpdate, AcpV2PromptExecution, AcpV2SessionBackend } from './agent.js';
import { projectPendingInteraction } from '../gateway/interaction-protocol.js';
import type { PendingInteractionSnapshot } from '../services/session/pending-interaction-state.js';

const MAX_TEXT = 16_384;
const MAX_ARGUMENTS = 8_192;
const PAGE_SIZE = 50;

type ActiveTurn = {
  session: ServerSession;
  turnId: string;
  leaseId: string;
  emit: AcpV2EmitUpdate | null;
  resolve: ((outcome: { stopReason: acp.StopReason }) => void) | null;
  reject: ((error: unknown) => void) | null;
  streamedAssistantLength: number;
};

type PermissionClient = { client: acp.AgentContext; signal: AbortSignal };

const ACP_PERMISSION_KINDS: Readonly<Record<string, acp.PermissionOptionKind>> = {
  approve: 'allow_once',
  'allow-once': 'allow_once',
  'allow-folder-session': 'allow_always',
  'allow-edit-file-session': 'allow_always',
  'allow-edit-folder-session': 'allow_always',
  reject: 'reject_once',
  deny: 'reject_once',
};

export function mapAcpPermissionChoices(choices: readonly { id: string; label: string }[]): Array<{
  choice: { id: string; label: string };
  option: { optionId: string; name: string; kind: acp.PermissionOptionKind };
}> {
  return choices.flatMap((choice) => {
    const kind = ACP_PERMISSION_KINDS[choice.id];
    return kind ? [{ choice, option: { optionId: choice.id, name: choice.label, kind } }] : [];
  });
}

export type AcpV2SessionBackendOptions = Readonly<{
  runtimeFactory: RuntimeFactory;
  createId?: () => string;
  list?: typeof listConversations;
  load?: typeof loadConversation;
  ownerUserId?: string;
  pageSize?: number;
  logger?: ILoggingService;
  writerFactory?: (options: { sessionId: string; dir: string; logger: ILoggingService }) => ConversationLogWriter;
  decideApproval?: (
    request: { readonly toolName: string; readonly callId?: string; readonly argumentsText: string },
    context: { readonly sessionId: string; readonly cwd: string },
  ) => Promise<{ readonly answer: string; readonly reason?: string }>;
}>;

/**
 * The production backend a launcher process owns: the adapter's protocol
 * surface plus a process-lifecycle method that cancels active turns and closes
 * every live session. `AcpV2SessionBackend` deliberately stays free of
 * lifecycle concerns (the adapter has no shutdown concept), so the launcher's
 * teardown is expressed additively here rather than in the adapter contract.
 */
export type AcpV2ProductionSessionBackend = AcpV2SessionBackend & {
  shutdown(): Promise<void>;
};

export function createAcpV2SessionBackend(options: AcpV2SessionBackendOptions): AcpV2ProductionSessionBackend {
  const sessions = new Map<string, ServerSession>();
  const active = new Map<string, ActiveTurn>();
  const createId = options.createId ?? randomUUID;
  const list = options.list ?? listConversations;
  const load = options.load ?? loadConversation;
  const ownerUserId = options.ownerUserId ?? 'acp';
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const logger = options.logger ?? new LoggingService({ disableLogging: true, suppressConsoleOutput: true });
  const writerFactory = options.writerFactory ?? createConversationLogWriter;
  const writers = new Map<string, ConversationLogWriter>();
  const permissionClients = new Map<string, PermissionClient>();
  const decideApproval =
    options.decideApproval ?? (async () => ({ answer: 'n', reason: 'Approval is not yet supported over ACP.' }));

  const requestPermission = async (
    sessionId: string,
    snapshot: PendingInteractionSnapshot,
    toolCallId: string | undefined,
  ): Promise<{ answer: string; reason?: string } | undefined> => {
    const pending = permissionClients.get(sessionId);
    if (!pending) return undefined;
    if (snapshot.revision === undefined) return { answer: 'n', reason: 'Permission revision is unavailable.' };
    const dto = projectPendingInteraction(snapshot.approval, String(snapshot.interactionId), snapshot.revision);
    if (dto.kind !== 'tool_approval') return { answer: 'n', reason: 'This interaction cannot be approved over ACP.' };
    const optionsById = mapAcpPermissionChoices(dto.choices);
    try {
      const response = await pending.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId,
          title: dto.descriptor.toolName,
          description: dto.descriptor.argumentsText,
          subject: {
            type: 'tool_call',
            toolCall: {
              toolCallId: toolCallId ?? dto.descriptor.callId ?? `${sessionId}:approval`,
              title: dto.descriptor.toolName,
              name: dto.descriptor.toolName,
              status: 'pending',
            },
          },
          options: optionsById.map(({ option }) => option),
        },
        { cancellationSignal: pending.signal },
      );
      const outcome = response?.outcome;
      if (
        !outcome ||
        outcome.outcome !== 'selected' ||
        !('optionId' in outcome) ||
        typeof outcome.optionId !== 'string'
      )
        return { answer: 'n', reason: 'Permission request was cancelled.' };
      const selected = optionsById.find(({ option }) => option.optionId === outcome.optionId);
      if (!selected) return { answer: 'n', reason: 'Client selected an unknown permission option.' };
      const answer =
        selected.option.kind === 'reject_once' || selected.option.kind === 'reject_always'
          ? 'n'
          : selected.choice.id === 'approve'
          ? 'y'
          : selected.choice.id;
      return { answer, ...(answer === 'n' ? { reason: 'Permission denied by client.' } : {}) };
    } catch {
      return { answer: 'n', reason: 'Permission request failed.' };
    }
  };

  const invalid = (message: string): never => {
    throw acp.RequestError.invalidParams(undefined, message);
  };
  const missing = (sessionId: string): never => {
    throw new acp.RequestError(-32001, `Session not found: ${sessionId}`);
  };

  const validateCwd = (cwd: string): string => {
    if (!path.isAbsolute(cwd)) invalid('cwd must be an absolute path');
    try {
      const canonical = realpathSync(cwd);
      if (!statSync(canonical).isDirectory()) invalid('cwd must be a directory');
      return canonical;
    } catch {
      invalid('cwd must exist and be a directory');
    }
    throw new Error('unreachable');
  };

  const mapEvent = async (event: ConversationEvent, turn: ActiveTurn): Promise<void> => {
    if (event.type === 'approval_required') {
      const snapshot = turn.session.resources.runtime?.pendingInteraction.getSnapshot();
      let answer = 'n';
      let reason = 'Approval is not yet supported over ACP.';
      let delivered = false;
      try {
        const permissionDecision = snapshot
          ? await requestPermission(turn.session.sessionId, snapshot, event.approval.callId)
          : undefined;
        const decision =
          permissionDecision ??
          (await decideApproval(
            {
              toolName: event.approval.toolName,
              callId: event.approval.callId,
              argumentsText: event.approval.argumentsText,
            },
            { sessionId: turn.session.sessionId, cwd: turn.session.binding.canonicalRoot },
          ));
        answer = decision.answer;
        reason = decision.reason ?? (answer === 'y' ? '' : 'Approval denied.');
        if (turn.emit && answer !== 'y' && !answer.startsWith('allow-')) {
          await turn.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: event.approval.callId ?? `${turn.turnId}:approval`,
            title: 'Approval required',
            kind: toolKind(event.approval.toolName),
            status: 'failed',
            content: [{ type: 'content', content: { type: 'text', text: reason || 'Approval granted.' } }],
          });
          delivered = true;
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : 'Approval denied.';
      } finally {
        if (snapshot) {
          try {
            turn.session.resolvePendingInteraction({
              expectedInteractionId: snapshot.interactionId,
              ...(snapshot.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
              answer: delivered ? answer : 'n',
              rejectionReason: delivered && answer === 'y' ? undefined : reason,
            });
          } catch {
            await turn.session.abort(turn.turnId).catch(() => undefined);
          }
        } else {
          await turn.session.abort(turn.turnId).catch(() => undefined);
        }
      }
      return;
    }
    if (!turn.emit) return;
    switch (event.type) {
      case 'text_delta': {
        const text = bound(event.delta, MAX_TEXT);
        turn.streamedAssistantLength += text.length;
        await turn.emit({
          sessionUpdate: 'agent_message_chunk',
          messageId: `${turn.turnId}:assistant`,
          content: { type: 'text', text },
        });
        return;
      }
      case 'reasoning_delta':
        // ConversationEvent reasoning is already the sanitized presentation path.
        await turn.emit({
          sessionUpdate: 'agent_thought_chunk',
          messageId: `${turn.turnId}:thought`,
          content: { type: 'text', text: bound(event.delta, MAX_TEXT) },
        });
        return;
      case 'tool_started':
        await turn.emit({
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          title: bound(event.toolName, 256),
          kind: toolKind(event.toolName),
          status: 'pending',
          rawInput: boundedJson(event.arguments, MAX_ARGUMENTS),
        });
        return;
      case 'tool_dispatched':
        await turn.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          name: bound(event.toolName, 256),
          title: bound(event.toolName, 256),
          kind: toolKind(event.toolName),
          status: 'in_progress',
        });
        return;
      case 'tool_call_streaming_delta':
        if (event.toolName && (event as ConversationEvent & { toolCallId?: string }).toolCallId) {
          await turn.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: (event as ConversationEvent & { toolCallId: string }).toolCallId,
            name: bound(event.toolName, 256),
            status: 'in_progress',
            rawInput: { argumentCharCount: Math.min(event.argumentCharCount, MAX_ARGUMENTS) },
          });
        }
        return;
      case 'final':
        if (event.finalText.slice(turn.streamedAssistantLength)) {
          await turn.emit({
            sessionUpdate: 'agent_message_chunk',
            messageId: `${turn.turnId}:assistant`,
            content: { type: 'text', text: bound(event.finalText.slice(turn.streamedAssistantLength), MAX_TEXT) },
          });
        }
        turn.resolve?.({ stopReason: stopReasonForTerminalCause(event.terminalCause) });
        return;
      case 'error':
        turn.reject?.(new Error(bound(event.message, MAX_TEXT)));
        return;
      default:
        return;
    }
  };

  const create = async (cwd: string, sessionId = createId()): Promise<ServerSession> => {
    const root = validateCwd(cwd);
    const binding = {
      sessionId,
      ownerUserId,
      workspaceId: root,
      grantVersion: 1,
      canonicalRoot: root,
      access: 'read_write' as const,
    };
    const created = await options.runtimeFactory.create(binding, {
      eventSink: async (event) => {
        const turn = active.get(sessionId);
        if (turn) await mapEvent(event, turn);
      },
    });
    if (!(created as ServerSession & { service?: unknown }).service) {
      sessions.set(sessionId, created);
      return created;
    }
    const settings = (created as ServerSession & { settings?: { modelId?: string; providerId?: string } }).settings;
    let writer: ConversationLogWriter;
    try {
      writer = writerFactory({ sessionId, dir: getConversationsDir(), logger });
      writer.init({
        id: sessionId,
        createdAt: new Date().toISOString(),
        projectPath: root,
        ...(settings?.modelId ? { model: settings.modelId } : {}),
        ...(settings?.providerId ? { provider: settings.providerId } : {}),
      });
      created.service.setLogSink((event) => writer.append(event));
    } catch (error) {
      await created.dispose();
      if (error instanceof LockConflictError) {
        throw new acp.RequestError(-32009, `Conversation ${sessionId} is locked`);
      }
      throw error;
    }
    writers.set(sessionId, writer);
    sessions.set(sessionId, created);
    return created;
  };

  const cancelSession = async (sessionId: string): Promise<void> => {
    const turn = active.get(sessionId);
    if (turn) await turn.session.abort(turn.turnId);
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (!session) return;
    try {
      await session.dispose();
    } finally {
      session.service.setLogSink(null);
      await writers.get(sessionId)?.close();
      writers.delete(sessionId);
      sessions.delete(sessionId);
    }
  };

  return {
    setClient(sessionId, client, signal) {
      permissionClients.set(sessionId, { client, signal });
    },
    clearClient(sessionId) {
      permissionClients.delete(sessionId);
    },
    async createSession(request) {
      const session = await create(request.cwd);
      return { sessionId: session.sessionId };
    },
    async listSessions(request) {
      const entries = list(request.cwd ?? undefined);
      const offset = request.cursor ? parseCursor(request.cursor) : 0;
      const page = entries.slice(offset, offset + pageSize);
      return {
        sessions: page.map(toSessionInfo),
        ...(offset + page.length < entries.length ? { nextCursor: String(offset + page.length) } : {}),
      };
    },
    async resumeSession(request, emit) {
      const existing = sessions.get(request.sessionId);
      if (existing) {
        const requestedRoot = validateCwd(request.cwd);
        if (requestedRoot !== existing.binding.canonicalRoot) {
          invalid('cwd does not match the live session workspace');
        }
      }
      const restored = load(request.sessionId, request.cwd);
      if (!existing) {
        if (!restored) missing(request.sessionId);
        const session = await create(request.cwd, request.sessionId);
        const restoredState = restored as RestoredState;
        const providerMatches = !restoredState.provider || restoredState.provider === session.settings.providerId;
        const modelMatches = !restoredState.model || restoredState.model === session.settings.modelId;
        session.service.importState({
          history: restoredState.history,
          previousResponseId: providerMatches && modelMatches ? restoredState.previousResponseId : null,
          toolLedger: restoredState.toolLedger,
          updatedAt: restoredState.updatedAt,
        });
      }
      if (restored && request.replayFrom) await replay(restored, emit);
      return {};
    },
    closeSession,
    async preparePrompt(request): Promise<AcpV2PromptExecution> {
      const session = sessions.get(request.sessionId);
      if (!session) missing(request.sessionId);
      const liveSession = session as ServerSession;
      const input = promptToTurn(request.prompt);
      const prepared = await liveSession.prepareMessage(input, { turnId: createId(), clientRequestId: createId() });
      if (prepared.kind !== 'prepared') throw new acp.RequestError(-32000, `Session is ${prepared.reason}`);
      return {
        run: async (emit, signal) => {
          if (signal.aborted) return { stopReason: 'cancelled' };
          const turn: ActiveTurn = {
            session: liveSession,
            turnId: prepared.turnId,
            leaseId: prepared.leaseId,
            emit,
            resolve: null,
            reject: null,
            streamedAssistantLength: 0,
          };
          active.set(request.sessionId, turn);
          const outcome = new Promise<{ stopReason: acp.StopReason }>((resolve, reject) => {
            turn.resolve = resolve;
            turn.reject = reject;
          });
          const abort = () => {
            void liveSession.abort(prepared.turnId).then(() => turn.resolve?.({ stopReason: 'cancelled' }));
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            await liveSession.commitMessage(prepared.leaseId);
            return await outcome;
          } finally {
            signal.removeEventListener('abort', abort);
            active.delete(request.sessionId);
          }
        },
      };
    },
    cancelSession,
    /**
     * Cancel every in-flight turn, then close every live session. Closing is
     * what flushes the conversation log writer and releases its lock, so this
     * is the flush boundary the launcher's bounded shutdown waits on.
     *
     * Every step settles before the next pass starts: a rejected cancellation
     * must not skip the close pass, because the sessions it never reached would
     * keep their log writers open and their `.lock` files behind. Failures are
     * aggregated and thrown once both passes are done, so the caller still
     * learns about them instead of reading a clean shutdown.
     */
    async shutdown() {
      const sessionIds = [...sessions.keys()];
      const settlements = [
        ...(await Promise.allSettled(sessionIds.map((sessionId) => cancelSession(sessionId)))),
        ...(await Promise.allSettled(sessionIds.map((sessionId) => closeSession(sessionId)))),
      ];
      const failures = settlements.filter(
        (settlement): settlement is PromiseRejectedResult => settlement.status === 'rejected',
      );
      if (failures.length === 0) return;
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `shutdown failed for ${failures.length} of ${settlements.length} teardown step(s): ${failures
          .map((failure) => describeError(failure.reason))
          .join('; ')}`,
      );
    },
  };
}

export const createProductionAcpV2SessionBackend = createAcpV2SessionBackend;

function bound(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function boundedJson(value: unknown, max: number): unknown {
  const text = bound(JSON.stringify(value) ?? 'null', max);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toolKind(name: string): 'read' | 'edit' | 'execute' | 'think' | 'fetch' | 'other' {
  if (/read|search|list|glob/i.test(name)) return 'read';
  if (/edit|write|patch/i.test(name)) return 'edit';
  if (/shell|command|exec/i.test(name)) return 'execute';
  if (/web|fetch/i.test(name)) return 'fetch';
  return 'other';
}

function stopReasonForTerminalCause(cause: RunTerminationCause | undefined): acp.StopReason {
  return cause === 'budget_exhausted' ? 'max_turn_requests' : 'end_turn';
}

function promptToTurn(blocks: acp.PromptRequest['prompt']): UserTurn {
  const text = blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource_link') return `[Resource: ${bound(String(block.uri), MAX_TEXT)}]`;
      if (block.type === 'resource') {
        const resource = block.resource as { type?: string; text?: string };
        if (resource.type === 'text' && typeof resource.text === 'string') return resource.text;
      }
      invalidBlock(block.type);
    })
    .join('\n');
  if (!text.trim()) throw acp.RequestError.invalidParams(undefined, 'prompt must contain text');
  return { text };
}

function invalidBlock(type: string): never {
  throw acp.RequestError.invalidParams(undefined, `Unsupported prompt content block: ${type}`);
}

function parseCursor(cursor: string): number {
  const value = Number.parseInt(cursor, 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function toSessionInfo(entry: ConversationListEntry): acp.SessionInfo {
  return {
    sessionId: entry.id,
    cwd: entry.projectPath ?? '/',
    ...(entry.firstUserMessage ? { title: bound(entry.firstUserMessage, 256) } : {}),
    ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
  };
}

async function replay(state: RestoredState, emit: AcpV2EmitUpdate): Promise<void> {
  for (const message of state.messages ?? []) {
    if (message.sender === 'user') {
      await emit({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: bound(message.text, MAX_TEXT) },
      });
    } else if (message.sender === 'bot') {
      await emit({
        sessionUpdate: 'agent_message_chunk',
        messageId: `${state.id}:replay`,
        content: { type: 'text', text: bound(message.text, MAX_TEXT) },
      });
    }
  }
}
