import { z } from 'zod';
import type { FormatCommandMessage, SchemaToolDefinition, ToolDefinition } from '../types.js';
import {
  createBaseMessage,
  getCallIdFromItem,
  getOutputText,
  isSuccessOutput,
  normalizeToolArguments,
} from '../format-helpers.js';
import {
  InvalidMemoryError,
  MemoryAlreadyExistsError,
  MemoryNotFoundError,
  MemoryStorageError,
  type Memory,
  type MemoryMetadata,
  type MemoryStore,
} from '../../services/memory/memory-store.js';
import {
  contentSnippet,
  queryTerms,
  rankMemorySearchResults,
  type ScopedMemorySearchResult,
} from '../../services/memory/memory-search.js';
import { boundedJsonFailure, fitSerializedEnvelope, fitsSerializedText } from '../../utils/output/bounded-json.js';
import { resolveToolResultMaxBytes } from '../../utils/output/bound-tool-result.js';
import type { ISettingsService } from '../../services/service-interfaces.js';

export type MemoryScope = 'global' | 'project';
export type MemoryStores = Record<MemoryScope, MemoryStore>;

const scope = z.enum(['global', 'project']).describe('Memory scope to write to.');
const MIN_TOOL_OUTPUT_CHARS = 512;
const MAX_TOOL_OUTPUT_CHARS = 12_000;
const DEFAULT_INDEX_OUTPUT_CHARS = 12_000;
const DEFAULT_DOCUMENT_OUTPUT_CHARS = 12_000;
const DEFAULT_RESULT_LIMIT = 10;
const MAX_RESULT_LIMIT = 50;
const maxChars = z.number().int().min(MIN_TOOL_OUTPUT_CHARS).max(MAX_TOOL_OUTPUT_CHARS).optional();
const resultLimit = z.number().int().min(1).max(MAX_RESULT_LIMIT).optional();

function normalizeStores(stores: MemoryStore | MemoryStores): MemoryStores {
  return 'list' in stores ? { global: stores, project: stores } : stores;
}

class MemoryCursorError extends Error {}
class StaleMemoryCursorError extends Error {}
class OutputBudgetExceededError extends Error {}

function metadata(memory: MemoryMetadata): MemoryMetadata {
  return {
    id: memory.id,
    title: memory.title,
    summary: memory.summary,
    tags: memory.tags,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

function output<T>(maxChars: number, build: (charsUsed: number) => T): T {
  const fitted = fitSerializedEnvelope(build, { maxChars });
  if (!fitted) throw new OutputBudgetExceededError();
  return fitted.value;
}

function boundedError(code: string, message: string, maxChars: number) {
  const result = { error: { code, message } };
  const serialized = JSON.stringify(result);
  return fitsSerializedText(serialized, { maxChars, maxBytes: resolveToolResultMaxBytes() })
    ? serialized
    : boundedJsonFailure({ maxChars, maxBytes: resolveToolResultMaxBytes() });
}

const makeFormat =
  (toolName: string): FormatCommandMessage =>
  (item, index, calls) => {
    const callId = getCallIdFromItem(item);
    const args =
      normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
      (callId ? normalizeToolArguments(calls.get(callId)) : {}) ??
      {};
    const outputText = getOutputText(item);
    const commandLabel = toolName.replace(/^memory_/, '');
    return [
      createBaseMessage(item, index, 0, false, {
        command: `memory_${commandLabel}: ${String(args.id ?? args.query ?? '')}`,
        output: outputText,
        success: isSuccessOutput(outputText),
        toolName,
        toolArgs: args,
      }),
    ];
  };

const id = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe('Stable lowercase memory identifier.');
const fields = {
  title: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
};
function safe(operation: () => Promise<unknown>, maxChars: number) {
  return operation()
    .then((value) => JSON.stringify(value))
    .catch((error) =>
      error instanceof MemoryNotFoundError
        ? boundedError('not_found', 'Memory was not found.', maxChars)
        : error instanceof MemoryAlreadyExistsError
        ? boundedError('already_exists', 'A memory with this ID already exists.', maxChars)
        : error instanceof InvalidMemoryError
        ? boundedError('invalid_memory', error.message || 'Memory input is invalid.', maxChars)
        : error instanceof MemoryStorageError
        ? boundedError('storage_error', 'Memory storage is unavailable or corrupted.', maxChars)
        : error instanceof MemoryCursorError
        ? boundedError('invalid_cursor', 'The memory cursor is invalid.', maxChars)
        : error instanceof StaleMemoryCursorError
        ? boundedError('stale_cursor', 'The memory cursor is stale.', maxChars)
        : error instanceof OutputBudgetExceededError
        ? boundedError('output_budget_exceeded', 'The requested result cannot fit in the output budget.', maxChars)
        : boundedError('memory_error', 'Memory operation failed.', maxChars),
    );
}
function definition<S extends z.ZodObject<any>>(
  name: string,
  description: string,
  parameters: S,
  execute: (params: z.infer<S>) => Promise<unknown>,
  needsApproval: boolean | (() => boolean) = false,
): SchemaToolDefinition<S> {
  return {
    name,
    description,
    parameters,
    preserveSerializedOutput: [
      'memory_list',
      'memory_get',
      'memory_search',
      'memory_retrieve',
      'memory_synthesize',
    ].includes(name),
    needsApproval: typeof needsApproval === 'function' ? needsApproval : () => needsApproval,
    execute: (params: z.infer<S>) =>
      safe(() => execute(params), (params as { maxChars?: number }).maxChars ?? DEFAULT_DOCUMENT_OUTPUT_CHARS),
    formatCommandMessage: makeFormat(name),
  };
}

export function createMemoryToolDefinitions(
  input: MemoryStore | MemoryStores,
  options?: { settingsService?: ISettingsService; includeSynthesize?: boolean },
): ToolDefinition[] {
  const stores = normalizeStores(input);
  const configuredLimits = stores.global.searchLimits?.() ?? {
    defaultLimit: DEFAULT_RESULT_LIMIT,
    maxLimit: MAX_RESULT_LIMIT,
  };
  const effectiveLimit = (requested: number | undefined) =>
    Math.min(requested ?? configuredLimits.defaultLimit, configuredLimits.maxLimit, MAX_RESULT_LIMIT);
  const rankedSearch = async (query: string, limit: number): Promise<ScopedMemorySearchResult[]> => {
    const options = { limit: Math.min(configuredLimits.maxLimit, MAX_RESULT_LIMIT) };
    const [global, project] = await Promise.all([
      stores.global.search(query, options),
      stores.project.search(query, options),
    ]);
    return rankMemorySearchResults([
      ...global.map((result) => ({ ...result, scope: 'global' as const })),
      ...project.map((result) => ({ ...result, scope: 'project' as const })),
    ]).slice(0, limit);
  };
  return [
    definition(
      'memory_list',
      'List persistent-memory summaries from both the global and project scopes.',
      z.object({ limit: resultLimit, maxChars }).strict(),
      async ({ limit, maxChars: requestedMaxChars }) => {
        const selectedLimit = effectiveLimit(limit);
        const [globalCandidates, projectCandidates] = await Promise.all([
          stores.global.list({ limit: selectedLimit }),
          stores.project.list({ limit: selectedLimit }),
        ]);
        const result = {
          scope: 'all' as const,
          global: [] as MemoryMetadata[],
          project: [] as MemoryMetadata[],
          omitted: { global: 0, project: 0 },
        };
        const budget = requestedMaxChars ?? DEFAULT_INDEX_OUTPUT_CHARS;
        // Admit each record against the largest possible final count so later
        // omissions cannot invalidate an already admitted envelope.
        const reservedOmitted = { global: globalCandidates.length, project: projectCandidates.length };
        for (const [entryScope, candidate] of [
          ...globalCandidates.map((memory) => ['global' as const, memory] as const),
          ...projectCandidates.map((memory) => ['project' as const, memory] as const),
        ]) {
          const admitted = fitSerializedEnvelope(
            (charsUsed) => ({
              ...result,
              [entryScope]: [...result[entryScope], metadata(candidate)],
              omitted: reservedOmitted,
              charsUsed,
            }),
            { maxChars: budget },
          );
          if (admitted) {
            result[entryScope] = admitted.value[entryScope];
            continue;
          }
          result.omitted[entryScope]++;
        }
        return output(budget, (charsUsed) => ({ ...result, charsUsed }));
      },
    ),
    definition(
      'memory_get',
      'Load one memory by ID, checking both the global and project scopes.',
      z.object({ id, cursor: z.string().optional(), maxChars }).strict(),
      async ({ id, cursor, maxChars: requestedMaxChars }) => {
        const budget = requestedMaxChars ?? DEFAULT_DOCUMENT_OUTPUT_CHARS;
        for (const scope of ['global', 'project'] as const) {
          const memory = await stores[scope].get(id);
          if (!memory) continue;
          const offset = cursor ? decodeMemoryCursor(cursor, id, scope, memory) : 0;
          if (cursor) return memoryPage(scope, memory, offset, budget);
          const complete = fitSerializedEnvelope((charsUsed) => ({ scope, memory, charsUsed }), { maxChars: budget });
          if (complete) return complete.value;
          return memoryPage(scope, memory, offset, budget);
        }
        throw new MemoryNotFoundError(id);
      },
    ),
    definition(
      'memory_search',
      'Search both the global and project memory scopes using deterministic local text matching.',
      z.object({ query: z.string().refine((value) => /\S/.test(value)), limit: resultLimit, maxChars }).strict(),
      async ({ query, limit, maxChars: requestedMaxChars }) => {
        const budget = requestedMaxChars ?? DEFAULT_INDEX_OUTPUT_CHARS;
        const candidates = await rankedSearch(query, effectiveLimit(limit));
        const result = { results: [] as Array<Record<string, unknown>>, omitted: 0 };
        const terms = queryTerms(query);
        for (const candidate of candidates) {
          const item = {
            scope: candidate.scope,
            memory: metadata(candidate.memory),
            matchedFields: candidate.matchedFields,
            available: candidate.available,
            ...(candidate.matchedFields.includes('content') && candidate.content !== undefined
              ? { contentSnippet: contentSnippet(candidate.content, terms) }
              : {}),
          };
          const prospective = fitSerializedEnvelope(
            // The eventual count is bounded by candidates.length; reserve its
            // digit width before admitting a result.
            (charsUsed) => ({ ...result, results: [...result.results, item], omitted: candidates.length, charsUsed }),
            { maxChars: budget },
          );
          if (prospective) result.results = prospective.value.results;
          else {
            const omitted = fitSerializedEnvelope(
              (charsUsed) => ({ ...result, omitted: result.omitted + 1, charsUsed }),
              {
                maxChars: budget,
              },
            );
            if (!omitted) throw new OutputBudgetExceededError();
            result.omitted++;
          }
        }
        return output(budget, (charsUsed) => ({ ...result, charsUsed }));
      },
    ),
    definition(
      'memory_retrieve',
      'Search and load relevant memories across both the global and project scopes.',
      z.object({ query: z.string().refine((value) => /\S/.test(value)), limit: resultLimit, maxChars }).strict(),
      async ({ query, limit, maxChars: requestedMaxChars }) => {
        const budget = requestedMaxChars ?? DEFAULT_DOCUMENT_OUTPUT_CHARS;
        const candidates = await rankedSearch(query, effectiveLimit(limit));
        const loaded: Array<{ scope: MemoryScope; memory?: Memory; id: string; unavailable: boolean }> = [];
        for (const candidate of candidates) {
          if (!candidate.available) {
            loaded.push({ scope: candidate.scope, id: candidate.memory.id, unavailable: true });
            continue;
          }
          try {
            const memory = await stores[candidate.scope].get(candidate.memory.id);
            loaded.push({
              scope: candidate.scope,
              id: candidate.memory.id,
              memory: memory ?? undefined,
              unavailable: !memory,
            });
          } catch (error) {
            if (!(error instanceof MemoryStorageError) && !(error instanceof MemoryNotFoundError)) throw error;
            loaded.push({ scope: candidate.scope, id: candidate.memory.id, unavailable: true });
          }
        }
        const result = {
          memories: [] as Array<{ scope: MemoryScope; memory: Memory }>,
          unavailableIds: [] as Array<{ scope: MemoryScope; id: string }>,
          omittedIds: [] as Array<{ scope: MemoryScope; id: string }>,
          omittedIdCount: 0,
          unavailableIdCount: 0,
        };
        const unavailable = loaded.filter((entry) => entry.unavailable);
        const available = loaded.filter(
          (entry): entry is typeof entry & { memory: Memory } => !entry.unavailable && !!entry.memory,
        );
        // References and memories are admitted against both terminal count
        // widths, so neither count can overflow a previously valid result.
        const reservedCounts = () => ({
          omittedIdCount: available.length,
          unavailableIdCount: unavailable.length,
        });
        result.unavailableIdCount = unavailable.length;
        for (const candidate of unavailable) {
          const reference = { scope: candidate.scope, id: candidate.id };
          const prospective = fitSerializedEnvelope(
            (charsUsed) => ({
              ...result,
              ...reservedCounts(),
              unavailableIds: [...result.unavailableIds, reference],
              charsUsed,
            }),
            { maxChars: budget },
          );
          if (prospective) result.unavailableIds = prospective.value.unavailableIds;
        }
        for (const candidate of available) {
          const memory = { scope: candidate.scope, memory: candidate.memory };
          const prospective = fitSerializedEnvelope(
            (charsUsed) => ({ ...result, ...reservedCounts(), memories: [...result.memories, memory], charsUsed }),
            { maxChars: budget },
          );
          if (prospective) {
            result.memories = prospective.value.memories;
            continue;
          }
          result.omittedIdCount++;
          const reference = { scope: candidate.scope, id: candidate.id };
          const omission = fitSerializedEnvelope(
            (charsUsed) => ({
              ...result,
              ...reservedCounts(),
              omittedIds: [...result.omittedIds, reference],
              charsUsed,
            }),
            { maxChars: budget },
          );
          if (omission) result.omittedIds = omission.value.omittedIds;
        }
        return output(budget, (charsUsed) => ({ ...result, charsUsed }));
      },
    ),
    ...(options?.includeSynthesize
      ? [
          definition(
            'memory_synthesize',
            'Retrieve one de-duplicated evidence packet for a broad memory objective. Use when the task depends on several memories, terminology may vary, or prior decisions may conflict or be stale. Supply 2-5 distinct search angles; the result traces every memory to the queries that found it. For one focused lookup, use memory_retrieve instead.',
            z
              .object({
                objective: z.string().refine((value) => /\S/.test(value)),
                queries: z
                  .array(z.string().refine((value) => /\S/.test(value)))
                  .min(2)
                  .max(5),
                limit: resultLimit,
                maxChars,
              })
              .strict(),
            async ({ objective, queries, limit, maxChars: requestedMaxChars }) => {
              const budget = requestedMaxChars ?? DEFAULT_DOCUMENT_OUTPUT_CHARS;
              const uniqueQueries = [...new Set(queries.map((query) => query.trim()))];
              const searches = await Promise.all(
                uniqueQueries.map(async (query) => ({
                  query,
                  candidates: await rankedSearch(query, effectiveLimit(limit)),
                })),
              );
              const aggregated = new Map<
                string,
                {
                  scope: MemoryScope;
                  id: string;
                  available: boolean;
                  matchedQueries: string[];
                }
              >();
              for (const { query, candidates } of searches) {
                for (const candidate of candidates) {
                  const key = `${candidate.scope}\0${candidate.memory.id}`;
                  const existing = aggregated.get(key);
                  if (existing) {
                    existing.available ||= candidate.available;
                    existing.matchedQueries.push(query);
                    continue;
                  }
                  aggregated.set(key, {
                    scope: candidate.scope,
                    id: candidate.memory.id,
                    available: candidate.available,
                    matchedQueries: [query],
                  });
                }
              }

              const loaded: Array<{
                scope: MemoryScope;
                id: string;
                memory?: Memory;
                unavailable: boolean;
                matchedQueries: string[];
              }> = [];
              for (const candidate of aggregated.values()) {
                if (!candidate.available) {
                  loaded.push({ ...candidate, unavailable: true });
                  continue;
                }
                try {
                  const memory = await stores[candidate.scope].get(candidate.id);
                  loaded.push({
                    ...candidate,
                    memory: memory ?? undefined,
                    unavailable: !memory,
                  });
                } catch (error) {
                  if (!(error instanceof MemoryStorageError) && !(error instanceof MemoryNotFoundError)) throw error;
                  loaded.push({ ...candidate, unavailable: true });
                }
              }

              const result = {
                objective,
                queries: uniqueQueries,
                memories: [] as Array<{ scope: MemoryScope; memory: Memory; matchedQueries: string[] }>,
                unavailableIds: [] as Array<{ scope: MemoryScope; id: string; matchedQueries: string[] }>,
                omittedIds: [] as Array<{ scope: MemoryScope; id: string; matchedQueries: string[] }>,
                omittedIdCount: 0,
                unavailableIdCount: 0,
              };
              const unavailable = loaded.filter((entry) => entry.unavailable);
              const available = loaded.filter(
                (entry): entry is typeof entry & { memory: Memory } => !entry.unavailable && !!entry.memory,
              );
              result.unavailableIdCount = unavailable.length;
              for (const candidate of unavailable) {
                const reference = {
                  scope: candidate.scope,
                  id: candidate.id,
                  matchedQueries: candidate.matchedQueries,
                };
                const prospective = fitSerializedEnvelope(
                  (charsUsed) => ({
                    ...result,
                    unavailableIds: [...result.unavailableIds, reference],
                    charsUsed,
                  }),
                  { maxChars: budget },
                );
                if (prospective) result.unavailableIds = prospective.value.unavailableIds;
              }
              for (const candidate of available) {
                const item = {
                  scope: candidate.scope,
                  memory: candidate.memory,
                  matchedQueries: candidate.matchedQueries,
                };
                const prospective = fitSerializedEnvelope(
                  (charsUsed) => ({ ...result, memories: [...result.memories, item], charsUsed }),
                  { maxChars: budget },
                );
                if (prospective) {
                  result.memories = prospective.value.memories;
                  continue;
                }
                result.omittedIdCount++;
                const reference = {
                  scope: candidate.scope,
                  id: candidate.id,
                  matchedQueries: candidate.matchedQueries,
                };
                const omission = fitSerializedEnvelope(
                  (charsUsed) => ({ ...result, omittedIds: [...result.omittedIds, reference], charsUsed }),
                  { maxChars: budget },
                );
                if (omission) result.omittedIds = omission.value.omittedIds;
              }
              return output(budget, (charsUsed) => ({ ...result, charsUsed }));
            },
          ),
        ]
      : []),
    definition(
      'memory_create',
      'Save durable information to the selected global or project memory scope.',
      z.object({
        scope,
        id,
        title: z.string(),
        summary: z.string(),
        content: z.string(),
        tags: z.array(z.string()).optional(),
      }),
      async ({ scope, ...params }) => {
        const memory = await stores[scope].create(params);
        return { scope, memory };
      },
    ),
    definition(
      'memory_update',
      'Update a memory in the selected global or project scope; its ID cannot change.',
      z
        .object({ scope, id, ...fields })
        .refine(({ id: _, scope: __, ...input }) => Object.values(input).some((value) => value !== undefined), {
          message: 'At least one field must be provided for a memory update.',
        }),
      async ({ scope, id, ...input }) => {
        const memory = await stores[scope].update(id, input);
        return { scope, memory };
      },
      () => {
        const mode = options?.settingsService?.get('shell.autoApproveMode');
        return mode !== 'auto' && mode !== 'always';
      },
    ),
    definition(
      'memory_delete',
      'Delete a memory from the selected global or project scope.',
      z.object({ scope, id }),
      async ({ scope, id }) => {
        const deleted = await stores[scope].remove(id);
        return { scope, deleted };
      },
      () => {
        const mode = options?.settingsService?.get('shell.autoApproveMode');
        return mode !== 'auto' && mode !== 'always';
      },
    ),
  ];
}

type MemoryCursor = { v: 1; scope: MemoryScope; id: string; updatedAt: string; nextOffset: number };

function decodeMemoryCursor(cursor: string, id: string, scope: MemoryScope, memory: Memory): number {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new MemoryCursorError();
  let decoded: string;
  let value: unknown;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw new Error();
    value = JSON.parse(decoded);
  } catch {
    throw new MemoryCursorError();
  }
  const parsed = value as Partial<MemoryCursor>;
  if (
    !parsed ||
    parsed.v !== 1 ||
    parsed.scope !== scope ||
    parsed.id !== id ||
    !isUtcTimestamp(parsed.updatedAt) ||
    typeof parsed.nextOffset !== 'number' ||
    !Number.isSafeInteger(parsed.nextOffset) ||
    parsed.nextOffset < 0 ||
    Object.keys(parsed).join(',') !== 'v,scope,id,updatedAt,nextOffset' ||
    JSON.stringify(parsed) !== decoded
  )
    throw new MemoryCursorError();
  const validated = parsed as MemoryCursor;
  if (validated.updatedAt !== memory.updatedAt) throw new StaleMemoryCursorError();
  if (
    (memory.content.length === 0 && validated.nextOffset !== 0) ||
    (memory.content.length > 0 && validated.nextOffset >= memory.content.length)
  )
    throw new MemoryCursorError();
  if (
    validated.nextOffset > 0 &&
    validated.nextOffset < memory.content.length &&
    isHighSurrogate(memory.content.charCodeAt(validated.nextOffset - 1)) &&
    isLowSurrogate(memory.content.charCodeAt(validated.nextOffset))
  )
    throw new MemoryCursorError();
  return validated.nextOffset;
}

function memoryPage(scope: MemoryScope, memory: Memory, offset: number, maxChars: number) {
  const totalChars = memory.content.length;
  const page = (end: number) => {
    const text = safePageSlice(memory.content, offset, end);
    if (!text && totalChars > offset) return null;
    const nextOffset = offset + text.length;
    const content = {
      offset,
      totalChars,
      text,
      ...(nextOffset < totalChars
        ? { nextCursor: encodeMemoryCursor({ v: 1, scope, id: memory.id, updatedAt: memory.updatedAt, nextOffset }) }
        : {}),
    };
    return fitSerializedEnvelope((charsUsed) => ({ scope, memory: metadata(memory), content, charsUsed }), {
      maxChars,
    });
  };
  if (totalChars === 0) {
    const empty = page(0);
    if (empty) return empty.value;
    throw new OutputBudgetExceededError();
  }
  let lower = offset + 1;
  let upper = totalChars;
  let best: ReturnType<typeof page> = null;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = page(middle);
    if (candidate) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  if (!best || !best.value.content.text) throw new OutputBudgetExceededError();
  return best.value;
}

function safePageSlice(content: string, start: number, end: number) {
  let safeEnd = end;
  if (
    safeEnd > start &&
    safeEnd < content.length &&
    isHighSurrogate(content.charCodeAt(safeEnd - 1)) &&
    isLowSurrogate(content.charCodeAt(safeEnd))
  )
    safeEnd--;
  return content.slice(start, safeEnd);
}

function encodeMemoryCursor(cursor: MemoryCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
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
