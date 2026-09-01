import { expect, it } from 'vitest';
import { createMemoryToolDefinitions } from './memory-tools.js';
import {
  InvalidMemoryError,
  MemoryNotFoundError,
  MemoryStorageError,
  type MemoryStore,
} from '../../services/memory/memory-store.js';
import type { MemoryScope } from './memory-tools.js';
import { getTrimConfig, setTrimConfig } from '../../utils/output/output-trim.js';

const memory = {
  id: 'project-rules',
  title: 'Rules',
  summary: 'Rules summary',
  content: 'private full content',
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const memoryMetadata = ({ content: _, ...value }: typeof memory) => value;
const store: MemoryStore = {
  list: async () => [memory],
  get: async () => memory,
  search: async () => [{ memory, matchedFields: ['title'], available: true, score: 15 }],
  create: async () => memory,
  update: async () => memory,
  remove: async () => true,
};

const stores: Record<MemoryScope, MemoryStore> = {
  global: store,
  project: { ...store, list: async () => [{ ...memory, id: 'project-only' }] },
};

function readTool(tools: ReturnType<typeof createMemoryToolDefinitions>, name: string) {
  return tools.find((tool) => tool.name === name)!;
}

it('memory_list lists both global and project stores', async () => {
  const tools = createMemoryToolDefinitions(stores);

  const result = JSON.parse((await tools[0].execute({})) as string);
  expect(result).toMatchObject({
    scope: 'all',
    global: [memoryMetadata(memory)],
    project: [memoryMetadata({ ...memory, id: 'project-only' })],
    omitted: { global: 0, project: 0 },
  });
  expect(result.charsUsed).toBe(JSON.stringify(result).length);
  expect(tools[0].parameters.safeParse({}).success).toBe(true);
  expect(tools[0].parameters.safeParse({ limit: 5 }).success).toBe(true);
  expect(tools[0].parameters.safeParse({ scope: 'global' }).success).toBe(false);
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
  expect(tools.slice(0, 4).every((tool) => tool.preserveSerializedOutput)).toBe(true);
  expect(tools.slice(4).every((tool) => !tool.preserveSerializedOutput)).toBe(true);
  expect(JSON.parse((await tools[0].execute({})) as string)).toMatchObject({
    scope: 'all',
    global: [memoryMetadata(memory)],
    project: [memoryMetadata(memory)],
  });
  expect(JSON.parse((await tools[1].execute({ id: memory.id })) as string)).toMatchObject({ scope: 'global', memory });
  expect(JSON.parse((await tools[2].execute({ query: 'rules' })) as string)).toMatchObject({
    results: [
      { scope: 'global', memory: memoryMetadata(memory) },
      { scope: 'project', memory: memoryMetadata(memory) },
    ],
  });
  expect(JSON.parse((await tools[3].execute({ query: 'rules' })) as string)).toMatchObject({
    memories: [
      { scope: 'global', memory },
      { scope: 'project', memory },
    ],
    unavailableIds: [],
  });
  expect(JSON.parse((await tools[4].execute({ ...memory, scope: 'global' })) as string)).toEqual({
    scope: 'global',
    memory,
  });
  expect(
    JSON.parse((await tools[5].execute({ id: memory.id, title: 'New rules', scope: 'global' })) as string),
  ).toEqual({
    scope: 'global',
    memory,
  });
  expect(JSON.parse((await tools[6].execute({ id: memory.id, scope: 'global' })) as string)).toEqual({
    scope: 'global',
    deleted: true,
  });
  expect(
    tools[4].parameters.safeParse({ id: '../escape', title: 'Title', summary: 'Summary', content: 'Content' }).success,
  ).toBe(false);
  expect(
    tools[4].parameters.safeParse({
      scope: 'global',
      id: 'valid-memory',
      title: 'Title',
      summary: 'Summary',
      content: 'Content',
    }).success,
  ).toBe(true);
});

it('synthesizes a de-duplicated evidence packet across several retrieval angles', async () => {
  const first = { ...memory, id: 'first', title: 'First' };
  const second = { ...memory, id: 'second', title: 'Second' };
  const global: MemoryStore = {
    ...store,
    search: async (query) =>
      query === 'endpoint'
        ? [
            { memory: first, matchedFields: ['title'], available: true, score: 15 },
            { memory: second, matchedFields: ['content'], available: true, score: 2, content: second.content },
          ]
        : [{ memory: first, matchedFields: ['content'], available: true, score: 2, content: first.content }],
    get: async (id) => (id === first.id ? first : second),
  };
  const tools = createMemoryToolDefinitions(
    { global, project: { ...store, search: async () => [] } },
    { includeSynthesize: true },
  );

  const synthesize = readTool(tools, 'memory_synthesize');
  const result = JSON.parse(
    (await synthesize.execute({
      objective: 'recover the credit contract',
      queries: ['endpoint', 'lifecycle'],
    })) as string,
  );

  expect(result).toMatchObject({
    objective: 'recover the credit contract',
    memories: [
      { scope: 'global', memory: first, matchedQueries: ['endpoint', 'lifecycle'] },
      { scope: 'global', memory: second, matchedQueries: ['endpoint'] },
    ],
    omittedIds: [],
    unavailableIds: [],
  });
  expect(result.charsUsed).toBe(JSON.stringify(result).length);
  expect(synthesize.parameters.safeParse({ objective: 'x', queries: ['one'] }).success).toBe(false);
  expect(synthesize.parameters.safeParse({ objective: 'x', queries: ['one', 'two'] }).success).toBe(true);
});

it('requires scope only on write tools', async () => {
  const tools = createMemoryToolDefinitions(store);
  const [list, get, search, retrieve, create, update, remove] = tools;

  expect(list.parameters.safeParse({ scope: 'global' }).success).toBe(false);
  expect(list.parameters.safeParse({}).success).toBe(true);
  expect(get.parameters.safeParse({ scope: 'global', id: memory.id }).success).toBe(false);
  expect(get.parameters.safeParse({ id: memory.id }).success).toBe(true);
  for (const tool of [search, retrieve]) {
    expect(tool.parameters.safeParse({ scope: 'global', query: 'x' }).success).toBe(false);
    expect(tool.parameters.safeParse({ query: 'x' }).success).toBe(true);
  }
  // Write tools require a scope and reject calls that omit it.
  expect(create.parameters.safeParse({ id: memory.id, title: 'T', summary: 'S', content: 'C' }).success).toBe(false);
  expect(
    create.parameters.safeParse({ scope: 'global', id: memory.id, title: 'T', summary: 'S', content: 'C' }).success,
  ).toBe(true);
  expect(update.parameters.safeParse({ id: memory.id, summary: 'Updated' }).success).toBe(false);
  expect(update.parameters.safeParse({ scope: 'global', id: memory.id, summary: 'Updated' }).success).toBe(true);
  expect(remove.parameters.safeParse({ id: memory.id }).success).toBe(false);
  expect(remove.parameters.safeParse({ scope: 'global', id: memory.id }).success).toBe(true);
});

it('retrieves other memories when one result becomes unavailable', async () => {
  const unavailable = { ...memory, id: 'missing-memory' };
  const tools = createMemoryToolDefinitions({
    ...store,
    search: async () => [
      { memory, matchedFields: ['title'], available: true, score: 15 },
      { memory: unavailable, matchedFields: ['title'], available: true, score: 15 },
    ],
    get: async (id) => {
      if (id === unavailable.id) throw new MemoryStorageError('gone');
      return memory;
    },
  });

  expect(JSON.parse((await tools[3].execute({ query: 'rules' })) as string)).toMatchObject({
    memories: [
      { scope: 'global', memory },
      { scope: 'project', memory },
    ],
    unavailableIds: [
      { scope: 'global', id: unavailable.id },
      { scope: 'project', id: unavailable.id },
    ],
  });
});

it('requires approval for destructive memory mutations', async () => {
  const tools = createMemoryToolDefinitions(store);
  const update = tools.find((tool) => tool.name === 'memory_update')!;
  const remove = tools.find((tool) => tool.name === 'memory_delete')!;

  expect(await update.needsApproval({ scope: 'global', id: memory.id, summary: 'Updated' })).toBe(true);
  expect(await remove.needsApproval({ scope: 'global', id: memory.id })).toBe(true);
});

it('auto-approves memory mutations when shell.autoApproveMode is auto or always', async () => {
  const autoSettings = { get: (key: string) => (key === 'shell.autoApproveMode' ? 'auto' : undefined) } as any;
  const autoTools = createMemoryToolDefinitions(store, { settingsService: autoSettings });
  const autoUpdate = autoTools.find((tool) => tool.name === 'memory_update')!;
  const autoRemove = autoTools.find((tool) => tool.name === 'memory_delete')!;

  expect(await autoUpdate.needsApproval({ scope: 'global', id: memory.id, summary: 'Updated' })).toBe(false);
  expect(await autoRemove.needsApproval({ scope: 'global', id: memory.id })).toBe(false);

  const alwaysSettings = { get: (key: string) => (key === 'shell.autoApproveMode' ? 'always' : undefined) } as any;
  const alwaysTools = createMemoryToolDefinitions(store, { settingsService: alwaysSettings });
  expect(
    await alwaysTools.find((t) => t.name === 'memory_update')!.needsApproval({ scope: 'global', id: memory.id }),
  ).toBe(false);
  expect(
    await alwaysTools.find((t) => t.name === 'memory_delete')!.needsApproval({ scope: 'global', id: memory.id }),
  ).toBe(false);

  const advisorySettings = { get: (key: string) => (key === 'shell.autoApproveMode' ? 'advisory' : undefined) } as any;
  const advisoryTools = createMemoryToolDefinitions(store, { settingsService: advisorySettings });
  expect(
    await advisoryTools.find((t) => t.name === 'memory_update')!.needsApproval({ scope: 'global', id: memory.id }),
  ).toBe(true);
  expect(
    await advisoryTools.find((t) => t.name === 'memory_delete')!.needsApproval({ scope: 'global', id: memory.id }),
  ).toBe(true);
});

it('requires memory updates to include a changed field', () => {
  const update = createMemoryToolDefinitions(store).find((tool) => tool.name === 'memory_update')!;

  expect(update.parameters.safeParse({ id: memory.id }).success).toBe(false);
  expect(update.parameters.safeParse({ scope: 'global', id: memory.id, summary: 'Updated' }).success).toBe(true);
});

it('converts domain failures to safe tool errors without paths or stacks', async () => {
  const tools = createMemoryToolDefinitions({
    ...store,
    get: async () => {
      throw new MemoryNotFoundError('/private/path');
    },
  });
  const result = JSON.parse((await tools[1].execute({ id: 'project-rules' })) as string);
  expect(result).toEqual({ error: { code: 'not_found', message: 'Memory was not found.' } });
  expect(JSON.stringify(result)).not.toContain('/private');
});

it('ranks search results across scopes and returns a bounded surrogate-safe content snippet', async () => {
  const content = `before ${'x'.repeat(200)} 😀 needle ${'y'.repeat(200)} after`;
  const global = { ...memory, id: 'same-id', content, updatedAt: '2026-02-01T00:00:00.000Z' };
  const project = { ...global, title: 'Project twin' };
  const tools = createMemoryToolDefinitions({
    global: {
      ...store,
      search: async () => [{ memory: global, matchedFields: ['content'], available: true, score: 2, content }],
    },
    project: {
      ...store,
      search: async () => [{ memory: project, matchedFields: ['content'], available: true, score: 2, content }],
    },
  });

  const result = JSON.parse((await readTool(tools, 'memory_search').execute({ query: 'needle' })) as string);
  expect(result.results.map((entry: { scope: string }) => entry.scope)).toEqual(['global', 'project']);
  expect(result.results[0].contentSnippet).toMatchObject({ truncated: true });
  expect(result.results[0].contentSnippet.text).toContain('needle');
  const snippetBody = result.results[0].contentSnippet.text.replace(/^…/, '').replace(/…$/, '');
  expect(snippetBody.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
  expect(snippetBody.charCodeAt(snippetBody.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  expect(result.results[0].contentSnippet.text.length).toBeLessThanOrEqual(240);
  expect(result.charsUsed).toBe(JSON.stringify(result).length);
});

it('omits complete search records that do not fit the serialized result budget', async () => {
  const first = { ...memory, id: 'first', title: 'small' };
  const oversized = { ...memory, id: 'second', title: '"'.repeat(600) };
  const tools = createMemoryToolDefinitions({
    global: {
      ...store,
      search: async () => [
        { memory: first, matchedFields: ['title'], available: true, score: 15 },
        { memory: oversized, matchedFields: ['title'], available: true, score: 15 },
      ],
    },
    project: { ...store, search: async () => [] },
  });

  const result = JSON.parse(
    (await readTool(tools, 'memory_search').execute({ query: 'small', maxChars: 512 })) as string,
  );
  expect(result.results).toEqual([
    { scope: 'global', memory: memoryMetadata(first), matchedFields: ['title'], available: true },
  ]);
  expect(result.omitted).toBe(1);
  expect(result.charsUsed).toBe(JSON.stringify(result).length);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(512);
});

it('retrieves only complete ranked memories and reports oversized omissions without reordering', async () => {
  const large = { ...memory, id: 'large', content: 'x'.repeat(2_000) };
  const small = { ...memory, id: 'small', content: 'ok' };
  const tools = createMemoryToolDefinitions({
    global: {
      ...store,
      search: async () => [
        { memory: large, matchedFields: ['content'], available: true, score: 2, content: large.content },
        { memory: small, matchedFields: ['content'], available: true, score: 2, content: small.content },
      ],
      get: async (id) => (id === 'large' ? large : small),
    },
    project: { ...store, search: async () => [] },
  });

  const result = JSON.parse(
    (await readTool(tools, 'memory_retrieve').execute({ query: 'x', maxChars: 512 })) as string,
  );
  expect(result.memories).toEqual([{ scope: 'global', memory: small }]);
  expect(result.omittedIds).toEqual([{ scope: 'global', id: 'large' }]);
  expect(result.omittedIdCount).toBe(1);
  expect(result.unavailableIds).toEqual([]);
  expect(result.unavailableIdCount).toBe(0);
  expect(JSON.stringify(result)).not.toContain(large.content.slice(0, 40));
  expect(result.charsUsed).toBe(JSON.stringify(result).length);
});

it('pages oversized memory content with strict cursors and preserves a fitting get shape', async () => {
  const large = { ...memory, content: `start😀${'x'.repeat(2_000)}end` };
  const tools = createMemoryToolDefinitions({ ...store, get: async () => large });
  const get = readTool(tools, 'memory_get');
  const pages: string[] = [];
  let cursor: string | undefined;
  do {
    const page = JSON.parse((await get.execute({ id: large.id, cursor, maxChars: 512 })) as string);
    expect(page.charsUsed).toBe(JSON.stringify(page).length);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(512);
    expect(page.content.text.length).toBeGreaterThan(0);
    pages.push(page.content.text);
    cursor = page.content.nextCursor;
  } while (cursor);
  expect(pages.join('')).toBe(large.content);

  const fitting = JSON.parse(
    (await readTool(createMemoryToolDefinitions(store), 'memory_get').execute({ id: memory.id })) as string,
  );
  expect(fitting).toMatchObject({ scope: 'global', memory });
  expect(fitting.content).toBeUndefined();
});

it('continues from a cursor even when a later larger budget could fit the whole memory', async () => {
  const large = { ...memory, content: 'x'.repeat(2_000) };
  const get = readTool(createMemoryToolDefinitions({ ...store, get: async () => large }), 'memory_get');
  const first = JSON.parse((await get.execute({ id: large.id, maxChars: 512 })) as string);
  const continued = JSON.parse(
    (await get.execute({ id: large.id, cursor: first.content.nextCursor, maxChars: 12_000 })) as string,
  );

  expect(continued.memory).toEqual(memoryMetadata(large));
  expect(continued.content.offset).toBe(first.content.text.length);
  expect(continued.content.text).not.toBe(large.content);
  expect(`${first.content.text}${continued.content.text}`).toBe(large.content);
  expect(continued.content.nextCursor).toBeUndefined();
});

it('reserves omission-count digit growth so index and retrieval outputs remain bounded', async () => {
  const fittingMetadata = { ...memory, id: 'fit', title: 'x'.repeat(296) };
  const oversizedMetadata = Array.from({ length: 10 }, (_, index) => ({
    ...memory,
    id: `large-${index}`,
    title: 'x'.repeat(1_000),
  }));
  const listTools = createMemoryToolDefinitions({
    global: { ...store, list: async () => [fittingMetadata] },
    project: { ...store, list: async () => oversizedMetadata },
  });
  const list = JSON.parse((await readTool(listTools, 'memory_list').execute({ maxChars: 512, limit: 11 })) as string);
  expect(list).toMatchObject({ global: [], project: [], omitted: { global: 1, project: 10 } });
  expect(JSON.stringify(list).length).toBeLessThanOrEqual(512);

  const fittingSearch = { ...memory, id: 'fit', title: 'x'.repeat(274) };
  const searchCandidates = [
    { memory: fittingSearch, matchedFields: ['title'] as Array<'title'>, available: true, score: 15 },
    ...oversizedMetadata.map((candidate) => ({
      memory: candidate,
      matchedFields: ['title'] as Array<'title'>,
      available: true,
      score: 15,
    })),
  ];
  const searchTools = createMemoryToolDefinitions({
    global: { ...store, search: async () => searchCandidates },
    project: { ...store, search: async () => [] },
  });
  const search = JSON.parse(
    (await readTool(searchTools, 'memory_search').execute({ query: 'x', maxChars: 512, limit: 11 })) as string,
  );
  expect(search).toMatchObject({ results: [], omitted: 11 });
  expect(JSON.stringify(search).length).toBeLessThanOrEqual(512);

  const fittingMemory = { ...memory, id: 'fit', content: 'x'.repeat(236) };
  const unavailableReferences = Array.from({ length: 10 }, (_, index) => ({
    ...memory,
    id: `z${index}${'x'.repeat(1_000)}`,
  }));
  const retrieveCandidates = [
    {
      memory: fittingMemory,
      matchedFields: ['content'] as Array<'content'>,
      available: true,
      score: 2,
      content: fittingMemory.content,
    },
    ...unavailableReferences.map((candidate) => ({
      memory: candidate,
      matchedFields: ['content'] as Array<'content'>,
      available: true,
      score: 2,
      content: candidate.content,
    })),
  ];
  const retrieveTools = createMemoryToolDefinitions({
    global: {
      ...store,
      search: async () => retrieveCandidates,
      get: async (id) => (id === fittingMemory.id ? fittingMemory : { ...memory, id, content: 'x'.repeat(2_000) }),
    },
    project: { ...store, search: async () => [] },
  });
  const retrieve = JSON.parse(
    (await readTool(retrieveTools, 'memory_retrieve').execute({ query: 'x', maxChars: 512, limit: 11 })) as string,
  );
  expect(retrieve).toMatchObject({ memories: [], omittedIdCount: 11, unavailableIdCount: 0 });
  expect(JSON.stringify(retrieve).length).toBeLessThanOrEqual(512);
});

it('reserves unavailable-count digit growth before admitting retrieval diagnostics', async () => {
  const unavailable = [
    ...Array.from({ length: 8 }, (_, index) => ({
      ...memory,
      id: `${String.fromCharCode(97 + index)}${'x'.repeat(19)}`,
      title: 'x',
    })),
    { ...memory, id: 'z', title: 'x' },
    { ...memory, id: `zz${'x'.repeat(1_000)}`, title: 'x' },
  ];
  const tools = createMemoryToolDefinitions({
    global: {
      ...store,
      search: async () =>
        unavailable.map((candidate) => ({
          memory: candidate,
          matchedFields: ['title'] as const,
          available: false,
          score: 15,
        })),
    },
    project: { ...store, search: async () => [] },
  });

  const result = JSON.parse(
    (await readTool(tools, 'memory_retrieve').execute({ query: 'x', maxChars: 512, limit: 10 })) as string,
  );
  expect(result.unavailableIdCount).toBe(10);
  expect(result.unavailableIds).toHaveLength(8);
  expect(JSON.stringify(result).length).toBeLessThanOrEqual(512);
});

it('returns a bounded JSON failure under a tiny runtime byte cap instead of throwing', async () => {
  const original = getTrimConfig();
  const minimal = JSON.stringify({ error: { code: 'output_budget_exceeded' } });
  const list = readTool(createMemoryToolDefinitions({ ...store, list: async () => [] }), 'memory_list');
  try {
    setTrimConfig({ maxCharacters: minimal.length });
    expect(await list.execute({})).toBe(minimal);

    setTrimConfig({ maxCharacters: 1 });
    expect(await list.execute({})).toBe('0');
  } finally {
    setTrimConfig(original);
  }
});

it('preserves the actionable validation message for invalid memory input', async () => {
  const tools = createMemoryToolDefinitions({
    ...store,
    create: async () => {
      throw new InvalidMemoryError('Summary must not exceed 1,000 characters.');
    },
  });

  const result = JSON.parse(
    (await readTool(tools, 'memory_create').execute({
      scope: 'project',
      id: 'project-rules',
      title: 'Rules',
      summary: 'too long',
      content: 'content',
    })) as string,
  );

  expect(result).toEqual({
    error: { code: 'invalid_memory', message: 'Summary must not exceed 1,000 characters.' },
  });
});

it('rejects blank queries and malformed or stale memory cursors with bounded public errors', async () => {
  const tools = createMemoryToolDefinitions(store);
  const search = readTool(tools, 'memory_search');
  expect(search.parameters.safeParse({ query: '   ' }).success).toBe(false);
  expect(search.parameters.safeParse({ query: 'x', maxChars: 511 }).success).toBe(false);
  expect(search.parameters.safeParse({ query: 'x', maxChars: 12_001 }).success).toBe(false);

  const invalid = JSON.parse((await readTool(tools, 'memory_get').execute({ id: memory.id, cursor: 'bad' })) as string);
  expect(invalid).toEqual({ error: { code: 'invalid_cursor', message: 'The memory cursor is invalid.' } });

  let current = { ...memory, content: 'x'.repeat(2_000) };
  const get = readTool(createMemoryToolDefinitions({ ...store, get: async () => current }), 'memory_get');
  const first = JSON.parse((await get.execute({ id: memory.id, maxChars: 512 })) as string);
  current = { ...current, updatedAt: '2026-01-02T00:00:00.000Z' };
  const stale = JSON.parse(
    (await get.execute({ id: memory.id, cursor: first.content.nextCursor, maxChars: 512 })) as string,
  );
  expect(stale).toEqual({ error: { code: 'stale_cursor', message: 'The memory cursor is stale.' } });
});
