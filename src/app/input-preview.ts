/**
 * App-only advisory projection over the owning Session's native request snapshot.
 * No log reads, mirrored history, writes, provider calls or admission authority.
 */
import { isEffortUpdateItem } from '../model/effort-updates.js';
import type { StreamedModelTurnInput } from '../model/streamed-model-turn.js';
import { InputSurgeGuard } from '../session/input-surge-guard.js';
import { getSerializedInputBytes, LargeUncachedInputGuard } from '../session/large-uncached-input-guard.js';
import { itemToInput } from '../model/provider-items.js';
import type {
  DirectInputPreviewDecisions,
  DirectInputPreviewOptions,
  DirectInputPreviewRequest,
  DirectInputPreviewResult,
  DirectInputPreviewSnapshot,
} from './input-preview-types.js';

export type * from './input-preview-types.js';
export { readDirectInputPreviewConfiguration } from './input-preview-settings.js';

/** No state is retained: accepted Session state is authoritative on every call. */
export function createDirectInputPreview(options: DirectInputPreviewOptions): {
  inspect(request: DirectInputPreviewRequest): Promise<DirectInputPreviewDecisions>;
  preview(request: DirectInputPreviewRequest): Promise<DirectInputPreviewResult>;
} {
  const inspect = async (request: DirectInputPreviewRequest): Promise<DirectInputPreviewDecisions> => {
    const snapshot = await options.snapshot(request);
    return inspectDirectInputPreview(snapshot, options.now?.() ?? Date.now());
  };
  return {
    inspect,
    async preview(request) {
      return directInputPreviewResult(await inspect(request));
    },
  };
}

/** Existing guard policy and defaults, primed only from real lifecycle evidence. */
export function inspectDirectInputPreview(
  snapshot: DirectInputPreviewSnapshot,
  now = Date.now(),
): DirectInputPreviewDecisions {
  // Reuse the provider adapter's lossless mapping, including images, raw tool
  // arguments, structured results and opaque items. Do not size UI messages.
  const outgoing = snapshot.input.map(itemToInput);
  const surge = new InputSurgeGuard().inspect(
    outgoing.map((item, index) => surgeItem(item, snapshot.toolOccurrences[index])),
    { kind: snapshot.kind, preview: true },
  );
  const inputSurge = {
    ...surge,
    // Occurrence evidence is guard-only metadata, never provider payload bytes.
    stats: { ...surge.stats, totalSerializedBytes: getSerializedInputBytes(outgoing) },
  };
  if (inputSurge.action === 'block' || snapshot.queueActive) {
    return { inputSurge, largeUncachedInput: null };
  }

  const large = new LargeUncachedInputGuard();
  if (snapshot.lastSuccessful) {
    large.recordSuccessfulInput({ ...snapshot.lastSuccessful, now: snapshot.lastSuccessful.completedAt });
  } else if (snapshot.resumed) {
    large.markResumedSession(snapshot.resumed);
  }
  if (snapshot.rewoundSinceSuccess) large.markUndoOrRewind();
  return {
    inputSurge,
    largeUncachedInput: large.inspect({
      input: outgoing,
      now,
      ...snapshot.configuration,
      // A marker means the request carries the effort change as cache-preserving input.
      reasoningEffortCachePreserved: snapshot.input.some(isEffortUpdateItem),
    }),
  };
}

/** Surge confirmation precedes the idle-only large-input advisory, as in source. */
export function directInputPreviewResult(decisions: DirectInputPreviewDecisions): DirectInputPreviewResult {
  if (decisions.inputSurge.action === 'block') {
    return {
      requiresConfirmation: true,
      notices: [{ kind: 'input_surge', message: decisions.inputSurge.reason ?? 'Input surge detected' }],
    };
  }
  const large = decisions.largeUncachedInput;
  if (large?.action === 'warn') {
    return {
      requiresConfirmation: true,
      notices: [
        {
          kind: 'large_uncached_input',
          estimatedTokens: large.estimatedTokens,
          message: `Large uncached input (~${large.estimatedTokens.toLocaleString(
            'en-US',
          )} estimated tokens); confirmation required (${large.reasons.join(', ')}).`,
        },
      ],
    };
  }
  return { requiresConfirmation: false, notices: [] };
}

/**
 * Streamed input uses id/name while the existing guard recognizes canonical
 * callId/toolName. Adapt only that vocabulary and attach accepted occurrence
 * evidence. Untagged items keep the existing legacy heuristic.
 */
function surgeItem(
  item: StreamedModelTurnInput,
  occurrence: DirectInputPreviewSnapshot['toolOccurrences'][number] | undefined,
): unknown {
  switch (item.type) {
    case 'tool_call':
      return { ...item, callId: item.id, toolName: item.name, ...occurrence };
    case 'tool_result':
      return { ...item, callId: item.id, toolName: 'unknown', ...occurrence };
    default:
      return occurrence ? { ...item, ...occurrence } : item;
  }
}
