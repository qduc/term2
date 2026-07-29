import { isDeepStrictEqual } from 'node:util';
import type { ProviderHistorySnapshot } from '../services/conversation/conversation-store.js';
import { filterChainedModelInput, type ChainedModelInputFilterOptions } from '../lib/chained-input-filter.js';

export type OpenAIChainedInputCompatibilityOptions = ChainedModelInputFilterOptions & {
  previousResponseId?: string | null;
};

export type OpenAIChainedInputPrefixEvidence =
  | {
      kind: 'match';
      snapshotIdentity: string;
      snapshotItemCount: number;
      modelInputItemCount: number;
      currentTurnSuffix: readonly unknown[];
    }
  | {
      kind: 'mismatch';
      snapshotIdentity: string;
      snapshotItemCount: number;
      modelInputItemCount: number;
      matchedPrefixItems: number;
      mismatchIndex: number;
    };

export type OpenAIChainedInputCompatibilityProjection = {
  prefix: OpenAIChainedInputPrefixEvidence;
  projectedModelData?: any;
  projectedInput?: unknown;
  error?: { name: string; message: string; callIds?: readonly string[] };
};

const prefixEvidence = (snapshot: ProviderHistorySnapshot, modelInput: unknown): OpenAIChainedInputPrefixEvidence => {
  const input = Array.isArray(modelInput) ? modelInput : [];
  const history = snapshot.history;
  const sharedLength = Math.min(history.length, input.length);
  for (let index = 0; index < sharedLength; index++) {
    if (!isDeepStrictEqual(history[index], input[index])) {
      return {
        kind: 'mismatch',
        snapshotIdentity: snapshot.identity,
        snapshotItemCount: history.length,
        modelInputItemCount: input.length,
        matchedPrefixItems: index,
        mismatchIndex: index,
      };
    }
  }

  if (input.length < history.length) {
    return {
      kind: 'mismatch',
      snapshotIdentity: snapshot.identity,
      snapshotItemCount: history.length,
      modelInputItemCount: input.length,
      matchedPrefixItems: sharedLength,
      mismatchIndex: sharedLength,
    };
  }

  return {
    kind: 'match',
    snapshotIdentity: snapshot.identity,
    snapshotItemCount: history.length,
    modelInputItemCount: input.length,
    currentTurnSuffix: input.slice(history.length),
  };
};

/**
 * OpenAI's private Stage 1 compatibility projection. It intentionally reuses
 * the established pure filter while recording the authoritative-history anchor
 * needed for the later ownership switch.
 */
export const projectOpenAIChainedModelInput = (
  snapshot: ProviderHistorySnapshot,
  modelData: any,
  options: OpenAIChainedInputCompatibilityOptions = {},
): OpenAIChainedInputCompatibilityProjection => {
  const prefix = prefixEvidence(snapshot, modelData?.input);
  try {
    const projectedModelData = filterChainedModelInput(modelData, options);
    return { prefix, projectedModelData, projectedInput: projectedModelData?.input };
  } catch (error) {
    const record = error as { name?: unknown; message?: unknown; callIds?: unknown };
    return {
      prefix,
      error: {
        name: typeof record?.name === 'string' ? record.name : 'Error',
        message: typeof record?.message === 'string' ? record.message : String(error),
        ...(Array.isArray(record?.callIds) ? { callIds: record.callIds as string[] } : {}),
      },
    };
  }
};
