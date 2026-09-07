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

  it('keeps essential detailed entries and compact Other-tool input signatures without purpose or returns', () => {
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
        parameters: z.object({
          query: z.string(),
          domains: z.array(z.string()).optional(),
          mode: z.enum(['fast', 'deep']).optional(),
        }),
        scriptedReturnShape: '{ results: object[] }',
      }),
    ]);

    expect(text).toContain('Essential tools:');
    expect(text).toContain(
      '- tools.read_file({ path: string, start_line?: number }) — Read a file\n    returns { content: string }',
    );
    expect(text).toContain('Other tools:');
    const other = text.slice(text.indexOf('Other tools:'));
    expect(other).toContain('- tools.web_search({ query: string, domains?: string[], mode?: "fast"|"deep" })');
    expect(other).not.toContain('Search the web');
    expect(other).not.toContain('returns { results: object[] }');
    expect(other).not.toMatch(/ — /);
    expect(text).toContain('tools.describe(name)');
    const essentialIndex = text.indexOf('Essential tools:');
    const otherIndex = text.indexOf('Other tools:');
    expect(essentialIndex).toBeLessThan(otherIndex);
  });

  it('reports failed conversion, union root, and non-object root schemas honestly as unavailable', () => {
    const text = header([
      tool({
        name: 'failing_tool',
        description: 'Failed conversion tool',
        parameters: z.custom(() => true),
      }),
      tool({
        name: 'union_tool',
        description: 'Union root tool',
        parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
      }),
      tool({
        name: 'non_object_tool',
        description: 'Non-object root tool',
        parameters: z.string(),
      }),
      tool({
        name: 'empty_tool',
        description: 'Truly empty schema tool',
        parameters: z.object({}),
      }),
    ]);

    expect(text).toContain('- tools.failing_tool(/* schema unavailable — use tools.describe */)');
    expect(text).toContain('- tools.union_tool(/* schema unavailable — use tools.describe */)');
    expect(text).toContain('- tools.non_object_tool(/* schema unavailable — use tools.describe */)');
    expect(text).toContain('- tools.empty_tool()');
    expect(text).not.toContain('Failed conversion tool');
    expect(text).not.toContain('Union root tool');
    expect(text).not.toContain('Non-object root tool');
    expect(text).not.toContain('Truly empty schema tool');
    expect(text).not.toContain('tools.failing_tool()');
    expect(text).not.toContain('tools.union_tool()');
    expect(text).not.toContain('tools.non_object_tool()');
  });

  it('says plainly that the shapes are approximate and the real schema decides', () => {
    expect(header([tool({ name: 'x' })])).toContain('approximate');
  });

  it('renders a truly empty parameter tool as callable with nothing', () => {
    expect(header([tool({ name: 'read_file', parameters: z.object({}) })])).toContain('- tools.read_file()');
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

  it('reports schema unavailable marker for failed conversion, union root, and non-object root', () => {
    expect(renderCompactSignature(tool({ name: 'unconvertible', parameters: z.custom(() => true) }))).toBe(
      'tools.unconvertible(/* schema unavailable — use tools.describe */)',
    );
    expect(
      renderCompactSignature(
        tool({
          name: 'union_tool',
          parameters: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
        }),
      ),
    ).toBe('tools.union_tool(/* schema unavailable — use tools.describe */)');
    expect(renderCompactSignature(tool({ name: 'string_tool', parameters: z.string() }))).toBe(
      'tools.string_tool(/* schema unavailable — use tools.describe */)',
    );
    expect(renderCompactSignature(tool({ name: 'empty_tool', parameters: z.object({}) }))).toBe('tools.empty_tool()');
  });
});

describe('renderToolsHeader scriptedReturnShape', () => {
  it('renders a declared return shape for an essential tool', () => {
    const text = header([tool({ name: 'read_file', scriptedReturnShape: '{ content: string, truncated: boolean }' })]);

    expect(text).toContain('- tools.read_file()');
    expect(text).toContain('returns { content: string, truncated: boolean }');
  });

  it('omits declared return shapes from compact Other-tool listings', () => {
    const text = header([tool({ name: 'session_list', scriptedReturnShape: '{ sessions: object[] }' })]);

    expect(text).toContain('- tools.session_list()');
    expect(text).not.toContain('returns { sessions: object[] }');
  });
});
