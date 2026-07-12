import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryCapabilityBuilder } from './memory-capabilities.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

const writeTools = ['memory_list', 'memory_get', 'memory_search', 'memory_create', 'memory_update', 'memory_delete'];
const readTools = writeTools.slice(0, 3);

describe('MemoryCapabilityBuilder', () => {
  it.each([
    ['default', { kind: 'main' as const }, 'write', writeTools],
    ['plan', { kind: 'main' as const }, 'write', writeTools],
    ['lite', { kind: 'main' as const }, 'write', writeTools],
    ['main-agent-mentor', { kind: 'main' as const }, 'write', writeTools],
    ['orchestrator', { kind: 'main' as const }, 'write', writeTools],
    ['explorer', { kind: 'subagent' as const, role: 'explorer' }, 'read', readTools],
    ['worker', { kind: 'subagent' as const, role: 'worker' }, 'read', readTools],
    ['researcher', { kind: 'subagent' as const, role: 'researcher' }, 'read', readTools],
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

  it.each(['explorer', 'worker', 'researcher'] as const)(
    'gives %s on-demand read access without injecting memory context',
    (role) => {
      const directory = mkdtempSync(join(tmpdir(), 'term2-memory-capability-'));
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
      expect(capability.guidance).toContain('Only a concise index is loaded initially.');
      expect(capability.guidance).toContain('materially improve correctness');
      expect(capability.context).toBe('');
    },
  );

  it('injects summary context for a main agent with write access', () => {
    const directory = mkdtempSync(join(tmpdir(), 'term2-memory-capability-'));
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
});
