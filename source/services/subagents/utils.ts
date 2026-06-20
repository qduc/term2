import { run } from '@openai/agents';
import { getProvider } from '../../providers/index.js';

export function isAbortLike(message: string | undefined, obj?: unknown): boolean {
  if (message?.includes('abort') || message?.includes('cancel')) return true;
  const o = obj as Record<string, unknown> | undefined;
  if (o && (o['name'] === 'AbortError' || o['code'] === 'ERR_ABORTED' || o['kind'] === 'aborted')) return true;
  return false;
}

export function isToolHistoryItem(raw: any): boolean {
  const type = typeof raw?.type === 'string' ? raw.type : '';
  if (raw?.role === 'tool') return true;
  return /tool|function_call/i.test(type);
}

export function assistantText(raw: any): string | null {
  if (raw?.role !== 'assistant') return null;
  const content = raw?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => typeof c?.text === 'string')
      .map((c: any) => c.text)
      .join('');
  }
  return null;
}

export function extractFinalText(result: any): string {
  if (!result?.interruptions?.length && typeof result.finalOutput === 'string' && result.finalOutput) {
    return result.finalOutput;
  }

  if (Array.isArray(result.history)) {
    const history = result.history;
    let lastToolIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (isToolHistoryItem(history[i]?.rawItem ?? history[i])) {
        lastToolIndex = i;
        break;
      }
    }

    for (let i = history.length - 1; i > lastToolIndex; i--) {
      const text = assistantText(history[i]?.rawItem ?? history[i]);
      if (text !== null) return text;
    }

    for (let i = history.length - 1; i >= 0; i--) {
      const text = assistantText(history[i]?.rawItem ?? history[i]);
      if (text !== null) return text;
    }
  }

  return '';
}

export function runWithProvider(providerId: string, runner: any, agent: any, input: any, options: any): Promise<any> {
  const providerDef = getProvider(providerId);
  const supportsTracingControl = providerDef?.capabilities?.supportsTracingControl ?? false;
  const effectiveOptions = { ...options };
  if (!supportsTracingControl) {
    effectiveOptions.tracingDisabled = true;
  }

  if (!runner && providerId !== 'openai') {
    const label = providerDef?.label || providerId;
    throw new Error(
      `${label} is configured but could not be initialized. ` +
        `Please check that all required credentials and provider settings are set.`,
    );
  }

  return runner ? runner.run(agent, input, effectiveOptions) : run(agent, input, effectiveOptions);
}

export function aggregateToolUsage(toolCounts: Map<string, number>): Array<{ toolName: string; count: number }> {
  return Array.from(toolCounts.entries()).map(([toolName, count]) => ({ toolName, count }));
}

export function aggregateContextToolUsage(
  toolCounts: Record<string, number>,
): Array<{ toolName: string; count: number }> {
  return Object.entries(toolCounts).map(([toolName, count]) => ({ toolName, count }));
}

export function safeEmit(logger: any, onEvent: any, event: any): void {
  try {
    onEvent?.(event);
  } catch (error: any) {
    logger.debug('Subagent event emit failed', { error: error?.message });
  }
}

/**
 * Combines multiple abort signals into one signal that aborts when any source
 * aborts. Returns undefined when no signals are provided. When only one signal
 * is provided it is returned directly. The returned cleanup function removes
 * any listeners that were added to the source signals.
 */
export function createCompositeAbortSignal(
  ...signals: (AbortSignal | undefined | null)[]
): { signal: AbortSignal; cleanup: () => void } | undefined {
  const validSignals = signals.filter((signal): signal is AbortSignal => signal != null);
  if (validSignals.length === 0) {
    return undefined;
  }

  const anyAborted = validSignals.some((signal) => signal.aborted);
  if (anyAborted) {
    const controller = new AbortController();
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  if (validSignals.length === 1) {
    return { signal: validSignals[0], cleanup: () => {} };
  }

  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();

  const cleanup = (): void => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener('abort', listener);
    }
    listeners.clear();
  };

  for (const signal of validSignals) {
    const listener = (): void => {
      controller.abort();
      cleanup();
    };
    signal.addEventListener('abort', listener, { once: true });
    listeners.set(signal, listener);
  }

  return { signal: controller.signal, cleanup };
}

export function createAbortError(message = 'The subagent run was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
