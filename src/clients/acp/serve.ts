import { Readable, Writable } from 'node:stream';
import type { AgentConnection as V1Connection, Stream as V1Stream } from '@agentclientprotocol/sdk';
import { createAcpV1Agent } from './v1-agent.js';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpAgent, type AcpAgentOptions } from './agent.js';
import { errorMessage } from './contract.js';

export type AcpIo = {
  readonly stdin: ReadableStream<Uint8Array>;
  readonly stdout: WritableStream<Uint8Array>;
  writeStderr(message: string): void;
  flushStdout?(): Promise<void>;
};

/** Adapt Node stdio without writing any diagnostic text to the protocol channel. */
export function createStdioAcpIo(): AcpIo {
  return {
    stdin: Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    stdout: Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    writeStderr: (message) => {
      process.stderr.write(`${message}\n`);
    },
    flushStdout: () =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write('', (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/**
 * Negotiate ACP v1 or v2 from initialize, retaining SDK-owned NDJSON framing.
 * EOF or the caller's shutdown signal detaches ACP subscriptions; the app must
 * dispose its direct Host afterward. No global signal handlers, runtime fallback
 * or shutdown deadline are installed here. Diagnostics use stderr only.
 */
export async function serveAcp(options: AcpAgentOptions, io: AcpIo, signal?: AbortSignal): Promise<number> {
  let connection: acp.AgentConnection | V1Connection | undefined;
  let reader: ReadableStreamDefaultReader<acp.AnyWireMessage> | undefined;
  const close = (): void => {
    connection?.close();
    if (!connection) void reader?.cancel().catch(() => undefined);
  };
  let exitCode = 0;
  try {
    const stream = acp.ndJsonStream(io.stdout, io.stdin);
    reader = stream.readable.getReader();
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    const first = await reader.read();
    if (!first.done && !signal?.aborted) {
      const source = reader;
      let initial = true;
      const readable = new ReadableStream<acp.AnyWireMessage>({
        async pull(controller) {
          if (initial) {
            initial = false;
            controller.enqueue(first.value);
            return;
          }
          const next = await source.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: () => source.cancel(),
      });
      const message = first.value;
      const v1 =
        !Array.isArray(message) &&
        'method' in message &&
        message.method === 'initialize' &&
        'params' in message &&
        typeof message.params === 'object' &&
        message.params !== null &&
        'protocolVersion' in message.params &&
        message.params.protocolVersion === 1;
      // v1 and v2 share individual JSON-RPC frames. A batch selects v2 and
      // remains under its SDK's validation; v1 never receives a batch here.
      connection = v1
        ? createAcpV1Agent(options).connect({ writable: stream.writable, readable } as V1Stream)
        : createAcpAgent(options).connect({ writable: stream.writable, readable });
      if (signal?.aborted) close();
      await connection.closed;
    }
  } catch (error) {
    io.writeStderr(`term2 acp: ${errorMessage(error)}`);
    exitCode = 1;
  } finally {
    signal?.removeEventListener('abort', close);
    connection?.close();
    await reader?.cancel().catch(() => undefined);
    try {
      await options.backend.shutdown();
    } catch (error) {
      io.writeStderr(`term2 acp: detach failed: ${errorMessage(error)}`);
      exitCode = 1;
    }
    try {
      await io.flushStdout?.();
    } catch (error) {
      io.writeStderr(`term2 acp: stdout drain failed: ${errorMessage(error)}`);
      exitCode = 1;
    }
  }
  return exitCode;
}
