import { describe, it, expect } from 'vitest';
import { formatToolArgs, parseRunCodeTrace } from './command-message-helpers.js';

describe('parseRunCodeTrace', () => {
  it('returns null when the output carries no call summary', () => {
    expect(parseRunCodeTrace('')).toBeNull();
    expect(parseRunCodeTrace('Result:\n42')).toBeNull();
  });

  it('groups repeated calls with a count and keeps the rest as the body', () => {
    const trace = parseRunCodeTrace('Result:\n{"matches":12}\n\n[3 tool calls: grep, read_file×2]');
    expect(trace).not.toBeNull();
    expect(trace!.rows).toEqual([
      { tool: 'grep', count: 1, status: 'completed' },
      { tool: 'read_file', count: 2, status: 'completed' },
    ]);
    expect(trace!.body).toBe('Result:\n{"matches":12}');
    expect(trace!.troubledCount).toBe(0);
  });

  it('reports a script that made no calls', () => {
    const trace = parseRunCodeTrace('Result:\n7\n\n[no tool calls]');
    expect(trace!.rows).toEqual([]);
    expect(trace!.body).toBe('Result:\n7');
  });

  it('parses real emitted summary fixtures with schema lookups (lookup-only and calls+lookups)', () => {
    const lookupOnly = parseRunCodeTrace('Result:\ndone\n\n[no tool calls; 1 schema lookup]');
    expect(lookupOnly).not.toBeNull();
    expect(lookupOnly!.rows).toEqual([]);
    expect(lookupOnly!.body).toBe('Result:\ndone');
    expect(lookupOnly!.troubledCount).toBe(0);

    const callsAndLookups = parseRunCodeTrace('Result:\necho:ok\n\n[1 tool call: inspect; 2 schema lookups]');
    expect(callsAndLookups).not.toBeNull();
    expect(callsAndLookups!.rows).toEqual([{ tool: 'inspect', count: 1, status: 'completed' }]);
    expect(callsAndLookups!.body).toBe('Result:\necho:ok');
    expect(callsAndLookups!.troubledCount).toBe(0);

    const pluralLookupsOnly = parseRunCodeTrace('Result:\ndone\n\n[no tool calls; 3 schema lookups]');
    expect(pluralLookupsOnly).not.toBeNull();
    expect(pluralLookupsOnly!.rows).toEqual([]);
    expect(pluralLookupsOnly!.body).toBe('Result:\ndone');
    expect(pluralLookupsOnly!.troubledCount).toBe(0);

    const pluralCallsSingularLookup = parseRunCodeTrace(
      'Result:\n{"matches":12}\n\n[3 tool calls: grep, read_file×2; 1 schema lookup]',
    );
    expect(pluralCallsSingularLookup).not.toBeNull();
    expect(pluralCallsSingularLookup!.rows).toEqual([
      { tool: 'grep', count: 1, status: 'completed' },
      { tool: 'read_file', count: 2, status: 'completed' },
    ]);
    expect(pluralCallsSingularLookup!.body).toBe('Result:\n{"matches":12}');
    expect(pluralCallsSingularLookup!.troubledCount).toBe(0);
  });

  it('marks approval-refused tools and drops the refusal prose from the body', () => {
    const output = [
      'Result:\n{"renamed":2}',
      'Refused (needs user approval and could not be completed from inside this script): search_replace',
      '[2 tool calls: grep, search_replace]',
    ].join('\n\n');
    const trace = parseRunCodeTrace(output);
    expect(trace!.rows).toEqual([
      { tool: 'grep', count: 1, status: 'completed' },
      { tool: 'search_replace', count: 1, status: 'failed', note: 'needs approval' },
    ]);
    expect(trace!.body).toBe('Result:\n{"renamed":2}');
    expect(trace!.troubledCount).toBe(1);
  });

  it('marks both unavailable-policy variants', () => {
    const output = [
      'Script failed: boom',
      'Unavailable (approval policy refused or failed; no user approval was requested): shell',
      'Unavailable (no registered approval policy): mystery_tool',
      '[2 tool calls: shell, mystery_tool]',
    ].join('\n\n');
    const trace = parseRunCodeTrace(output);
    expect(trace!.rows).toEqual([
      { tool: 'shell', count: 1, status: 'failed', note: 'approval policy refused' },
      { tool: 'mystery_tool', count: 1, status: 'failed', note: 'no approval policy' },
    ]);
    expect(trace!.body).toBe('Script failed: boom');
    expect(trace!.troubledCount).toBe(2);
  });

  it('keeps a refused tool that the summary omitted', () => {
    const trace = parseRunCodeTrace(
      'Refused (needs user approval and could not be completed from inside this script): shell\n\n[no tool calls]',
    );
    expect(trace!.rows).toEqual([{ tool: 'shell', count: 1, status: 'failed', note: 'needs approval' }]);
  });
});

describe('formatToolArgs for run_code', () => {
  it('shows the description and never the script body', () => {
    const args = { code: 'const x = await tools.grep({ pattern: "formatToolArgs" });', description: 'count callers' };
    expect(formatToolArgs('run_code', args)).toBe('count callers');
  });

  it('falls back to nothing when the model omitted a description', () => {
    expect(formatToolArgs('run_code', { code: 'return 1;' })).toBe('');
  });
});
