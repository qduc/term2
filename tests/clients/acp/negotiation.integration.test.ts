import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { integrationCliPath } from '../../helpers/integration-cli.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';

// Cross the actual stdio/SDK initialization boundary, including offers outside
// the version accepted by either SDK client helper.
it.each([0, 1, 2, 3, 4, -1, '1'])(
  'negotiates or rejects protocol offer %s',
  async (version) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'term2-acp-negotiate-'));
    const child = spawn(process.execPath, [integrationCliPath(), 'acp'], {
      env: createTestChildEnv({ HOME: temp, XDG_CONFIG_HOME: temp, XDG_STATE_HOME: temp, DISABLE_LOGGING: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += String(data)));
    const lines = createInterface({ input: child.stdout });
    const response = new Promise<any>((resolve, reject) => {
      lines.once('line', (line) => {
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(error);
        }
      });
      child.once('exit', () => reject(new Error(`No ACP response: ${stderr}`)));
    });
    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: version,
            ...(version === 2
              ? { info: { name: 'fixture', version: '1' } }
              : version === 4
              ? {}
              : { clientInfo: { name: 'fixture', version: '1' } }),
          },
        }) + '\n',
      );
      const received = await response;
      expect(received).toMatchObject({ jsonrpc: '2.0', id: 1 });
      if (typeof version === 'string' || version < 0) expect(received.error).toMatchObject({ code: -32602 });
      else expect(received.result).toMatchObject({ protocolVersion: version === 1 ? 1 : 2 });
      child.stdin.end();
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      lines.close();
      child.kill('SIGKILL');
      await exited;
      await rm(temp, { recursive: true, force: true });
    }
  },
  30_000,
);
