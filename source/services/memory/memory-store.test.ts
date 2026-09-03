import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

it('rejects updates that do not change any memory fields', async () => {
  const memory = await store();
  await memory.create(input);

  await expect(memory.update(input.id, {})).rejects.toThrow(/at least one field/i);
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
  expect(results[1]).toMatchObject({ score: 37, content: '# Rules\nUse TypeScript.' });
});

it('recovers a missing index from the last durable backup', async () => {
  const memory = await store();
  await memory.create(input);
  await rm(join(roots[0], 'index.json'));

  expect(await new FileMemoryStore({ root: roots[0] }).list()).toMatchObject([{ id: input.id }]);
});

it('recovers a corrupted index from the last durable backup', async () => {
  const memory = await store();
  await memory.create(input);
  expect(await readFile(join(roots[0], 'index.json.tmp'), 'utf8').catch(() => '')).toBe('');
  await writeFile(join(roots[0], 'index.json'), '{ bad');

  expect(await new FileMemoryStore({ root: roots[0] }).list()).toMatchObject([{ id: input.id }]);
});

it('rejects corrupted index metadata with invalid field types', async () => {
  const memory = await store();
  await memory.create(input);
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

it('allows summaries longer than the old 300-character limit', async () => {
  const memory = await store();
  const longSummary = 'summary '.repeat(60);

  const created = await memory.create({ ...input, id: 'long-summary', summary: longSummary });

  expect(created.summary).toBe(longSummary.trim());
});

it('settles a failed create without leaving metadata when the content path is a directory', async () => {
  const memory = await store();
  await memory.list();
  const id = 'blocked-memory';
  await mkdir(join(roots[0], 'items', `${id}.md`));

  await expect(memory.create({ ...input, id })).rejects.toBeDefined();
  expect((await memory.list()).find((entry) => entry.id === id)).toBeUndefined();
});

it('settles remove when content is already missing and omits the metadata', async () => {
  const memory = await store();
  await memory.create(input);
  await rm(join(roots[0], 'items', `${input.id}.md`));

  await expect(memory.remove(input.id)).resolves.toBe(true);
  expect((await memory.list()).find((entry) => entry.id === input.id)).toBeUndefined();
});

it('marks search results whose full content is unavailable', async () => {
  const memory = await store();
  await memory.create(input);
  await rm(join(roots[0], 'items', `${input.id}.md`));

  expect(await memory.search('project-rules')).toMatchObject([{ available: false }]);
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

it('serializes mutations across store instances sharing a directory', async () => {
  const first = await store();
  const second = new FileMemoryStore({ root: roots[0] });

  await Promise.all([
    ...Array.from({ length: 4 }, (_, index) => first.create({ ...input, id: `first-${index}` })),
    ...Array.from({ length: 4 }, (_, index) => second.create({ ...input, id: `second-${index}` })),
  ]);

  expect(await first.list({ limit: 20 })).toHaveLength(8);
});

type Seed = { id: string; title: string; summary: string; day: number };
function dayTimestamp(day: number) {
  return `2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`;
}
async function storeWithSeeds(seeds: Seed[]) {
  const memory = await store();
  await writeFile(
    join(roots[0], 'index.json'),
    JSON.stringify({
      version: 1,
      memories: seeds.map((seed) => ({
        id: seed.id,
        title: seed.title,
        summary: seed.summary,
        tags: [],
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: dayTimestamp(seed.day),
      })),
    }),
  );
  return memory;
}

it('lists every memory with its summary and full counts when everything fits', async () => {
  const memory = await storeWithSeeds([
    { id: 'mem-1', title: 'Rules one', summary: 'First durable rule.', day: 5 },
    { id: 'mem-2', title: 'Rules two', summary: 'Second durable rule.', day: 4 },
  ]);
  const text = memory.contextSync(8000);
  expect(text).toContain(
    '2 memories · 2 summarized · 0 title-only · 0 not listed. Load full memories selectively with memory_get.',
  );
  expect(text).toContain('- `mem-1` — Rules one — First durable rule.');
  expect(text).toContain('- `mem-2` — Rules two — Second durable rule.');
  expect(text).not.toContain('older entries, titles only');
  expect(text).not.toContain('memory_list or memory_search for the full index');
  expect(text.length).toBeLessThanOrEqual(8000);
});

it('degrades older entries as a contiguous recency prefix with counted omissions', async () => {
  const memory = await storeWithSeeds([
    { id: 'mem-1', title: `Title 1 ${'x'.repeat(70)}`, summary: 'Summary 1.', day: 5 },
    { id: 'mem-2', title: `Title 2 ${'x'.repeat(70)}`, summary: 'Summary 2.', day: 4 },
    { id: 'mem-3', title: `Title 3 ${'x'.repeat(70)}`, summary: 'Summary 3.', day: 3 },
    { id: 'mem-4', title: `Title 4 ${'x'.repeat(70)}`, summary: 'Summary 4.', day: 2 },
    { id: 'mem-5', title: `Title 5 ${'x'.repeat(70)}`, summary: 'Summary 5.', day: 1 },
  ]);
  const text = memory.contextSync(550);
  expect(text).toContain(
    '5 memories · 3 summarized · 0 title-only · 2 not listed. Load full memories selectively with memory_get.',
  );
  expect(text).toContain(`- \`mem-1\` — Title 1 ${'x'.repeat(70)} — Summary 1.`);
  expect(text).toContain(`- \`mem-3\` — Title 3 ${'x'.repeat(70)} — Summary 3.`);
  expect(text).toContain('+ 2 not listed — memory_list or memory_search for the full index.');
  expect(text).not.toContain('- `mem-4`');
  expect(text).not.toContain('— older entries, titles only —');
  expect(text.length).toBeLessThanOrEqual(550);
});

it('never summarizes an older entry after excluding a newer one', async () => {
  const memory = await storeWithSeeds([
    { id: 'mem-new', title: 'New title', summary: 'N'.repeat(120), day: 5 },
    { id: 'mem-old', title: 'Old title', summary: 'tiny sum', day: 4 },
  ]);
  const text = memory.contextSync(190);
  expect(text).not.toContain('tiny sum');
  expect(text).toContain('2 memories · 0 summarized · 2 title-only · 0 not listed.');
  expect(text).toContain('- `mem-new` — New title');
  expect(text).toContain('- `mem-old` — Old title');
  expect(text.length).toBeLessThanOrEqual(190);
});

it('caps rendered titles without mutating stored metadata', async () => {
  const memory = await storeWithSeeds([{ id: 'solo', title: 'A'.repeat(150), summary: 'S'.repeat(30), day: 5 }]);
  const text = memory.contextSync(8000);
  expect(text).toContain(`${'A'.repeat(120)}…`);
  expect(text).not.toContain('A'.repeat(121));
  expect((await memory.list())[0]?.title).toBe('A'.repeat(150));
});

it('renders identical text through context and contextSync', async () => {
  const memory = await storeWithSeeds([
    { id: 'mem-1', title: 'One', summary: 'First.', day: 5 },
    { id: 'mem-2', title: 'Two', summary: 'Second.', day: 4 },
    { id: 'mem-3', title: 'Three', summary: 'Third.', day: 3 },
  ]);
  expect(await memory.context(900)).toBe(memory.contextSync(900));
});

it('stays within its budget across regimes while keeping the status line visible', async () => {
  const memory = await storeWithSeeds(
    Array.from({ length: 12 }, (_, index) => ({
      id: `mem-${String(index).padStart(2, '0')}`,
      title: `Title ${index}`,
      summary: `Summary ${index} ${'x'.repeat(20)}`,
      day: 12 - index,
    })),
  );
  for (const budget of [250, 500, 1000, 2000, 4000, 8000]) {
    const text = memory.contextSync(budget);
    expect(text).toContain('12 memories ·');
    expect(text.length).toBeLessThanOrEqual(budget);
  }
});

it('degrades the newest summary first and lists older entries titles-only within a tiny budget', async () => {
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
  expect(context).toContain(
    '2 memories · 1 summarized · 1 title-only · 0 not listed. Load full memories selectively with memory_get.',
  );
  expect(context).toContain('- `project-rules` — Project rules — Durable project constraints.');
  expect(context).toContain('- `second-rule` — Second\n');
  expect(context).toContain('— older entries, titles only —');
  expect(context).not.toContain('full secret content');
  expect(context).not.toContain('A second durable constraint');
  expect(context.length).toBeLessThanOrEqual(300);
});

it('omits initial context on a clean first run', async () => {
  expect((await store()).contextSync(3000)).toBe('');
});
