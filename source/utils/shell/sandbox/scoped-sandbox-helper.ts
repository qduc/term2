import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';

let key: string | undefined;
let nextAsk = 0;
const asks = new Map<number, (allowed: boolean) => void>();
const wrapping = new Map<number, AbortController>();
const send = (value: Record<string, unknown>) => {
  if (process.connected) process.send?.({ version: 1, ...value });
};
process.on('disconnect', () => {
  for (const resolve of asks.values()) resolve(false);
  void SandboxManager.reset().finally(() => process.exit(1));
});
process.on('message', async (message: any) => {
  if (!message || message.version !== 1 || !Number.isSafeInteger(message.id) || message.id < 1) {
    process.disconnect?.();
    return;
  }
  const keys: Record<string, string[]> = {
    abort: ['version', 'type', 'id'],
    answer: ['version', 'type', 'id', 'allowed'],
    availability: ['version', 'type', 'id'],
    wrap: ['version', 'type', 'id', 'cwd', 'config', 'command'],
    cleanup: ['version', 'type', 'id'],
    annotate: ['version', 'type', 'id', 'command', 'stderr'],
    dispose: ['version', 'type', 'id'],
  };
  if (!(message.type in keys) || Object.keys(message).some((key) => !keys[message.type]!.includes(key))) {
    process.disconnect?.();
    return;
  }
  if (message?.type === 'abort') {
    wrapping.get(message.id)?.abort();
    return;
  }
  if (message?.type === 'answer') {
    if (typeof message.allowed !== 'boolean' || !asks.has(message.id)) {
      process.disconnect?.();
      return;
    }
    asks.get(message.id)?.(message.allowed === true);
    asks.delete(message.id);
    return;
  }
  const { id, type } = message ?? {};
  try {
    let result: unknown;
    if (type === 'availability') {
      const check = SandboxManager.checkDependencies();
      result = !SandboxManager.isSupportedPlatform()
        ? { type: 'unsupported_platform', reason: 'Sandbox runtime does not support this platform.' }
        : check.errors.length
        ? { type: 'missing_dependency', reason: check.errors.join('; ') }
        : { type: 'available' };
    } else if (type === 'wrap') {
      if (
        typeof message.command !== 'string' ||
        typeof message.cwd !== 'string' ||
        !message.config ||
        typeof message.config !== 'object'
      )
        throw new Error('Invalid wrap request');
      const abort = new AbortController();
      wrapping.set(id, abort);
      const config = message.config as SandboxRuntimeConfig;
      const nextKey = JSON.stringify({ cwd: message.cwd, config });
      if (key !== nextKey) {
        if (key) await SandboxManager.reset();
        await SandboxManager.initialize(
          config,
          ({ host, port }) =>
            new Promise<boolean>((resolve) => {
              const askId = ++nextAsk;
              asks.set(askId, resolve);
              send({ type: 'ask', id: askId, host, port });
            }),
        );
        key = nextKey;
        send({
          type: 'bridges',
          id,
          http: SandboxManager.getLinuxHttpSocketPath(),
          socks: SandboxManager.getLinuxSocksSocketPath(),
        });
      }
      result = {
        command: await SandboxManager.wrapWithSandbox(message.command, undefined, undefined, abort.signal),
        diagnostics: SandboxManager.getLinuxGlobPatternWarnings?.() ?? [],
      };
    } else if (type === 'cleanup') {
      SandboxManager.cleanupAfterCommand();
    } else if (type === 'annotate') {
      if (typeof message.command !== 'string' || typeof message.stderr !== 'string')
        throw new Error('Invalid annotate request');
      result = SandboxManager.annotateStderrWithSandboxFailures(message.command, message.stderr);
    } else if (type === 'dispose') {
      await SandboxManager.reset();
      send({ type: 'result', id });
      process.disconnect?.();
      return;
    } else throw new Error('Unknown helper operation');
    send({ type: 'result', id, result });
  } catch (error) {
    send({ type: 'result', id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    wrapping.delete(id);
  }
});
