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

const format: FormatCommandMessage = (item, index, calls) => {
  const callId = getCallIdFromItem(item);
  const args =
    normalizeToolArguments(item?.rawItem?.arguments ?? item?.arguments) ??
    (callId ? normalizeToolArguments(calls.get(callId)) : {}) ??
    {};
  return [
    createBaseMessage(item, index, 0, false, {
      command: `memory: ${String(args.id ?? args.query ?? 'list')}`,
      output: getOutputText(item),
      success: !getOutputText(item).startsWith('Error:'),
      toolName: 'memory',
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
): ToolDefinition<P> {
  return {
    name,
    description,
    parameters,
    needsApproval: () => false,
    execute: (params) => safe(() => execute(params)),
    formatCommandMessage: format,
  };
}

export function createMemoryToolDefinitions(store: MemoryStore): ToolDefinition[] {
  return [
    definition(
      'memory_list',
      'List available persistent-memory summaries.',
      z.object({ limit: z.number().int().positive().optional() }),
      async (params) => ({ memories: await store.list(params) }),
    ),
    definition('memory_get', 'Load the full content of one relevant memory.', z.object({ id }), async ({ id }) => {
      const memory = await store.get(id);
      if (!memory) throw new MemoryNotFoundError(id);
      return { memory };
    }),
    definition(
      'memory_search',
      'Search persistent memory using deterministic local text matching.',
      z.object({ query: z.string(), limit: z.number().int().positive().optional() }),
      async (params) => ({ results: await store.search(params.query, params) }),
    ),
    definition(
      'memory_create',
      'Explicitly save durable information as persistent memory.',
      z.object({
        id,
        title: z.string(),
        summary: z.string(),
        content: z.string(),
        tags: z.array(z.string()).optional(),
      }),
      async (params) => ({ memory: await store.create(params) }),
    ),
    definition(
      'memory_update',
      'Update an existing persistent memory; its ID cannot change.',
      z.object({ id, ...fields }),
      async ({ id, ...input }) => ({ memory: await store.update(id, input) }),
    ),
    definition('memory_delete', 'Delete an explicit persistent memory item.', z.object({ id }), async ({ id }) => ({
      deleted: await store.remove(id),
    })),
  ];
}
