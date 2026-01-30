import test from 'ava';
import { createWebFetchToolDefinition } from './web-fetch.js';
import { ISettingsService, ILoggingService } from '../services/service-interfaces.js';

// Mock services
const mockSettingsService = {} as ISettingsService;
const mockLoggingService = {
    error: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
} as unknown as ILoggingService;

const webFetchTool = createWebFetchToolDefinition({
    settingsService: mockSettingsService,
    loggingService: mockLoggingService,
});

test('needsApproval: returns false', async t => {
    const result = await webFetchTool.needsApproval({ url: 'https://example.com' });
    t.false(result);
});

test('execute: fetches and converts to markdown', async t => {
    // Mock global fetch
    const originalFetch = global.fetch;
    global.fetch = async () => {
        return {
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            text: async () => '<html><body><h1>Hello World</h1><p>This is a test.</p></body></html>',
            body: {
                getReader: () => {
                    const chunks = [Buffer.from('<html><body><h1>Hello World</h1><p>This is a test.</p></body></html>')];
                    let i = 0;
                    return {
                        read: async () => {
                            if (i < chunks.length) {
                                return { done: false, value: chunks[i++] };
                            }
                            return { done: true };
                        },
                        releaseLock: () => {}
                    };
                }
            }
        } as any;
    };

    try {
        const result = await webFetchTool.execute({ url: 'https://example.com' });
        t.true(result.includes('# Hello World'));
        t.true(result.includes('This is a test.'));
        t.true(result.includes('Table of Contents'));
    } finally {
        global.fetch = originalFetch;
    }
});

test('execute: handles fetch errors', async t => {
    const originalFetch = global.fetch;
    global.fetch = async () => {
        return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
        } as any;
    };

    try {
        const result = await webFetchTool.execute({ url: 'https://example.com/404' });
        t.true(result.includes('Error'));
        t.true(result.includes('404'));
    } finally {
        global.fetch = originalFetch;
    }
});
