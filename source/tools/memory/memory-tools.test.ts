import { expect, it } from 'vitest';
import { createMemoryToolDefinitions } from './memory-tools.js';
import { MemoryNotFoundError, MemoryStorageError, type MemoryStore } from '../../services/memory/memory-store.js';
import type { MemoryScope } from './memory-tools.js';

const memory = {
  id: 'project-rules',
  title: 'Rules',
  summary: 'Rules summary',
  content: 'private full content',
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const store: MemoryStore = {
  list: async () => [memory],
  get: async () => memory,
  search: async () => [{ memory, matchedFields: ['title'], available: true }],
  create: async () => memory,
  update: async () => memory,
  remove: async () => true,
};

const stores: Record<MemoryScope, MemoryStore> = {
  global: store,
  project: { ...store, list: async () => [{ ...memory, id: 'project-only' }] },
};

it('selects project memory explicitly and defaults omitted scope to global', async () => {
  const tools = createMemoryToolDefinitions(stores);

  expect(JSON.parse(await tools[0].execute({}))).toEqual({ scope: 'global', memories: [memory] });
  expect(JSON.parse(await tools[0].execute({ scope: 'project' }))).toEqual({
    scope: 'project',
    memories: [{ ...memory, id: 'project-only' }],
  });
  expect(tools[0].parameters.safeParse({ scope: 'project' }).success).toBe(true);
  expect(tools[0].parameters.safeParse({ scope: 'invalid' }).success).toBe(false);
});

it('exposes memory operations with structured responses', async () => {
  const tools = createMemoryToolDefinitions(store);
  expect(tools.map((tool) => tool.name)).toEqual([
    'memory_list',
    'memory_get',
    'memory_search',
    'memory_retrieve',
    'memory_create',
    'memory_update',
    'memory_delete',
  ]);
  expect(JSON.parse(await tools[0].execute({}))).toEqual({ scope: 'global', memories: [memory] });
  expect(JSON.parse(await tools[1].execute({ id: memory.id }))).toEqual({ scope: 'global', memory });
  expect(JSON.parse(await tools[2].execute({ query: 'rules' }))).toMatchObject({
    scope: 'global',
    results: [{ memory }],
  });
  expect(JSON.parse(await tools[3].execute({ query: 'rules' }))).toEqual({
    scope: 'global',
    memories: [memory],
    unavailableIds: [],
  });
  expect(JSON.parse(await tools[4].execute(memory))).toEqual({ scope: 'global', memory });
  expect(JSON.parse(await tools[5].execute({ id: memory.id, title: 'New rules' }))).toEqual({
    scope: 'global',
    memory,
  });
  expect(JSON.parse(await tools[6].execute({ id: memory.id }))).toEqual({ scope: 'global', deleted: true });
  expect(
    tools[4].parameters.safeParse({ id: '../escape', title: 'Title', summary: 'Summary', content: 'Content' }).success,
  ).toBe(false);
  expect(
    tools[4].parameters.safeParse({ id: 'valid-memory', title: 'Title', summary: 'Summary', content: 'Content' })
      .success,
  ).toBe(true);
});

it('retrieves other memories when one result becomes unavailable', async () => {
  const unavailable = { ...memory, id: 'missing-memory' };
  const tools = createMemoryToolDefinitions({
    ...store,
    search: async () => [
      { memory, matchedFields: ['title'], available: true },
      { memory: unavailable, matchedFields: ['title'], available: true },
    ],
    get: async (id) => {
      if (id === unavailable.id) throw new MemoryStorageError('gone');
      return memory;
    },
  });

  expect(JSON.parse(await tools[3].execute({ query: 'rules' }))).toEqual({
    scope: 'global',
    memories: [memory],
    unavailableIds: [unavailable.id],
  });
});

it('requires approval for destructive memory mutations', async () => {
  const tools = createMemoryToolDefinitions(store);
  const update = tools.find((tool) => tool.name === 'memory_update')!;
  const remove = tools.find((tool) => tool.name === 'memory_delete')!;

  expect(await update.needsApproval({ id: memory.id, summary: 'Updated' })).toBe(true);
  expect(await remove.needsApproval({ id: memory.id })).toBe(true);
});

it('requires memory updates to include a changed field', () => {
  const update = createMemoryToolDefinitions(store).find((tool) => tool.name === 'memory_update')!;

  expect(update.parameters.safeParse({ id: memory.id }).success).toBe(false);
  expect(update.parameters.safeParse({ id: memory.id, summary: 'Updated' }).success).toBe(true);
});

it('converts domain failures to safe tool errors without paths or stacks', async () => {
  const tools = createMemoryToolDefinitions({
    ...store,
    get: async () => {
      throw new MemoryNotFoundError('/private/path');
    },
  });
  const result = JSON.parse(await tools[1].execute({ id: 'project-rules' }));
  expect(result).toEqual({ error: { code: 'not_found', message: 'Memory was not found.' } });
  expect(JSON.stringify(result)).not.toContain('/private');
});
