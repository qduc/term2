import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import {
  MAX_SESSION_BROWSER_CHARS,
  type Kind,
  type SessionBrowser,
} from '../../services/conversation/session-browser.js';
import { boundedJsonFailure, fitsSerializedText } from '../../utils/output/bounded-json.js';
import { isScriptedToolCall, resolveToolResultMaxBytes } from '../../utils/output/bound-tool-result.js';
import {
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
  createBaseMessage,
} from '../format-helpers.js';

const maxChars = z.number().int().min(512).max(MAX_SESSION_BROWSER_CHARS).optional();
const limit = z.number().int().min(1).max(50).optional();
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const sessionKind = z.enum(['user', 'assistant', 'reasoning', 'system', 'tool', 'subagent'] satisfies Kind[]);

export function createSessionBrowserToolDefinitions(browser: SessionBrowser): ToolDefinition[] {
  return [
    definition(
      'session_list',
      'List prior locally persisted sessions for the current project. `total` is the number of browsable sessions in scope; `omitted` counts list entries dropped only because the output budget could not fit them (entries beyond `limit` are excluded by `total`).',
      z.object({ limit, maxChars }).strict(),
      (params) => browser.list(params),
      '{ sessions: { id: string, shortRef: string, createdAt: string, updatedAt: string, firstUserMessage?: string, model?: string, provider?: string, messageCount: number }[], scope: string, total: number, omitted: number, unavailable: number, charsUsed: number } | { error: { code: string, message: string, candidates?: { id: string, shortRef: string }[] } }',
    ),
    definition(
      'session_search',
      'Search prior locally persisted session transcripts for the current project. Whitespace-separated query terms use OR matching, so prefer distinctive terms over broad words. Use `kinds: ["user", "assistant"]` to exclude noisy tool, reasoning, system, and subagent records when looking for conversation content. Without `kinds`, every projected record kind is searched. `total` is the number of ranked matches after the kind filter and before `limit` is applied; `omitted` counts matches dropped only because the output budget could not fit them. Matches from the currently active session sort last, because searching indexes tool outputs and the query echoes in the live transcript. Each match\'s `updatedAt` is the session\'s last-write timestamp, not per-message time.',
      z
        .object({
          query: z.string().refine((value) => /\S/.test(value)),
          kinds: z.array(sessionKind).min(1).max(6).optional(),
          limit,
          maxChars,
        })
        .strict(),
      (params) => browser.search(params),
      '{ results: { sessionId: string, shortRef: string, kind: string, messageIndex: number, snippet: { text: string, truncated: boolean }, updatedAt: string }[], scope: string, total: number, omitted: number, unavailable: number, skippedMessageCount: number, charsUsed: number } | { error: { code: string, message: string, candidates?: { id: string, shortRef: string }[] } }',
    ),
    definition(
      'session_read',
      'Read a prior local session transcript progressively by cursor. Use `id: "previous"` for the session before this one — the persisted rollover predecessor when one exists, otherwise the most recently updated other session in this scope (possibly a concurrently running session; check the returned `session.id` against `session_list` when that matters) — or an exact/unambiguous ID or shortRef returned by `session_list`/`session_search`; never reconstruct an ID. Ambiguous prefixes return candidates and are never guessed. Long sessions are mostly tool output and reasoning: pass `kinds: ["user", "assistant"]` to read only the conversation, or `itemMaxChars` for an outline where each longer record is cut to a preview marked `truncated: true` (its `totalTextChars` is the full length). To open a search hit, start with `index` set to a `session_search` `messageIndex` (or an item `index`), optionally with `before` for that many preceding records; the read starts at the first record at or after that index that passes `kinds`. On an initial read, `from: "end"` starts at the last `limit` projected records in chronological order (with `kinds`, the last `limit` matching records; `limit` selects the tail region; without `from: "end"` the read starts at the first record unless `index` is set); omit `cursor` with `from` or `index`, then continue with the returned cursor and neither. Cursors are process-local opaque handles: use exactly the `nextCursor` returned by the preceding page with the same `id`. Never invent, edit, or reuse a cursor from another read; after an invalid or stale cursor, restart without one. A cursor keeps the `kinds` and `itemMaxChars` it was issued with; omit them on continuation or repeat them unchanged. `maxChars` may require continuation pages; `nextCursor` is returned only while forward content remains, so its absence after a tail read says nothing about earlier records. `total` is the projected record count for the whole session, and `matched` (present only with `kinds`) counts the records of those kinds; `omitted` counts whole-session records not represented on this page for any reason — excluded by `kinds`, before the anchor, beyond `limit`, or awaiting continuation — unlike `session_list`/`session_search`, whose `omitted` counts only budget-dropped entries; a partial or resumed chunk still represents its record, so `total - omitted` records are represented here.',
      z
        .object({
          id,
          from: z.literal('end').optional(),
          index: z.number().int().min(0).optional(),
          before: z.number().int().min(0).max(50).optional(),
          cursor: z.string().optional(),
          kinds: z.array(sessionKind).min(1).max(6).optional(),
          itemMaxChars: z.number().int().min(100).max(MAX_SESSION_BROWSER_CHARS).optional(),
          limit,
          maxChars,
        })
        .strict()
        .superRefine((params, ctx) => {
          const issue = (path: string, message: string) =>
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
          if (params.from === 'end' && params.cursor !== undefined)
            issue('from', '`from: "end"` requires an initial read without cursor.');
          if (params.index !== undefined && params.cursor !== undefined)
            issue('index', '`index` requires an initial read without cursor.');
          if (params.index !== undefined && params.from === 'end')
            issue('index', 'Use either `index` or `from: "end"`, not both.');
          if (params.before !== undefined && params.index === undefined) issue('before', '`before` requires `index`.');
        }),
      (params) => browser.read(params),
      '{ scope: string, session: { id: string, shortRef: string, createdAt: string, updatedAt: string, model?: string, provider?: string }, items: { index: number, kind: string, toolName?: string, text: string, textOffset: number, totalTextChars: number, complete: boolean, truncated?: boolean }[], nextCursor?: string, total: number, matched?: number, omitted: number, skippedMessageCount: number, charsUsed: number } | { error: { code: string, message: string, candidates?: { id: string, shortRef: string }[] } }',
    ),
  ];
}

function definition<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  parameters: S,
  execute: (params: z.infer<S>) => unknown,
  scriptedReturnShape: string,
): ToolDefinition<S> {
  return {
    name,
    description,
    parameters,
    scriptedReturnShape,
    preserveSerializedOutput: true,
    needsApproval: () => false,
    execute: async (params, context) => {
      const value = await execute(params);
      // A scripted call receives the structured envelope directly; the
      // serialized-JSON-string form exists to bound what enters model
      // context, and a script would otherwise have to JSON.parse every
      // result before reading its fields.
      if (isScriptedToolCall(context)) return value;
      const result = JSON.stringify(value);
      const budget = (params as { maxChars?: number }).maxChars ?? 12_000;
      return fitsSerializedText(result, { maxChars: budget, maxBytes: resolveToolResultMaxBytes() })
        ? result
        : boundedJsonFailure({ maxChars: budget, maxBytes: resolveToolResultMaxBytes() });
    },
    formatCommandMessage: (item, index, calls) => {
      const callId = getCallIdFromItem(item);
      const args =
        normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
        (callId ? normalizeToolArguments(calls.get(callId)) : {}) ??
        {};
      const output = getOutputText(item);
      return [
        createBaseMessage(item, index, 0, false, {
          command: `${name}: ${String(args.id ?? args.query ?? '')}`,
          output,
          success: isSuccessOutput(output),
          toolName: name,
          toolArgs: args,
        }),
      ];
    },
  };
}
