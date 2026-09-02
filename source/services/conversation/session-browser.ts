import {
  browseConversationsForProject,
  loadConversationForProjectReadOnly,
  resolveConversationReference,
  uniqueConversationShortRefs,
  type RestoredState,
} from './conversation-persistence.js';
import {
  boundedJsonFailure,
  fitSerializedEnvelope,
  fitsSerializedText,
  safeUtf16Slice,
} from '../../utils/output/bounded-json.js';
import { matchCenteredSnippet } from '../../utils/output/text-snippet.js';
import { createHash } from 'node:crypto';

export const MIN_SESSION_BROWSER_CHARS = 512;
export const MAX_SESSION_BROWSER_CHARS = 12_000;
const DEFAULT_INDEX_CHARS = 12_000;
const DEFAULT_READ_CHARS = 12_000;
const DEFAULT_LIMIT = 10;
const DEFAULT_READ_LIMIT = 20;
const SNIPPET_CHARS = 240;
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type SessionBrowserContext = { projectPath: string; sshHost?: string; currentSessionId?: string };
type Kind = 'user' | 'assistant' | 'reasoning' | 'system' | 'tool' | 'subagent';
type ProjectedMessage = { index: number; kind: Kind; text: string };
type BrowserError = {
  error: {
    code:
      | 'not_found'
      | 'ambiguous_reference'
      | 'session_unavailable'
      | 'invalid_cursor'
      | 'stale_cursor'
      | 'output_budget_exceeded';
    message: string;
    candidates?: Array<{ id: string; shortRef: string }>;
  };
};
type CursorState = {
  sessionId: string;
  updatedAt: string;
  revision: string;
  nextIndex: number;
  nextTextOffset: number;
};

export type SessionListInput = { limit?: number; maxChars?: number };
export type SessionSearchInput = { query: string; limit?: number; maxChars?: number };
export type SessionReadInput = { id: string; cursor?: string; limit?: number; maxChars?: number };

export class SessionBrowser {
  readonly #cursorStates = new Map<string, CursorState>();
  readonly #cursorHandles = new Map<string, string>();
  #nextCursorId = 1;

  constructor(private readonly getContext: () => SessionBrowserContext) {}

  list(input: SessionListInput) {
    const budget = input.maxChars ?? DEFAULT_INDEX_CHARS;
    const browsed = this.conversations();
    let unavailable = browsed.unavailable;
    const conversations = browsed.conversations;
    const shortRefs = uniqueConversationShortRefs(conversations);
    const candidates: Array<{ conversation: RestoredState; projection: NonNullable<ReturnType<typeof project>> }> = [];
    for (const conversation of conversations) {
      const projection = project(conversation);
      if (!projection || !isBrowsableSession(conversation)) unavailable++;
      else candidates.push({ conversation, projection });
    }
    const selected = candidates.slice(0, clamp(input.limit, DEFAULT_LIMIT));
    const result = {
      sessions: [] as Array<Record<string, unknown>>,
      scope: browsed.scope,
      total: candidates.length,
      omitted: 0,
      unavailable,
    };
    for (const { conversation, projection } of selected) {
      const firstUser = projection.records.find((record) => record.kind === 'user' && record.text);
      const item = {
        id: conversation.id,
        shortRef: shortRefs.get(conversation.id) ?? conversation.id,
        createdAt: conversation.createdAt,
        updatedAt: updatedAt(conversation),
        ...(firstUser ? { firstUserMessage: prefixSnippet(firstUser.text) } : {}),
        ...(conversation.model ? { model: conversation.model } : {}),
        ...(conversation.provider ? { provider: conversation.provider } : {}),
        messageCount: projection.records.length,
      };
      const candidate = fitted({ ...result, sessions: [...result.sessions, item], omitted: selected.length }, budget);
      if (candidate) result.sessions = candidate.sessions;
      else result.omitted++;
    }
    return fitted(result, budget) ?? outputBudgetError(budget);
  }

  search(input: SessionSearchInput) {
    const budget = input.maxChars ?? DEFAULT_INDEX_CHARS;
    const terms = termsFor(input.query);
    const browsed = this.conversations();
    let unavailable = browsed.unavailable;
    const conversations = browsed.conversations;
    const shortRefs = uniqueConversationShortRefs(conversations);
    let skippedMessageCount = 0;
    const currentSessionId = this.getContext().currentSessionId;
    const matches: Array<{
      sessionId: string;
      shortRef: string;
      kind: Kind;
      messageIndex: number;
      snippet: { text: string; truncated: boolean };
      updatedAt: string;
      score: number;
    }> = [];
    for (const conversation of conversations) {
      const projection = project(conversation);
      if (!projection || !isBrowsableSession(conversation)) {
        unavailable++;
        continue;
      }
      skippedMessageCount += projection.skipped;
      for (const record of projection.records) {
        if (!record.text) continue;
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
    matches.sort((a, b) => {
      // Demote the live session so its self-referential matches (the query text
      // appears in its own transcript while the agent is searching) cannot
      // crowd out older sessions by the updatedAt tie-break. Ordering only:
      // scoring and result contents are unchanged.
      const aCurrent = a.sessionId === currentSessionId ? 1 : 0;
      const bCurrent = b.sessionId === currentSessionId ? 1 : 0;
      if (aCurrent !== bCurrent) return aCurrent - bCurrent;
      return (
        b.score - a.score ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.messageIndex - b.messageIndex
      );
    });
    const selected = matches.slice(0, clamp(input.limit, DEFAULT_LIMIT));
    const result = {
      results: [] as Array<Record<string, unknown>>,
      scope: browsed.scope,
      total: matches.length,
      omitted: 0,
      unavailable,
      skippedMessageCount,
    };
    for (const match of selected) {
      const { score: _, ...item } = match;
      const candidate = fitted({ ...result, results: [...result.results, item], omitted: selected.length }, budget);
      if (candidate) result.results = candidate.results;
      else result.omitted++;
    }
    return fitted(result, budget) ?? outputBudgetError(budget);
  }

  read(input: SessionReadInput): unknown {
    const budget = input.maxChars ?? DEFAULT_READ_CHARS;
    if (!SAFE_SESSION_ID.test(input.id)) return boundedError('not_found', 'Session was not found.', budget);
    const context = this.getContext();
    const browsed = this.conversations();
    const resolution = resolveSessionReference(input.id, browsed.conversations, context.currentSessionId);
    if (resolution.kind === 'ambiguous') {
      return (
        fitted(
          {
            error: {
              code: 'ambiguous_reference',
              message: 'Session reference is ambiguous; use a longer prefix or an exact ID.',
              candidates: resolution.candidates,
            },
          },
          budget,
        ) ??
        boundedError(
          'ambiguous_reference',
          `Session reference is ambiguous. Candidates: ${resolution.candidates
            .map((candidate) => candidate.shortRef)
            .join(', ')}.`,
          budget,
        )
      );
    }
    if (resolution.kind === 'not_found') return boundedError('not_found', resolution.message, budget);
    const resolvedId = resolution.id;
    const loaded = loadConversationForProjectReadOnly(resolvedId, context.projectPath, context.sshHost);
    if (loaded.status === 'not_found')
      return boundedError('not_found', `Session was not found in scope ${context.projectPath}.`, budget);
    if (loaded.status === 'project_mismatch')
      return boundedError(
        'not_found',
        `Session exists but belongs to project ${loaded.conversation.projectPath}, which does not match the current scope (${context.projectPath}); it cannot be read from the current scope.`,
        budget,
      );
    if (loaded.status !== 'loaded' || loaded.conversation.id !== resolvedId || !loaded.conversation.createdAt)
      return boundedError('session_unavailable', 'Session transcript is unavailable.', budget);
    const conversation = loaded.conversation;
    const projection = project(conversation);
    if (!projection || !isBrowsableSession(conversation))
      return boundedError('session_unavailable', 'Session transcript is unavailable.', budget);
    const currentUpdatedAt = updatedAt(conversation);
    const currentRevision = revision(conversation, projection);
    const cursor: CursorState | null = input.cursor
      ? this.#decodeCursor(input.cursor, resolvedId)
      : {
          sessionId: resolvedId,
          updatedAt: currentUpdatedAt,
          revision: currentRevision,
          nextIndex: 0,
          nextTextOffset: 0,
        };
    if (!cursor) return boundedError('invalid_cursor', 'The session cursor is invalid.', budget);
    if (input.cursor && (cursor.updatedAt !== currentUpdatedAt || cursor.revision !== currentRevision))
      return boundedError('stale_cursor', 'The session cursor is stale.', budget);
    if (input.cursor && !validCursorPosition(cursor, projection.records))
      return boundedError('invalid_cursor', 'The session cursor is invalid.', budget);
    const session = {
      id: conversation.id,
      shortRef: uniqueConversationShortRefs(browsed.conversations).get(conversation.id) ?? conversation.id,
      createdAt: conversation.createdAt,
      updatedAt: currentUpdatedAt,
      ...(conversation.model ? { model: conversation.model } : {}),
      ...(conversation.provider ? { provider: conversation.provider } : {}),
    };
    const items: Array<Record<string, unknown>> = [];
    let index = cursor.nextIndex;
    let offset = cursor.nextTextOffset;
    const total = projection.records.length;
    const limit = clamp(input.limit, DEFAULT_READ_LIMIT);
    while (index < projection.records.length && items.length < limit) {
      const record = projection.records[index]!;
      if (offset > record.text.length) return boundedError('invalid_cursor', 'The session cursor is invalid.', budget);
      const completeItem = pageItem(record, record.text.slice(offset), offset, true);
      const afterIndex = index + 1;
      const nextCursor =
        afterIndex < projection.records.length
          ? this.#cursorFor(resolvedId, currentUpdatedAt, currentRevision, afterIndex, 0)
          : undefined;
      const candidate = fitted(
        {
          scope: context.projectPath,
          session,
          items: [...items, completeItem],
          ...(nextCursor ? { nextCursor } : {}),
          total,
          omitted: total,
          skippedMessageCount: projection.skipped,
        },
        budget,
      );
      if (candidate) {
        items.push(completeItem);
        index = afterIndex;
        offset = 0;
        continue;
      }
      // Preserve source order: once fitting records already occupy this page,
      // leave the next record for its own page rather than making an earlier
      // page invalid by trying to append a partial later record.
      if (items.length > 0) break;
      if (record.text.length === offset) return outputBudgetError(budget);
      const chunk = largestChunk(record, offset, (text) => {
        const next = this.#cursorFor(resolvedId, currentUpdatedAt, currentRevision, index, offset + text.length);
        return fitted(
          {
            scope: context.projectPath,
            session,
            items: [...items, pageItem(record, text, offset, false)],
            nextCursor: next,
            total,
            omitted: total,
            skippedMessageCount: projection.skipped,
          },
          budget,
        );
      });
      if (!chunk) return outputBudgetError(budget);
      items.push(pageItem(record, chunk, offset, false));
      offset += chunk.length;
      break;
    }
    const nextCursor =
      index < total ? this.#cursorFor(resolvedId, currentUpdatedAt, currentRevision, index, offset) : undefined;
    // Records begun in this page are total - omitted. A mid-record chunk (the
    // cursor offset is nonzero) began its own record, so it is not counted as
    // omitted; every later record is.
    const omitted = total - index - (offset > 0 ? 1 : 0);
    return (
      fitted(
        {
          scope: context.projectPath,
          session,
          items,
          ...(nextCursor ? { nextCursor } : {}),
          total,
          omitted,
          skippedMessageCount: projection.skipped,
        },
        budget,
      ) ?? outputBudgetError(budget)
    );
  }

  #cursorFor(sessionId: string, updatedAt: string, revision: string, nextIndex: number, nextTextOffset: number) {
    const state = { sessionId, updatedAt, revision, nextIndex, nextTextOffset };
    const stateKey = JSON.stringify(state);
    const existing = this.#cursorHandles.get(stateKey);
    if (existing) return existing;
    const handle = `c${this.#nextCursorId.toString(36)}`;
    this.#nextCursorId++;
    this.#cursorStates.set(handle, state);
    this.#cursorHandles.set(stateKey, handle);
    return handle;
  }

  #decodeCursor(cursor: string, id: string): CursorState | null {
    if (!/^c[0-9a-z]+$/.test(cursor)) return null;
    const state = this.#cursorStates.get(cursor);
    return state?.sessionId === id ? state : null;
  }

  private conversations() {
    const context = this.getContext();
    const result = browseConversationsForProject(context.projectPath, context.sshHost);
    return {
      unavailable: result.unavailable,
      scope: context.projectPath,
      conversations: result.conversations.sort(
        (a, b) => updatedAt(b).localeCompare(updatedAt(a)) || a.id.localeCompare(b.id),
      ),
    };
  }
}

type SessionReferenceResolution =
  | { kind: 'resolved'; id: string }
  | { kind: 'not_found'; message: string }
  | { kind: 'ambiguous'; candidates: Array<{ id: string; shortRef: string }> };

function resolveSessionReference(
  reference: string,
  conversations: readonly RestoredState[],
  currentSessionId?: string,
): SessionReferenceResolution {
  if (reference === 'previous') {
    const current = conversations.find((conversation) => conversation.id === currentSessionId);
    if (!current?.rolloverFrom) {
      return { kind: 'not_found', message: 'This session has no persisted rollover predecessor.' };
    }
    return { kind: 'resolved', id: current.rolloverFrom };
  }

  return resolveConversationReference(reference, conversations);
}

function project(conversation: RestoredState) {
  const records: ProjectedMessage[] = [];
  let skipped = 0;
  for (let index = 0; index < conversation.messages.length; index++) {
    const message = conversation.messages[index]!;
    switch (message.sender) {
      case 'user':
        if (typeof message.text !== 'string') return null;
        records.push({ index, kind: 'user', text: message.text });
        break;
      case 'bot':
        if (typeof message.text !== 'string') return null;
        records.push({ index, kind: 'assistant', text: message.text });
        break;
      case 'reasoning':
        if (typeof message.text !== 'string') return null;
        records.push({ index, kind: 'reasoning', text: message.text });
        break;
      case 'system':
        if (typeof message.text !== 'string') return null;
        records.push({ index, kind: 'system', text: message.text });
        break;
      case 'command':
        if (typeof message.command !== 'string' || (message.output !== undefined && typeof message.output !== 'string'))
          return null;
        records.push({
          index,
          kind: 'tool',
          text: message.output ? `${message.command}\n${message.output}` : message.command,
        });
        break;
      case 'subagent':
        if (
          typeof message.task !== 'string' ||
          (message.finalText !== undefined && typeof message.finalText !== 'string')
        )
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

function updatedAt(conversation: RestoredState) {
  return conversation.updatedAt ?? conversation.createdAt;
}
function clamp(value: number | undefined, fallback: number) {
  return Math.max(1, Math.min(50, value ?? fallback));
}
function termsFor(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => term.toLowerCase());
}
function scoreText(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  return terms.reduce(
    (total, term) => total + (lower === term ? 100 : lower.startsWith(term) ? 20 : lower.includes(term) ? 2 : 0),
    0,
  );
}
function prefixSnippet(text: string) {
  if (text.length <= SNIPPET_CHARS) return text;
  return `${safeUtf16Slice(text, 0, SNIPPET_CHARS - 1)}…`;
}
function pageItem(record: ProjectedMessage, text: string, textOffset: number, complete: boolean) {
  return { index: record.index, kind: record.kind, text, textOffset, totalTextChars: record.text.length, complete };
}
function fitted<T extends Record<string, unknown>>(value: T, maxChars: number): T | null {
  const result = fitSerializedEnvelope((charsUsed) => ({ ...value, charsUsed }), { maxChars });
  return (result?.value as T | undefined) ?? null;
}
function outputBudgetError(maxChars: number): BrowserError | number {
  return boundedError('output_budget_exceeded', 'The requested result cannot fit in the output budget.', maxChars);
}
function boundedError(code: BrowserError['error']['code'], message: string, maxChars: number): BrowserError | number {
  const value: BrowserError = { error: { code, message } };
  if (fitsSerializedText(JSON.stringify(value), { maxChars })) return value;
  const fallback = boundedJsonFailure({ maxChars });
  return fallback ? (JSON.parse(fallback) as BrowserError | number) : 0;
}
function largestChunk(record: ProjectedMessage, offset: number, fits: (text: string) => unknown) {
  let low = 1;
  let high = record.text.length - offset;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = safeUtf16Slice(record.text, offset, offset + middle);
    if (text && fits(text)) {
      best = text;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}
function isBrowsableSession(conversation: RestoredState) {
  return (
    SAFE_SESSION_ID.test(conversation.id) &&
    isUtcTimestamp(conversation.createdAt) &&
    isUtcTimestamp(updatedAt(conversation)) &&
    (conversation.model === undefined || typeof conversation.model === 'string') &&
    (conversation.provider === undefined || typeof conversation.provider === 'string')
  );
}

function validCursorPosition(cursor: CursorState, records: ProjectedMessage[]) {
  if (cursor.nextIndex > records.length) return false;
  if (cursor.nextIndex === records.length) return false;
  const text = records[cursor.nextIndex]!.text;
  if (cursor.nextTextOffset === 0) return true;
  if (cursor.nextTextOffset >= text.length) return false;
  return !(
    isHighSurrogate(text.charCodeAt(cursor.nextTextOffset - 1)) &&
    isLowSurrogate(text.charCodeAt(cursor.nextTextOffset))
  );
}

function revision(conversation: RestoredState, projection: NonNullable<ReturnType<typeof project>>) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: conversation.id,
        createdAt: conversation.createdAt,
        model: conversation.model,
        provider: conversation.provider,
        records: projection.records,
        skipped: projection.skipped,
      }),
    )
    .digest()
    .subarray(0, 12)
    .toString('base64url');
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}
