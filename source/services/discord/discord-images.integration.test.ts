import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { stageDiscordImages } from './discord-images.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==',
  'base64',
);

async function fixture(bytes = png, stall = false) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-image-fixture-'));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url!);
    expect(request.headers.authorization).toBeUndefined();
    if (stall) {
      response.writeHead(200);
      response.write(bytes.subarray(0, 1));
      return;
    }
    response.end(bytes);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address() as { port: number };
  const options = {
    stateDir,
    channelId: '200',
    fetch: ((url, init) => {
      expect(init?.redirect).toBe('error');
      const parsed = new URL(String(url));
      return fetch(`http://127.0.0.1:${address.port}${parsed.pathname}`, init);
    }) as typeof fetch,
  };
  const image = (id = '501', extra = {}) => ({
    id,
    size: bytes.length,
    url: `https://cdn.discordapp.com/attachments/200/${id}/ignored.png`,
    ...extra,
  });
  return { options, image, calls, stateDir };
}

it('uses actual byte signatures, permits absent optional MIME and does not trust filenames', async () => {
  const f = await fixture();
  const result = await stageDiscordImages([f.image('501', { filename: '../../secret.exe' })], f.options);
  expect(result.omitted).toBe(0);
  expect(result.paths[0]).toMatch(/\/images-[^/]+\/0\.png$/);
  expect(fs.readFileSync(result.paths[0]!)).toEqual(png);
  const mismatch = await stageDiscordImages([f.image('502', { content_type: 'image/jpeg' })], f.options);
  expect(mismatch).toEqual({ paths: [], omitted: 1 });
});

it('rejects non-images and shorter or longer streams rather than delivering truncated bytes', async () => {
  const f = await fixture();
  for (const size of [png.length - 1, png.length + 1]) {
    expect(await stageDiscordImages([f.image('501', { size })], f.options)).toEqual({ paths: [], omitted: 1 });
  }
  const text = await fixture(Buffer.from('<script>not an image</script>'));
  expect(await stageDiscordImages([text.image()], text.options)).toEqual({ paths: [], omitted: 1 });
  expect(fs.readdirSync(f.stateDir)).toEqual([]);
});

it('enforces the exact 20MiB aggregate byte boundary without fetching oversized siblings', async () => {
  const bytes = Buffer.alloc(20 * 1024 * 1024);
  png.copy(bytes);
  const f = await fixture(bytes);
  const result = await stageDiscordImages([f.image(), f.image('502', { size: 1 })], f.options);
  expect(result.paths).toHaveLength(1);
  expect(result.omitted).toBe(1);
  expect(fs.statSync(result.paths[0]!).size).toBe(bytes.length);
  expect(f.calls).toHaveLength(1);
  expect(await stageDiscordImages([f.image('503', { size: bytes.length + 1 })], f.options)).toEqual({
    paths: [],
    omitted: 1,
  });
  expect(f.calls).toHaveLength(1);
});

it('limits attachment admission to ten while retaining successful siblings and reporting the rest', async () => {
  const f = await fixture();
  const result = await stageDiscordImages(
    Array.from({ length: 11 }, (_, i) => f.image(String(501 + i))),
    f.options,
  );
  expect(result.paths).toHaveLength(10);
  expect(result.omitted).toBe(1);
  expect(f.calls).toHaveLength(10);
});

it('rejects non-CDN, wrong-channel/id, credential, port and redirect-like paths before network access', async () => {
  const f = await fixture();
  const urls = [
    'http://cdn.discordapp.com/attachments/200/501/a.png',
    'https://cdn.discordapp.com.evil.test/attachments/200/501/a.png',
    'https://media.discordapp.net/attachments/200/501/a.png',
    'https://cdn.discordapp.com/attachments/201/501/a.png',
    'https://cdn.discordapp.com/attachments/200/502/a.png',
    'https://cdn.discordapp.com/attachments/200/501/../private',
    'https://user:pass@cdn.discordapp.com/attachments/200/501/a.png',
    'https://cdn.discordapp.com:8443/attachments/200/501/a.png',
    'https://cdn.discordapp.com/attachments/200/501/a.png#fragment',
  ];
  const result = await stageDiscordImages(
    urls.map((url) => f.image('501', { url })),
    f.options,
  );
  expect(result).toEqual({ paths: [], omitted: urls.length });
  expect(f.calls).toEqual([]);
});

it('ends a stalled response body within the shared 30-second download deadline', async () => {
  const f = await fixture(png, true);
  const started = Date.now();
  expect(await stageDiscordImages([f.image(), f.image('502')], f.options)).toEqual({ paths: [], omitted: 2 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(29000);
  expect(Date.now() - started).toBeLessThan(34000);
  expect(f.calls).toHaveLength(1);
  expect(fs.readdirSync(f.stateDir)).toEqual([]);
}, 35000);
