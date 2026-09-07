import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderCompactSignature, renderToolsHeader } from './tools-header.js';
import type { AnyToolDefinition, ToolRegistry } from '../../types.js';

const tool = (overrides: Partial<AnyToolDefinition> & { name: string }): AnyToolDefinition =>
  ({ description: '', parameters: z.object({}), ...overrides } as AnyToolDefinition);

const header = (registry: ToolRegistry) => renderToolsHeader(registry);

describe('renderToolsHeader', () => {
  it('renders a signature per tool, marking optional fields', () => {
    const text = header([
      tool({
        name: 'read_file',
        description: 'Read a file',
        parameters: z.object({ path: z.string(), limit: z.number().optional(), raw: z.boolean().optional() }),
      }),
    ]);

    expect(text).toContain('- tools.read_file({ path: string, limit?: number, raw?: boolean }) — Read a file');
  });

  it('renders compact signature, short purpose, and declared return shape for all scriptable tools while preserving essential ordering', () => {
    const text = header([
      tool({
        name: 'read_file',
        description: 'Read a file',
        parameters: z.object({ path: z.string(), start_line: z.number().optional() }),
        scriptedReturnShape: '{ content: string }',
      }),
      tool({
        name: 'web_search',
        description: 'Search the web',
        parameters: z.object({ query: z.string(), domains: z.array(z.string()).optional() }),
        scriptedReturnShape: '{ results: object[] }',
      }),
    ]);

    expect(text).toContain('Essential tools:');
    expect(text).toContain(
      '- tools.read_file({ path: string, start_line?: number }) — Read a file\n    returns { content: string }',
    );
    expect(text).toContain('Other tools:');
    expect(text).toContain(
      '- tools.web_search({ query: string, domains?: string[] }) — Search the web\n    returns { results: object[] }',
    );
    expect(text).toContain('tools.describe(name)');
    const essentialIndex = text.indexOf('Essential tools:');
    const otherIndex = text.indexOf('Other tools:');
    expect(essentialIndex).toBeLessThan(otherIndex);
  });

  it('reports unconvertible schema honestly rather than a bogus zero-argument signature', () => {
    const text = header([
      tool({
        name: 'complex_tool',
        description: 'Tool with unconvertible schema',
        parameters: z.custom(() => true),
      }),
    ]);

    expect(text).toContain('tools.complex_tool(/* unconvertible schema */) — Tool with unconvertible schema');
    expect(text).not.toContain('tools.complex_tool()');
  });

  it('says plainly that the shapes are approximate and the real schema decides', () => {
    expect(header([tool({ name: 'x' })])).toContain('approximate');
  });

  it('renders a no-parameter tool as callable with nothing', () => {
    expect(header([tool({ name: 'read_file' })])).toContain('- tools.read_file()');
  });

  it('renders enums and arrays structurally and falls back to unknown', () => {
    const text = header([
      tool({
        name: 'read_file',
        parameters: z.object({ mode: z.enum(['fast', 'deep']), globs: z.array(z.string()) }),
      }),
    ]);

    expect(text).toContain('mode: "fast"|"deep"');
    expect(text).toContain('globs: string[]');
  });

  it('collapses a long tool description to one bounded line', () => {
    const text = header([tool({ name: 'read_file', description: `${'word '.repeat(80)}\n\nmore` })]);
    const line = text.split('\n').find((entry) => entry.startsWith('- tools.read_file'))!;

    expect(line.length).toBeLessThan(220);
    expect(line).toContain('…');
  });

  it('is empty when nothing is exposed', () => {
    expect(header([])).toBe('');
  });
});

describe('renderCompactSignature (shared with the invalid-parameters site)', () => {
  it('renders the compact call shape a failure message appends', () => {
    expect(renderCompactSignature(tool({ name: 'strict', parameters: z.object({ value: z.string() }) }))).toBe(
      'tools.strict({ value: string })',
    );
  });

  it('expands nested object shapes for tools that carry them', () => {
    const signature = renderCompactSignature(
      tool({
        name: 'search_replace',
        parameters: z.object({
          path: z.string(),
          replacements: z
            .array(
              z.object({
                search_content: z.string(),
                replace_content: z.string(),
                match_all: z.boolean().optional(),
              }),
            )
            .min(1),
        }),
      }),
    );

    expect(signature).toBe(
      'tools.search_replace({ path: string, replacements: { search_content: string, replace_content: string, match_all?: boolean }[] })',
    );
  });

  it('inlines a short enum and degrades a long enum to its base type', () => {
    const many = Array.from({ length: 30 }, (_, index) => `skill_${String(index).padStart(2, '0')}`);
    const signature = renderCompactSignature(
      tool({
        name: 'activate_skill',
        parameters: z.object({ name: z.enum(many as [string, ...string[]]) }),
      }),
    );

    expect(signature).toBe('tools.activate_skill({ name: string })');
    expect(signature).not.toContain('skill_00');
  });

  it('shows expanded nested shapes in the header listing for an essential tool that carries them', () => {
    const text = header([
      tool({
        name: 'search_replace',
        parameters: z.object({
          path: z.string(),
          replacements: z.array(z.object({ search_content: z.string(), replace_content: z.string() })),
        }),
      }),
    ]);

    expect(text).toContain(
      'tools.search_replace({ path: string, replacements: { search_content: string, replace_content: string }[] })',
    );
    expect(text).not.toContain('replacements: object[]');
  });

  it('reports unconvertible schema honestly rather than a bogus zero-argument signature', () => {
    expect(renderCompactSignature(tool({ name: 'unconvertible', parameters: z.custom(() => true) }))).toBe(
      'tools.unconvertible(/* unconvertible schema */)',
    );
  });
});

describe('renderToolsHeader scriptedReturnShape', () => {
  it('renders a declared return shape for an essential tool', () => {
    const text = header([tool({ name: 'read_file', scriptedReturnShape: '{ content: string, truncated: boolean }' })]);

    expect(text).toContain('- tools.read_file()');
    expect(text).toContain('returns { content: string, truncated: boolean }');
  });

  it('renders a declared return shape for non-essential tools', () => {
    const text = header([tool({ name: 'session_list', scriptedReturnShape: '{ sessions: object[] }' })]);

    expect(text).toContain('- tools.session_list()');
    expect(text).toContain('returns { sessions: object[] }');
  });
});
