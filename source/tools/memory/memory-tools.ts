import { z } from 'zod';
import type { FormatCommandMessage, SchemaToolDefinition, ToolDefinition } from '../types.js';
import { createBaseMessage, getCallIdFromItem, getOutputText, normalizeToolArguments } from '../format-helpers.js';
import {
  InvalidMemoryError,
  MemoryAlreadyExistsError,
  MemoryNotFoundError,
  MemoryStorageError,
  type Memory,
  type MemoryStore,
} from '../../services/memory/memory-store.js';

export type MemoryScope = 'global' | 'project';
export type MemoryStores = Record<MemoryScope, MemoryStore>;

const scope = z.enum(['global', 'project']).describe('Memory scope to write to.');

function normalizeStores(stores: MemoryStore | MemoryStores): MemoryStores {
  return 'list' in stores ? { global: stores, project: stores } : stores;
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

function isSuccessOutput(outputText: string): boolean {
  const trimmed = outputText.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('Error:') || trimmed.startsWith('Tool input did not match schema')) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) return false;
  } catch {
    // Not JSON — fall through to prefix checks above
  }
  return true;
}
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
function safe(operation: () => Promise<unknown>) {
  return operation()
    .then((value) => JSON.stringify(value))
    .catch((error) =>
      JSON.stringify({
        error:
          error instanceof MemoryNotFoundError
            ? { code: 'not_found', message: 'Memory was not found.' }
            : error instanceof MemoryAlreadyExistsError
            ? { code: 'already_exists', message: 'A memory with this ID already exists.' }
            : error instanceof InvalidMemoryError
            ? { code: 'invalid_memory', message: error.message }
            : error instanceof MemoryStorageError
            ? { code: 'storage_error', message: 'Memory storage is unavailable or corrupted.' }
            : { code: 'memory_error', message: 'Memory operation failed.' },
      }),
    );
}
function definition<S extends z.ZodObject<any>>(
  name: string,
  description: string,
  parameters: S,
  execute: (params: z.infer<S>) => Promise<unknown>,
  needsApproval = false,
): SchemaToolDefinition<S> {
  return {
    name,
    description,
    parameters,
    needsApproval: () => needsApproval,
    execute: (params: z.infer<S>) => safe(() => execute(params)),
    formatCommandMessage: makeFormat(name),
  };
}

export function createMemoryToolDefinitions(input: MemoryStore | MemoryStores): ToolDefinition[] {
  const stores = normalizeStores(input);
  return [
    definition(
      'memory_list',
      'List persistent-memory summaries from both the global and project scopes.',
      z.object({ limit: z.number().int().positive().optional() }).strict(),
      async ({ limit }) => {
        const options = { limit };
        const [global, project] = await Promise.all([stores.global.list(options), stores.project.list(options)]);
        return { scope: 'all', global, project };
      },
    ),
    definition(
      'memory_get',
      'Load one memory by ID, checking both the global and project scopes.',
      z.object({ id }).strict(),
      async ({ id }) => {
        for (const scope of ['global', 'project'] as const) {
          const memory = await stores[scope].get(id);
          if (memory) return { scope, memory };
        }
        throw new MemoryNotFoundError(id);
      },
    ),
    definition(
      'memory_search',
      'Search both the global and project memory scopes using deterministic local text matching.',
      z.object({ query: z.string(), limit: z.number().int().positive().optional() }).strict(),
      async ({ query, ...options }) => {
        const [global, project] = await Promise.all([
          stores.global.search(query, options),
          stores.project.search(query, options),
        ]);
        return {
          results: [
            ...global.map((result) => ({ scope: 'global' as const, ...result })),
            ...project.map((result) => ({ scope: 'project' as const, ...result })),
          ],
        };
      },
    ),
    definition(
      'memory_retrieve',
      'Search and load relevant memories across both the global and project scopes.',
      z.object({ query: z.string(), limit: z.number().int().positive().optional() }).strict(),
      async ({ query, ...options }) => {
        const searchAcross = async (scope: MemoryScope) => {
          const results = await stores[scope].search(query, options);
          const memories: Array<{ scope: MemoryScope; memory: Memory }> = [];
          const unavailableIds: Array<{ scope: MemoryScope; id: string }> = [];
          for (const result of results) {
            if (!result.available) {
              unavailableIds.push({ scope, id: result.memory.id });
              continue;
            }
            try {
              const memory = await stores[scope].get(result.memory.id);
              if (memory) memories.push({ scope, memory });
              else unavailableIds.push({ scope, id: result.memory.id });
            } catch (error) {
              if (!(error instanceof MemoryStorageError) && !(error instanceof MemoryNotFoundError)) throw error;
              unavailableIds.push({ scope, id: result.memory.id });
            }
          }
          return { memories, unavailableIds };
        };
        const [global, project] = await Promise.all([searchAcross('global'), searchAcross('project')]);
        return {
          memories: [...global.memories, ...project.memories],
          unavailableIds: [...global.unavailableIds, ...project.unavailableIds],
        };
      },
    ),
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
      true,
    ),
    definition(
      'memory_delete',
      'Delete a memory from the selected global or project scope.',
      z.object({ scope, id }),
      async ({ scope, id }) => {
        const deleted = await stores[scope].remove(id);
        return { scope, deleted };
      },
      true,
    ),
  ];
}
