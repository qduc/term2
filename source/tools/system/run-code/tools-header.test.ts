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

  it('shows full shapes only for essential tools and names other tools for on-demand lookup', () => {
    const text = header([
      tool({
        name: 'read_file',
        parameters: z.object({ path: z.string(), start_line: z.number().optional() }),
      }),
      tool({
        name: 'web_search',
        description: 'Search the web',
        parameters: z.object({ query: z.string(), domains: z.array(z.string()).optional() }),
      }),
    ]);

    expect(text).toContain('- tools.read_file({ path: string, start_line?: number })');
    expect(text).toContain('- tools.web_search');
    expect(text).not.toContain('tools.web_search({ query: string');
    expect(text).toContain('tools.describe(name)');
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
});

describe('renderToolsHeader scriptedReturnShape', () => {
  it('renders a declared return shape for an essential tool', () => {
    const text = header([tool({ name: 'read_file', scriptedReturnShape: '{ content: string, truncated: boolean }' })]);

    expect(text).toContain('- tools.read_file()');
    expect(text).toContain('returns { content: string, truncated: boolean }');
  });

  it('keeps non-essential tools name-only even when they declare a shape', () => {
    const text = header([tool({ name: 'session_list', scriptedReturnShape: '{ sessions: object[] }' })]);

    expect(text).toContain('- tools.session_list');
    expect(text).not.toContain('returns { sessions: object[] }');
  });
});
