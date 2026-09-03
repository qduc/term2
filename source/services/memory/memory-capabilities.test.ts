import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { MemoryCapabilityBuilder } from './memory-capabilities.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'term2-memory-capability-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

const writeTools = [
  'memory_list',
  'memory_get',
  'memory_search',
  'memory_retrieve',
  'memory_create',
  'memory_update',
  'memory_delete',
];
const mainWriteTools = [...writeTools.slice(0, 4), 'memory_synthesize', ...writeTools.slice(4)];
const readTools = ['memory_list', 'memory_get', 'memory_search', 'memory_retrieve'];
const mutatingTools = new Set(['memory_create', 'memory_update', 'memory_delete']);

describe('MemoryCapabilityBuilder', () => {
  it.each([
    ['default', { kind: 'main' as const }, 'write', mainWriteTools],
    ['plan', { kind: 'main' as const }, 'write', mainWriteTools],
    ['lite', { kind: 'main' as const }, 'write', mainWriteTools],
    ['main-agent-mentor', { kind: 'main' as const }, 'write', mainWriteTools],
    ['orchestrator', { kind: 'main' as const }, 'write', mainWriteTools],
    ['explorer', { kind: 'subagent' as const, role: 'explorer' }, 'read', readTools],
    ['worker', { kind: 'subagent' as const, role: 'worker' }, 'read', readTools],
    ['mentor', { kind: 'subagent' as const, role: 'mentor' }, 'none', []],
    ['librarian', { kind: 'subagent' as const, role: 'librarian' }, 'write', writeTools],
  ])('grants %s the expected enabled-memory access', (_mode, subject, access, tools) => {
    const capability = new MemoryCapabilityBuilder(createMockSettingsService()).build(subject);

    expect(capability.access).toBe(access);
    expect(capability.tools.map((tool) => tool.name)).toEqual(tools);
    expect(capability.guidance).toEqual(
      access === 'none' ? '' : expect.stringMatching(/Persistent memory|Memory librarian/),
    );
    if (access === 'none') expect(capability.context).toBe('');
  });

  it.each(['explorer', 'worker'] as const)('gives %s a strict read-only subset of main memory tools', (role) => {
    const directory = mkdtempSync(join(tmpdir(), 'term2-memory-capability-'));
    try {
      const capability = new MemoryCapabilityBuilder(
        createMockSettingsService({ 'memory.directory': directory }),
      ).build({
        kind: 'subagent',
        role,
      });
      const mainTools = new Set(
        new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }))
          .build({ kind: 'main' })
          .tools.map((tool) => tool.name),
      );
      const readToolNames = new Set(capability.tools.map((tool) => tool.name));

      expect([...readToolNames].some((name) => mutatingTools.has(name))).toBe(false);
      expect([...readToolNames].every((name) => mainTools.has(name))).toBe(true);
      expect(readToolNames.size).toBeLessThan(mainTools.size);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['explorer', 'worker'] as const)(
    'gives %s on-demand read access without injecting memory context',
    (role) => {
      const directory = makeTempDir();
      mkdirSync(join(directory, 'items'));
      writeFileSync(
        join(directory, 'index.json'),
        JSON.stringify({
          version: 1,
          memories: [
            {
              id: 'durable-rule',
              title: 'Durable rule',
              summary: 'Read this only on demand.',
              tags: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      );

      const capability = new MemoryCapabilityBuilder(
        createMockSettingsService({ 'memory.directory': directory }),
      ).build({ kind: 'subagent', role });

      expect(capability.tools.map((tool) => tool.name)).toEqual(readTools);
      expect(capability.guidance).toContain('propose it in your final report');
      expect(capability.guidance).toContain('No index is injected into your context');
      expect(capability.guidance).toContain('materially improve correctness');
      expect(capability.context).toBe('');
    },
  );

  it('guides the main agent to review durable turn outcomes without storing routine conversation', () => {
    const capability = new MemoryCapabilityBuilder(createMockSettingsService()).build({ kind: 'main' });

    expect(capability.guidance).toContain('memory_retrieve');
    expect(capability.guidance).toContain('cursor when a large memory is paged');
    expect(capability.guidance).toContain('Before finishing a task');
    expect(capability.guidance).toContain('explicit durable');
    expect(capability.guidance).toContain('ordinary conversation');
  });

  it('injects summary context for a main agent with write access', () => {
    const directory = makeTempDir();
    mkdirSync(join(directory, 'items'));
    writeFileSync(
      join(directory, 'index.json'),
      JSON.stringify({
        version: 1,
        memories: [
          {
            id: 'durable-rule',
            title: 'Durable rule',
            summary: 'Inject this for the main agent.',
            tags: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const capability = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory })).build({
      kind: 'main',
    });

    expect(capability.tools.map((tool) => tool.name)).toEqual(mainWriteTools);
    expect(capability.context).toContain('Inject this for the main agent.');
  });

  it('isolates project memories by project path and injects both scopes', async () => {
    const directory = makeTempDir();
    const first = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory })).build(
      { kind: 'main' },
      { projectPath: '/workspace/first' },
    );
    const second = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory })).build(
      { kind: 'main' },
      { projectPath: '/workspace/second' },
    );
    const firstCreate = first.tools.find((tool) => tool.name === 'memory_create')!;
    const firstList = first.tools.find((tool) => tool.name === 'memory_list')!;
    const secondList = second.tools.find((tool) => tool.name === 'memory_list')!;

    await firstCreate.execute({
      scope: 'project',
      id: 'local-rule',
      title: 'Local rule',
      summary: 'Only for the first project.',
      content: 'Project-specific content.',
    });

    expect(JSON.parse((await firstList.execute({})) as string).project).toHaveLength(1);
    expect(JSON.parse((await secondList.execute({})) as string).project).toHaveLength(0);

    const rebuilt = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory })).build(
      { kind: 'main' },
      { projectPath: '/workspace/first' },
    );
    expect(rebuilt.context).toContain('Project scope');
    expect(rebuilt.context).toContain('Only for the first project.');
  });

  it.each([
    { kind: 'main' } as const,
    { kind: 'subagent' as const, role: 'worker' } as const,
    { kind: 'subagent' as const, role: 'librarian' } as const,
  ])('removes tools, guidance, and context when memory is disabled', (subject) => {
    const capability = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.enabled': false })).build(
      subject,
    );

    expect(capability).toMatchObject({ access: 'none', tools: [], guidance: '', context: '' });
  });

  it('gives librarian write access without injecting memory context', () => {
    const capability = new MemoryCapabilityBuilder(createMockSettingsService()).build({
      kind: 'subagent',
      role: 'librarian',
    });

    expect(capability.access).toBe('write');
    expect(capability.tools.map((tool) => tool.name)).toEqual(writeTools);
    expect(capability.context).toBe('');
    expect(capability.guidance).toContain('memory librarian');
  });

  it('states the omission contract in the main guidance and the on-demand contract for subagents', () => {
    const main = new MemoryCapabilityBuilder(createMockSettingsService()).build({ kind: 'main' });
    const explorer = new MemoryCapabilityBuilder(createMockSettingsService()).build({
      kind: 'subagent',
      role: 'explorer',
    });

    expect(main.guidance).toContain('had it omitted for budget');
    expect(main.guidance).toContain('read it with memory_get before treating it as irrelevant');
    expect(explorer.guidance).not.toContain('concise index');
  });

  it('donates unused global scope budget to a project scope that exceeds its fair share', async () => {
    const directory = makeTempDir();
    const settings = createMockSettingsService({
      'memory.directory': directory,
      'memory.contextBudgetChars': 8000,
    });
    const builder = (projectPath: string) =>
      new MemoryCapabilityBuilder(settings).build({ kind: 'main' }, { projectPath });
    const create = builder('/workspace/donation').tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'global',
      id: 'global-rule',
      title: 'Global rule',
      summary: 'Cross-project preference.',
      content: 'content',
    });
    const projectSummaries = 60;
    for (let index = 0; index < projectSummaries; index += 1) {
      await create.execute({
        scope: 'project',
        id: `project-mem-${String(index).padStart(2, '0')}`,
        title: `Title ${index}`,
        summary: `Project summary ${index} ${'y'.repeat(60)}`,
        content: 'content',
      });
    }

    const context = builder('/workspace/donation').context;
    expect(context).toContain('Global scope:');
    expect(context).toContain('60 memories · 60 summarized · 0 title-only · 0 not listed.');
    expect(context).toContain('`project-mem-59`');
  });

  it('gives the root a broad synthesis operation without exposing it recursively to the librarian', () => {
    const settings = createMockSettingsService();
    const main = new MemoryCapabilityBuilder(settings).build({ kind: 'main' });
    const librarian = new MemoryCapabilityBuilder(settings).build({ kind: 'subagent', role: 'librarian' });

    expect(main.tools.map((tool) => tool.name)).toContain('memory_synthesize');
    expect(librarian.tools.map((tool) => tool.name)).not.toContain('memory_synthesize');
    expect(main.guidance).toContain('Use memory_synthesize when the task depends on several memories');
  });
});
