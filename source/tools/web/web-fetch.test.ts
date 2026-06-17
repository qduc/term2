import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { createWebFetchToolDefinition } from './web-fetch.js';
import { ISettingsService, ILoggingService } from '../../services/service-interfaces.js';

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

it('needsApproval: returns false', async () => {
  const result = await webFetchTool.needsApproval({ url: 'https://example.com' });
  expect(result).toBe(false);
});

it.sequential('execute: fetches and converts to markdown', async () => {
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
            releaseLock: () => {},
          };
        },
      },
    } as any;
  };

  try {
    const result = await webFetchTool.execute({ url: 'https://example.com' });
    expect(result.includes('# Hello World')).toBe(true);
    expect(result.includes('This is a test.')).toBe(true);
    expect(result.includes('Table of Contents')).toBe(true);
  } finally {
    global.fetch = originalFetch;
  }
});

it.sequential('execute: handles fetch errors', async () => {
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
    expect(result.includes('Error')).toBe(true);
    expect(result.includes('404')).toBe(true);
  } finally {
    global.fetch = originalFetch;
  }
});

it.sequential('execute: converts github blob links to raw links', async () => {
  const originalFetch = global.fetch;
  let fetchedUrl = '';
  global.fetch = async (url: string | URL | Request) => {
    fetchedUrl = url.toString();
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/plain']]),
      text: async () => 'raw github content',
    } as any;
  };

  try {
    const githubUrl = 'https://github.com/qduc/term2/blob/main/package.json';
    await webFetchTool.execute({ url: githubUrl });
    expect(fetchedUrl).toBe('https://raw.githubusercontent.com/qduc/term2/main/package.json');
  } finally {
    global.fetch = originalFetch;
  }
});

it.sequential('execute: saves full content to temp file when content exceeds max_chars', async () => {
  const originalFetch = global.fetch;

  // Generate enough HTML to produce > 200 chars of markdown
  const longText =
    'This is a long paragraph that generates enough markdown to exceed the max_chars limit and trigger the temp file creation behavior in the web fetch tool. '.repeat(
      10,
    );
  const html = `<html><body><h1>Long Page</h1><p>${longText}</p></body></html>`;

  global.fetch = async () => {
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => html,
    } as any;
  };

  let tempFile: string | null = null;
  try {
    const result = await webFetchTool.execute({ url: 'https://example.com/long', max_chars: 200 });

    expect(result.includes('Content truncated at 200 characters')).toBe(true);
    expect(result.includes('Full content saved to temp file:')).toBe(true);

    // Extract the temp file path from the output and clean up
    const match = result.match(/`([^`]+\.md)`/);
    if (match) {
      tempFile = match[1];
    }
  } finally {
    global.fetch = originalFetch;
    if (tempFile) {
      await fs.rm(tempFile, { force: true });
    }
  }
});

it.sequential('execute: does not save temp file when content fits within max_chars', async () => {
  const originalFetch = global.fetch;
  const shortHtml = '<html><body><h1>Short Page</h1><p>Small content.</p></body></html>';

  global.fetch = async () => {
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      text: async () => shortHtml,
    } as any;
  };

  try {
    const result = await webFetchTool.execute({ url: 'https://example.com/short' });
    expect(result.includes('Full content saved to temp file:')).toBe(false);
  } finally {
    global.fetch = originalFetch;
  }
});

it.sequential('execute: does not save temp file on continuation request', async () => {
  // Continuation requests should skip the temp file logic entirely,
  // even if a valid result were returned.
  const result = await webFetchTool.execute({
    url: 'https://example.com/page',
    max_chars: 200,
    continuation_token: 'nonexistent-token',
  });
  // The call will error because the token doesn't exist in the cache,
  // but it should never try to save a temp file.
  expect(result.startsWith('Error:')).toBe(true);
  expect(result.includes('Full content saved to temp file:')).toBe(false);
});
