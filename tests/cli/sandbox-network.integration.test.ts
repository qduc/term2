import { afterEach, expect, it } from 'vitest';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { integrationCliPath } from '../helpers/integration-cli.js';
import {
  createWorld,
  removeWorld,
  runCli,
  startLoopbackProvider,
  toolResults,
  writeWorldSettings,
  type LoopbackProvider,
  type World,
} from '../helpers/loopback-chat-world.js';

// The shell sandbox's network promise (docs/reference/shell-sandbox.md, "Network approval"), through the
// built CLI headlessly with the real sandbox ON (bubblewrap + socat on Linux): a sandboxed command cannot
// reach a loopback HTTP server directly, cannot reach it through the sandbox's proxy until the destination
// is approved (`term2 sandbox-network allow HOST PORT`), can after that, and cannot when
// `sandbox.allowNetworking` is false even for an approved destination. A loopback HTTP server in this
// process plays the destination and counts what reaches it, so "blocked" means the server saw nothing.
// The PTY approval prompt for the same flow is checked in sandbox-network.e2e.test.ts.
//
// Not skipped when the sandbox tools are missing: the shell then asks for approval instead of running
// the command and the assertions below fail. The `integration` job installs bubblewrap and socat
// (setup-tests `ripgrep: 'true'`) on ubuntu-22.04. The sandbox's in-namespace proxy bridge is
// `socat TCP-LISTEN:3128`, which needs IPv6 sockets: on a kernel without IPv6 a proxied command fails
// with "Failed to connect to localhost port 3128" and this test says so instead of reporting a policy bug.
//
// Every command is a `curl` to 127.0.0.1 on this test's own port; the child's TMPDIR is a throwaway of its own.
//
// Linux only: the direct-connection and proxy behaviour asserted here is bubblewrap's network namespace and
// the socat bridge. Seatbelt on macOS has not been run with it.

let world: World | undefined;
let provider: LoopbackProvider | undefined;
let server: http.Server | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  removeWorld(world);
  world = undefined;
});

const BODY = 'LOOPBACK-DESTINATION-REACHED';
const BLOCKED = 'Connection blocked by network allowlist';

it.skipIf(process.platform !== 'linux')(
  'keeps loopback destinations behind approval and honours sandbox.allowNetworking',
  { timeout: 90_000 },
  async () => {
    world = createWorld('term2-sandbox-net');
    const w = world;
    const hits: string[] = [];
    server = http.createServer((request, response) => {
      hits.push(request.url ?? '');
      response.end(BODY);
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const url = `http://127.0.0.1:${port}/probe`;
    const curl = (flags: string) => `curl -sS ${flags} -m 10 -w ' [curl exit %{exitcode} http %{http_code}]' ${url}`;
    const cli = integrationCliPath();

    async function run(commands: string[], sandbox: Record<string, unknown>) {
      provider = await startLoopbackProvider({
        turns: commands.map((command) => ({ call: { tool: 'shell', args: { command, description: 'Fetch' } } })),
      });
      writeWorldSettings(w, provider.baseUrl, { sandbox: { enabled: true, ...sandbox } });
      const result = await runCli(w, cli, ['--profile', 'bare', 'Fetch the fixture URL']);
      const report = `exit ${result.status}\nstderr:\n${result.stderr}`;
      expect(result.status, report).toBe(0);
      const texts = toolResults(provider.requests().at(-1)).map((entry) => entry.text);
      expect(texts, report).toHaveLength(commands.length);
      const bridgeDown = texts.find((text) => text.includes('port 3128'));
      expect(bridgeDown, `the sandbox proxy bridge did not start (socat TCP-LISTEN needs IPv6): ${bridgeDown}`).toBe(
        undefined,
      );
      await provider.close();
      provider = undefined;
      return texts;
    }
    const provision = (decision: 'allow' | 'revoke') => {
      const result = spawnSync('node', [cli, 'sandbox-network', decision, '127.0.0.1', String(port)], {
        cwd: w.workspace,
        env: w.env,
      });
      expect(result.status, result.stderr?.toString()).toBe(0);
    };

    // 1. No approval: direct connections have no route; the proxy refuses; the server sees nothing.
    const [direct, unapproved] = await run([curl("--noproxy '*'"), curl('')], {});
    expect(direct).toMatch(/exit 7[\s\S]*curl exit 7/);
    expect(direct).not.toContain(BODY);
    expect(unapproved).toContain(BLOCKED);
    expect(unapproved).toContain('http 403');
    expect(unapproved).not.toContain(BODY);
    expect(hits).toEqual([]);

    // 2. After the documented approval the proxy forwards it; a direct connection still has no route.
    provision('allow');
    const [approved, stillDirect] = await run([curl(''), curl("--noproxy '*'")], {});
    expect(approved).toMatch(/^exit 0[\s\S]*LOOPBACK-DESTINATION-REACHED \[curl exit 0 http 200\]/);
    expect(stillDirect).toMatch(/curl exit 7/);
    expect(hits).toEqual(['/probe']);

    // 3. sandbox.allowNetworking=false turns the proxy path off even for the approved destination.
    const [disabled] = await run([curl('')], { allowNetworking: false });
    expect(disabled).not.toContain(BODY);
    expect(disabled).not.toContain('http 200');
    expect(hits).toEqual(['/probe']);

    // 4. Revoking the approval closes it again.
    provision('revoke');
    const [revoked] = await run([curl('')], {});
    expect(revoked).toContain(BLOCKED);
    expect(hits).toEqual(['/probe']);
  },
);
