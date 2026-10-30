import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { getConversationsDir, listConversations, loadConversation, } from '../services/conversation/conversation-persistence.js';
import { createConversationLogWriter, LockConflictError, } from '../services/logging/conversation-log-writer.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { describeError } from '../utils/error-helpers.js';
import { projectPendingInteraction } from '../gateway/interaction-protocol.js';
const MAX_TEXT = 16_384;
const MAX_ARGUMENTS = 8_192;
const PAGE_SIZE = 50;
const ACP_PERMISSION_KINDS = {
    approve: 'allow_once',
    'allow-once': 'allow_once',
    'allow-folder-session': 'allow_always',
    'allow-edit-file-session': 'allow_always',
    'allow-edit-folder-session': 'allow_always',
    reject: 'reject_once',
    deny: 'reject_once',
};
export function mapAcpPermissionChoices(choices) {
    return choices.flatMap((choice) => {
        const kind = ACP_PERMISSION_KINDS[choice.id];
        return kind ? [{ choice, option: { optionId: choice.id, name: choice.label, kind } }] : [];
    });
}
export function createAcpV2SessionBackend(options) {
    const sessions = new Map();
    const active = new Map();
    const createId = options.createId ?? randomUUID;
    const list = options.list ?? listConversations;
    const load = options.load ?? loadConversation;
    const ownerUserId = options.ownerUserId ?? 'acp';
    const pageSize = options.pageSize ?? PAGE_SIZE;
    const logger = options.logger ?? new LoggingService({ disableLogging: true, suppressConsoleOutput: true });
    const writerFactory = options.writerFactory ?? createConversationLogWriter;
    const writers = new Map();
    const permissionClients = new Map();
    const sessionPermissionGrants = new Map();
    const decideApproval = options.decideApproval ?? (async () => ({ answer: 'n', reason: 'Approval is not yet supported over ACP.' }));
    const requestPermission = async (sessionId, snapshot, toolCallId) => {
        const pending = permissionClients.get(sessionId);
        if (!pending)
            return undefined;
        if (snapshot.revision === undefined)
            return { answer: 'n', reason: 'Permission revision is unavailable.' };
        const toolName = snapshot.approval.toolName;
        const dto = projectPendingInteraction(snapshot.approval, String(snapshot.interactionId), snapshot.revision);
        if (dto.kind !== 'tool_approval')
            return { answer: 'n', reason: 'This interaction cannot be approved over ACP.' };
        const optionsById = mapAcpPermissionChoices(dto.choices);
        const grants = sessionPermissionGrants.get(sessionId) ?? [];
        const existingGrant = grants.find((grant) => grant.toolName === toolName &&
            optionsById.some(({ option }) => option.optionId === grant.answer) &&
            grantCovers(grant, snapshot.approval));
        if (existingGrant)
            return { answer: existingGrant.answer };
        try {
            const response = await pending.client.request(acp.methods.client.session.requestPermission, {
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
            }, { cancellationSignal: pending.signal });
            const outcome = response?.outcome;
            if (!outcome ||
                outcome.outcome !== 'selected' ||
                !('optionId' in outcome) ||
                typeof outcome.optionId !== 'string')
                return { answer: 'n', reason: 'Permission request was cancelled.' };
            const selected = optionsById.find(({ option }) => option.optionId === outcome.optionId) ??
                (outcome.optionId === 'allow-once' ? optionsById.find(({ choice }) => choice.id === 'approve') : undefined);
            if (!selected)
                return { answer: 'n', reason: 'Client selected an unknown permission option.' };
            const answer = selected.option.kind === 'reject_once' || selected.option.kind === 'reject_always'
                ? 'n'
                : selected.choice.id === 'approve'
                    ? 'y'
                    : selected.choice.id === 'allow-once'
                        ? 'y'
                        : selected.choice.id;
            if (selected.option.kind === 'allow_always') {
                const scope = permissionScope(answer, snapshot.approval);
                if (scope) {
                    const current = sessionPermissionGrants.get(sessionId) ?? [];
                    current.push({ toolName, answer, ...scope });
                    sessionPermissionGrants.set(sessionId, current);
                }
            }
            return { answer, ...(answer === 'n' ? { reason: 'Permission denied by client.' } : {}) };
        }
        catch (error) {
            return {
                answer: 'n',
                reason: error instanceof Error && error.message.includes('Method not found')
                    ? 'Approval is not yet supported over ACP.'
                    : 'Permission request failed.',
            };
        }
    };
    const invalid = (message) => {
        throw acp.RequestError.invalidParams(undefined, message);
    };
    const missing = (sessionId) => {
        throw new acp.RequestError(-32001, `Session not found: ${sessionId}`);
    };
    const validateCwd = (cwd) => {
        if (!path.isAbsolute(cwd))
            invalid('cwd must be an absolute path');
        try {
            const canonical = realpathSync(cwd);
            if (!statSync(canonical).isDirectory())
                invalid('cwd must be a directory');
            return canonical;
        }
        catch {
            invalid('cwd must exist and be a directory');
        }
        throw new Error('unreachable');
    };
    const mapEvent = async (event, turn) => {
        if (event.type === 'approval_required') {
            const snapshot = turn.session.service.getPendingInteractionSnapshot?.() ?? null;
            let answer = 'n';
            let reason = 'Approval is not yet supported over ACP.';
            let decisionReady = false;
            try {
                const permissionDecision = snapshot
                    ? await requestPermission(turn.session.sessionId, snapshot, event.approval.callId)
                    : undefined;
                const decision = permissionDecision ??
                    (await decideApproval({
                        toolName: event.approval.toolName,
                        callId: event.approval.callId,
                        argumentsText: event.approval.argumentsText,
                    }, { sessionId: turn.session.sessionId, cwd: turn.session.binding.canonicalRoot }));
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
                }
                decisionReady = true;
            }
            catch (error) {
                reason = error instanceof Error ? error.message : 'Approval denied.';
            }
            finally {
                if (snapshot) {
                    try {
                        const resolution = turn.session.resolvePendingInteraction({
                            expectedInteractionId: snapshot.interactionId,
                            ...(snapshot.revision === undefined ? {} : { expectedRevision: snapshot.revision }),
                            answer: decisionReady ? answer : 'n',
                            rejectionReason: decisionReady && (answer === 'y' || answer.startsWith('allow-')) ? undefined : reason,
                        });
                        if ((!resolution || resolution.kind === 'resolved') && decisionReady) {
                            await turn.session.service.handleApprovalDecision(answer, answer === 'y' || answer.startsWith('allow-') ? undefined : reason);
                        }
                    }
                    catch {
                        await turn.session.abort(turn.turnId).catch(() => undefined);
                        turn.resolve?.({ stopReason: 'cancelled' });
                    }
                }
                else {
                    if (decisionReady) {
                        turn.resolve?.({ stopReason: 'end_turn' });
                    }
                    else {
                        await turn.session.abort(turn.turnId).catch(() => undefined);
                        turn.resolve?.({ stopReason: 'cancelled' });
                    }
                }
            }
            return;
        }
        if (!turn.emit)
            return;
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
                if (event.toolName && event.toolCallId) {
                    await turn.emit({
                        sessionUpdate: 'tool_call_update',
                        toolCallId: event.toolCallId,
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
    const create = async (cwd, sessionId = createId()) => {
        const root = validateCwd(cwd);
        const binding = {
            sessionId,
            ownerUserId,
            workspaceId: root,
            grantVersion: 1,
            canonicalRoot: root,
            access: 'read_write',
        };
        const created = await options.runtimeFactory.create(binding, {
            eventSink: async (event) => {
                const turn = active.get(sessionId);
                if (turn)
                    await mapEvent(event, turn);
            },
        });
        if (!created.service) {
            sessions.set(sessionId, created);
            return created;
        }
        const settings = created.settings;
        let writer;
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
        }
        catch (error) {
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
    const cancelSession = async (sessionId) => {
        const turn = active.get(sessionId);
        if (turn)
            await turn.session.abort(turn.turnId);
    };
    const closeSession = async (sessionId) => {
        const session = sessions.get(sessionId);
        if (!session)
            return;
        try {
            await session.dispose();
        }
        finally {
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
            sessionPermissionGrants.delete(sessionId);
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
                if (!restored)
                    missing(request.sessionId);
                const session = await create(request.cwd, request.sessionId);
                const restoredState = restored;
                const providerMatches = !restoredState.provider || restoredState.provider === session.settings.providerId;
                const modelMatches = !restoredState.model || restoredState.model === session.settings.modelId;
                session.service.importState({
                    history: restoredState.history,
                    previousResponseId: providerMatches && modelMatches ? restoredState.previousResponseId : null,
                    toolLedger: restoredState.toolLedger,
                    updatedAt: restoredState.updatedAt,
                });
            }
            if (restored && request.replayFrom)
                await replay(restored, emit);
            return {};
        },
        closeSession,
        async preparePrompt(request) {
            const session = sessions.get(request.sessionId);
            if (!session)
                missing(request.sessionId);
            const liveSession = session;
            const input = promptToTurn(request.prompt);
            const prepared = await liveSession.prepareMessage(input, { turnId: createId(), clientRequestId: createId() });
            if (prepared.kind !== 'prepared')
                throw new acp.RequestError(-32000, `Session is ${prepared.reason}`);
            return {
                run: async (emit, signal) => {
                    if (signal.aborted)
                        return { stopReason: 'cancelled' };
                    const turn = {
                        session: liveSession,
                        turnId: prepared.turnId,
                        leaseId: prepared.leaseId,
                        emit,
                        resolve: null,
                        reject: null,
                        streamedAssistantLength: 0,
                    };
                    active.set(request.sessionId, turn);
                    const outcome = new Promise((resolve, reject) => {
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
                    }
                    finally {
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
            const failures = settlements.filter((settlement) => settlement.status === 'rejected');
            if (failures.length === 0)
                return;
            throw new AggregateError(failures.map((failure) => failure.reason), `shutdown failed for ${failures.length} of ${settlements.length} teardown step(s): ${failures
                .map((failure) => describeError(failure.reason))
                .join('; ')}`);
        },
    };
}
function permissionScope(answer, approval) {
    const scopeKind = answer === 'allow-edit-file-session' ? 'file' : 'folder';
    const outside = approval.outsideWorkspaceEdit;
    if (outside)
        return { scopeKind, scopePath: path.resolve(scopeKind === 'file' ? outside.path : outside.folder) };
    const target = approvalPath(approval.argumentsText);
    return target ? { scopeKind, scopePath: path.resolve(target) } : undefined;
}
function grantCovers(grant, approval) {
    const scope = permissionScope(grant.answer, approval);
    if (!scope || scope.scopeKind !== grant.scopeKind)
        return false;
    const target = path.resolve(scope.scopePath);
    const granted = path.resolve(grant.scopePath);
    return grant.scopeKind === 'file'
        ? target === granted
        : target === granted || target.startsWith(`${granted}${path.sep}`);
}
function approvalPath(argumentsText) {
    try {
        const parsed = JSON.parse(argumentsText);
        for (const key of ['path', 'filePath', 'filepath', 'target']) {
            if (typeof parsed[key] === 'string' && parsed[key])
                return parsed[key];
        }
    }
    catch {
        // A malformed or non-path approval cannot safely reuse a scoped grant.
    }
    return undefined;
}
function bound(value, max) {
    return value.length > max ? `${value.slice(0, max)}…` : value;
}
function boundedJson(value, max) {
    const text = bound(JSON.stringify(value) ?? 'null', max);
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}
function toolKind(name) {
    if (/read|search|list|glob/i.test(name))
        return 'read';
    if (/edit|write|patch/i.test(name))
        return 'edit';
    if (/shell|command|exec/i.test(name))
        return 'execute';
    if (/web|fetch/i.test(name))
        return 'fetch';
    return 'other';
}
function stopReasonForTerminalCause(cause) {
    return cause === 'budget_exhausted' ? 'max_turn_requests' : 'end_turn';
}
function promptToTurn(blocks) {
    const text = blocks
        .map((block) => {
        if (block.type === 'text')
            return block.text;
        if (block.type === 'resource_link')
            return `[Resource: ${bound(String(block.uri), MAX_TEXT)}]`;
        if (block.type === 'resource') {
            const resource = block.resource;
            if (resource.type === 'text' && typeof resource.text === 'string')
                return resource.text;
        }
        invalidBlock(block.type);
    })
        .join('\n');
    if (!text.trim())
        throw acp.RequestError.invalidParams(undefined, 'prompt must contain text');
    return { text };
}
function invalidBlock(type) {
    throw acp.RequestError.invalidParams(undefined, `Unsupported prompt content block: ${type}`);
}
function parseCursor(cursor) {
    const value = Number.parseInt(cursor, 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function toSessionInfo(entry) {
    return {
        sessionId: entry.id,
        cwd: entry.projectPath ?? '/',
        ...(entry.firstUserMessage ? { title: bound(entry.firstUserMessage, 256) } : {}),
        ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    };
}
async function replay(state, emit) {
    for (const message of state.messages ?? []) {
        if (message.sender === 'user') {
            await emit({
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: bound(message.text, MAX_TEXT) },
            });
        }
        else if (message.sender === 'bot') {
            await emit({
                sessionUpdate: 'agent_message_chunk',
                messageId: `${state.id}:replay`,
                content: { type: 'text', text: bound(message.text, MAX_TEXT) },
            });
        }
    }
}
//# sourceMappingURL=session-backend.js.map