import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { MemoryCapabilityBuilder } from './memory-capabilities.js';
import { AutomaticMemoryCanary } from './automatic-memory-canary.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { MEMORY_RECALL_CLOSE, MEMORY_RECALL_OPEN, recalledMemoryKeys } from '../../prompts/memory-recall-notice.js';

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

  it('makes an automatic project preference available to a new session and supports undo', async () => {
    const directory = makeTempDir();
    const settings = createMockSettingsService({ 'memory.directory': directory });
    const first = new MemoryCapabilityBuilder(settings);
    const receipt = await new AutomaticMemoryCanary(first.projectStore(process.cwd())).record(
      'For future sessions, I prefer short test reports.',
      'prior-session',
    );
    expect(receipt).not.toBeNull();
    const returning = new MemoryCapabilityBuilder(settings);
    const selected = await returning.selectForTurn('Please prepare short test reports.', {
      projectPath: process.cwd(),
    });
    expect(selected.memories).toContainEqual(expect.objectContaining({ id: receipt!.id, scope: 'project' }));
    expect((await returning.projectStore(process.cwd()).get(receipt!.id))?.provenance?.sessionId).toBe('prior-session');
    await returning.projectStore(process.cwd()).remove(receipt!.id);
    expect(
      (await returning.selectForTurn('Please prepare short test reports.', { projectPath: process.cwd() })).memories,
    ).toEqual([]);
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
    expect(capability.guidance).toContain('Before finishing a task');
    expect(capability.guidance).toContain('explicit durable');
    expect(capability.guidance).toContain('ordinary conversation');
    expect(capability.guidance).toContain('facts easily recovered by reading the repository');
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

  it('states the recall contract in the main guidance and the on-demand contract for subagents', () => {
    const main = new MemoryCapabilityBuilder(createMockSettingsService()).build({ kind: 'main' });
    const explorer = new MemoryCapabilityBuilder(createMockSettingsService()).build({
      kind: 'subagent',
      role: 'explorer',
    });

    expect(main.guidance).toContain('<memory-recall> block ahead of that message');
    expect(main.guidance).toContain('not a complete index');
    expect(main.guidance).toContain('read the full memory with memory_get');
    expect(explorer.guidance).not.toContain('concise index');
  });

  it('selects an older task-relevant decision ahead of newer unrelated memories without leaking content', async () => {
    const directory = makeTempDir();
    const settings = createMockSettingsService({ 'memory.directory': directory, 'memory.contextBudgetChars': 800 });
    const builder = new MemoryCapabilityBuilder(settings);
    const create = builder
      .build({ kind: 'main' }, { projectPath: '/workspace/recall' })
      .tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'project',
      id: 'nested-chain',
      title: 'Codex nested-chain incident',
      summary: 'Child runs need distinct physical WebSocket identity; preserve root cache affinity and chaining.',
      content: 'Do not disable chaining.',
    });
    for (let i = 0; i < 25; i++) {
      await create.execute({
        scope: 'project',
        id: `release-${i}`,
        title: 'Release notes',
        summary: 'Unrelated release-note work.',
        content: 'No socket decision.',
      });
    }
    const recencyIndex = builder.build({ kind: 'main' }, { projectPath: '/workspace/recall' }).context;
    expect(recencyIndex).not.toContain('distinct physical WebSocket identity');
    const selected = await builder.contextForTurn('The nested Codex 400s are back. What should we avoid?', {
      projectPath: '/workspace/recall',
    });
    expect(selected).toContain('distinct physical WebSocket identity');
    expect(selected).not.toContain('Unrelated release-note work');
    expect(selected).not.toContain('Do not disable chaining.');
    expect(selected.length).toBeLessThanOrEqual(800);
    expect(
      (
        await builder.selectForTurn('The nested Codex 400s are back. What should we avoid?', {
          projectPath: '/workspace/recall',
        })
      ).memories,
    ).toEqual([{ scope: 'project', id: 'nested-chain', title: 'Codex nested-chain incident' }]);
  });

  it('renders a bounded recall block for the user turn and skips already-recalled memories', async () => {
    const directory = makeTempDir();
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    for (const id of ['socket-a', 'socket-b', 'socket-c', 'socket-d', 'socket-e']) {
      await create.execute({
        scope: 'project',
        id,
        title: `Socket rule ${id}`,
        summary: `Socket guidance ${id}.`,
        content: 'details',
      });
    }

    const first = await builder.selectForTurn('socket');
    expect(first.memories).toHaveLength(3);
    expect(first.text.startsWith(MEMORY_RECALL_OPEN)).toBe(true);
    expect(first.text.endsWith(MEMORY_RECALL_CLOSE)).toBe(true);
    expect([...recalledMemoryKeys([first.text])]).toEqual(
      first.memories.map((memory) => `${memory.scope}:${memory.id}`),
    );

    const second = await builder.selectForTurn('socket', { exclude: recalledMemoryKeys([first.text]) });
    expect(second.memories).toHaveLength(2);
    expect(second.memories.map((memory) => memory.id)).not.toContain(first.memories[0]!.id);
    const third = await builder.selectForTurn('socket', {
      exclude: recalledMemoryKeys([first.text, second.text]),
    });
    expect(third).toEqual({ text: '', memories: [] });
  });

  it('does not inject an unrelated lexical match or memories when disabled', async () => {
    const directory = makeTempDir();
    const enabled = createMockSettingsService({ 'memory.directory': directory });
    const builder = new MemoryCapabilityBuilder(enabled);
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'global',
      id: 'cost-policy',
      title: 'Cost policy',
      summary: 'Always report experiment costs.',
      content: 'Include costs.',
    });
    expect(await builder.contextForTurn('The cost of this?')).toContain('Always report experiment costs.');
    expect(await builder.contextForTurn('How is the socket?')).toBe('');
    expect(
      await new MemoryCapabilityBuilder(
        createMockSettingsService({ 'memory.directory': directory, 'memory.enabled': false }),
      ).contextForTurn('cost'),
    ).toBe('');
  });

  it('does not inject memories for a context-dependent follow-up with no topical query', async () => {
    const directory = makeTempDir();
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'project',
      id: 'provider-feature',
      title: 'Provider feature',
      summary: 'The feature was implemented and merged.',
      content: 'One feature was changed.',
    });
    expect((await builder.selectForTurn('Refine that feature.')).memories).toEqual([]);
    expect((await builder.selectForTurn('What were we doing?')).memories).toEqual([]);
  });

  it('requires an exact topical match instead of substring or generic wording noise', async () => {
    const directory = makeTempDir();
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'project',
      id: 'memory-index',
      title: 'Memory index',
      summary: 'Memory index budget was changed.',
      content: 'The index has a larger budget.',
    });
    await create.execute({
      scope: 'project',
      id: 'injection-relevance',
      title: 'Memory injection relevance',
      summary: 'Only inject memories with evidence for the current question.',
      content: 'Generic words are not enough.',
    });
    await create.execute({
      scope: 'project',
      id: 'feature-showcase',
      title: 'Feature showcase',
      summary: 'A showcase of an unrelated memory feature.',
      content: 'Only a generic term matches.',
    });

    const selected = await builder.selectForTurn('Can you reduce memory injection noise?', {
      projectPath: process.cwd(),
    });
    expect(selected.memories.map((memory) => memory.id)).toEqual(['injection-relevance']);
    expect(selected.text).not.toContain('Memory index budget');
    expect((await builder.selectForTurn('Show the memory-index decision')).memories.map((memory) => memory.id)).toEqual(
      ['memory-index'],
    );
  });

  it('keeps a one-topic summary match despite conversational padding', async () => {
    const directory = makeTempDir();
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'project',
      id: 'transport-rule',
      title: 'Transport rule',
      summary: 'The WebSocket needs a distinct physical child identity.',
      content: 'Preserve root affinity.',
    });
    const direct = await builder.selectForTurn('WebSocket?');
    const conversational = await builder.selectForTurn('What did we decide about WebSocket?');
    expect(conversational.memories).toEqual(direct.memories);
    expect(conversational.memories.map((memory) => memory.id)).toEqual(['transport-rule']);
  });

  it('does not inject memories on a UI follow-up whose only matches are generic wording', async () => {
    const directory = makeTempDir();
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));
    const create = builder.build({ kind: 'main' }).tools.find((tool) => tool.name === 'memory_create')!;
    await create.execute({
      scope: 'project',
      id: 'unrelated-fix',
      title: 'Unrelated fix',
      summary: 'The fix was a little noisy in the old UI.',
      content: 'No relevant decision.',
    });
    expect((await builder.selectForTurn('It is a little noisy in the UI, can you fix that?')).memories).toEqual([]);
  });

  it('never injects a superseded summary from a corrected memory', async () => {
    const directory = makeTempDir();
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }));
    const tools = builder.build({ kind: 'main' }).tools;
    await tools
      .find((tool) => tool.name === 'memory_create')!
      .execute({
        scope: 'global',
        id: 'policy',
        title: 'Rule',
        summary: 'obsoleteprotocol',
        content: 'obsoleteprotocol',
      });
    await tools
      .find((tool) => tool.name === 'memory_update')!
      .execute({
        scope: 'global',
        id: 'policy',
        summary: 'newprotocol',
        content: 'newprotocol',
        supersede: { reason: 'User correction' },
      });
    expect(await builder.contextForTurn('obsoleteprotocol')).toBe('');
    expect((await builder.selectForTurn('newprotocol')).memories).toMatchObject([{ id: 'policy' }]);
  });

  it('fails open and warns when the memory index cannot be read', async () => {
    const directory = makeTempDir();
    writeFileSync(join(directory, 'index.json'), '{ malformed');
    const warnings: string[] = [];
    const builder = new MemoryCapabilityBuilder(createMockSettingsService({ 'memory.directory': directory }), {
      onWarning: (warning) => warnings.push(warning),
    });
    expect(await builder.contextForTurn('release notes')).toBe('');
    expect(warnings).toEqual([expect.stringMatching(/memory retrieval could not be loaded/i)]);
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
});
