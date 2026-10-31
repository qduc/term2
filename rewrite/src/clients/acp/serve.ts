import { Readable, Writable } from 'node:stream';
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
 * Serve ACP v2 NDJSON using the same SDK/framing as the existing executable.
 * EOF or the caller's shutdown signal detaches ACP subscriptions; the app must
 * dispose its direct Host afterward. No global signal handlers, runtime fallback
 * or shutdown deadline are installed here. Diagnostics use stderr only.
 */
export async function serveAcp(options: AcpAgentOptions, io: AcpIo, signal?: AbortSignal): Promise<number> {
  let connection: acp.AgentConnection | undefined;
  const close = (): void => {
    connection?.close();
  };
  let exitCode = 0;
  try {
    connection = createAcpAgent(options).connect(acp.ndJsonStream(io.stdout, io.stdin));
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    await connection.closed;
  } catch (error) {
    io.writeStderr(`term2 acp: ${errorMessage(error)}`);
    exitCode = 1;
  } finally {
    signal?.removeEventListener('abort', close);
    connection?.close();
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
