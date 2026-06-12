import type { ILoggingService } from '../service-interfaces.js';
import { asRecord, getCallIdFromObject, getString } from '../interruption-info.js';

export type ToolOwner =
  | { kind: 'parent' }
  | {
      kind: 'subagent';
      agentId: string;
      role: string;
    };

export const PARENT_TOOL_OWNER: ToolOwner = { kind: 'parent' };

const getSerializedInterruptions = (serializedState: unknown): unknown[] => {
  const state = asRecord(serializedState);
  const currentStep = asRecord(state?.currentStep);
  const data = asRecord(currentStep?.data);
  return Array.isArray(data?.interruptions) ? data.interruptions : [];
};

const getSerializedSubagentOwner = (serializedState: unknown): ToolOwner | null => {
  const state = asRecord(serializedState);
  const contextEnvelope = asRecord(state?.context);
  const context = asRecord(contextEnvelope?.context);
  const agentId = getString(context, 'agentId');
  const role = getString(context, 'role');
  return agentId && role ? { kind: 'subagent', agentId, role } : null;
};

export const resolveToolOwner = (state: unknown, interruption: unknown, logger?: ILoggingService): ToolOwner => {
  const interruptionCallId = getCallIdFromObject(interruption);
  if (!interruptionCallId) {
    return PARENT_TOOL_OWNER;
  }

  const stateRecord = asRecord(state);
  if (!stateRecord || !('_pendingAgentToolRuns' in stateRecord)) {
    logger?.warn(
      'SDK field _pendingAgentToolRuns is absent from agent state — nested tool ownership will default to parent.',
    );
    return PARENT_TOOL_OWNER;
  }

  const pendingRuns = stateRecord._pendingAgentToolRuns;
  if (!(pendingRuns instanceof Map)) {
    logger?.warn('SDK field _pendingAgentToolRuns is not a Map — nested tool ownership will default to parent.');
    return PARENT_TOOL_OWNER;
  }

  for (const serializedRun of pendingRuns.values()) {
    if (typeof serializedRun !== 'string') {
      logger?.warn('Pending nested agent state is not serialized JSON — ignoring it for tool ownership.');
      continue;
    }

    let nestedState: unknown;
    try {
      nestedState = JSON.parse(serializedRun);
    } catch {
      logger?.warn('Pending nested agent state contains invalid JSON — ignoring it for tool ownership.');
      continue;
    }

    const ownsInterruption = getSerializedInterruptions(nestedState).some(
      (candidate) => getCallIdFromObject(candidate) === interruptionCallId,
    );
    if (!ownsInterruption) {
      continue;
    }

    const owner = getSerializedSubagentOwner(nestedState);
    if (owner) {
      return owner;
    }

    logger?.warn('Matching nested agent state has no agentId or role — tool ownership will default to parent.');
    return PARENT_TOOL_OWNER;
  }

  return PARENT_TOOL_OWNER;
};
