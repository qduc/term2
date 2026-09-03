import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { z } from 'zod';
import { ToolBridgeServer, type ToolBridgeCallRecord } from './tool-bridge.js';
import type { AnyToolDefinition } from '../../types.js';

const noopFormatter = (() => []) as unknown as AnyToolDefinition['formatCommandMessage'];

const tool = (overrides: Partial<AnyToolDefinition> & { name: string }): AnyToolDefinition =>
  ({
    description: 'test tool',
    parameters: z.object({ value: z.string() }),
    needsApproval: () => false,
    execute: (params: unknown) => `echo:${(params as { value: string }).value}`,
    formatCommandMessage: noopFormatter,
    ...overrides,
  } as AnyToolDefinition);

/** Speaks the bridge's newline-delimited JSON protocol over the real socket. */
class BridgeClient {
  #socket: net.Socket;
  #buffer = '';
  #pending = new Map<number, (message: Record<string, unknown>) => void>();

  private constructor(socket: net.Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf('\n');
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id: number };
        this.#pending.get(message.id)?.(message as Record<string, unknown>);
        this.#pending.delete(message.id);
      }
    });
  }

  static connect(socketPath: string): Promise<BridgeClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once('error', reject);
      socket.once('connect', () => resolve(new BridgeClient(socket)));
    });
  }

  call(id: number, toolName: string, params: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.write(`${JSON.stringify({ id, tool: toolName, params })}\n`);
    });
  }

  close(): void {
    this.#socket.destroy();
  }
}

describe('ToolBridgeServer', () => {
  let bridge: ToolBridgeServer | undefined;
  let client: BridgeClient | undefined;

  afterEach(async () => {
    client?.close();
    await bridge?.stop();
    bridge = undefined;
    client = undefined;
  });

  const start = async (server: ToolBridgeServer) => {
    bridge = server;
    const socketPath = await server.start();
    client = await BridgeClient.connect(socketPath);
    return client;
  };

  it('executes a registered tool and returns its result', async () => {
    const connection = await start(new ToolBridgeServer({ registry: [tool({ name: 'echo' })] }));

    const response = await connection.call(1, 'echo', { value: 'hi' });

    expect(response).toMatchObject({ id: 1, ok: true, result: 'echo:hi' });
  });

  it('refuses a tool whose needsApproval returns true, without executing it', async () => {
    let executed = false;
    const connection = await start(
      new ToolBridgeServer({
        registry: [
          tool({
            name: 'dangerous',
            needsApproval: () => true,
            execute: () => {
              executed = true;
              return 'ran';
            },
          }),
        ],
      }),
    );

    const response = await connection.call(1, 'dangerous', { value: 'x' });

    expect(executed).toBe(false);
    expect(response.ok).toBe(false);
    expect(String(response.error)).toContain('needs user approval');
    expect(String(response.error)).toContain('dangerous');
  });

  it('refuses the call when needsApproval throws rather than assuming it is safe', async () => {
    let executed = false;
    const connection = await start(
      new ToolBridgeServer({
        registry: [
          tool({
            name: 'unstable',
            needsApproval: () => {
              throw new Error('policy lookup failed');
            },
            execute: () => {
              executed = true;
              return 'ran';
            },
          }),
        ],
      }),
    );

    const response = await connection.call(1, 'unstable', { value: 'x' });

    expect(executed).toBe(false);
    expect(response.ok).toBe(false);
  });

  it('rejects parameters that fail the tool schema and names the failing field', async () => {
    const connection = await start(new ToolBridgeServer({ registry: [tool({ name: 'echo' })] }));

    const response = await connection.call(1, 'echo', { value: 42 });

    expect(response.ok).toBe(false);
    expect(String(response.error)).toContain('value');
  });

  it('reports an unknown tool with the list of tools that do exist', async () => {
    const connection = await start(
      new ToolBridgeServer({ registry: [tool({ name: 'echo' }), tool({ name: 'other' })] }),
    );

    const response = await connection.call(1, 'missing', {});

    expect(response.ok).toBe(false);
    expect(String(response.error)).toContain('echo, other');
  });

  it('surfaces a thrown tool error as a failed call rather than killing the connection', async () => {
    const connection = await start(
      new ToolBridgeServer({
        registry: [
          tool({
            name: 'boom',
            execute: () => {
              throw new Error('tool blew up');
            },
          }),
        ],
      }),
    );

    const failure = await connection.call(1, 'boom', { value: 'x' });
    expect(failure).toMatchObject({ ok: false, error: 'tool blew up' });

    // The same connection must still serve later calls.
    const recovered = await connection.call(2, 'boom', { value: 'x' });
    expect(recovered.ok).toBe(false);
  });

  it('stops accepting calls once the per-run limit is reached', async () => {
    const connection = await start(
      new ToolBridgeServer({ registry: [tool({ name: 'echo' })], limits: { maxCalls: 2 } }),
    );

    expect((await connection.call(1, 'echo', { value: 'a' })).ok).toBe(true);
    expect((await connection.call(2, 'echo', { value: 'b' })).ok).toBe(true);
    const third = await connection.call(3, 'echo', { value: 'c' });

    expect(third.ok).toBe(false);
    expect(String(third.error)).toContain('limit');
  });

  it('truncates an oversized string result with an explicit marker', async () => {
    const connection = await start(
      new ToolBridgeServer({
        registry: [tool({ name: 'big', execute: () => 'x'.repeat(500) })],
        limits: { maxResultChars: 50 },
      }),
    );

    const response = await connection.call(1, 'big', { value: 'x' });

    expect(String(response.result)).toContain('[truncated:');
    expect(String(response.result).length).toBeLessThan(200);
  });

  it('records each call so the tool can summarise what the script did', async () => {
    const calls: ToolBridgeCallRecord[] = [];
    const connection = await start(
      new ToolBridgeServer({
        registry: [tool({ name: 'echo' }), tool({ name: 'locked', needsApproval: () => true })],
        onCall: (record) => calls.push(record),
      }),
    );

    await connection.call(1, 'echo', { value: 'a' });
    await connection.call(2, 'locked', { value: 'b' });
    await connection.call(3, 'nope', {});

    expect(calls.map((call) => [call.tool, call.outcome])).toEqual([
      ['echo', 'ok'],
      ['locked', 'approval_required'],
      ['nope', 'unknown_tool'],
    ]);
  });

  it('removes the socket file on stop so runs do not accumulate dead sockets', async () => {
    const server = new ToolBridgeServer({ registry: [tool({ name: 'echo' })] });
    const socketPath = await server.start();
    const { existsSync } = await import('node:fs');
    expect(existsSync(socketPath)).toBe(true);

    await server.stop();

    expect(existsSync(socketPath)).toBe(false);
  });
});
