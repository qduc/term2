import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  CachedOpencodeTransportDiscovery,
  parseOpencodeTransportDocumentation,
} from './opencode-transport-discovery.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const documentation = `
| Model | Model ID | Endpoint | AI SDK Package |
| --- | --- | --- | --- |
| Muse Spark 1.2 | muse-spark-1.2 | \`https://opencode.ai/zen/v1/responses\` | \`@ai-sdk/openai\` |
| Claude Sonnet | claude-sonnet-4-6 | \`https://opencode.ai/zen/v1/messages\` | \`@ai-sdk/anthropic\` |
| DeepSeek V4 Flash | deepseek-v4-flash | \`https://opencode.ai/zen/v1/chat/completions\` | \`@ai-sdk/openai-compatible\` |
`;

it('parses exact model transports from the official endpoint table', () => {
  expect(parseOpencodeTransportDocumentation(documentation)).toEqual({
    'muse-spark-1.2': 'openai-responses',
    'claude-sonnet-4-6': 'anthropic-messages',
    'deepseek-v4-flash': 'openai-chat-completions',
  });
});

it('caches a successful documentation lookup and reuses it for later models', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-transport-discovery-'));
  tempDirectories.push(directory);
  const cachePath = path.join(directory, 'opencode-transport-cache.json');
  let fetches = 0;
  const discovery = new CachedOpencodeTransportDiscovery({
    cachePath,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(documentation, { status: 200 });
    },
  });

  await expect(discovery.resolve('claude-sonnet-4-6')).resolves.toBe('anthropic-messages');
  await expect(discovery.resolve('deepseek-v4-flash')).resolves.toBe('openai-chat-completions');
  expect(fetches).toBe(1);
  await expect(fs.readFile(cachePath, 'utf8')).resolves.toContain('claude-sonnet-4-6');
});

it('does not replace the safe fallback when documentation cannot be fetched', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-transport-discovery-'));
  tempDirectories.push(directory);
  const discovery = new CachedOpencodeTransportDiscovery({
    cachePath: path.join(directory, 'opencode-transport-cache.json'),
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
  });

  await expect(discovery.resolve('unknown-model')).resolves.toBeUndefined();
});

it('abandons discovery when the user turn is cancelled', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-transport-discovery-'));
  tempDirectories.push(directory);
  const controller = new AbortController();
  const discovery = new CachedOpencodeTransportDiscovery({
    cachePath: path.join(directory, 'opencode-transport-cache.json'),
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      }),
  });

  const resolution = discovery.resolve('unknown-model', controller.signal);
  controller.abort();
  await expect(resolution).resolves.toBeUndefined();
});

it('refreshes an expired cache before trusting a discovered transport', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-transport-discovery-'));
  tempDirectories.push(directory);
  const cachePath = path.join(directory, 'opencode-transport-cache.json');
  await fs.writeFile(
    cachePath,
    JSON.stringify({
      version: 1,
      fetchedAt: 0,
      transports: { 'new-responses-model': 'openai-chat-completions' },
    }),
  );
  let fetches = 0;
  const discovery = new CachedOpencodeTransportDiscovery({
    cachePath,
    now: () => 24 * 60 * 60 * 1000 + 1,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(
        `${documentation}\n| New | new-responses-model | \`https://opencode.ai/zen/v1/responses\` | x |`,
      );
    },
  });

  await expect(discovery.resolve('new-responses-model')).resolves.toBe('openai-responses');
  expect(fetches).toBe(1);
});
