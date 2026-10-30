/** Proof-only composition: existing noninteractive runtime, canonical C2 store/writer. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectPendingInteraction } from '../../source/gateway/interaction-protocol.js';
import { getConversationsDir } from '../../source/services/conversation/conversation-persistence.js';
import { LocalSessionStore } from '../src/session/local-store.js';
export async function createProofPersistence(input, options = {}) {
    const { sessionId, resumedConversation, metadata, settingsService, logger, runtime, adapter } = input;
    const root = options.root ?? getConversationsDir();
    const selection = settingsService.get('agent.modelSelection');
    const workspace = {
        root: metadata.projectPath ?? process.cwd(),
        access: 'read_write',
        target: 'local',
    };
    const model = { provider: selection.provider, model: selection.model };
    const generationByInteraction = new Map();
    const fault = options.injectedFailure
        ? failingFileSystem(options.injectedFailure.endsWith('write') ? 'write' : 'fsync')
        : undefined;
    let selectedSession;
    let driverContext;
    let beforeDecisionPort;
    const legacyFile = path.join(root, `${sessionId}.jsonl`);
    const legacyBytesBeforeOpen = resumedConversation && fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile) : null;
    const store = new LocalSessionStore({
        root,
        logger: logger,
        defaultWorkspace: workspace,
        defaultModel: model,
        admissionTtlMs: 60_000,
        ...(fault ? { fileSystem: fault.fileSystem } : {}),
        driverFactory: (context) => {
            driverContext = context;
            return sourceDriver(adapter, runtime, context, (decision) => {
                if (!beforeDecisionPort)
                    throw new Error('C2 decision port is not initialized');
                return beforeDecisionPort(decision);
            });
        },
    });
    selectedSession = resumedConversation
        ? await store.open(sessionId)
        : await store.createWithId(sessionId, workspace, model, undefined, metadata);
    if (legacyBytesBeforeOpen && !fs.readFileSync(legacyFile).equals(legacyBytesBeforeOpen)) {
        await selectedSession.close();
        throw new Error('opening a settled old CLI log changed bytes before the resumed append');
    }
    if (resumedConversation) {
        const projected = selectedSession.state().providerHistory;
        if (JSON.stringify(projected) !== JSON.stringify(resumedConversation.history)) {
            await selectedSession.close();
            throw new Error('C2 canonical replay differs from the source runner resume transcript');
        }
    }
    const buffered = [];
    let poison;
    let disposed = false;
    let currentTurnId = null;
    let currentRequestId = null;
    let admittedUserRef = null;
    let blockedRollbackDone = false;
    let pendingObservation = null;
    const assertHealthy = () => {
        if (poison !== undefined)
            throw poison;
        if (disposed)
            throw new Error('C2 proof persistence port is disposed');
    };
    const capture = (event) => {
        if (poison !== undefined)
            return;
        if (blockedRollbackDone && event.type === 'error')
            return;
        try {
            if (event.type === 'approval_resolved' && pendingObservation) {
                const expected = pendingObservation;
                const expectedAnswer = expected.answer === 'y' ? 'y' : 'n';
                if (event.answer !== expectedAnswer || (event.rejectionReason ?? undefined) !== expected.rejectionReason) {
                    throw new Error('source approval resolution did not match the C2-owned decision observation');
                }
                pendingObservation = null;
                return;
            }
            buffered.push(structuredClone(event));
        }
        catch (error) {
            poison = error;
        }
    };
    const commit = async (facts) => {
        assertHealthy();
        const all = [...buffered, ...facts];
        if (all.length) {
            try {
                const entries = await driverContext.commit(all);
                buffered.splice(0, all.length - facts.length);
                assertHealthy();
                return entries.slice(all.length - facts.length);
            }
            catch (error) {
                poison ??= error;
                throw poison;
            }
        }
        assertHealthy();
        return [];
    };
    const state = () => selectedSession.state();
    const port = {
        capture,
        admit: async ({ prompt, userMessageId }) => {
            assertHealthy();
            if (options.injectedFailure === 'write' || options.injectedFailure === 'fsync')
                fault?.arm();
            const requestId = crypto.randomUUID();
            const turnId = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            const expiresAt = new Date(Date.now() + 60_000).toISOString();
            currentTurnId = turnId;
            currentRequestId = requestId;
            blockedRollbackDone = false;
            const admitted = await commit([
                { type: 'user_message', message: { id: userMessageId, sender: 'user', text: prompt } },
                {
                    type: 'session_admitted',
                    version: 1,
                    clientRequestId: requestId,
                    normalizedBodyHash: normalizedHash(prompt),
                    turnId,
                    disposition: 'started',
                    createdAt,
                    expiresAt,
                },
                { type: 'session_turn_started', version: 1, turnId, clientRequestId: requestId },
            ]);
            admittedUserRef = admitted[0].ref;
        },
        beforeDecision: async ({ answer, rejectionReason, approvalAnswer, }) => {
            assertHealthy();
            const pending = state().pendingInteraction;
            const turnId = currentTurnId ?? state().activeTurnId;
            if (!pending || !turnId || pending.turnId !== turnId)
                throw new Error('no current C2 pending interaction');
            const identity = {
                turnId: pending.turnId,
                interactionId: pending.interaction.interactionId,
                revision: pending.interaction.revision,
                generation: pending.generation,
            };
            pendingObservation = { answer: answer === 'y' ? 'y' : 'n', ...(rejectionReason ? { rejectionReason } : {}) };
            const approvalResolved = {
                type: 'approval_resolved',
                answer: answer === 'y' ? 'y' : 'n',
                ...(rejectionReason ? { rejectionReason } : {}),
                ...(approvalAnswer ? { approvalAnswer } : {}),
            };
            await commit([
                approvalResolved,
                {
                    type: 'session_interaction_resolved',
                    version: 1,
                    ...identity,
                    outcome: 'answered',
                    answer: approvalAnswer ? { answers: [approvalAnswer] } : rejectionReason ? { rejectionReason } : {},
                },
            ]);
            if (options.decisionBarrierFile) {
                await fs.promises.writeFile(options.decisionBarrierFile, `${state().lastSeq}\n`);
                await new Promise(() => { });
            }
        },
        eventBoundary: async (event) => {
            assertHealthy();
            if (event.type === 'error' && event.droppedUserMessage && blockedRollbackDone)
                return;
            if (!currentTurnId && state().activeTurnId)
                currentTurnId = state().activeTurnId;
            if (!currentRequestId && currentTurnId) {
                currentRequestId =
                    Object.values(state().admissions).find((admission) => admission.turnId === currentTurnId)?.clientRequestId ??
                        null;
            }
            const facts = [];
            if (event.type === 'approval_required') {
                const snapshot = runtime.pendingInteraction.getSnapshot();
                if (!snapshot || snapshot.revision === undefined || !currentTurnId)
                    throw new Error('approval event lacks authoritative pending interaction snapshot');
                const interactionId = String(snapshot.interactionId);
                const generation = generationByInteraction.get(interactionId) ?? `interaction-${crypto.randomUUID()}`;
                generationByInteraction.set(interactionId, generation);
                const interaction = projectPendingInteraction(snapshot.approval, interactionId, snapshot.revision, snapshot.askUserAnswers, snapshot.currentAskUserQuestionIndex);
                facts.push({ type: 'session_interaction_pending', version: 1, turnId: currentTurnId, interaction, generation });
            }
            else if (event.type === 'final' || event.type === 'error') {
                if (currentTurnId && currentRequestId) {
                    if (event.type === 'error' && event.droppedUserMessage) {
                        if (!admittedUserRef)
                            throw new Error('blocked input lacks its admitted event reference');
                        facts.push({ type: 'events_retracted', version: 1, refs: [admittedUserRef] });
                        facts.push({
                            type: 'undo',
                            removedUserTurns: 1,
                            snapshot: runtime.state.exportState(),
                        });
                    }
                    const outcome = event.type === 'error'
                        ? 'failed'
                        : event.terminalCause === 'budget_exhausted'
                            ? 'budget_exhausted'
                            : 'completed';
                    facts.push({ type: 'session_turn_ended', version: 1, turnId: currentTurnId, outcome });
                    facts.push({
                        type: 'session_admission_settled',
                        version: 1,
                        clientRequestId: currentRequestId,
                        turnId: currentTurnId,
                        result: event.type === 'final' ? 'accepted' : 'failed',
                    });
                }
            }
            if (options.injectedFailure === 'boundary-write' || options.injectedFailure === 'boundary-fsync') {
                const target = options.injectedFailure === 'boundary-write' ? 'approval_required' : 'final';
                if (event.type === target)
                    fault?.arm();
            }
            await commit(facts);
            if (event.type === 'error' && event.droppedUserMessage)
                blockedRollbackDone = true;
            if (event.type === 'approval_required' && options.barrierFile) {
                await fs.promises.writeFile(options.barrierFile, `${state().lastSeq}\n`, { flag: 'w' });
                await new Promise(() => { });
            }
        },
        flush: async () => {
            assertHealthy();
            await commit([]);
        },
        assertHealthy,
        dispose: async () => {
            if (disposed)
                return;
            await selectedSession.close();
            disposed = true;
        },
    };
    beforeDecisionPort = port.beforeDecision;
    return port;
}
function failingFileSystem(kind) {
    let armed = false;
    let failed = false;
    const fileSystem = new Proxy(fs, {
        get(target, property) {
            if (property === 'writeSync' && kind === 'write') {
                return (...args) => {
                    if (armed && !failed) {
                        failed = true;
                        throw new Error('injected C2 write EIO');
                    }
                    return target.writeSync(...args);
                };
            }
            if (property === 'fsyncSync' && kind === 'fsync') {
                return (fd) => {
                    if (armed && !failed) {
                        failed = true;
                        throw new Error('injected C2 fsync EIO');
                    }
                    return target.fsyncSync(fd);
                };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return {
        fileSystem,
        arm: () => {
            armed = true;
        },
    };
}
function sourceDriver(adapter, runtime, context, persistDecision) {
    const listeners = new Set();
    return {
        submit: async (requestId, items) => {
            const admission = context.state().admissions[requestId];
            if (!admission)
                throw new Error('source driver received a request without a durable C2 admission');
            const text = items
                .map((item) => item.type === 'user_message'
                ? item.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
                : '')
                .join('\n');
            await adapter.sendMessage(text);
            return { kind: 'started', turnId: admission.turnId };
        },
        decide: async (decision) => {
            const current = context.state().pendingInteraction;
            if (!current ||
                current.turnId !== decision.turnId ||
                current.interaction.interactionId !== decision.interactionId ||
                current.interaction.revision !== decision.revision ||
                current.generation !== decision.generation)
                throw new Error('stale C2 interaction decision');
            const expectedCallId = current.interaction.descriptor.callId ?? current.interaction.interactionId;
            if (decision.decisions.length !== 1 || decision.decisions[0]?.callId !== expectedCallId) {
                throw new Error('C2 interaction decision does not match the pending tool call');
            }
            const answer = decision.decisions.every((item) => item.approve) ? 'y' : 'n';
            await persistDecision({ answer, rejectionReason: decision.decisions.find((item) => item.reason)?.reason });
            await adapter.handleApprovalDecision(answer, decision.decisions.find((item) => item.reason)?.reason);
        },
        cancel: async () => {
            adapter.abort();
        },
        retry: async () => {
            if (!runtime.state.retryLastUserTurn())
                throw new Error('no user turn is available to retry');
            const requestId = crypto.randomUUID();
            const turnId = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            await context.commit([
                {
                    type: 'session_admitted',
                    version: 1,
                    clientRequestId: requestId,
                    normalizedBodyHash: normalizedHash(runtime.state.exportState().history),
                    turnId,
                    disposition: 'started',
                    createdAt,
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
                { type: 'session_turn_started', version: 1, turnId, clientRequestId: requestId },
            ]);
            await adapter.sendMessage('', { replayFromHistory: true });
            return { kind: 'started', turnId: turnId };
        },
        compact: async () => {
            await runtime.compactContext();
        },
        setModel: async (model) => {
            runtime.settings.setModelSelection(model);
        },
        subscribe: (_fromSeq, listener) => {
            listeners.add(listener);
            const sink = (event) => {
                for (const callback of listeners)
                    callback({
                        kind: 'live',
                        turnId: context.state().activeTurnId ?? 'unknown',
                        event: event,
                    });
            };
            adapter.setEventSink(sink);
            return () => {
                listeners.delete(listener);
                if (!listeners.size)
                    adapter.setEventSink(null);
            };
        },
    };
}
function normalizedHash(prompt) {
    const canonical = (value) => Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value)
                .sort()
                .map((key) => [key, canonical(value[key])]))
            : value;
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(canonical(prompt)))
        .digest('hex');
}
//# sourceMappingURL=c2-proof-persistence.js.map