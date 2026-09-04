import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderToolsHeader } from './tools-header.js';
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

  it('says plainly that the shapes are approximate and the real schema decides', () => {
    expect(header([tool({ name: 'x' })])).toContain('approximate');
  });

  it('renders a no-parameter tool as callable with nothing', () => {
    expect(header([tool({ name: 'ping' })])).toContain('- tools.ping()');
  });

  it('renders enums and arrays structurally and falls back to unknown', () => {
    const text = header([
      tool({
        name: 'search',
        parameters: z.object({ mode: z.enum(['fast', 'deep']), globs: z.array(z.string()) }),
      }),
    ]);

    expect(text).toContain('mode: "fast"|"deep"');
    expect(text).toContain('globs: string[]');
  });

  it('collapses a long tool description to one bounded line', () => {
    const text = header([tool({ name: 'verbose', description: `${'word '.repeat(80)}\n\nmore` })]);
    const line = text.split('\n').find((entry) => entry.startsWith('- tools.verbose'))!;

    expect(line.length).toBeLessThan(220);
    expect(line).toContain('…');
  });

  it('is empty when nothing is exposed', () => {
    expect(header([])).toBe('');
  });
});
