import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxAvailability, ShellSandboxRunner } from './sandbox-policy.js';
import type { ScopedSandboxNetworkAccess } from './scoped-sandbox-network-access.js';
import { isSandboxNetworkHost, isSandboxNetworkPort } from './sandbox-network-validation.js';

const hasOnly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function assertSerializable(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || value === undefined)
    throw new Error('Unsupported sandbox configuration value');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Unsupported sandbox configuration number');
  if (value && typeof value === 'object') {
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error('Unsupported sandbox configuration object');
    if (seen.has(value)) throw new Error('Cyclic sandbox configuration');
    seen.add(value);
    for (const child of Object.values(value)) assertSerializable(child, seen);
    seen.delete(value);
  }
}

/** One manager process and lease belong to one application graph. */
export class ScopedSandboxRunner implements ShellSandboxRunner {
  #child: ChildProcess | undefined;
  #pending = new Map<number, { type: string; resolve(value: any): void; reject(error: Error): void }>();
  #next = 0;
  #lastAskId = 0;
  #lease: Promise<void> = Promise.resolve();
  #closed = false;
  #lost = false;
  #disposing = false;
  #disposePromise: Promise<void> | undefined;
  constructor(
    private readonly network: ScopedSandboxNetworkAccess,
    private readonly onLost: () => void,
    private readonly onExecutionEnded: () => Promise<void>,
    private readonly entry = new URL('./scoped-sandbox-helper.js', import.meta.url),
  ) {}
  #start(): ChildProcess {
    if (this.#closed || this.#lost) throw new Error('Sandbox helper unavailable');
    if (this.#child) return this.#child;
    const helperTemp = mkdtempSync(join(tmpdir(), 'term2-sandbox-helper-'));
    let child: ChildProcess;
    try {
      child = fork(this.entry, [], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          TMPDIR: helperTemp,
          ...(process.platform === 'win32' ? { TEMP: helperTemp, TMP: helperTemp } : {}),
        },
      });
    } catch (error) {
      rmSync(helperTemp, { recursive: true, force: true });
      throw error;
    }
    this.#child = child;
    const lost = () => {
      if (this.#lost) return;
      this.#lost = true;
      // Linux bridge processes inherit the helper's private process group.
      // A helper killed unexpectedly cannot run SandboxManager.reset itself.
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      try {
        rmSync(helperTemp, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
      for (const pending of this.#pending.values()) pending.reject(new Error('Sandbox helper lost'));
      this.#pending.clear();
      this.network.dispose(this.#disposing ? 'closed' : 'helper_lost');
      if (!this.#disposing && !this.#closed) this.onLost();
    };
    child.on('error', lost);
    child.on('exit', lost);
    child.on('disconnect', lost);
    child.on('message', (message: any) => {
      if (!message || message.version !== 1 || !Number.isSafeInteger(message.id) || message.id < 1) {
        child.kill('SIGKILL');
        return;
      }
      if (message?.type === 'ask') {
        if (
          !hasOnly(message, ['version', 'type', 'id', 'host', 'port']) ||
          !isSandboxNetworkHost(message.host) ||
          (message.port !== undefined && !isSandboxNetworkPort(message.port)) ||
          message.id <= this.#lastAskId
        ) {
          child.kill('SIGKILL');
          return;
        }
        this.#lastAskId = message.id;
        void this.network.request({ host: message.host, port: message.port }).then((allowed) => {
          try {
            if (child.connected) child.send({ version: 1, type: 'answer', id: message.id, allowed }, () => {});
          } catch {
            child.kill('SIGKILL');
          }
        });
      } else if (message?.type === 'bridges') {
        const pending = this.#pending.get(message.id);
        const paths = [message.http, message.socks];
        if (
          pending?.type !== 'wrap' ||
          !hasOnly(message, ['version', 'type', 'id', 'http', 'socks']) ||
          paths.some(
            (path) =>
              path !== undefined &&
              (typeof path !== 'string' ||
                dirname(path) !== helperTemp ||
                !/^claude-(http|socks)-[a-f0-9]{16}\.sock$/.test(basename(path))),
          )
        ) {
          child.kill('SIGKILL');
          return;
        }
      } else if (message?.type === 'result') {
        const pending = this.#pending.get(message.id);
        if (
          !pending ||
          !hasOnly(message, ['version', 'type', 'id', 'result', 'error']) ||
          (message.error !== undefined && (typeof message.error !== 'string' || Object.hasOwn(message, 'result')))
        ) {
          child.kill('SIGKILL');
          return;
        }
        const result = message.result;
        const validResult =
          pending.type === 'wrap'
            ? Boolean(
                result &&
                  typeof result === 'object' &&
                  hasOnly(result, ['command', 'diagnostics']) &&
                  typeof result.command === 'string' &&
                  (result.diagnostics === undefined ||
                    (Array.isArray(result.diagnostics) &&
                      result.diagnostics.every((item: unknown) => typeof item === 'string'))),
              )
            : pending.type === 'annotate'
            ? typeof result === 'string'
            : pending.type === 'availability'
            ? Boolean(
                result &&
                  typeof result === 'object' &&
                  hasOnly(result, ['type', 'reason']) &&
                  ['available', 'unsupported_platform', 'missing_dependency', 'initialization_failed'].includes(
                    result.type,
                  ) &&
                  (result.type === 'available' || typeof result.reason === 'string'),
              )
            : result === undefined;
        if (message.error === undefined && !validResult) {
          child.kill('SIGKILL');
          return;
        }
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } else {
        child.kill('SIGKILL');
      }
    });
    return child;
  }
  #call(type: string, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    const child = this.#start();
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        try {
          if (child.connected) child.send({ version: 1, type: 'abort', id }, () => {});
        } catch {
          child.kill('SIGKILL');
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, {
        type,
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
      try {
        child.send({ version: 1, type, id, ...fields }, (error) => {
          if (error) {
            this.#pending.delete(id);
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          }
        });
      } catch (error) {
        this.#pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
      if (signal?.aborted) onAbort();
    });
  }
  availability(): Promise<SandboxAvailability> {
    return this.#call('availability');
  }
  async acquire(): Promise<() => void> {
    const previous = this.#lease;
    let release!: () => void;
    this.#lease = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }
  async wrap(command: string, options: { cwd: string; config?: SandboxRuntimeConfig; signal?: AbortSignal }) {
    if (!options.config) throw new Error('Scoped sandbox requires explicit configuration');
    assertSerializable(options.config);
    if (options.signal?.aborted) throw new Error('Sandbox wrapping cancelled');
    return await this.#call('wrap', { command, cwd: options.cwd, config: options.config }, options.signal);
  }
  async cleanupAfterCommand(): Promise<void> {
    try {
      await this.onExecutionEnded();
    } finally {
      this.network.cancelAll('cancelled');
      if (!this.#lost && !this.#closed) await this.#call('cleanup');
    }
  }
  async annotateFailure(command: string, stderr: string): Promise<string> {
    return await this.#call('annotate', { command, stderr });
  }
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposing = true;
    this.network.dispose('closed');
    this.#disposePromise = (async () => {
      if (this.#child && !this.#lost) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.#call('dispose'),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                this.#child?.kill('SIGKILL');
                reject(new Error('Sandbox helper disposal timed out'));
              }, 5000);
            }),
          ]);
        } catch {
          /* fail closed */
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      this.#closed = true;
      this.#child?.kill('SIGKILL');
    })();
    return this.#disposePromise;
  }
}
