import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { expect, it } from 'vitest';
import { executeShellCommand } from '../execute-shell.js';
import { createSandboxRuntimeConfig } from './sandbox-policy.js';
import { AnthropicShellSandboxRunner } from './shell-sandbox-runner.js';

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

it.sequential('sandbox runtime denies a credential-resident socket until the exact socket is granted', async () => {
  const runner = new AnthropicShellSandboxRunner();
  const availability = await runner.availability();
  if (availability.type !== 'available') {
    console.warn(
      `[SKIP] Docker socket sandbox-runtime test: ${availability.type}${
        'reason' in availability ? `: ${availability.reason}` : ''
      }`,
    );
    return;
  }

  // macOS Unix-domain socket paths have a short length limit (~104 bytes); keep the
  // fixture under the repo cwd so it stays short and writable on both macOS and Linux.
  const root = fs.mkdtempSync(path.join(process.cwd(), '.t2d-'));
  const home = path.join(root, 'home');
  const dockerDir = path.join(home, '.docker');
  const socketPath = path.join(dockerDir, 'run', 'docker.sock');
  const credentialPath = path.join(dockerDir, 'config.json');
  const clientPath = path.join(root, 'socket-client.mjs');
  const credentialReaderPath = path.join(root, 'credential-reader.mjs');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.writeFileSync(credentialPath, '{"auths":{"registry.example":"secret"}}');
  fs.writeFileSync(
    clientPath,
    [
      "import net from 'node:net';",
      'const client = net.createConnection(process.argv[2]);',
      "client.once('data', (data) => { process.stdout.write(data); client.end(); });",
      "client.once('error', () => { process.exitCode = 1; });",
    ].join('\n'),
  );
  fs.writeFileSync(
    credentialReaderPath,
    ["import fs from 'node:fs';", "process.stdout.write(fs.readFileSync(process.argv[2], 'utf8'));"].join('\n'),
  );
  const server = net.createServer((socket) => socket.end('ok'));

  try {
    try {
      await listen(server, socketPath);
    } catch (error) {
      // Some sandboxed environments (e.g. restricted CI) support the sandbox
      // runtime but prohibit creating Unix domain sockets. This test verifies
      // socket-level sandbox policy, so it cannot run there; skip instead of
      // reporting a false failure on a platform that is otherwise supported.
      if (error instanceof Error && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        console.warn(
          `[SKIP] Docker socket sandbox-runtime test: environment denies Unix socket creation: ${error.message}`,
        );
        await close(server);
        fs.rmSync(root, { recursive: true, force: true });
        return;
      }
      throw error;
    }

    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(clientPath)} ${JSON.stringify(socketPath)}`;
    const deniedConfig = createSandboxRuntimeConfig({ cwd: root, home, env: {} });
    const deniedWrapped = await runner.wrap(command, { cwd: root, config: deniedConfig });
    const denied = await executeShellCommand(deniedWrapped.command, { cwd: root, timeout: 10_000 });
    await runner.cleanupAfterCommand();

    expect(denied.exitCode).not.toBe(0);

    const grantedConfig = createSandboxRuntimeConfig({ cwd: root, home, dockerSocketPath: socketPath, env: {} });
    const grantedWrapped = await runner.wrap(command, { cwd: root, config: grantedConfig });
    const granted = await executeShellCommand(grantedWrapped.command, { cwd: root, timeout: 10_000 });
    await runner.cleanupAfterCommand();

    expect(granted.exitCode).toBe(0);
    expect(granted.stdout).toBe('ok');

    const credentialProbe = `${JSON.stringify(process.execPath)} ${JSON.stringify(
      credentialReaderPath,
    )} ${JSON.stringify(credentialPath)}`;
    const credentialWrapped = await runner.wrap(credentialProbe, { cwd: root, config: grantedConfig });
    const credentialRead = await executeShellCommand(credentialWrapped.command, { cwd: root, timeout: 10_000 });
    await runner.cleanupAfterCommand();

    expect(credentialRead.exitCode).not.toBe(0);
    expect(credentialRead.stdout).not.toContain('secret');
  } finally {
    await runner.cleanupAfterCommand();
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
