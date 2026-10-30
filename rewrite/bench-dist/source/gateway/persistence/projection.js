import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeLogEnvelope } from '../../services/conversation/conversation-decoder.js';
import { replayEvents } from '../../services/conversation/conversation-replay.js';
import { GatewayPersistenceError, TERMINAL_AGENT_EVENT_TYPES, } from './contracts.js';
import { fsyncDirectory } from './storage.js';
function quarantine(pathname, bytes, suffix) {
    const directory = path.join(path.dirname(pathname), 'corruption');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `${path.basename(pathname)}.${Date.now()}.${suffix}`), bytes, { mode: 0o600 });
}
function rewriteAndSync(pathname, content) {
    fs.writeFileSync(pathname, content, { mode: 0o600 });
    const fd = fs.openSync(pathname, 'r');
    try {
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fsyncDirectory(path.dirname(pathname));
}
function decodeLines(pathname, repairFinalTail) {
    const data = fs.readFileSync(pathname, 'utf8');
    const lines = data.split('\n');
    const envelopes = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const isLastWithoutNewline = index === lines.length - 1 && line.length > 0;
        if (!line.trim())
            continue;
        try {
            const envelope = decodeLogEnvelope(JSON.parse(line));
            if (!envelope || !Number.isSafeInteger(envelope.seq) || envelope.seq <= 0) {
                throw new GatewayPersistenceError('corrupt', 'term2 transcript contains an invalid sequence');
            }
            envelopes.push(envelope);
        }
        catch (error) {
            if (repairFinalTail && isLastWithoutNewline) {
                quarantine(pathname, Buffer.from(line, 'utf8'), 'tail');
                const valid = envelopes.map((envelope) => JSON.stringify(envelope) + '\n').join('');
                rewriteAndSync(pathname, valid);
                return { envelopes, warning: `${path.basename(pathname)} torn tail quarantined and repaired` };
            }
            throw error instanceof GatewayPersistenceError
                ? error
                : new GatewayPersistenceError('corrupt', `${path.basename(pathname)} contains invalid JSON`);
        }
    }
    return { envelopes, warning: null };
}
function readTerm2Envelopes(directory, expectedSessionId) {
    const canonicalPath = path.join(directory, 'term2.jsonl');
    if (!fs.existsSync(canonicalPath))
        return [];
    const canonical = decodeLines(canonicalPath, true);
    const all = [...canonical.envelopes];
    const deltaPath = path.join(directory, 'term2.deltas');
    if (fs.existsSync(deltaPath)) {
        try {
            all.push(...decodeLines(deltaPath, false).envelopes);
        }
        catch (error) {
            if (error instanceof GatewayPersistenceError) {
                quarantine(deltaPath, fs.readFileSync(deltaPath), 'corrupt');
                // A corrupt sidecar only loses an unsettled turn. The canonical prefix remains replayable.
            }
            else {
                throw new GatewayPersistenceError('corrupt', 'term2 delta sidecar is corrupt');
            }
        }
    }
    all.sort((a, b) => a.seq - b.seq);
    let previous = 0;
    for (const envelope of all) {
        if (envelope.seq <= previous)
            throw new GatewayPersistenceError('corrupt', 'term2 transcript sequence is duplicated');
        previous = envelope.seq;
        if (expectedSessionId &&
            envelope.event.type === 'session_init' &&
            'id' in envelope.event &&
            envelope.event.id !== expectedSessionId) {
            throw new GatewayPersistenceError('corrupt', 'term2 transcript belongs to another session');
        }
    }
    return all;
}
const WIRE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;
/**
 * The one raw tool call id -> wire id function. The web client accepts only
 * `WIRE_ID_PATTERN` ids, so every source (ledger, journal event, transcript,
 * projection) maps through here and agrees on the same card key. A conforming id
 * is unchanged; anything else (control characters, other punctuation, over 256
 * characters) becomes a sanitized stem plus a hash of the raw id, so two
 * different raw ids cannot meet. Idempotent: its output is a conforming id.
 */
export function wireCallId(raw) {
    if (WIRE_ID_PATTERN.test(raw))
        return raw;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    return `${raw.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 243)}-${hash}`;
}
function commandsFromJournal(events) {
    const commandsByTurn = new Map();
    const statusByTerminalEvent = new Map([
        ['turn_completed', 'completed'],
        ['turn_failed', 'failed'],
        ['turn_aborted', 'aborted'],
    ]);
    for (const event of events) {
        if (event.type === 'tool_started') {
            const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : null;
            const callId = typeof event.payload.callId === 'string' ? wireCallId(event.payload.callId) : null;
            const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName : null;
            if (!turnId || !callId || !toolName)
                continue;
            const commands = commandsByTurn.get(turnId) ?? [];
            if (!commands.some((command) => command.callId === callId) && commands.length < 64) {
                commands.push({ callId, toolName, status: 'unknown' });
            }
            commandsByTurn.set(turnId, commands);
            continue;
        }
        if (event.type === 'command_message') {
            const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : null;
            const callId = typeof event.payload.callId === 'string' ? wireCallId(event.payload.callId) : null;
            const commands = turnId ? commandsByTurn.get(turnId) : undefined;
            if (!turnId || !callId || !commands)
                continue;
            const output = typeof event.payload.output === 'string' ? event.payload.output : undefined;
            const error = typeof event.payload.error === 'string' ? event.payload.error : undefined;
            commandsByTurn.set(turnId, commands.map((command) => command.callId === callId
                ? { ...command, ...(output ? { output } : {}), ...(error ? { error } : {}) }
                : command));
            continue;
        }
        const status = statusByTerminalEvent.get(event.type);
        const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : null;
        if (!status || !turnId)
            continue;
        const commands = commandsByTurn.get(turnId);
        if (!commands)
            continue;
        commandsByTurn.set(turnId, commands.map((command) => ({ ...command, status })));
    }
    return commandsByTurn;
}
/**
 * Partial answer of every turn that ended in `turn_aborted`. An abort settles
 * only the journal, never the transcript, so this is the one durable copy of
 * the text the user saw. A turn whose `assistant_started` was compacted away
 * keeps an empty answer rather than a tail of it.
 */
const ABORTED_TEXT_MAX = 16_384;
function abortedTurnsFromJournal(events) {
    const textByTurn = new Map();
    const aborted = new Map();
    for (const event of events) {
        const turnId = typeof event.payload.turnId === 'string' ? event.payload.turnId : null;
        if (!turnId)
            continue;
        if (event.type === 'assistant_started')
            textByTurn.set(turnId, '');
        else if (event.type === 'text_delta' && typeof event.payload.delta === 'string') {
            const text = textByTurn.get(turnId);
            if (text !== undefined && text.length < ABORTED_TEXT_MAX)
                textByTurn.set(turnId, text + event.payload.delta);
        }
        else if (event.type === 'turn_aborted')
            aborted.set(turnId, (textByTurn.get(turnId) ?? '').slice(0, ABORTED_TEXT_MAX));
        else if (TERMINAL_AGENT_EVENT_TYPES.has(event.type))
            aborted.delete(turnId);
    }
    return aborted;
}
/**
 * Sequence just before the live turn's `assistant_started`, or null when the
 * turn has no retained start or already settled. A client that resumes from
 * here replays the turn's text, tools and usage instead of skipping them.
 */
function beforeLiveTurn(events, turnId) {
    let start = null;
    for (const event of events) {
        if (event.payload.turnId !== turnId)
            continue;
        if (event.type === 'assistant_started' && start === null)
            start = event.id;
        if (TERMINAL_AGENT_EVENT_TYPES.has(event.type))
            return null;
    }
    return start === null ? null : start - 1;
}
function transcriptHasReply(transcript, turnId) {
    const messages = transcript?.messages ?? [];
    const start = messages.findIndex((message) => message.sender === 'user' && message.id === turnId);
    if (start < 0)
        return false;
    for (const message of messages.slice(start + 1)) {
        if (message.sender === 'user')
            return false;
        if (message.sender === 'bot')
            return true;
    }
    return false;
}
function interactionFromJournal(journal) {
    let projection = null;
    const resolvedInteractionIds = new Set();
    for (const event of journal.events()) {
        if (event.type === 'interaction_resolved' && typeof event.payload.interactionId === 'string') {
            resolvedInteractionIds.add(event.payload.interactionId);
        }
        if (event.type === 'approval_required' ||
            event.type === 'interaction_updated' ||
            event.type === 'subagent_approval_required' ||
            event.type === 'subagent_question') {
            projection = {
                state: 'recovered',
                interaction: event.payload.interaction && typeof event.payload.interaction === 'object'
                    ? event.payload.interaction
                    : {},
                turnId: String(event.payload.turnId),
                resolvable: false,
                reason: 'daemon_restart',
            };
        }
        const recoveredInteractionId = event.type === 'interaction_recovered' &&
            event.payload.interaction &&
            typeof event.payload.interaction === 'object' &&
            typeof event.payload.interaction.interactionId === 'string'
            ? event.payload.interaction.interactionId
            : null;
        if (event.type === 'interaction_recovered' && !resolvedInteractionIds.has(recoveredInteractionId ?? '')) {
            projection = {
                state: 'recovered',
                interaction: event.payload.interaction && typeof event.payload.interaction === 'object'
                    ? event.payload.interaction
                    : {},
                turnId: String(event.payload.turnId),
                resolvable: false,
                reason: event.payload.reason === 'forced_shutdown' || event.payload.reason === 'persistence_recovery'
                    ? event.payload.reason
                    : 'daemon_restart',
            };
        }
        if (event.type === 'interaction_resolved' ||
            event.type === 'turn_completed' ||
            event.type === 'turn_aborted' ||
            event.type === 'turn_failed') {
            projection = null;
        }
    }
    return projection;
}
export function hydrateTranscript(directory, expectedSessionId) {
    const envelopes = readTerm2Envelopes(directory, expectedSessionId);
    if (envelopes.length === 0)
        return null;
    return replayEvents(envelopes);
}
export function hydrateConversationService(service, directory, expectedSessionId) {
    const restored = hydrateTranscript(directory, expectedSessionId);
    if (!restored)
        return null;
    service.importState({
        history: restored.history,
        previousResponseId: restored.previousResponseId,
        toolLedger: restored.toolLedger,
        updatedAt: restored.updatedAt,
    });
    return restored;
}
export async function createSessionProjectionSource(options) {
    const session = options.index.getForOwner(options.ownerUserId, options.sessionId);
    const highWater = options.journal.highWater();
    const journalEvents = options.journal.events();
    const journalCommands = commandsFromJournal(journalEvents);
    // The durable transcript records an assistant turn only when it settles, so
    // it covers every published journal event except those of a turn that is
    // still streaming. Report that coverage rather than the journal's optional
    // checkpoint, which may still be zero after restart/compaction.
    const directory = options.layout.existingSessionPath(session.ownerUserId, session.workspaceId, session.id);
    if (!directory)
        throw new GatewayPersistenceError('not_found', 'session persistence directory not found');
    const transcript = hydrateTranscript(directory, session.id);
    // The settled reply is written before the terminal journal event. Between the
    // two the transcript already holds the whole answer, so replaying its deltas
    // would duplicate it.
    const liveTurnFloor = options.activeTurnId && !transcriptHasReply(transcript, options.activeTurnId)
        ? beforeLiveTurn(journalEvents, options.activeTurnId)
        : null;
    const projectionSequence = liveTurnFloor === null
        ? Math.max(highWater.lastPublishedSequence, highWater.firstRetainedEventSequence, highWater.projectionSequence)
        : Math.max(liveTurnFloor, highWater.firstRetainedEventSequence);
    let interaction = interactionFromJournal(options.journal);
    const resolvedInteractionIds = new Set();
    for (const event of journalEvents) {
        if (event.type === 'interaction_resolved' && typeof event.payload.interactionId === 'string') {
            resolvedInteractionIds.add(event.payload.interactionId);
        }
    }
    if (options.liveInteraction) {
        try {
            const live = await options.liveInteraction();
            if (live)
                interaction = live;
        }
        catch {
            // A disposed runtime is represented by the non-resolvable recovery projection.
        }
    }
    return {
        session,
        latestSequence: highWater.lastPublishedSequence,
        earliestReplayableSequence: highWater.firstRetainedEventSequence,
        projectionSequence,
        journalCommands,
        abortedTurns: abortedTurnsFromJournal(journalEvents),
        transcript,
        interaction,
        resolvedInteractionIds,
        subscribeFrom: (after, listener) => options.journal.subscribeFrom(after, listener, session.transcriptGeneration),
    };
}
//# sourceMappingURL=projection.js.map