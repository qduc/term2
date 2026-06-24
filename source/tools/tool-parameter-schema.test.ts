import { it, expect } from 'vitest';
import { createFindFilesToolDefinition } from './file/find-files.js';
import { createReadFileToolDefinition } from './file/read-file.js';
import { createShellToolDefinition } from './system/shell.js';
import { createGrepToolDefinition } from './system/grep.js';
import { createWebFetchToolDefinition } from './web/web-fetch.js';
import { createAskMentorToolDefinition } from './agent/ask-mentor.js';
import { createSearchReplaceToolDefinition } from './file/search-replace.js';
import { createCodeContextSearchToolDefinition, createReadCodeOutlineToolDefinition } from './system/code-context.js';
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

it('glob schema uses optional params instead of nullable', () => {
  const tool = createFindFilesToolDefinition();

  expect(tool.parameters.safeParse({ pattern: '*.ts' }).success).toBe(true);
  expect(tool.parameters.safeParse({ pattern: '*.ts', path: null }).success).toBe(false);
  expect(tool.parameters.safeParse({ pattern: '*.ts', max_results: null }).success).toBe(false);
});

it('read_file schema uses optional line params instead of nullable', () => {
  const tool = createReadFileToolDefinition();

  expect(tool.parameters.safeParse({ path: 'README.md' }).success).toBe(true);
  expect(tool.parameters.safeParse({ path: 'README.md', start_line: null }).success).toBe(false);
  expect(tool.parameters.safeParse({ path: 'README.md', end_line: null }).success).toBe(false);
});

it('shell schema uses optional params instead of nullable', () => {
  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  expect(tool.parameters.safeParse({ command: 'echo hi' }).success).toBe(true);
  expect(tool.parameters.safeParse({ command: 'echo hi', timeout_ms: null }).success).toBe(false);
  expect(tool.parameters.safeParse({ command: 'echo hi', max_output_length: null }).success).toBe(false);
});

it('grep schema uses optional include instead of nullable', () => {
  const tool = createGrepToolDefinition();

  expect(tool.parameters.safeParse({ pattern: 'foo', path: '.' }).success).toBe(true);
  expect(tool.parameters.safeParse({ pattern: 'foo', path: '.', include: null }).success).toBe(false);
});

it('web_fetch schema uses optional continuation_token instead of nullable', () => {
  const tool = createWebFetchToolDefinition({
    settingsService: createMockSettingsService(),
    loggingService,
  });

  expect(tool.parameters.safeParse({ url: 'https://example.com' }).success).toBe(true);
  expect(tool.parameters.safeParse({ url: 'https://example.com', max_chars: 5000 }).success).toBe(true);
  expect(tool.parameters.safeParse({ url: 'https://example.com', max_chars: null }).success).toBe(false);
  expect(tool.parameters.safeParse({ url: 'https://example.com', heading: ['Intro'] }).success).toBe(true);
  expect(tool.parameters.safeParse({ url: 'https://example.com', heading: null }).success).toBe(false);
  expect(tool.parameters.safeParse({ url: 'https://example.com', continuation_token: null }).success).toBe(false);
});

it('ask_mentor schema uses optional context instead of nullable', () => {
  const tool = createAskMentorToolDefinition(async () => 'ok');

  expect(tool.parameters.safeParse({ question: 'How?' }).success).toBe(true);
  expect(tool.parameters.safeParse({ question: 'How?', context: null }).success).toBe(false);
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

it('read_code_outline schema requires path and rejects null', () => {
  const tool = createReadCodeOutlineToolDefinition();

  expect(tool.parameters.safeParse({ path: 'source/app.tsx' }).success).toBe(true);
  expect(tool.parameters.safeParse({}).success).toBe(false);
  expect(tool.parameters.safeParse({ path: null }).success).toBe(false);
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
