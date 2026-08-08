import { getSubagentDelegationAddendum } from './subagent-delegation.js';

/** @deprecated Compatibility wrapper for callers not yet using the unified delegation prompt builder. */
export function getAsyncSubagentDelegationAddendum({
  memoryEnabled = true,
  orchestratorMode = false,
  controlsEnabled = false,
}: { memoryEnabled?: boolean; orchestratorMode?: boolean; controlsEnabled?: boolean } = {}): string {
  return getSubagentDelegationAddendum({
    memoryEnabled,
    orchestratorMode,
    foregroundEnabled: false,
    backgroundEnabled: true,
    controlsEnabled,
  });
}
