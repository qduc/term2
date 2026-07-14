import { z } from 'zod';
import type { FormatCommandMessage, ToolDefinition } from '../types.js';
import { createBaseMessage, getCallIdFromItem, getOutputText, normalizeToolArguments } from '../format-helpers.js';
import {
  InvalidMemoryError,
  MemoryAlreadyExistsError,
  MemoryNotFoundError,
  MemoryStorageError,
  type MemoryStore,
} from '../../services/memory/memory-store.js';

export type MemoryScope = 'global' | 'project';
export type MemoryStores = Record<MemoryScope, MemoryStore>;

const scope = z.enum(['global', 'project']).optional().describe('Memory scope. Defaults to global.');

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
        success: !outputText.startsWith('Error:'),
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
function definition<P>(
  name: string,
  description: string,
  parameters: z.ZodObject<any>,
  execute: (params: P) => Promise<unknown>,
  needsApproval = false,
): ToolDefinition<P> {
  return {
    name,
    description,
    parameters,
    needsApproval: () => needsApproval,
    execute: (params) => safe(() => execute(params)),
    formatCommandMessage: makeFormat(name),
  };
}

export function createMemoryToolDefinitions(input: MemoryStore | MemoryStores): ToolDefinition[] {
  const stores = normalizeStores(input);
  const select = (requested?: MemoryScope) => {
    const selectedScope = requested ?? 'global';
    return { scope: selectedScope, store: stores[selectedScope] };
  };
  return [
    definition(
      'memory_list',
      'List persistent-memory summaries in the selected global or project scope.',
      z.object({ scope, limit: z.number().int().positive().optional() }),
      async ({ scope: requestedScope, ...options }) => {
        const { scope, store } = select(requestedScope);
        return { scope, memories: await store.list(options) };
      },
    ),
    definition(
      'memory_get',
      'Load one memory from the selected global or project scope.',
      z.object({ scope, id }),
      async ({ scope: requestedScope, id }) => {
        const { scope, store } = select(requestedScope);
        const memory = await store.get(id);
        if (!memory) throw new MemoryNotFoundError(id);
        return { scope, memory };
      },
    ),
    definition(
      'memory_search',
      'Search the selected global or project memory scope using deterministic local text matching.',
      z.object({ scope, query: z.string(), limit: z.number().int().positive().optional() }),
      async ({ scope: requestedScope, query, ...options }) => {
        const { scope, store } = select(requestedScope);
        return { scope, results: await store.search(query, options) };
      },
    ),
    definition(
      'memory_retrieve',
      'Search and load relevant memories from the selected global or project scope.',
      z.object({ scope, query: z.string(), limit: z.number().int().positive().optional() }),
      async ({ scope: requestedScope, query, ...options }) => {
        const { scope, store } = select(requestedScope);
        const results = await store.search(query, options);
        const memories = [];
        const unavailableIds: string[] = [];
        for (const result of results) {
          if (!result.available) {
            unavailableIds.push(result.memory.id);
            continue;
          }
          try {
            const memory = await store.get(result.memory.id);
            if (memory) memories.push(memory);
            else unavailableIds.push(result.memory.id);
          } catch (error) {
            if (!(error instanceof MemoryStorageError) && !(error instanceof MemoryNotFoundError)) throw error;
            unavailableIds.push(result.memory.id);
          }
        }
        return { scope, memories, unavailableIds };
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
      async ({ scope: requestedScope, ...params }) => {
        const { scope, store } = select(requestedScope);
        return { scope, memory: await store.create(params) };
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
      async ({ scope: requestedScope, id, ...input }) => {
        const { scope, store } = select(requestedScope);
        return { scope, memory: await store.update(id, input) };
      },
      true,
    ),
    definition(
      'memory_delete',
      'Delete a memory from the selected global or project scope.',
      z.object({ scope, id }),
      async ({ scope: requestedScope, id }) => {
        const { scope, store } = select(requestedScope);
        return { scope, deleted: await store.remove(id) };
      },
      true,
    ),
  ];
}
