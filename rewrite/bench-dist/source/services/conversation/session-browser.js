import { browseConversationsForProject, getConversationSourceVersionReadOnly, getConversationsDirectoryVersionReadOnly, getConversationsDir, isConversationLocked, loadConversationForProjectReadOnly, loadConversationUnscopedForIndex, resolveConversationReference, uniqueConversationShortRefs, } from './conversation-persistence.js';
import { boundedJsonFailure, fitSerializedEnvelope, fitsSerializedText, safeUtf16Slice, } from '../../utils/output/bounded-json.js';
import { matchCenteredSnippet } from '../../utils/output/text-snippet.js';
import { createHash } from 'node:crypto';
import { SessionIndexService } from './session-index/session-index-service.js';
import { SessionIndexWorkerClient } from './session-index/session-index-worker-client.js';
import { SNIPPET_CHARS, scoreText, termsFor } from './session-search-helpers.js';
// Matches the default tool-result byte cap (output trim maxCharacters); a larger
// budget would only produce a bounded-failure envelope for non-scripted calls.
export const MAX_SESSION_BROWSER_CHARS = 40_000;
const DEFAULT_INDEX_CHARS = 12_000;
const DEFAULT_READ_CHARS = 12_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_READ_LIMIT = 20;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const KIND_ORDER = ['user', 'assistant', 'reasoning', 'system', 'tool', 'subagent'];
export class SessionBrowser {
    getContext;
    #cursorStates = new Map();
    #cursorHandles = new Map();
    #readSnapshot = null;
    #nextCursorId = 1;
    #backend;
    #indexService;
    #lazyIndexService = null;
    #canonicalWorker = null;
    #cursorPrefix;
    constructor(getContext, options) {
        this.getContext = getContext;
        this.#backend =
            options?.backend ?? (process.env['TERM2_SESSION_BROWSER_BACKEND'] === 'canonical' ? 'canonical' : 'indexed');
        this.#indexService = options?.indexService;
        this.#cursorPrefix = options?.cursorPrefix ?? 'c';
    }
    async close() {
        if (this.#canonicalWorker) {
            await this.#canonicalWorker.close();
            this.#canonicalWorker = null;
        }
        if (this.#indexService) {
            await this.#indexService.close();
        }
        if (this.#lazyIndexService) {
            await this.#lazyIndexService.close();
            this.#lazyIndexService = null;
        }
    }
    #getIndexService() {
        if (this.#indexService)
            return this.#indexService;
        if (!this.#lazyIndexService) {
            this.#lazyIndexService = new SessionIndexService();
        }
        return this.#lazyIndexService;
    }
    async #browseCanonicalInWorker(request) {
        this.#canonicalWorker ??= new SessionIndexWorkerClient();
        return this.#canonicalWorker.browseCanonical(getConversationsDir(), this.getContext(), request);
    }
    list(input) {
        if (this.#backend === 'indexed') {
            return this.#listIndexed(input);
        }
        return this.#listCanonical(input);
    }
    #pageListResult(scope, items, total, unavailable, limit, maxChars) {
        const budget = maxChars ?? DEFAULT_INDEX_CHARS;
        const selected = items.slice(0, clamp(limit, DEFAULT_LIMIT));
        const result = {
            sessions: [],
            scope,
            total,
            omitted: 0,
            unavailable,
        };
        for (const item of selected) {
            const candidate = fitted({ ...result, sessions: [...result.sessions, item], omitted: selected.length }, budget);
            if (candidate)
                result.sessions = candidate.sessions;
            else
                result.omitted++;
        }
        return fitted(result, budget) ?? outputBudgetError(budget);
    }
    #listCanonical(input) {
        const browsed = this.conversations();
        let unavailable = browsed.unavailable;
        const conversations = browsed.conversations;
        const shortRefs = uniqueConversationShortRefs(conversations);
        const candidates = [];
        for (const conversation of conversations) {
            const projection = project(conversation);
            if (!projection || !isBrowsableSession(conversation)) {
                unavailable++;
            }
            else {
                const firstUser = projection.records.find((record) => record.kind === 'user' && record.text);
                candidates.push({
                    id: conversation.id,
                    shortRef: shortRefs.get(conversation.id) ?? conversation.id,
                    createdAt: conversation.createdAt,
                    updatedAt: updatedAt(conversation),
                    ...(firstUser ? { firstUserMessage: prefixSnippet(firstUser.text) } : {}),
                    ...(conversation.model ? { model: conversation.model } : {}),
                    ...(conversation.provider ? { provider: conversation.provider } : {}),
                    messageCount: projection.records.length,
                });
            }
        }
        return this.#pageListResult(browsed.scope, candidates, candidates.length, unavailable, input.limit, input.maxChars);
    }
    async #listIndexed(input) {
        const service = this.#getIndexService();
        const context = this.getContext();
        const indexed = await service.list(context);
        if (indexed !== null) {
            return this.#pageListResult(indexed.scope, indexed.sessions, indexed.total, indexed.unavailable, input.limit, input.maxChars);
        }
        return this.#browseCanonicalInWorker({ operation: 'list', input });
    }
    search(input) {
        if (this.#backend === 'indexed') {
            return this.#searchIndexed(input);
        }
        return this.#searchCanonical(input);
    }
    #searchCanonical(input) {
        const terms = termsFor(input.query);
        const browsed = this.conversations();
        let unavailable = browsed.unavailable;
        const conversations = browsed.conversations;
        const shortRefs = uniqueConversationShortRefs(conversations);
        let skippedMessageCount = 0;
        const matches = [];
        for (const conversation of conversations) {
            const projection = project(conversation);
            if (!projection || !isBrowsableSession(conversation)) {
                unavailable++;
                continue;
            }
            skippedMessageCount += projection.skipped;
            for (const record of projection.records) {
                if (!record.text)
                    continue;
                const score = scoreText(record.text, terms);
                if (score)
                    matches.push({
                        sessionId: conversation.id,
                        shortRef: shortRefs.get(conversation.id) ?? conversation.id,
                        kind: record.kind,
                        messageIndex: record.index,
                        snippet: matchCenteredSnippet(record.text, terms, SNIPPET_CHARS),
                        updatedAt: updatedAt(conversation),
                        score,
                    });
            }
        }
        return this.#pageSearchResult(matches, browsed.scope, unavailable, skippedMessageCount, input.kinds, input.limit, input.maxChars);
    }
    async #searchIndexed(input) {
        const service = this.#getIndexService();
        const context = this.getContext();
        const indexed = await service.search(input.query, context);
        if (indexed !== null) {
            return this.#pageSearchResult(indexed.matches, indexed.scope, indexed.unavailable, indexed.skippedMessageCount, input.kinds, input.limit, input.maxChars);
        }
        return this.#browseCanonicalInWorker({ operation: 'search', input });
    }
    #pageSearchResult(matches, scope, unavailable, skippedMessageCount, kinds, limit, maxChars) {
        const budget = maxChars ?? DEFAULT_INDEX_CHARS;
        const includedKinds = kinds ? new Set(kinds) : null;
        matches = includedKinds ? matches.filter((match) => includedKinds.has(match.kind)) : matches;
        const currentSessionId = this.getContext().currentSessionId;
        matches.sort((a, b) => {
            // Demote the live session so its self-referential matches (the query text
            // appears in its own transcript while the agent is searching) cannot
            // crowd out older sessions by the updatedAt tie-break. Ordering only:
            // scoring and result contents are unchanged.
            const aCurrent = a.sessionId === currentSessionId ? 1 : 0;
            const bCurrent = b.sessionId === currentSessionId ? 1 : 0;
            if (aCurrent !== bCurrent)
                return aCurrent - bCurrent;
            return (b.score - a.score ||
                b.updatedAt.localeCompare(a.updatedAt) ||
                a.sessionId.localeCompare(b.sessionId) ||
                a.messageIndex - b.messageIndex);
        });
        const selected = matches.slice(0, clamp(limit, DEFAULT_LIMIT));
        const result = {
            results: [],
            scope,
            total: matches.length,
            omitted: 0,
            unavailable,
            skippedMessageCount,
        };
        for (const match of selected) {
            const { score: _, ...item } = match;
            const candidate = fitted({ ...result, results: [...result.results, item], omitted: selected.length }, budget);
            if (candidate)
                result.results = candidate.results;
            else
                result.omitted++;
        }
        return fitted(result, budget) ?? outputBudgetError(budget);
    }
    read(input) {
        if (this.#backend === 'indexed') {
            return this.#readIndexed(input);
        }
        return this.#readCanonical(input);
    }
    #readCanonical(input) {
        const budget = input.maxChars ?? DEFAULT_READ_CHARS;
        if (!SAFE_SESSION_ID.test(input.id))
            return boundedError('not_found', 'Session was not found.', budget);
        const anchorError = readAnchorError(input, budget);
        if (anchorError !== null)
            return anchorError;
        const context = this.getContext();
        const cached = input.cursor ? this.#snapshotForContinuation(input.cursor, input.id, context) : null;
        let conversation;
        let projection;
        let resolvedId;
        let shortRef;
        let currentRevision;
        if (cached) {
            ({ conversation, projection, shortRef, revision: currentRevision } = cached);
            resolvedId = conversation.id;
        }
        else {
            const browsed = this.conversations(input.id);
            const resolution = resolveSessionReference(input.id, browsed.conversations, context.currentSessionId);
            if (resolution.kind === 'ambiguous') {
                return (fitted({
                    error: {
                        code: 'ambiguous_reference',
                        message: 'Session reference is ambiguous; use a longer prefix or an exact ID.',
                        candidates: resolution.candidates,
                    },
                }, budget) ??
                    boundedError('ambiguous_reference', `Session reference is ambiguous. Candidates: ${resolution.candidates
                        .map((candidate) => candidate.shortRef)
                        .join(', ')}.`, budget));
            }
            if (resolution.kind === 'not_found')
                return boundedError('not_found', resolution.message, budget);
            resolvedId = resolution.id;
            const indexedConversation = browsed.conversations.find((candidate) => candidate.id === resolvedId);
            const indexedSourceVersion = browsed.sourceVersions.get(resolvedId);
            let sourceVersion;
            let canonicalConversation;
            if (indexedConversation &&
                indexedSourceVersion &&
                getConversationSourceVersionReadOnly(resolvedId) === indexedSourceVersion) {
                canonicalConversation = indexedConversation;
                sourceVersion = indexedSourceVersion;
            }
            else {
                const loaded = loadConversationForProjectReadOnly(resolvedId, context.projectPath, context.sshHost);
                if (loaded.status === 'not_found')
                    return boundedError('not_found', `Session was not found in scope ${context.projectPath}.`, budget);
                if (loaded.status === 'project_mismatch')
                    return boundedError('not_found', `Session exists but belongs to project ${loaded.conversation.projectPath}, which does not match the current scope (${context.projectPath}); it cannot be read from the current scope.`, budget);
                if (loaded.status !== 'loaded' || loaded.conversation.id !== resolvedId || !loaded.conversation.createdAt)
                    return boundedError('session_unavailable', 'Session transcript is unavailable.', budget);
                canonicalConversation = loaded.conversation;
                sourceVersion = loaded.sourceVersion;
            }
            const projected = project(canonicalConversation);
            if (!projected || !isBrowsableSession(canonicalConversation))
                return boundedError('session_unavailable', 'Session transcript is unavailable.', budget);
            conversation = canonicalConversation;
            projection = projected;
            shortRef =
                uniqueConversationShortRefs(browsed.conversations).get(canonicalConversation.id) ?? canonicalConversation.id;
            currentRevision = revision(canonicalConversation, projection);
            if (sourceVersion && browsed.directoryVersion) {
                const previousDependency = input.id === 'previous' && context.currentSessionId
                    ? browsed.sourceVersions.get(context.currentSessionId)
                    : undefined;
                this.#readSnapshot = {
                    contextKey: contextKey(context),
                    directoryVersion: browsed.directoryVersion,
                    sourceVersion,
                    conversation,
                    projection,
                    shortRef,
                    revision: currentRevision,
                    ...(context.currentSessionId && previousDependency
                        ? { previousDependency: { sessionId: context.currentSessionId, sourceVersion: previousDependency } }
                        : {}),
                };
            }
            else {
                this.#readSnapshot = null;
            }
        }
        return this.#pageReadResult(input, context, conversation, projection, shortRef, resolvedId, currentRevision);
    }
    async #readIndexed(input) {
        // Explicit references need only their filename-prefix collision bucket,
        // not a refresh of the whole project-wide search index. Keep canonical
        // replay off the main thread and its cursor state in the same worker.
        if ((!input.cursor && input.id !== 'previous') || input.cursor?.startsWith('f')) {
            return this.#browseCanonicalInWorker({ operation: 'read', input });
        }
        const budget = input.maxChars ?? DEFAULT_READ_CHARS;
        if (!SAFE_SESSION_ID.test(input.id))
            return boundedError('not_found', 'Session was not found.', budget);
        const anchorError = readAnchorError(input, budget);
        if (anchorError !== null)
            return anchorError;
        const context = this.getContext();
        const cached = input.cursor ? this.#snapshotForContinuation(input.cursor, input.id, context) : null;
        if (cached) {
            return this.#pageReadResult(input, context, cached.conversation, cached.projection, cached.shortRef, cached.conversation.id, cached.revision);
        }
        const service = this.#getIndexService();
        const resolution = await service.resolveReference(input.id, context);
        if (!resolution) {
            return this.#browseCanonicalInWorker({ operation: 'read', input });
        }
        if (resolution.kind === 'ambiguous') {
            return (fitted({
                error: {
                    code: 'ambiguous_reference',
                    message: 'Session reference is ambiguous; use a longer prefix or an exact ID.',
                    candidates: resolution.candidates,
                },
            }, budget) ??
                boundedError('ambiguous_reference', `Session reference is ambiguous. Candidates: ${resolution.candidates
                    .map((candidate) => candidate.shortRef)
                    .join(', ')}.`, budget));
        }
        if (resolution.kind === 'not_found') {
            return boundedError('not_found', resolution.message, budget);
        }
        const resolvedId = resolution.id;
        const sessionResult = await service.readSession(resolvedId, context);
        if (!sessionResult) {
            return this.#browseCanonicalInWorker({ operation: 'read', input });
        }
        if (sessionResult.kind === 'not_found') {
            return boundedError('not_found', `Session was not found in scope ${context.projectPath}.`, budget);
        }
        if (sessionResult.kind === 'project_mismatch') {
            return boundedError('not_found', `Session exists but belongs to project ${sessionResult.projectPath ?? 'undefined'}, which does not match the current scope (${context.projectPath}); it cannot be read from the current scope.`, budget);
        }
        if (sessionResult.kind === 'unavailable') {
            return boundedError('session_unavailable', 'Session transcript is unavailable.', budget);
        }
        const sessionData = sessionResult.session;
        const conversation = {
            id: sessionData.id,
            createdAt: sessionData.createdAt,
            updatedAt: sessionData.updatedAt,
            model: sessionData.model ?? undefined,
            provider: sessionData.provider ?? undefined,
            rolloverFrom: sessionData.predecessorId ?? undefined,
        };
        const projection = {
            records: sessionData.records,
            skipped: sessionData.skippedCount,
        };
        const shortRef = resolution.shortRef ?? conversation.id;
        const currentRevision = sessionData.projectionRevision;
        const dirVersion = getConversationsDirectoryVersionReadOnly();
        const sourceVersion = sessionData.sourceVersion;
        if (sourceVersion && dirVersion) {
            const previousDependency = input.id === 'previous' && context.currentSessionId
                ? getConversationSourceVersionReadOnly(context.currentSessionId) ?? undefined
                : undefined;
            this.#readSnapshot = {
                contextKey: contextKey(context),
                directoryVersion: dirVersion,
                sourceVersion,
                conversation,
                projection,
                shortRef,
                revision: currentRevision,
                ...(context.currentSessionId && previousDependency
                    ? { previousDependency: { sessionId: context.currentSessionId, sourceVersion: previousDependency } }
                    : {}),
            };
        }
        else {
            this.#readSnapshot = null;
        }
        return this.#pageReadResult(input, context, conversation, projection, shortRef, resolvedId, currentRevision);
    }
    #pageReadResult(input, context, conversation, projection, shortRef, resolvedId, currentRevision) {
        const budget = input.maxChars ?? DEFAULT_READ_CHARS;
        const currentUpdatedAt = updatedAt(conversation);
        const limit = clamp(input.limit, DEFAULT_READ_LIMIT);
        let cursor;
        let records;
        if (input.cursor) {
            const decoded = this.#decodeCursor(input.cursor, resolvedId);
            if (!decoded)
                return boundedError('invalid_cursor', invalidCursorMessage(), budget);
            if (decoded.updatedAt !== currentUpdatedAt || decoded.revision !== currentRevision)
                return boundedError('stale_cursor', staleCursorMessage(), budget);
            if ((input.kinds !== undefined && !sameKinds(normalizeKinds(input.kinds), decoded.kinds)) ||
                (input.itemMaxChars !== undefined && input.itemMaxChars !== decoded.itemMaxChars))
                return boundedError('invalid_cursor', viewMismatchMessage(), budget);
            cursor = decoded;
            records = viewRecords(projection.records, cursor);
            if (!validCursorPosition(cursor, records))
                return boundedError('invalid_cursor', invalidCursorMessage(), budget);
        }
        else {
            const view = { kinds: normalizeKinds(input.kinds), itemMaxChars: input.itemMaxChars ?? null };
            records = viewRecords(projection.records, view);
            cursor = {
                sessionId: resolvedId,
                updatedAt: currentUpdatedAt,
                revision: currentRevision,
                ...view,
                nextIndex: initialIndex(input, records, limit),
                nextTextOffset: 0,
            };
        }
        const cursorAt = (nextIndex, nextTextOffset) => this.#cursorFor({ ...cursor, nextIndex, nextTextOffset });
        const session = {
            id: conversation.id,
            shortRef,
            createdAt: conversation.createdAt,
            updatedAt: currentUpdatedAt,
            ...(conversation.model ? { model: conversation.model } : {}),
            ...(conversation.provider ? { provider: conversation.provider } : {}),
        };
        const items = [];
        let index = cursor.nextIndex;
        let offset = cursor.nextTextOffset;
        const total = projection.records.length;
        // `total` stays whole-session so `total - omitted === items.length` holds
        // on every view; `matched` sizes the filtered view.
        const counts = cursor.kinds ? { total, matched: records.length } : { total };
        while (index < records.length && items.length < limit) {
            const record = records[index];
            if (offset > record.text.length)
                return boundedError('invalid_cursor', invalidCursorMessage(), budget);
            const completeItem = pageItem(record, record.text.slice(offset), offset, true);
            const afterIndex = index + 1;
            const nextCursor = afterIndex < records.length ? cursorAt(afterIndex, 0) : undefined;
            const candidate = fitted({
                scope: context.projectPath,
                session,
                items: [...items, completeItem],
                ...(nextCursor ? { nextCursor } : {}),
                ...counts,
                omitted: total,
                skippedMessageCount: projection.skipped,
            }, budget);
            if (candidate) {
                items.push(completeItem);
                index = afterIndex;
                offset = 0;
                continue;
            }
            // Preserve source order: once fitting records already occupy this page,
            // leave the next record for its own page rather than making an earlier
            // page invalid by trying to append a partial later record.
            if (items.length > 0)
                break;
            if (record.text.length === offset)
                return outputBudgetError(budget);
            const chunk = largestChunk(record, offset, (text) => {
                const next = cursorAt(index, offset + text.length);
                return fitted({
                    scope: context.projectPath,
                    session,
                    items: [...items, pageItem(record, text, offset, false)],
                    nextCursor: next,
                    ...counts,
                    omitted: total,
                    skippedMessageCount: projection.skipped,
                }, budget);
            });
            if (!chunk)
                return outputBudgetError(budget);
            items.push(pageItem(record, chunk, offset, false));
            offset += chunk.length;
            break;
        }
        const nextCursor = index < records.length ? cursorAt(index, offset) : undefined;
        // Page-local counts: every record represented on this page counts once,
        // whether complete or a partial/resumed chunk, so on every page shape
        // `total - omitted === items.length`.
        const omitted = total - items.length;
        return (fitted({
            scope: context.projectPath,
            session,
            items,
            ...(nextCursor ? { nextCursor } : {}),
            ...counts,
            omitted,
            skippedMessageCount: projection.skipped,
        }, budget) ?? outputBudgetError(budget));
    }
    #snapshotForContinuation(cursorHandle, inputId, context) {
        if (!/^[cf][0-9a-z]+$/.test(cursorHandle))
            return null;
        const cursor = this.#cursorStates.get(cursorHandle);
        const snapshot = this.#readSnapshot;
        if (!cursor || !snapshot || cursor.sessionId !== snapshot.conversation.id)
            return null;
        // Reuse is authorization-neutral: the exact context that authorized the
        // snapshot must still be active, and every persistence source that can
        // affect this page must still have the same cheap filesystem version.
        if (snapshot.contextKey !== contextKey(context))
            return null;
        if (getConversationsDirectoryVersionReadOnly() !== snapshot.directoryVersion)
            return null;
        if (getConversationSourceVersionReadOnly(cursor.sessionId) !== snapshot.sourceVersion)
            return null;
        if (inputId !== cursor.sessionId) {
            const dependency = snapshot.previousDependency;
            if (inputId !== 'previous' ||
                !dependency ||
                dependency.sessionId !== context.currentSessionId ||
                getConversationSourceVersionReadOnly(dependency.sessionId) !== dependency.sourceVersion)
                return null;
        }
        return snapshot;
    }
    #cursorFor(state) {
        const stateKey = JSON.stringify(state);
        const existing = this.#cursorHandles.get(stateKey);
        if (existing)
            return existing;
        const handle = `${this.#cursorPrefix}${this.#nextCursorId.toString(36)}`;
        this.#nextCursorId++;
        this.#cursorStates.set(handle, state);
        this.#cursorHandles.set(stateKey, handle);
        return handle;
    }
    #decodeCursor(cursor, id) {
        if (!/^[cf][0-9a-z]+$/.test(cursor))
            return null;
        const state = this.#cursorStates.get(cursor);
        return state?.sessionId === id ? state : null;
    }
    conversations(reference) {
        const context = this.getContext();
        // Include the whole minimum-short-ref collision bucket, even for exact
        // IDs, so short refs and ambiguity match a full scoped catalog.
        // `previous` still needs all sessions for predecessor/recency selection.
        const idPrefix = reference && reference !== 'previous' ? reference.slice(0, 8) : undefined;
        const result = browseConversationsForProject(context.projectPath, context.sshHost, idPrefix);
        return {
            unavailable: result.unavailable,
            scope: context.projectPath,
            sourceVersions: result.sourceVersions,
            directoryVersion: result.directoryVersion,
            conversations: result.conversations.sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)) || a.id.localeCompare(b.id)),
        };
    }
}
const PREVIOUS_UNAVAILABLE_MESSAGE = 'The current session is unknown, so "previous" cannot be resolved; use session_list to find the session.';
const NO_OTHER_SESSION_MESSAGE = 'This session has no rollover predecessor and no other session exists in this scope.';
const ONLY_RUNNING_SESSIONS_MESSAGE = 'This session has no rollover predecessor and every other session in this scope is still running, so "previous" cannot be inferred; use session_list to find the session.';
const CURRENT_OUT_OF_SCOPE_MESSAGE = 'This session has no rollover predecessor and is not in this scope, so "previous" cannot be inferred; use session_list to find the session.';
/**
 * A session another live process is still writing. The project scope spans
 * every worktree, so the newest other session is often a concurrently running
 * sibling rather than anything this session continues; the recency fallback
 * for "previous" skips those.
 */
function isRunningElsewhere(sessionId) {
    return isConversationLocked(sessionId)?.status === 'held';
}
function resolveSessionReference(reference, conversations, currentSessionId) {
    if (reference === 'previous') {
        // Without a known live session the newest session may be the live one
        // itself, so the recency fallback is only safe when it can be excluded.
        if (!currentSessionId)
            return { kind: 'not_found', message: PREVIOUS_UNAVAILABLE_MESSAGE };
        const current = conversations.find((conversation) => conversation.id === currentSessionId);
        if (current?.rolloverFrom)
            return { kind: 'resolved', id: current.rolloverFrom };
        if (!current) {
            // The live session's own record names its predecessor even when it was
            // persisted outside this scope; the predecessor read stays scope-checked.
            const own = loadConversationUnscopedForIndex(currentSessionId);
            if (own.status === 'loaded' && own.conversation.rolloverFrom)
                return { kind: 'resolved', id: own.conversation.rolloverFrom };
            // A recency guess from outside the scope is likely a concurrent sibling.
            return { kind: 'not_found', message: CURRENT_OUT_OF_SCOPE_MESSAGE };
        }
        // `conversations` is already ordered most recently updated first, matching session_list.
        const others = conversations.filter((conversation) => conversation.id !== currentSessionId && isBrowsableSession(conversation) && project(conversation) !== null);
        if (others.length === 0)
            return { kind: 'not_found', message: NO_OTHER_SESSION_MESSAGE };
        const fallback = others.find((conversation) => !isRunningElsewhere(conversation.id));
        if (!fallback)
            return { kind: 'not_found', message: ONLY_RUNNING_SESSIONS_MESSAGE };
        return { kind: 'resolved', id: fallback.id };
    }
    return resolveConversationReference(reference, conversations);
}
function project(conversation) {
    const records = [];
    let skipped = 0;
    for (let index = 0; index < conversation.messages.length; index++) {
        const message = conversation.messages[index];
        switch (message.sender) {
            case 'user':
                if (typeof message.text !== 'string')
                    return null;
                records.push({ index, kind: 'user', text: message.text });
                break;
            case 'bot':
                if (typeof message.text !== 'string')
                    return null;
                records.push({ index, kind: 'assistant', text: message.text });
                break;
            case 'reasoning':
                if (typeof message.text !== 'string')
                    return null;
                records.push({ index, kind: 'reasoning', text: message.text });
                break;
            case 'system':
                if (typeof message.text !== 'string')
                    return null;
                records.push({ index, kind: 'system', text: message.text });
                break;
            case 'command':
                if (typeof message.command !== 'string' || (message.output !== undefined && typeof message.output !== 'string'))
                    return null;
                records.push({
                    index,
                    kind: 'tool',
                    ...(message.toolName ? { toolName: message.toolName } : {}),
                    text: message.output ? `${message.command}\n${message.output}` : message.command,
                });
                break;
            case 'subagent':
                if (typeof message.task !== 'string' ||
                    (message.finalText !== undefined && typeof message.finalText !== 'string'))
                    return null;
                records.push({
                    index,
                    kind: 'subagent',
                    text: message.finalText !== undefined ? `${message.task}\n${message.finalText}` : message.task,
                });
                break;
            default:
                skipped++;
        }
    }
    return { records, skipped };
}
function updatedAt(conversation) {
    return conversation.updatedAt ?? conversation.createdAt;
}
function contextKey(context) {
    return JSON.stringify([context.projectPath, context.sshHost ?? null, context.currentSessionId ?? null]);
}
function clamp(value, fallback) {
    return Math.max(1, Math.min(50, value ?? fallback));
}
function prefixSnippet(text) {
    if (text.length <= SNIPPET_CHARS)
        return text;
    return `${safeUtf16Slice(text, 0, SNIPPET_CHARS - 1)}…`;
}
function pageItem(record, text, textOffset, complete) {
    return {
        index: record.index,
        kind: record.kind,
        ...(record.toolName ? { toolName: record.toolName } : {}),
        text,
        textOffset,
        totalTextChars: record.fullTextChars ?? record.text.length,
        complete,
        ...(record.fullTextChars !== undefined ? { truncated: true } : {}),
    };
}
function readAnchorError(input, budget) {
    if (input.cursor !== undefined && input.from === 'end')
        return boundedError('invalid_cursor', 'The `from: "end"` anchor is only valid on an initial read.', budget);
    if (input.cursor !== undefined && input.index !== undefined)
        return boundedError('invalid_cursor', 'An `index` seek is only valid on an initial read; omit `cursor`.', budget);
    if (input.from === 'end' && input.index !== undefined)
        return boundedError('invalid_cursor', 'Anchor an initial read with `index` or `from: "end"`, not both.', budget);
    return null;
}
function normalizeKinds(kinds) {
    return kinds ? KIND_ORDER.filter((kind) => kinds.includes(kind)) : null;
}
function sameKinds(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function viewRecords(records, view) {
    const kinds = view.kinds;
    const selected = kinds ? records.filter((record) => kinds.includes(record.kind)) : records;
    const cap = view.itemMaxChars;
    if (cap === null)
        return selected;
    return selected.map((record) => record.text.length > cap
        ? { ...record, text: safeUtf16Slice(record.text, 0, cap), fullTextChars: record.text.length }
        : record);
}
function initialIndex(input, records, limit) {
    // The tail anchor is a region, not a record: start at the last `limit`
    // records of the view so last-N access works through the forward cursor.
    if (input.from === 'end')
        return Math.max(0, records.length - limit);
    if (input.index === undefined)
        return 0;
    const seek = input.index;
    const at = records.findIndex((record) => record.index >= seek);
    return Math.max(0, (at === -1 ? records.length : at) - (input.before ?? 0));
}
function viewMismatchMessage() {
    return 'This cursor was issued with different `kinds` or `itemMaxChars`; omit them or repeat the original values on continuation.';
}
function fitted(value, maxChars) {
    const result = fitSerializedEnvelope((charsUsed) => ({ ...value, charsUsed }), { maxChars });
    return result?.value ?? null;
}
function outputBudgetError(maxChars) {
    return boundedError('output_budget_exceeded', 'The requested result cannot fit in the output budget.', maxChars);
}
function invalidCursorMessage() {
    return 'The session cursor is invalid. Use exactly the nextCursor returned by the preceding page with the same id. Restart without a cursor if that handle is unavailable.';
}
function staleCursorMessage() {
    return 'The session cursor is stale because the session changed. Restart without a cursor to read the current transcript.';
}
function boundedError(code, message, maxChars) {
    const value = { error: { code, message } };
    if (fitsSerializedText(JSON.stringify(value), { maxChars }))
        return value;
    const fallback = boundedJsonFailure({ maxChars });
    return fallback ? JSON.parse(fallback) : 0;
}
function largestChunk(record, offset, fits) {
    let low = 1;
    let high = record.text.length - offset;
    let best = '';
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const text = safeUtf16Slice(record.text, offset, offset + middle);
        if (text && fits(text)) {
            best = text;
            low = middle + 1;
        }
        else
            high = middle - 1;
    }
    return best;
}
function isBrowsableSession(conversation) {
    return (SAFE_SESSION_ID.test(conversation.id) &&
        isUtcTimestamp(conversation.createdAt) &&
        isUtcTimestamp(updatedAt(conversation)) &&
        (conversation.model === undefined || typeof conversation.model === 'string') &&
        (conversation.provider === undefined || typeof conversation.provider === 'string'));
}
function validCursorPosition(cursor, records) {
    if (cursor.nextIndex > records.length)
        return false;
    if (cursor.nextIndex === records.length)
        return false;
    const text = records[cursor.nextIndex].text;
    if (cursor.nextTextOffset === 0)
        return true;
    if (cursor.nextTextOffset >= text.length)
        return false;
    return !(isHighSurrogate(text.charCodeAt(cursor.nextTextOffset - 1)) &&
        isLowSurrogate(text.charCodeAt(cursor.nextTextOffset)));
}
function revision(conversation, projection) {
    return createHash('sha256')
        .update(JSON.stringify({
        id: conversation.id,
        createdAt: conversation.createdAt,
        model: conversation.model,
        provider: conversation.provider,
        records: projection.records,
        skipped: projection.skipped,
    }))
        .digest()
        .subarray(0, 12)
        .toString('base64url');
}
function isUtcTimestamp(value) {
    return (typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        !Number.isNaN(Date.parse(value)));
}
function isHighSurrogate(value) {
    return value >= 0xd800 && value <= 0xdbff;
}
function isLowSurrogate(value) {
    return value >= 0xdc00 && value <= 0xdfff;
}
export { project as projectMessages, updatedAt as sessionUpdatedAt, revision as sessionRevision, isBrowsableSession, prefixSnippet, PREVIOUS_UNAVAILABLE_MESSAGE, NO_OTHER_SESSION_MESSAGE, ONLY_RUNNING_SESSIONS_MESSAGE, CURRENT_OUT_OF_SCOPE_MESSAGE, isRunningElsewhere, };
//# sourceMappingURL=session-browser.js.map