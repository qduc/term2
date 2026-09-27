import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const readTools = ['memory_list', 'memory_get', 'memory_search', 'memory_retrieve'];
const mutatingTools = new Set(['memory_create', 'memory_update', 'memory_delete']);

describe('MemoryCapabilityBuilder', () => {
  it('shares one on-disk project store between a git checkout and its worktrees', async () => {
    const directory = makeTempDir();
    const root = realpathSync(makeTempDir());
    const repo = join(root, 'repo');
    const worktree = join(root, 'repo-worktree');
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i'], {
      cwd: repo,
      stdio: 'ignore',
    });
    execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: repo, stdio: 'ignore' });
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));

    await builder
      .projectStore(worktree)
      .create({ id: 'shared-rule', title: 'Shared rule', summary: 'Applies everywhere.', content: 'body' });

    expect(await builder.projectStore(repo).get('shared-rule')).not.toBeNull();
    // Existing stores are addressed by sha256 of the project root; changing the
    // key would orphan every memory already written.
    const projectId = createHash('sha256').update(repo).digest('hex');
    expect(existsSync(join(directory, 'projects', projectId))).toBe(true);
  });

  it.each([
    ['default', { kind: 'main' as const }, 'write', writeTools],
    ['plan', { kind: 'main' as const }, 'write', writeTools],
    ['lite', { kind: 'main' as const }, 'write', writeTools],
    ['main-agent-mentor', { kind: 'main' as const }, 'write', writeTools],
    ['orchestrator', { kind: 'main' as const }, 'write', writeTools],
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
    expect(capability.guidance).toContain('durable user preference');
    expect(capability.guidance).toContain('note the date');
    expect(capability.guidance).toContain('ordinary conversation');
    expect(capability.guidance).toContain('facts already recorded in repo docs or git');
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

    expect(capability.tools.map((tool) => tool.name)).toEqual(writeTools);
    expect(capability.context).toContain('Inject this for the main agent.');
  });

  it('isolates project memories by project path without pinning them', async () => {
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
    expect(rebuilt.context).not.toContain('Project scope');
    expect(rebuilt.context).not.toContain('Only for the first project.');
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

  it('states the pinned-global and on-demand-project contract without automatic recall', () => {
    const main = new MemoryCapabilityBuilder(createMockSettingsService()).build({ kind: 'main' });
    const explorer = new MemoryCapabilityBuilder(createMockSettingsService()).build({
      kind: 'subagent',
      role: 'explorer',
    });

    expect(main.guidance).toContain('Global memories are listed in your instructions');
    expect(main.guidance).toContain('Search or retrieve project memories');
    expect(main.guidance).not.toContain('<memory-recall>');
    expect(explorer.guidance).not.toContain('concise index');
  });

  it('pins only global summaries and reports globals omitted by the 3000-char cap', async () => {
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
    expect(context).toContain('Global memories');
    expect(context).toContain('Cross-project preference.');
    expect(context).not.toContain('Project summary');
    expect(context.length).toBeLessThanOrEqual(3000);
  });

  it('counts omitted global memories within the configured instruction budget', async () => {
    const directory = makeTempDir();
    const settings = createMockSettingsService({ 'memory.directory': directory, 'memory.contextBudgetChars': 500 });
    const builder = new MemoryCapabilityBuilder(settings);
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    for (let i = 0; i < 40; i++) {
      await create.execute({
        scope: 'global',
        id: `rule-${i}`,
        title: `Rule ${i}`,
        summary: 'A durable preference with details.',
        content: 'body',
      });
    }
    const context = builder.build({ kind: 'main' }).context;
    expect(context).toMatch(/\+ \d+ more global memories exist; find them with memory_search\./);
    expect(context.length).toBeLessThanOrEqual(500);
  });
});
