import { getProvider } from '../../providers/index.js';
import type { ApplicationCompatibilityRunner } from '../../providers/registry.js';
import type { SubagentResult } from './types.js';

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

export async function runWithProvider(providerId: string, runner: any, agent: any, input: any, options: any): Promise<any> {
  const providerDef = getProvider(providerId);
  const supportsTracingControl = providerDef?.capabilities?.supportsTracingControl ?? false;
  const effectiveOptions = { ...options };
  if (!supportsTracingControl) {
    effectiveOptions.tracingDisabled = true;
  }

  if (!runner) {
    const label = providerDef?.label || providerId;
    throw new Error(
      `${label} is configured but could not be initialized. ` +
        `Please check that all required credentials and provider settings are set.`,
    );
  }

  // Every registered provider now has an application-owned runner synthesized
  // from createStreamedModel; a missing runner is a configuration error, not a
  // silent fallback. runToCompletion settles the stream so result-shaped
  // callers (the mentor) read finalOutput/usage from a completed run. Runners
  // that only expose the live-stream run() (test fakes) are settled here.
  const compatRunner = runner as ApplicationCompatibilityRunner;
  if (typeof compatRunner.runToCompletion === 'function') {
    return compatRunner.runToCompletion(agent, input, effectiveOptions);
  }
  const liveStream = await runner.run(agent, input, effectiveOptions);
  if (liveStream?.completed) {
    return Object.assign(liveStream, await liveStream.completed);
  }
  return liveStream;
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

export const MAX_PREVIEW_LENGTH = 300;

/**
 * Condenses subagent output into a single-line, length-bounded preview: the
 * first paragraph with whitespace collapsed, ellipsised at MAX_PREVIEW_LENGTH.
 */
export function truncatePreview(text: unknown): string {
  if (typeof text !== 'string') {
    return '';
  }

  const firstParagraph =
    text
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() || '';
  if (!firstParagraph) {
    return '';
  }

  if (firstParagraph.length <= MAX_PREVIEW_LENGTH) {
    return firstParagraph;
  }

  return `${firstParagraph.slice(0, MAX_PREVIEW_LENGTH - 3)}...`;
}

/**
 * Formats a SubagentResult into the model-facing report string: status,
 * error, structured validation and diff evidence, then the full final
 * text. Used both by the get_subagent_result tool and by the completion
 * notification so the same evidence shape reaches the main agent either way.
 */
export function formatSubagentResult(result: SubagentResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.status}`);

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  // Structured validation evidence (machine-checkable, before narrative).
  if (result.validation) {
    lines.push('');
    const v = result.validation;
    lines.push(`Validation: ${v.command} → exit ${v.exitStatus}`);
    if (v.outputExcerpt) {
      const excerpt = v.outputExcerpt.length > 500 ? v.outputExcerpt.slice(-500) + '...' : v.outputExcerpt;
      lines.push(`Output excerpt: ${excerpt}`);
    }
  }

  // Structured diff stat (machine-checkable, before narrative).
  if (result.diffStat && result.diffStat.length > 0) {
    lines.push('');
    const stats = result.diffStat.map((d) => `  ${d.path} +${d.added}/-${d.deleted}`).join('\n');
    lines.push(`Diff stat:`);
    lines.push(stats);
  }

  if (result.finalText) {
    lines.push('');
    lines.push(result.finalText);
  }

  if (result.toolsUsed && result.toolsUsed.length > 0) {
    lines.push('');
    lines.push(`Tools used: ${result.toolsUsed.map((t) => `${t.toolName}(${t.count})`).join(', ')}`);
  }

  if (result.filesChanged && result.filesChanged.length > 0) {
    lines.push('');
    lines.push(`Files changed: ${result.filesChanged.join(', ')}`);
  }

  return lines.join('\n') || `Status: ${result.status}`;
}

export function createAbortError(message = 'The subagent run was aborted.'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
