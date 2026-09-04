import type { Worker } from 'node:worker_threads';
import { isJsonValue, type JsonValue } from '../agent-runtime/workflow/workflow-types.js';
import { createSandbox } from './sandbox.js';
import {
  isCapabilityOutcome,
  type CapabilityHandler,
  type HostError,
  type HostErrorCode,
  type HostResult,
  type HostRunInput,
  type SandboxedCodeHost,
} from './host-types.js';

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs model-authored code in a disposable worker thread and brokers its calls
 * back into the harness.
 *
 * The host owns everything that is the same for every caller: worker lifecycle,
 * the wall-clock deadline, parent cancellation, code and output byte budgets,
 * console capture, per-capability admission control and concurrency permits.
 * What the code can *reach* is entirely in the capabilities it is handed —
 * `run_agent_workflow` passes `agent`, `run_code` passes `tools` — so the two
 * tools differ only in that object.
 */
export class SandboxedCodeHostImpl implements SandboxedCodeHost {
  async run(input: HostRunInput): Promise<HostResult> {
    const { limits, subject } = input;
    const failure = (code: HostErrorCode, message: string): HostResult => ({ ok: false, error: { code, message } });

    if (typeof input.code !== 'string') return failure('runtime_error', `${subject} code must be a string`);
    if (Buffer.byteLength(input.code, 'utf8') > limits.maxCodeBytes) {
      return failure('code_too_large', `${subject} code exceeds the configured size limit`);
    }

    const entries = Object.entries(input.capabilities);
    let worker: Worker;
    try {
      worker =
        input.workerFactory?.(input.code, limits.timeoutMs) ??
        createSandbox(input.code, {
          syncTimeoutMs: limits.timeoutMs,
          maxConsoleBytes: limits.maxConsoleBytes,
          subject,
          allowVoidOutput: input.allowVoidOutput,
          capabilities: entries.map(([, handler]) => handler.binding),
        });
    } catch (error) {
      return failure('sandbox_unavailable', `${subject} sandbox is unavailable: ${safeMessage(error)}`);
    }

    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      failFromParentAbort?.();
    };
    let failFromParentAbort: (() => void) | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // One admission ledger per capability: a script reading 200 files and a
    // workflow spawning 8 agents want different budgets, so they never share.
    const ledgers = new Map<string, Ledger>();
    for (const [name, handler] of entries)
      ledgers.set(
        name,
        createLedger(handler, () => settled || controller.signal.aborted),
      );
    const cancelWaiting = () => {
      for (const ledger of ledgers.values()) ledger.cancelWaiting();
    };

    const result = await new Promise<HostResult>((resolve) => {
      const finish = (value: HostResult) => {
        if (settled) return;
        settled = true;
        cancelWaiting();
        resolve(value);
      };
      const fail = (code: HostErrorCode, message: string) => finish(failure(code, message) as HostResult);
      const timeout = () => {
        controller.abort();
        fail('timeout', `${subject} exceeded its configured timeout`);
      };
      failFromParentAbort = () => fail('timeout', `${subject} was cancelled by its parent`);
      timer = setTimeout(timeout, limits.timeoutMs);
      if (input.signal?.aborted) onAbort();
      input.signal?.addEventListener('abort', onAbort, { once: true });

      let consoleBytes = 0;
      worker.on('message', async (message: any) => {
        if (settled) return;
        if (message?.type === 'console.log') {
          if (Array.isArray(message.values) && message.values.every((value: unknown) => isJsonValue(value))) {
            const size = bytes(message.values);
            if (size <= limits.maxConsoleBytes && consoleBytes + size <= limits.maxConsoleBytes) {
              consoleBytes += size;
              input.onConsole?.(message.values);
            }
          }
          return;
        }
        if (message?.type === 'workflow.complete') {
          if (!isJsonValue(message.output) || bytes(message.output) > limits.maxOutputBytes) {
            fail('invalid_output', `${subject} output must be JSON-safe and within the configured size limit`);
          } else finish({ ok: true, output: message.output });
          return;
        }
        if (message?.type === 'workflow.error') {
          const errorMessage = safeMessage(message.error?.message ?? `${subject} failed`);
          fail(
            message.syntax ? 'syntax_error' : /timed out/i.test(errorMessage) ? 'timeout' : 'runtime_error',
            errorMessage,
          );
          return;
        }
        if (typeof message?.type !== 'string' || !message.type.endsWith('.run')) return;
        const name = message.type.slice(0, -'.run'.length);
        const handler = input.capabilities[name];
        const ledger = ledgers.get(name);
        if (!handler || !ledger) return;

        const reply = (result: JsonValue) =>
          worker.postMessage({ type: `${name}.result`, requestId: message.requestId, result });

        const { type: _type, requestId: _requestId, ...payload } = message as Record<string, unknown>;
        let prepared: unknown;
        try {
          prepared = await handler.prepare(payload as Record<string, unknown>);
        } catch (error) {
          fail('runtime_error', safeMessage(error));
          return;
        }
        if (settled) return;
        if (isCapabilityOutcome(prepared)) {
          if (prepared.kind === 'fail') fail(prepared.code, prepared.message);
          else reply(prepared.result);
          return;
        }

        const admitted = ledger.admit();
        if (!admitted.ok) {
          const outcome = handler.overBudget?.();
          if (!outcome || outcome.kind === 'fail')
            fail(outcome?.code ?? 'limit_exceeded', outcome?.message ?? handler.limits.limitExceededMessage);
          else reply(outcome.result);
          return;
        }
        const callContext = { callId: admitted.callId, signal: controller.signal };
        handler.onAdmitted?.(prepared, callContext);

        const releasePermit = await ledger.acquire(handler.lane?.(prepared) ?? 'default');
        if (!releasePermit) return;
        if (settled || controller.signal.aborted) {
          releasePermit();
          return;
        }
        try {
          const outcome = await handler.invoke(prepared, callContext);
          if (outcome.kind === 'fail') fail(outcome.code, outcome.message);
          else reply(outcome.result);
        } catch (error) {
          fail('runtime_error', safeMessage(error));
        } finally {
          releasePermit();
        }
      });
      worker.once('error', (error) => fail('sandbox_unavailable', `${subject} sandbox failed: ${safeMessage(error)}`));
      worker.once('exit', (code) => {
        if (!settled) fail('sandbox_unavailable', `${subject} sandbox exited unexpectedly (${code})`);
      });
    });

    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    await worker.terminate().catch(() => undefined);
    return result;
  }
}

type Waiter = (release: (() => void) | undefined) => void;
interface Pool {
  active: number;
  limit: number;
  waiting: Waiter[];
}

interface Ledger {
  admit(): { ok: true; callId: number } | { ok: false };
  acquire(lane: 'serial' | 'default'): Promise<(() => void) | undefined>;
  cancelWaiting(): void;
}

/**
 * Admission counting and concurrency permits for one capability. A released
 * permit is handed directly to the next waiter so a settled run cannot leak it.
 */
function createLedger(handler: CapabilityHandler<any>, isDone: () => boolean): Ledger {
  let admissions = 0;
  const pools = {
    default: { active: 0, limit: handler.limits.maxConcurrency, waiting: [] as Waiter[] },
    // A lane of one: the run loop's rule that a tool which is not declared
    // parallel-safe never overlaps another such call.
    serial: { active: 0, limit: 1, waiting: [] as Waiter[] },
  };
  const grantPermit = (pool: Pool): (() => void) => {
    pool.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pool.active--;
      const waiter = pool.waiting.shift();
      if (waiter) waiter(grantPermit(pool));
    };
  };
  return {
    admit() {
      admissions++;
      if (admissions > handler.limits.maxCalls) return { ok: false };
      return { ok: true, callId: admissions };
    },
    async acquire(lane) {
      if (isDone()) return undefined;
      const pool = pools[lane];
      if (pool.active < pool.limit) return grantPermit(pool);
      return new Promise<(() => void) | undefined>((resolve) => pool.waiting.push(resolve));
    },
    cancelWaiting() {
      for (const pool of Object.values(pools)) for (const waiter of pool.waiting.splice(0)) waiter(undefined);
    },
  };
}

export type { HostError, HostResult };
