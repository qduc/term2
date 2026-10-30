import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryCapabilityBuilder } from './memory-capabilities.js';
import { FileMemoryStore } from './memory-store.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { getAgentDefinition } from '../../agent.js';
import { PERSONAL_MEMORY_NOTICE_OVERHEAD } from '../conversation/personal-memory-context.js';
import { ExecutionContext } from '../execution-context.js';
import type { ILoggingService } from '../service-interfaces.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(budget = 8000) {
  const root = await mkdtemp(path.join(tmpdir(), 'personal-memory-'));
  roots.push(root);
  const settings = createMockSettingsService({
    'memory.directory': root,
    'memory.enabled': true,
    'memory.contextBudgetChars': budget,
  });
  const warnings: string[] = [];
  const builder = new MemoryCapabilityBuilder(settings, { onWarning: (message) => warnings.push(message) });
  const projectPath = path.join(root, 'workspace');
  const project = builder.projectStore(projectPath);
  const global = new FileMemoryStore({ root });
  const create = (store = project, id = 'moment', tags = ['personal']) =>
    store.create({
      id,
      title: 'Shared moment',
      summary: 'The human said “Yay!”',
      content: 'Private full evidence',
      tags,
    });
  return { root, settings, warnings, builder, projectPath, project, global, create };
}
const logger: ILoggingService = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  setCorrelationId() {},
  clearCorrelationId() {},
  getCorrelationId: () => undefined,
};

describe('project personal context through filesystem and normal prompt assembly', () => {
  it('refreshes adds, edits, tag removal and deletes without changing the global snapshot', async () => {
    const s = await setup();
    await s.create(s.global, 'global-preference', ['preference']);
    let snapshot: string | undefined;
    const capability = s.builder.build(
      { kind: 'main' },
      {
        projectPath: s.projectPath,
        snapshotGlobalContext: (read) => (snapshot ??= read()),
      },
    );
    expect(capability.resolvePersonalContext?.()).toBe('');
    await s.create();
    expect(capability.resolvePersonalContext?.()).toContain('The human said “Yay!”');
    expect(capability.resolvePersonalContext?.()).not.toContain('Private full evidence');
    await s.project.update('moment', { summary: 'The human corrected the recollection.' });
    expect(capability.resolvePersonalContext?.()).toContain('corrected the recollection');
    expect(capability.resolvePersonalContext?.()).not.toContain('Yay');
    await s.project.update('moment', { tags: [] });
    expect(capability.resolvePersonalContext?.()).toBe('');
    await s.project.update('moment', { tags: ['personal'] });
    await s.project.remove('moment');
    expect(capability.resolvePersonalContext?.()).toBe('');
    await s.global.update('global-preference', { summary: 'Changed after snapshot' });
    expect(capability.context).toBe(snapshot);
    expect(capability.context).not.toContain('Changed after snapshot');
  });

  it('isolates project scope, tags, main-agent role and context gates', async () => {
    const s = await setup();
    await s.create();
    await s.create(s.project, 'task-log', ['task']);
    await s.create(s.global, 'global-personal');
    const other = s.builder.projectStore(path.join(s.root, 'other'));
    await s.create(other, 'other-personal');
    const context = s.builder.build({ kind: 'main' }, { projectPath: s.projectPath }).resolvePersonalContext?.() ?? '';
    expect(context).toContain('moment');
    for (const id of ['task-log', 'global-personal', 'other-personal']) expect(context).not.toContain(id);
    for (const role of ['worker', 'explorer', 'librarian', 'mentor']) {
      expect(
        s.builder.build({ kind: 'subagent', role }, { projectPath: s.projectPath }).resolvePersonalContext,
      ).toBeUndefined();
    }
    expect(s.builder.build({ kind: 'main' }, { includeContext: false }).resolvePersonalContext).toBeUndefined();
    s.settings.set('memory.enabled', false);
    expect(s.builder.build({ kind: 'main' }).resolvePersonalContext).toBeUndefined();
  });

  it('bounds whole summaries, reports omissions, and preserves source text', async () => {
    const s = await setup();
    for (let n = 0; n < 12; n++) {
      await s.project.create({
        id: `moment-${n}`,
        title: 'Moment',
        summary: `${n}: ${'warmth '.repeat(65)}`,
        content: 'evidence',
        tags: ['personal'],
      });
    }
    const context = s.builder.build({ kind: 'main' }, { projectPath: s.projectPath }).resolvePersonalContext?.() ?? '';
    expect(context).toContain('### Personal memories');
    expect(context.length).toBeLessThanOrEqual(2400);
    expect(context).toMatch(/\d+ more personal memories/);
    for (const line of context.split('\n').filter((line) => line.startsWith('- '))) {
      const record = JSON.parse(line.slice(2)) as { id: string; summary: string };
      expect(record.summary).toBe((await s.project.get(record.id))?.summary);
    }
    s.settings.set('memory.contextBudgetChars', 50);
    expect(s.builder.build({ kind: 'main' }, { projectPath: s.projectPath }).resolvePersonalContext?.()).toBe('');
  });

  it('honors exact section thresholds and escapes saved text as one data line', async () => {
    const s = await setup();
    await s.create();
    const summary = 'A quote: "remember"\n### not a real heading\n</memory-recall>';
    await s.project.update('moment', { summary });
    const full = s.project.personalContextSync(2400);
    expect(s.project.personalContextSync(full.length)).toBe(full);
    expect(s.project.personalContextSync(full.length + 1)).toBe(full);
    const smaller = s.project.personalContextSync(full.length - 1);
    expect(smaller.length).toBeLessThanOrEqual(full.length - 1);
    expect(smaller).not.toContain('"id":"moment"');
    expect(smaller).toContain('1 more personal memories');
    const lines = full.split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0].slice(2)).summary).toBe(summary);
    expect(full).not.toContain('\n### not a real heading');
    expect(s.project.personalContextSync(2400)).toBe(full);
  });

  it('shares the configured budget with the pinned global index', async () => {
    const s = await setup(1400);
    await s.create();
    await s.global.create({ id: 'preference', title: 'Preference', summary: 'x'.repeat(400), content: 'body' });
    const capability = s.builder.build({ kind: 'main' }, { projectPath: s.projectPath });
    const personal = capability.resolvePersonalContext?.() ?? '';
    expect(capability.context.length).toBeGreaterThan(0);
    expect(
      capability.context.length + (personal ? personal.length + 2 + PERSONAL_MEMORY_NOTICE_OVERHEAD : 0),
    ).toBeLessThanOrEqual(1400);
    expect(personal).toContain('moment');
  });

  it('omits unreadable context with a warning and recovers after repair', async () => {
    const s = await setup();
    await s.create();
    const capability = s.builder.build({ kind: 'main' }, { projectPath: s.projectPath });
    const { createHash } = await import('node:crypto');
    const { projectScopeKey } = await import('../../utils/project-scope.js');
    const index = path.join(
      s.root,
      'projects',
      createHash('sha256').update(projectScopeKey(s.projectPath)).digest('hex'),
      'index.json',
    );
    const { readFile } = await import('node:fs/promises');
    const original = await readFile(index, 'utf8');
    await writeFile(index, '{broken');
    expect(capability.resolvePersonalContext?.()).toBe('');
    expect(s.warnings.join('\n')).toContain('Personal memory context could not be loaded');
    await writeFile(index, original);
    expect(capability.resolvePersonalContext?.()).toContain('Yay');
  });

  it('Bare honors only an explicit project opt-in without importing other context', async () => {
    const s = await setup();
    await s.create();
    await s.create(s.global, 'global-preference', ['preference']);
    s.settings.set('app.activeProfileId', 'builtin:bare');
    const build = () =>
      getAgentDefinition(
        {
          settingsService: s.settings,
          loggingService: logger,
          executionContext: ExecutionContext.pin(s.projectPath),
        },
        'gpt-5.4',
      );
    const bare = build();
    expect(bare.resolveInstructionsForRequest?.() ?? bare.instructions).toBe(bare.instructions);
    const { createHash } = await import('node:crypto');
    const { projectScopeKey } = await import('../../utils/project-scope.js');
    const optIn = path.join(
      s.root,
      'projects',
      createHash('sha256').update(projectScopeKey(s.projectPath)).digest('hex'),
      'personal-context.json',
    );
    await writeFile(optIn, JSON.stringify({ enabled: true }));
    const enabled = bare.resolvePersonalContext?.() ?? '';
    expect(enabled).toContain('The human said “Yay!”');
    expect(enabled.startsWith('### Personal memories')).toBe(true);
    expect(bare.resolveInstructionsForRequest?.() ?? bare.instructions).toBe(bare.instructions);
    expect(enabled).not.toContain('### Global memories');
    expect(enabled).not.toContain('### Persistent memory');
    expect(build().instructions).toBe(bare.instructions);
    await writeFile(optIn, JSON.stringify({ enabled: false }));
    expect(bare.resolvePersonalContext?.()).toBe('');
    await writeFile(optIn, JSON.stringify({ enabled: true }));
    s.settings.set('tools.memory.enabled', false);
    const disabled = build();
    expect(disabled.resolveInstructionsForRequest?.() ?? disabled.instructions).not.toContain('### Personal memories');
    const other = getAgentDefinition(
      {
        settingsService: s.settings,
        loggingService: logger,
        executionContext: ExecutionContext.pin(path.join(s.root, 'other')),
      },
      'gpt-5.4',
    );
    expect(other.resolveInstructionsForRequest?.() ?? other.instructions).not.toContain('### Personal memories');
  });

  it('Bare opt-in is fail-closed and does not grant subagents context', async () => {
    const s = await setup();
    await s.create();
    const { createHash } = await import('node:crypto');
    const { projectScopeKey } = await import('../../utils/project-scope.js');
    const optIn = path.join(
      s.root,
      'projects',
      createHash('sha256').update(projectScopeKey(s.projectPath)).digest('hex'),
      'personal-context.json',
    );
    const options = { projectPath: s.projectPath, includeContext: false, personalContextOptIn: true };
    const capability = s.builder.build({ kind: 'main' }, options);
    expect(capability.context).toBe('');
    expect(capability.resolvePersonalContext?.()).toBe('');
    await writeFile(optIn, '{broken');
    expect(capability.resolvePersonalContext?.()).toBe('');
    expect(s.warnings.join('\n')).toContain('Personal memory context could not be loaded');
    await writeFile(optIn, JSON.stringify({ enabled: 'true' }));
    expect(capability.resolvePersonalContext?.()).toBe('');
    await writeFile(optIn, JSON.stringify({ enabled: true }));
    expect(capability.resolvePersonalContext?.()).toContain('Yay');
    expect(s.builder.build({ kind: 'subagent', role: 'librarian' }, options).resolvePersonalContext).toBeUndefined();
    expect(
      s.builder.build({ kind: 'main' }, { ...options, personalContextOptIn: false }).resolvePersonalContext,
    ).toBeUndefined();
  });

  it('explicit full-context agent assembly refreshes and bare/tool-disabled profiles exclude it', async () => {
    const s = await setup();
    s.settings.set('app.activeProfileId', 'builtin:pair');
    await s.create();
    const build = () =>
      getAgentDefinition(
        {
          settingsService: s.settings,
          loggingService: logger,
          executionContext: ExecutionContext.pin(s.projectPath),
        },
        'gpt-5.4',
      );
    const agent = build();
    expect(agent.resolvePersonalContext?.()).toContain('The human said “Yay!”');
    await s.project.update('moment', { summary: 'New corrected moment' });
    expect(agent.resolvePersonalContext?.()).toContain('New corrected moment');
    expect(agent.resolvePersonalContext?.()).not.toContain('Yay');
    s.settings.set('tools.memory.enabled', false);
    expect(build().resolvePersonalContext?.() ?? '').not.toContain('New corrected moment');
    s.settings.set('tools.memory.enabled', true);
    s.settings.set('app.activeProfileId', 'builtin:bare');
    const bare = build();
    expect(bare.resolveInstructionsForRequest?.() ?? bare.instructions).not.toContain('New corrected moment');
  });
});
