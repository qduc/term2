import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileMemoryStore, InvalidMemoryError, MemoryStorageError } from './memory-store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
async function store() {
  const root = await mkdtemp(join(tmpdir(), 'term2-memory-'));
  roots.push(root);
  return new FileMemoryStore({ root, now: () => new Date('2026-07-12T00:00:00.000Z') });
}
const input = {
  id: 'project-rules',
  title: 'Project rules',
  summary: 'Durable project constraints.',
  content: '# Rules\nUse TypeScript.',
  tags: [' Term2 ', 'term2', 'Architecture'],
};

it('persists normalized metadata and Markdown content across store instances', async () => {
  const first = await store();
  const created = await first.create(input);
  expect(created.tags).toEqual(['term2', 'architecture']);
  const second = new FileMemoryStore({ root: roots[0] });
  expect(await second.get(input.id)).toMatchObject({ ...input, tags: ['term2', 'architecture'] });
  expect(JSON.parse(await readFile(join(roots[0], 'index.json'), 'utf8')).memories[0]).not.toHaveProperty('content');
});

it('validates IDs and inputs before constructing item paths', async () => {
  const memory = await store();
  await expect(memory.create({ ...input, id: '../escape' })).rejects.toBeInstanceOf(InvalidMemoryError);
  await expect(memory.create({ ...input, id: 123 as any })).rejects.toBeInstanceOf(InvalidMemoryError);
  await expect(memory.create({ ...input, summary: ' ' })).rejects.toBeInstanceOf(InvalidMemoryError);
});

it('updates partial fields, changes timestamp, and removes broken entries', async () => {
  const memory = await store();
  await memory.create(input);
  const later = new FileMemoryStore({ root: roots[0], now: () => new Date('2026-07-13T00:00:00.000Z') });
  const updated = await later.update(input.id, { title: 'New rules', content: 'Updated Markdown' });
  expect(updated).toMatchObject({
    title: 'New rules',
    content: 'Updated Markdown',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
  });
  expect((await later.get(input.id))?.content).toBe('Updated Markdown');
  await rm(join(roots[0], 'items', `${input.id}.md`));
  await expect(memory.get(input.id)).rejects.toBeInstanceOf(MemoryStorageError);
  expect(await memory.remove(input.id)).toBe(true);
  expect(await memory.remove(input.id)).toBe(false);
});

it('returns null for an absent memory without creating content', async () => {
  const memory = await store();
  expect(await memory.get('unknown-memory')).toBeNull();
});

it('searches deterministically with fixed field scoring and tie breaking', async () => {
  const memory = await store();
  await memory.create(input);
  await memory.create({
    ...input,
    id: 'rules-guide',
    title: 'Rules guide',
    summary: 'More durable rules.',
    content: 'Nothing',
    tags: [],
  });
  const results = await memory.search('rules');
  expect(results.map((result) => result.memory.id)).toEqual(['rules-guide', 'project-rules']);
  expect(results[1].matchedFields).toEqual(expect.arrayContaining(['id', 'title', 'content']));
});

it('reports malformed indexes rather than replacing them and replaces indexes atomically', async () => {
  const memory = await store();
  await memory.create(input);
  expect(await readFile(join(roots[0], 'index.json.tmp'), 'utf8').catch(() => '')).toBe('');
  await writeFile(join(roots[0], 'index.json'), '{ bad');
  await expect(new FileMemoryStore({ root: roots[0] }).list()).rejects.toBeInstanceOf(MemoryStorageError);
});

it('rejects corrupted index metadata with invalid field types', async () => {
  const memory = await store();
  await writeFile(
    join(roots[0], 'index.json'),
    JSON.stringify({
      version: 1,
      memories: [
        {
          id: 'project-rules',
          title: 42,
          summary: 'Durable project constraints.',
          tags: ['term2', 1],
          createdAt: 'not-a-timestamp',
          updatedAt: '2026-07-12T00:00:00.000Z',
        },
      ],
    }),
  );
  await expect(memory.list()).rejects.toBeInstanceOf(MemoryStorageError);
  await expect(memory.list()).rejects.toThrow(/Memory index\.json/);
});

it('searches every indexed memory before applying its result limit', async () => {
  const memory = await store();
  const memories = Array.from({ length: 51 }, (_, index) => ({
    id: index === 50 ? 'z-target' : `memory-${index}`,
    title: `Memory ${index}`,
    summary: 'Durable project constraint.',
    tags: [],
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
  }));
  await writeFile(join(roots[0], 'index.json'), JSON.stringify({ version: 1, memories }));

  expect((await memory.search('z-target')).map((result) => result.memory.id)).toEqual(['z-target']);
});

it('serializes concurrent in-process mutations', async () => {
  const memory = await store();
  await Promise.all(Array.from({ length: 8 }, (_, index) => memory.create({ ...input, id: `rule-${index}` })));
  expect((await memory.list({ limit: 20 })).map((entry) => entry.id)).toHaveLength(8);
});

it('renders summary-only context within a budget', async () => {
  const memory = await store();
  await memory.create(input);
  await memory.create({
    ...input,
    id: 'second-rule',
    title: 'Second',
    summary:
      'A second durable constraint that is deliberately long enough to exceed the compact context budget while the first summary remains available.',
    content: 'full secret content',
  });
  const context = await memory.context(300);
  expect(context).toContain('## Persistent memory');
  expect(context).toContain('project-rules');
  expect(context).not.toContain('full secret content');
  expect(context).toContain('Additional memories');
});

it('omits initial context on a clean first run', async () => {
  expect((await store()).contextSync(3000)).toBe('');
});
