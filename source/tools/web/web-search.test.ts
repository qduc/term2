import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createWebSearchToolDefinition, formatResultsAsMarkdown, formatWebSearchCommandMessage } from './web-search.js';
import type { WebSearchResponse } from '../../providers/web-search/index.js';

// Helper to create a mock settings service
const createMockSettingsService = (settings: Record<string, any> = {}) => ({
  get: <T>(key: string): T => settings[key] as T,
  set: () => {},
});

// Helper to create a mock logging service
const createMockLoggingService = () => {
  const logs: Array<{ level: string; message: string; meta?: any }> = [];
  return {
    info: (message: string, meta?: any) => logs.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: any) => logs.push({ level: 'warn', message, meta }),
    error: (message: string, meta?: any) => logs.push({ level: 'error', message, meta }),
    debug: (message: string, meta?: any) => logs.push({ level: 'debug', message, meta }),
    security: (message: string, meta?: any) => logs.push({ level: 'security', message, meta }),
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
    getLogs: () => logs,
  };
};

it('createWebSearchToolDefinition defines tool correctly', () => {
  const settings = createMockSettingsService();
  const logging = createMockLoggingService();

  const tool = createWebSearchToolDefinition({
    settingsService: settings,
    loggingService: logging,
  });

  expect(tool.name).toBe('web_search');
  expect(tool.description.includes('Search the web')).toBe(true);
  expect(typeof tool.execute).toBe('function');
  expect(typeof tool.formatCommandMessage).toBe('function');
});

it('needsApproval returns false (read-only operation)', () => {
  const settings = createMockSettingsService();
  const logging = createMockLoggingService();

  const tool = createWebSearchToolDefinition({
    settingsService: settings,
    loggingService: logging,
  });

  const result = tool.needsApproval({ query: 'test' }, undefined);
  expect(result).toBe(false);
});

it('execute returns error when provider not configured', async () => {
  const settings = createMockSettingsService({
    'webSearch.provider': 'tavily',
    // No API key set
  });
  const logging = createMockLoggingService();

  const tool = createWebSearchToolDefinition({
    settingsService: settings,
    loggingService: logging,
  });

  const result = await tool.execute({ query: 'test' }, undefined);

  expect(typeof result === 'string').toBe(true);
  expect((result as string).includes('Error:')).toBe(true);
  expect((result as string).includes('not properly configured')).toBe(true);
});

it('formatResultsAsMarkdown formats results correctly', () => {
  const response: WebSearchResponse = {
    query: 'test query',
    results: [
      {
        title: 'Test Result 1',
        url: 'https://example.com/1',
        content: 'This is the first result content.',
        score: 0.95,
      },
      {
        title: 'Test Result 2',
        url: 'https://example.com/2',
        content: 'This is the second result content.',
        publishedDate: '2024-01-15',
      },
    ],
  };

  const markdown = formatResultsAsMarkdown(response);

  expect(markdown.includes('## Search Results')).toBe(true);
  expect(markdown.includes('### 1. Test Result 1')).toBe(true);
  expect(markdown.includes('**URL:** https://example.com/1')).toBe(true);
  expect(markdown.includes('This is the first result content.')).toBe(true);
  expect(markdown.includes('### 2. Test Result 2')).toBe(true);
  expect(markdown.includes('**Published:** 2024-01-15')).toBe(true);
});

it('formatResultsAsMarkdown handles empty results', () => {
  const response: WebSearchResponse = {
    query: 'no results query',
    results: [],
  };

  const markdown = formatResultsAsMarkdown(response);

  expect(markdown.includes('No results found')).toBe(true);
});

it('formatResultsAsMarkdown includes answer box when available', () => {
  const response: WebSearchResponse = {
    query: 'what is the capital of France',
    results: [],
    answerBox: 'The capital of France is Paris.',
  };

  const markdown = formatResultsAsMarkdown(response);

  expect(markdown.includes('## Answer')).toBe(true);
  expect(markdown.includes('The capital of France is Paris.')).toBe(true);
});

it('formatResultsAsMarkdown includes both answer box and results', () => {
  const response: WebSearchResponse = {
    query: 'test',
    results: [
      {
        title: 'Result',
        url: 'https://example.com',
        content: 'Content here.',
      },
    ],
    answerBox: 'Direct answer.',
  };

  const markdown = formatResultsAsMarkdown(response);

  expect(markdown.includes('## Answer')).toBe(true);
  expect(markdown.includes('Direct answer.')).toBe(true);
  expect(markdown.includes('## Search Results')).toBe(true);
  expect(markdown.includes('Result')).toBe(true);
});

it('formatWebSearchCommandMessage extracts query correctly', () => {
  const item = {
    rawItem: {
      arguments: JSON.stringify({ query: 'test search' }),
    },
    output: 'Search results here',
  };

  const messages = formatWebSearchCommandMessage(item, 0, new Map());

  expect(messages.length).toBe(1);
  expect(messages[0].command).toBe('web_search: "test search"');
  expect(messages[0].toolName).toBe('web_search');
  expect(messages[0].sender).toBe('command');
});

it('formatWebSearchCommandMessage handles missing query', () => {
  const item = {
    rawItem: {},
    output: 'Some output',
  };

  const messages = formatWebSearchCommandMessage(item, 0, new Map());

  expect(messages.length).toBe(1);
  expect(messages[0].command).toBe('web_search: "unknown query"');
});

it('formatWebSearchCommandMessage detects success from output', () => {
  const successItem = {
    rawItem: {
      arguments: JSON.stringify({ query: 'test' }),
    },
    output: '## Search Results\n...',
  };

  const errorItem = {
    rawItem: {
      arguments: JSON.stringify({ query: 'test' }),
    },
    output: 'Error: Something went wrong',
  };

  const successMessages = formatWebSearchCommandMessage(successItem, 0, new Map());
  const errorMessages = formatWebSearchCommandMessage(errorItem, 0, new Map());

  expect(successMessages[0].success).toBe(true);
  expect(errorMessages[0].success).toBe(false);
});

it('formatWebSearchCommandMessage uses fallback args from map', () => {
  const callId = 'call-123';
  const item = {
    rawItem: {
      callId,
    },
    output: 'Results',
  };
  const argsMap = new Map<string, unknown>([[callId, { query: 'fallback query' }]]);

  const messages = formatWebSearchCommandMessage(item, 0, argsMap);

  expect(messages[0].command).toBe('web_search: "fallback query"');
});
