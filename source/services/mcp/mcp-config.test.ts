import { describe, expect, it } from 'vitest';
import { loadMcpConfig } from './mcp-config.js';

const readFile = (files: Record<string, string>) => async (path: string) => {
  const hit = Object.entries(files)
    .filter(([name]) => path.endsWith(name))
    .sort((a, b) => b[0].length - a[0].length)[0];
  if (!hit) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return hit[1];
};

describe('loadMcpConfig', () => {
  it('infers stdio from command and http from url, mapping http to streamable-http', async () => {
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({
          mcpServers: {
            local: { command: 'node', args: ['server.js'] },
            remote: { url: 'https://example.com/mcp' },
            legacy: { type: 'sse', url: 'https://example.com/sse' },
          },
        }),
      }),
    });
    expect(servers.map((s) => [s.name, s.provenance, s.transport])).toEqual([
      ['local', 'user', 'stdio'],
      ['remote', 'user', 'streamable-http'],
      ['legacy', 'user', 'sse'],
    ]);
  });

  it('loads project servers from .mcp.json with project provenance', async () => {
    const { servers } = await loadMcpConfig({
      files: readFile({
        '.mcp.json': JSON.stringify({ mcpServers: { repo: { command: 'node' } } }),
      }),
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'repo', provenance: 'project', transport: 'stdio' });
  });

  it('marks invalid entries as errors without dropping valid ones', async () => {
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({
          mcpServers: {
            good: { command: 'node' },
            neither: { args: ['x'] },
            badType: { type: 'carrier-pigeon', url: 'https://x' },
            stdioNeedsCommand: { type: 'stdio', url: 'https://x' },
            badArgs: { command: 'node', args: 'not-an-array' },
          },
        }),
      }),
    });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.good.error).toBeUndefined();
    expect(byName.neither.error).toMatch(/command|url/i);
    expect(byName.badType.error).toMatch(/type/i);
    expect(byName.stdioNeedsCommand.error).toMatch(/command/i);
    expect(byName.badArgs.error).toMatch(/args/i);
  });

  it('a user entry wins over a clashing project entry, and the drop is noted', async () => {
    const notes: string[] = [];
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({ mcpServers: { shared: { command: 'user-cmd' } } }),
        '.mcp.json': JSON.stringify({ mcpServers: { shared: { command: 'evil' }, other: { command: 'ok' } } }),
      }),
      onNote: (m) => notes.push(m),
    });
    const shared = servers.find((s) => s.name === 'shared');
    expect(shared).toMatchObject({ provenance: 'user', command: 'user-cmd' });
    expect(servers.find((s) => s.name === 'other')).toMatchObject({ provenance: 'project' });
    expect(notes.join('\n')).toMatch(/shared/);
  });

  it('expands ${VAR} from the environment in user config only', async () => {
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({
          mcpServers: {
            u: {
              url: 'https://${HOST}/mcp',
              headers: { authorization: 'Bearer ${SECRET}' },
              command: 'run',
              args: ['--token', '${SECRET}'],
              env: { TOKEN: '${SECRET}' },
            },
          },
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: { p: { url: 'https://${HOST}/mcp' } },
        }),
      }),
      env: { HOST: 'api.example.com', SECRET: 's3cret' },
    });
    const u = servers.find((s) => s.name === 'u');
    expect(u?.url).toBe('https://api.example.com/mcp');
    expect(u?.headers).toEqual({ authorization: 'Bearer s3cret' });
    expect(u?.args).toEqual(['--token', 's3cret']);
    expect(u?.env).toEqual({ TOKEN: 's3cret' });
    const p = servers.find((s) => s.name === 'p');
    expect(p?.url).toBe('https://${HOST}/mcp');
  });

  it('attaches projectServers enabled overrides from user config to project entries', async () => {
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({
          mcpServers: { mine: { command: 'a' } },
          projectServers: {
            allowed: { enabled: true },
            denied: { enabled: false },
          },
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: { allowed: { command: 'b' }, denied: { command: 'c' }, unlisted: { command: 'd' } },
          projectServers: { evil: { enabled: true } },
        }),
      }),
    });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.allowed.projectEnabledOverride).toBe(true);
    expect(byName.denied.projectEnabledOverride).toBe(false);
    expect(byName.unlisted.projectEnabledOverride).toBeUndefined();
    expect(byName.mine.projectEnabledOverride).toBeUndefined();
    // projectServers inside a project .mcp.json is ignored
    expect(servers.find((s) => s.name === 'evil')).toBeUndefined();
  });

  it('treats missing config files as empty, not an error', async () => {
    const { servers, notes } = await loadMcpConfig({
      files: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(servers).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('a project file that is not valid JSON is noted and skipped', async () => {
    const notes: string[] = [];
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({ mcpServers: { u: { command: 'a' } } }),
        '.mcp.json': '{ not json',
      }),
      onNote: (m) => notes.push(m),
    });
    expect(servers.map((s) => s.name)).toEqual(['u']);
    expect(notes.join('\n')).toMatch(/\.mcp\.json/);
  });

  it('a non-object mcpServers section is noted and skipped', async () => {
    const notes: string[] = [];
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({ mcpServers: ['nope'] }),
      }),
      onNote: (m) => notes.push(m),
    });
    expect(servers).toEqual([]);
    expect(notes.join('\n')).toMatch(/mcpServers/);
  });

  it('parses headers and cwd for stdio/http entries', async () => {
    const { servers } = await loadMcpConfig({
      files: readFile({
        'mcp.json': JSON.stringify({
          mcpServers: {
            h: { url: 'https://x/mcp', headers: { 'x-a': 'b' } },
            s: { command: 'node', cwd: '/tmp', env: { A: '1' } },
          },
        }),
      }),
    });
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
    expect(byName.h.headers).toEqual({ 'x-a': 'b' });
    expect(byName.s.cwd).toBe('/tmp');
    expect(byName.s.env).toEqual({ A: '1' });
  });

  it('exposes the resolved user config path for override hints', async () => {
    const result = await loadMcpConfig({ files: async () => '' });
    expect(result.userConfigPath).toMatch(/mcp\.json$/);
    expect(result.userConfigPath).not.toMatch(/\.mcp\.json$/);
  });
});
