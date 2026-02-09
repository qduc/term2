import test from 'ava';
import { createFindFilesToolDefinition } from './find-files.js';
import { createReadFileToolDefinition } from './read-file.js';
import { createShellToolDefinition } from './shell.js';
import { createGrepToolDefinition } from './grep.js';
import { grepToolDefinition as searchToolDefinition } from './search.js';
import { createWebFetchToolDefinition } from './web-fetch.js';
import { createAskMentorToolDefinition } from './ask-mentor.js';
import { createSearchReplaceToolDefinition } from './search-replace.js';
import { createMockSettingsService } from '../services/settings-service.mock.js';
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

test('search schema uses optional params instead of nullable', (t) => {
  t.true(searchToolDefinition.parameters.safeParse({ pattern: 'foo', path: '.', case_sensitive: true }).success);
  t.true(searchToolDefinition.parameters.safeParse({ pattern: 'foo', path: '.' }).success);
  t.false(searchToolDefinition.parameters.safeParse({ pattern: 'foo', path: '.', case_sensitive: null }).success);
  t.false(
    searchToolDefinition.parameters.safeParse({ pattern: 'foo', path: '.', case_sensitive: true, file_pattern: null })
      .success,
  );
  t.false(
    searchToolDefinition.parameters.safeParse({
      pattern: 'foo',
      path: '.',
      case_sensitive: true,
      exclude_pattern: null,
    }).success,
  );
  t.false(
    searchToolDefinition.parameters.safeParse({ pattern: 'foo', path: '.', case_sensitive: true, max_results: null })
      .success,
  );
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

test('search_replace schema uses optional replace_all default', (t) => {
  const tool = createSearchReplaceToolDefinition({
    loggingService,
    settingsService: createMockSettingsService(),
  });

  t.true(tool.parameters.safeParse({ path: 'a.ts', search_content: 'old', replace_content: 'new' }).success);
  t.false(
    tool.parameters.safeParse({ path: 'a.ts', search_content: 'old', replace_content: 'new', replace_all: null })
      .success,
  );
});
