import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import type { ConversationEvent } from '../services/conversation/conversation-events.js';
import {
  listConversations,
  loadConversation,
  type ConversationListEntry,
  type RestoredState,
} from '../services/conversation/conversation-persistence.js';
import type { UserTurn } from '../types/user-turn.js';
import type { RuntimeFactory } from '../gateway/runtime-factory.js';
import type { ServerSession } from '../gateway/server-session.js';
import type { AcpV2EmitUpdate, AcpV2PromptExecution, AcpV2SessionBackend } from './agent.js';

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
};

export type AcpV2SessionBackendOptions = Readonly<{
  runtimeFactory: RuntimeFactory;
  createId?: () => string;
  list?: typeof listConversations;
  load?: typeof loadConversation;
  ownerUserId?: string;
  pageSize?: number;
  decideApproval?: (
    request: { readonly toolName: string; readonly callId?: string; readonly argumentsText: string },
    context: { readonly sessionId: string; readonly cwd: string },
  ) => Promise<{ readonly answer: string; readonly reason?: string }>;
}>;

export function createAcpV2SessionBackend(options: AcpV2SessionBackendOptions): AcpV2SessionBackend {
  const sessions = new Map<string, ServerSession>();
  const active = new Map<string, ActiveTurn>();
  const createId = options.createId ?? randomUUID;
  const list = options.list ?? listConversations;
  const load = options.load ?? loadConversation;
  const ownerUserId = options.ownerUserId ?? 'acp';
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const decideApproval =
    options.decideApproval ?? (async () => ({ answer: 'n', reason: 'Approval is not yet supported over ACP.' }));

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
    if (!turn.emit) return;
    switch (event.type) {
      case 'text_delta':
        await turn.emit({
          sessionUpdate: 'agent_message_chunk',
          messageId: `${turn.turnId}:assistant`,
          content: { type: 'text', text: bound(event.delta, MAX_TEXT) },
        });
        return;
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
        if (toolKind(event.toolName) === 'edit') {
          await turn.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: event.toolCallId,
            status: 'failed',
            content: [{ type: 'content', content: { type: 'text', text: 'Approval is not yet supported over ACP.' } }],
          });
        }
        return;
      case 'tool_call_streaming_delta':
        if (event.toolName) {
          await turn.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId: `${turn.turnId}:tool`,
            name: bound(event.toolName, 256),
            status: 'in_progress',
            rawInput: { argumentCharCount: Math.min(event.argumentCharCount, MAX_ARGUMENTS) },
          });
        }
        return;
      case 'approval_required': {
        const snapshot = turn.session.resources.runtime?.pendingInteraction.getSnapshot();
        const decision = await decideApproval(
          {
            toolName: event.approval.toolName,
            callId: event.approval.callId,
            argumentsText: event.approval.argumentsText,
          },
          { sessionId: turn.session.sessionId, cwd: turn.session.binding.canonicalRoot },
        );
        await turn.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: event.approval.callId ?? `${turn.turnId}:approval`,
          title: 'Approval required',
          kind: toolKind(event.approval.toolName),
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: decision.reason ?? 'Approval denied.' } }],
        });
        if (snapshot) {
          turn.session.resolvePendingInteraction({
            expectedInteractionId: snapshot.interactionId,
            answer: decision.answer,
            rejectionReason: decision.answer === 'y' ? undefined : decision.reason,
          });
        }
        return;
      }
      case 'final':
        if (event.finalText) {
          await turn.emit({
            sessionUpdate: 'agent_message_chunk',
            messageId: `${turn.turnId}:assistant`,
            content: { type: 'text', text: bound(event.finalText, MAX_TEXT) },
          });
        }
        turn.resolve?.({ stopReason: 'end_turn' });
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
      access: 'read' as const,
    };
    const created = await options.runtimeFactory.create(binding, {
      eventSink: async (event) => {
        const turn = active.get(sessionId);
        if (turn) await mapEvent(event, turn);
      },
    });
    sessions.set(sessionId, created);
    return created;
  };

  return {
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
      if (!existing) {
        const restored = load(request.sessionId, request.cwd);
        if (!restored) missing(request.sessionId);
        await create(request.cwd, request.sessionId);
      }
      const restored = load(request.sessionId, request.cwd);
      if (restored && request.replayFrom) await replay(restored, emit);
      return {};
    },
    async closeSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      await session.dispose();
      sessions.delete(sessionId);
    },
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
    async cancelSession(sessionId) {
      const turn = active.get(sessionId);
      if (turn) await turn.session.abort(turn.turnId);
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
