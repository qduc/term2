import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpConfigController } from './mcp-config-controller.js';

describe('McpConfigController', () => {
  it('preserves unrelated config while adding, renaming, and deleting user servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'term2-mcp-config-'));
    const path = join(dir, 'mcp.json');
    await writeFile(
      path,
      JSON.stringify({ nonInteractiveAllow: ['x'], custom: { keep: true }, mcpServers: { old: { command: 'old' } } }),
    );
    const replaceServers = vi.fn(async () => {});
    const controller = new McpConfigController({ userConfigPath: path, workspaceRoot: dir, replaceServers });

    await controller.saveUserServer('old', 'renamed', { type: 'stdio', command: 'new', env: { TOKEN: '${TOKEN}' } });
    let stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored).toMatchObject({ nonInteractiveAllow: ['x'], custom: { keep: true } });
    expect(stored.mcpServers).toEqual({ renamed: { type: 'stdio', command: 'new', env: { TOKEN: '${TOKEN}' } } });
    expect(replaceServers).toHaveBeenCalledTimes(1);

    await controller.deleteUserServer('renamed');
    stored = JSON.parse(await readFile(path, 'utf8'));
    expect(stored.mcpServers).toEqual({});
    expect(replaceServers).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite malformed JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'term2-mcp-bad-'));
    const path = join(dir, 'mcp.json');
    await writeFile(path, '{ nope');
    const controller = new McpConfigController({ userConfigPath: path, workspaceRoot: dir, replaceServers: vi.fn() });
    await expect(controller.saveUserServer(null, 'x', { command: 'x' })).rejects.toThrow('valid JSON');
    expect(await readFile(path, 'utf8')).toBe('{ nope');
  });

  it('lists raw user entries without expanding secret placeholders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'term2-mcp-list-'));
    const path = join(dir, 'mcp.json');
    await writeFile(
      path,
      JSON.stringify({ mcpServers: { remote: { url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } } } }),
    );
    const controller = new McpConfigController({ userConfigPath: path, workspaceRoot: dir, replaceServers: vi.fn() });
    expect(await controller.listUserServers()).toEqual([
      { name: 'remote', config: { url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } } },
    ]);
  });
});
