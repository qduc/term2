import { it, expect } from 'vitest';
import { createFindFilesToolDefinition } from './file/glob.js';
import { createReadFileToolDefinition } from './file/read-file.js';
import { createShellToolDefinition } from './system/shell.js';
import { createGrepToolDefinition } from './file/grep.js';
import { createWebFetchToolDefinition } from './web/web-fetch.js';
import { createAskMentorToolDefinition } from './agent/ask-mentor.js';
import { createSearchReplaceToolDefinition } from './file/search-replace.js';
import { createCodeContextSearchToolDefinition, createReadCodeOutlineToolDefinition } from './file/code-context.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import type { ILoggingService } from '../services/service-interfaces.js';

const loggingService: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

// One table drives every tool schema's optional-vs-nullable probe so the matrix
// stays readable and a new tool just adds a row (per-tool schema behavior stays
// in each tool's own test file).
interface SchemaCase {
  title: string;
  build: () => { parameters: { safeParse(payload: unknown): { success: boolean } } };
  accepts: Array<Record<string, unknown>>;
  rejects: Array<Record<string, unknown>>;
}

const schemaCases: SchemaCase[] = [
  {
    title: 'glob schema uses optional params instead of nullable',
    build: () => createFindFilesToolDefinition(),
    accepts: [{ pattern: '*.ts' }],
    rejects: [
      { pattern: '*.ts', path: null },
      { pattern: '*.ts', max_results: null },
    ],
  },
  {
    title: 'read_file schema uses optional line params instead of nullable',
    build: () => createReadFileToolDefinition(),
    accepts: [{ path: 'README.md' }],
    rejects: [
      { path: 'README.md', start_line: null },
      { path: 'README.md', end_line: null },
    ],
  },
  {
    title: 'shell schema uses optional params instead of nullable',
    build: () =>
      createShellToolDefinition({
        loggingService,
        settingsService: createMockSettingsService(),
      }),
    accepts: [{ command: 'echo hi' }],
    rejects: [
      { command: 'echo hi', timeout_ms: null },
      { command: 'echo hi', max_output_length: null },
    ],
  },
  {
    title: 'grep schema uses optional include instead of nullable',
    build: () => createGrepToolDefinition(),
    accepts: [{ pattern: 'foo', path: '.' }],
    rejects: [{ pattern: 'foo', path: '.', include: null }],
  },
  {
    title: 'web_fetch schema uses optional params instead of nullable',
    build: () =>
      createWebFetchToolDefinition({
        settingsService: createMockSettingsService(),
        loggingService,
      }),
    accepts: [
      { url: 'https://example.com' },
      { url: 'https://example.com', max_chars: 5000 },
      { url: 'https://example.com', heading: ['Intro'] },
    ],
    rejects: [
      { url: 'https://example.com', max_chars: null },
      { url: 'https://example.com', heading: null },
      { url: 'https://example.com', continuation_token: null },
    ],
  },
  {
    title: 'ask_mentor schema uses optional context instead of nullable',
    build: () => createAskMentorToolDefinition(async () => 'ok'),
    accepts: [{ question: 'How?' }],
    rejects: [{ question: 'How?', context: null }],
  },
  {
    title: 'read_code_outline schema requires path and rejects null',
    build: () => createReadCodeOutlineToolDefinition(),
    accepts: [{ path: 'source/app.tsx' }],
    rejects: [{}, { path: null }],
  },
];

it.each(schemaCases)('$title', ({ build, accepts, rejects }) => {
  const tool = build();

  for (const payload of accepts) {
    expect(tool.parameters.safeParse(payload).success).toBe(true);
  }
  for (const payload of rejects) {
    expect(tool.parameters.safeParse(payload).success).toBe(false);
  }
});

it('read_file (migrated) derives typed executor and approval params from its schema', () => {
  const tool = createReadFileToolDefinition();

  const executeParams: Parameters<typeof tool.execute>[0] = { path: 'a.ts', start_line: 1 };
  const approvalParams: Parameters<typeof tool.needsApproval>[0] = { path: 'a.ts' };
  // @ts-expect-error — schema-derived params reject unknown fields
  const rejected: Parameters<typeof tool.execute>[0] = { path: 'a.ts', bogus: true };
  void rejected;

  expect(tool.parameters.safeParse(executeParams).success).toBe(true);
  expect(tool.parameters.safeParse(approvalParams).success).toBe(true);
});

it('search_replace schema validates path and replacements array structure', () => {
  const tool = createSearchReplaceToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  const omittedMatchAll = tool.parameters.safeParse({
    path: 'a.ts',
    replacements: [{ search_content: 'old', replace_content: 'new' }],
  });
  expect(omittedMatchAll.success).toBe(true);
  if (omittedMatchAll.success) {
    const parsed = omittedMatchAll.data as {
      replacements: Array<{ match_all: boolean }>;
    };
    expect(parsed.replacements[0].match_all).toBe(false);
  }
  expect(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [{ search_content: 'old', replace_content: 'new', match_all: true }],
    }).success,
  ).toBe(true);
  expect(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [],
    }).success,
  ).toBe(false);
  expect(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [{ search_content: null, replace_content: 'new' }],
    }).success,
  ).toBe(false);
  expect(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [{ search_content: 'old', replace_content: 'new', match_all: null }],
    }).success,
  ).toBe(false);
});

it('code_context_search schema uses query-specific optional params instead of nullable', () => {
  const tool = createCodeContextSearchToolDefinition();

  expect(tool.parameters.safeParse({ query_type: 'related', path: 'source/app.tsx' }).success).toBe(true);
  expect(tool.parameters.safeParse({ query_type: 'related' }).success).toBe(false);
  expect(tool.parameters.safeParse({ query_type: 'related', path: null }).success).toBe(false);
  expect(tool.parameters.safeParse({ query_type: 'related', path: 'source/app.tsx', max_results: null }).success).toBe(
    false,
  );
  expect(tool.parameters.safeParse({ query_type: 'symbol', symbol: 'getAgentDefinition' }).success).toBe(true);
  expect(tool.parameters.safeParse({ query_type: 'symbol' }).success).toBe(false);
  expect(tool.parameters.safeParse({ query_type: 'symbol', symbol: null }).success).toBe(false);
  expect(
    tool.parameters.safeParse({ query_type: 'symbol', symbol: 'getAgentDefinition', max_results: null }).success,
  ).toBe(false);
});
