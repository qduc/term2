import { describe, expect, it, vi } from 'vitest';
import { McpConfigController, type McpConfigFileSystem } from './mcp-config-controller.js';

const createBoundary = (initial?: string) => {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set('/config/mcp.json', initial);
  const fileSystem: McpConfigFileSystem = {
    readFile: vi.fn(async (path) => {
      const value = files.get(String(path));
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return value;
    }) as unknown as McpConfigFileSystem['readFile'],
    mkdir: vi.fn(async () => undefined) as McpConfigFileSystem['mkdir'],
    writeFile: vi.fn(async (path, contents) => {
      files.set(String(path), String(contents));
    }) as McpConfigFileSystem['writeFile'],
    rename: vi.fn(async (from, to) => {
      files.set(String(to), files.get(String(from))!);
      files.delete(String(from));
    }) as McpConfigFileSystem['rename'],
  };
  const loadConfig = vi.fn(async () => ({
    servers: [],
    notes: [],
    userConfigPath: '/config/mcp.json',
    nonInteractiveAllow: [],
  }));
  const replaceServers = vi.fn(async () => {});
  const controller = new McpConfigController({
    userConfigPath: '/config/mcp.json',
    workspaceRoot: '/workspace',
    replaceServers,
    fileSystem,
    temporaryPath: () => '/config/mcp.json.fixed.tmp',
    loadConfig,
  });
  return { controller, files, fileSystem, loadConfig, replaceServers };
};

describe('McpConfigController', () => {
  it('preserves unrelated config while adding, renaming, and deleting user servers', async () => {
    const { controller, files, fileSystem, loadConfig, replaceServers } = createBoundary(
      JSON.stringify({ nonInteractiveAllow: ['x'], custom: { keep: true }, mcpServers: { old: { command: 'old' } } }),
    );

    await controller.saveUserServer('old', 'renamed', { type: 'stdio', command: 'new', env: { TOKEN: '${TOKEN}' } });
    let stored = JSON.parse(files.get('/config/mcp.json')!);
    expect(stored).toMatchObject({ nonInteractiveAllow: ['x'], custom: { keep: true } });
    expect(stored.mcpServers).toEqual({ renamed: { type: 'stdio', command: 'new', env: { TOKEN: '${TOKEN}' } } });
    expect(replaceServers).toHaveBeenCalledTimes(1);
    expect(fileSystem.rename).toHaveBeenCalledWith('/config/mcp.json.fixed.tmp', '/config/mcp.json');
    expect(loadConfig).toHaveBeenCalledWith({ settingsDir: '/config', workspaceRoot: '/workspace' });

    await controller.deleteUserServer('renamed');
    stored = JSON.parse(files.get('/config/mcp.json')!);
    expect(stored.mcpServers).toEqual({});
    expect(replaceServers).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite malformed JSON', async () => {
    const { controller, files } = createBoundary('{ nope');
    await expect(controller.saveUserServer(null, 'x', { command: 'x' })).rejects.toThrow('valid JSON');
    expect(files.get('/config/mcp.json')).toBe('{ nope');
  });

  it('lists raw user entries without expanding secret placeholders', async () => {
    const { controller } = createBoundary(
      JSON.stringify({ mcpServers: { remote: { url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } } } }),
    );
    expect(await controller.listUserServers()).toEqual([
      { name: 'remote', config: { url: 'https://x', headers: { Authorization: 'Bearer ${TOKEN}' } } },
    ]);
  });
});
