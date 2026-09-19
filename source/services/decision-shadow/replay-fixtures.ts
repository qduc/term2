import { createReadFileToolDefinition } from '../../tools/file/read-file.js';
import { snapshotCallableToolCatalog } from './callable-tool-catalog.js';
import { buildFailureObservation } from './failure-observation.js';
import type { ToolSelectionRequestObservation } from './decision-shadow-observer.js';
import type { FailureTriageEvidence, FailureTriagePrediction } from './failure-triage.js';
import type { ToolSelectionEvidence } from './tool-selection.js';

export type ToolSelectionReplayFixture = {
  readonly id: string;
  readonly evidence: ToolSelectionEvidence;
  readonly expectedToolId?: string;
};
export type FailureTriageReplayFixture = {
  readonly id: string;
  readonly evidence: FailureTriageEvidence;
  readonly expected: Pick<FailureTriagePrediction, 'category' | 'retry'>;
};

/** Accept the factory-built tools from the observed agent, not a hand-maintained catalog. */
export function buildToolSelectionReplayFixture(
  id: string,
  observation: ToolSelectionRequestObservation,
  expectedToolId?: string,
): ToolSelectionReplayFixture {
  return {
    id,
    evidence: {
      ...observation,
      input: structuredClone(observation.input),
      tools: structuredClone(snapshotCallableToolCatalog(observation.tools)),
    },
    expectedToolId,
  };
}

// Synthetic direct-only graph, using the real read_file definition. Factory
// integration coverage separately checks the root run_code graph end to end.
export const TOOL_SELECTION_REPLAY_FIXTURES: readonly ToolSelectionReplayFixture[] = [
  buildToolSelectionReplayFixture(
    'tool-selection-v2-known-file',
    {
      requestId: 'replay-tool-1',
      provider: 'openrouter',
      model: 'fixture-model',
      tier: 'standard',
      chaining: false,
      input: [{ type: 'message', role: 'user', content: 'Open source/cli.tsx and summarize its banner.' }],
      tools: [createReadFileToolDefinition({})],
    },
    'direct:read_file',
  ),
];
export const FAILURE_TRIAGE_REPLAY_FIXTURES: readonly FailureTriageReplayFixture[] = [
  {
    id: 'failure-triage-v2-rate-limit',
    evidence: buildFailureObservation(
      Object.assign(new Error('Provider returned HTTP 429 with retry-after.'), { status: 429, retryAfterMs: 2000 }),
      {
        requestId: 'replay-failure-1',
        provider: 'openrouter',
        model: 'fixture-model',
        tier: 'standard',
      },
    ).evidence,
    expected: { category: 'TRANSIENT_PROVIDER', retry: 'RETRY' },
  },
];
