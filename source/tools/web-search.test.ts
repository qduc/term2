import test from 'ava';
import {
    createWebSearchToolDefinition,
    formatResultsAsMarkdown,
    formatWebSearchCommandMessage,
} from './web-search.js';
import type { WebSearchResponse } from '../providers/web-search/index.js';

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

test('createWebSearchToolDefinition defines tool correctly', t => {
    const settings = createMockSettingsService();
    const logging = createMockLoggingService();

    const tool = createWebSearchToolDefinition({
        settingsService: settings,
        loggingService: logging,
    });

    t.is(tool.name, 'web_search');
    t.true(tool.description.includes('Search the web'));
    t.is(typeof tool.execute, 'function');
    t.is(typeof tool.formatCommandMessage, 'function');
});

test('needsApproval returns false (read-only operation)', t => {
    const settings = createMockSettingsService();
    const logging = createMockLoggingService();

    const tool = createWebSearchToolDefinition({
        settingsService: settings,
        loggingService: logging,
    });

    const result = tool.needsApproval({ query: 'test' }, undefined);
    t.is(result, false);
});

test('execute returns error when provider not configured', async t => {
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

    t.true(typeof result === 'string');
    t.true((result as string).includes('Error:'));
    t.true((result as string).includes('not properly configured'));
});

test('formatResultsAsMarkdown formats results correctly', t => {
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

    t.true(markdown.includes('## Search Results'));
    t.true(markdown.includes('### 1. Test Result 1'));
    t.true(markdown.includes('**URL:** https://example.com/1'));
    t.true(markdown.includes('This is the first result content.'));
    t.true(markdown.includes('### 2. Test Result 2'));
    t.true(markdown.includes('**Published:** 2024-01-15'));
});

test('formatResultsAsMarkdown handles empty results', t => {
    const response: WebSearchResponse = {
        query: 'no results query',
        results: [],
    };

    const markdown = formatResultsAsMarkdown(response);

    t.true(markdown.includes('No results found'));
});

test('formatResultsAsMarkdown includes answer box when available', t => {
    const response: WebSearchResponse = {
        query: 'what is the capital of France',
        results: [],
        answerBox: 'The capital of France is Paris.',
    };

    const markdown = formatResultsAsMarkdown(response);

    t.true(markdown.includes('## Answer'));
    t.true(markdown.includes('The capital of France is Paris.'));
});

test('formatResultsAsMarkdown includes both answer box and results', t => {
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

    t.true(markdown.includes('## Answer'));
    t.true(markdown.includes('Direct answer.'));
    t.true(markdown.includes('## Search Results'));
    t.true(markdown.includes('Result'));
});

test('formatWebSearchCommandMessage extracts query correctly', t => {
    const item = {
        rawItem: {
            arguments: JSON.stringify({ query: 'test search' }),
        },
        output: 'Search results here',
    };

    const messages = formatWebSearchCommandMessage(item, 0, new Map());

    t.is(messages.length, 1);
    t.is(messages[0].command, 'web_search: "test search"');
    t.is(messages[0].toolName, 'web_search');
    t.is(messages[0].sender, 'command');
});

test('formatWebSearchCommandMessage handles missing query', t => {
    const item = {
        rawItem: {},
        output: 'Some output',
    };

    const messages = formatWebSearchCommandMessage(item, 0, new Map());

    t.is(messages.length, 1);
    t.is(messages[0].command, 'web_search: "unknown query"');
});

test('formatWebSearchCommandMessage detects success from output', t => {
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

    t.true(successMessages[0].success);
    t.false(errorMessages[0].success);
});

test('formatWebSearchCommandMessage uses fallback args from map', t => {
    const callId = 'call-123';
    const item = {
        rawItem: {
            callId,
        },
        output: 'Results',
    };
    const argsMap = new Map<string, unknown>([
        [callId, { query: 'fallback query' }],
    ]);

    const messages = formatWebSearchCommandMessage(item, 0, argsMap);

    t.is(messages[0].command, 'web_search: "fallback query"');
});
