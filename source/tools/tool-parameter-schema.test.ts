import test from 'ava';
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

test('find_files schema uses optional params instead of nullable', (t) => {
  const tool = createFindFilesToolDefinition();

  t.true(tool.parameters.safeParse({ pattern: '*.ts' }).success);
  t.false(tool.parameters.safeParse({ pattern: '*.ts', path: null }).success);
  t.false(tool.parameters.safeParse({ pattern: '*.ts', max_results: null }).success);
});

test('read_file schema uses optional line params instead of nullable', (t) => {
  const tool = createReadFileToolDefinition();

  t.true(tool.parameters.safeParse({ path: 'README.md' }).success);
  t.false(tool.parameters.safeParse({ path: 'README.md', start_line: null }).success);
  t.false(tool.parameters.safeParse({ path: 'README.md', end_line: null }).success);
});

test('shell schema uses optional params instead of nullable', (t) => {
  const tool = createShellToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  t.true(tool.parameters.safeParse({ command: 'echo hi' }).success);
  t.false(tool.parameters.safeParse({ command: 'echo hi', timeout_ms: null }).success);
  t.false(tool.parameters.safeParse({ command: 'echo hi', max_output_length: null }).success);
});

test('grep schema uses optional file_pattern instead of nullable', (t) => {
  const tool = createGrepToolDefinition();

  t.true(tool.parameters.safeParse({ pattern: 'foo', path: '.' }).success);
  t.false(tool.parameters.safeParse({ pattern: 'foo', path: '.', file_pattern: null }).success);
});

test('web_fetch schema uses optional continuation_token instead of nullable', (t) => {
  const tool = createWebFetchToolDefinition({
    settingsService: createMockSettingsService(),
    loggingService,
  });

  t.true(tool.parameters.safeParse({ url: 'https://example.com' }).success);
  t.true(tool.parameters.safeParse({ url: 'https://example.com', max_chars: 5000 }).success);
  t.false(tool.parameters.safeParse({ url: 'https://example.com', max_chars: null }).success);
  t.true(tool.parameters.safeParse({ url: 'https://example.com', heading: ['Intro'] }).success);
  t.false(tool.parameters.safeParse({ url: 'https://example.com', heading: null }).success);
  t.false(tool.parameters.safeParse({ url: 'https://example.com', continuation_token: null }).success);
});

test('ask_mentor schema uses optional context instead of nullable', (t) => {
  const tool = createAskMentorToolDefinition(async () => 'ok');

  t.true(tool.parameters.safeParse({ question: 'How?' }).success);
  t.false(tool.parameters.safeParse({ question: 'How?', context: null }).success);
});

test('search_replace schema validates path and replacements array structure', (t) => {
  const tool = createSearchReplaceToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  const omittedMatchAll = tool.parameters.safeParse({
    path: 'a.ts',
    replacements: [{ search_content: 'old', replace_content: 'new' }],
  });
  t.true(omittedMatchAll.success);
  if (omittedMatchAll.success) {
    const parsed = omittedMatchAll.data as {
      replacements: Array<{ match_all: boolean }>;
    };
    t.false(parsed.replacements[0].match_all);
  }
  t.true(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [{ search_content: 'old', replace_content: 'new', match_all: true }],
    }).success,
  );
  t.false(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [],
    }).success,
  );
  t.false(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [{ search_content: null, replace_content: 'new' }],
    }).success,
  );
  t.false(
    tool.parameters.safeParse({
      path: 'a.ts',
      replacements: [{ search_content: 'old', replace_content: 'new', match_all: null }],
    }).success,
  );
});

test('read_code_outline schema requires path and rejects null', (t) => {
  const tool = createReadCodeOutlineToolDefinition();

  t.true(tool.parameters.safeParse({ path: 'source/app.tsx' }).success);
  t.false(tool.parameters.safeParse({}).success);
  t.false(tool.parameters.safeParse({ path: null }).success);
});

test('code_context_search schema uses query-specific optional params instead of nullable', (t) => {
  const tool = createCodeContextSearchToolDefinition();

  t.true(tool.parameters.safeParse({ query_type: 'related', path: 'source/app.tsx' }).success);
  t.false(tool.parameters.safeParse({ query_type: 'related' }).success);
  t.false(tool.parameters.safeParse({ query_type: 'related', path: null }).success);
  t.false(tool.parameters.safeParse({ query_type: 'related', path: 'source/app.tsx', max_results: null }).success);
  t.true(tool.parameters.safeParse({ query_type: 'symbol', symbol: 'getAgentDefinition' }).success);
  t.false(tool.parameters.safeParse({ query_type: 'symbol' }).success);
  t.false(tool.parameters.safeParse({ query_type: 'symbol', symbol: null }).success);
  t.false(tool.parameters.safeParse({ query_type: 'symbol', symbol: 'getAgentDefinition', max_results: null }).success);
});
