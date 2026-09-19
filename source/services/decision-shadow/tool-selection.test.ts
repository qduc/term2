import { describe, expect, it, vi } from 'vitest';
import type { DecisionClient } from './decision-client.js';
import { TOOL_SELECTION_PROMPT_VERSION, evaluateToolSelection, type ToolSelectionEvidence } from './tool-selection.js';

const evidence: ToolSelectionEvidence = {
  requestId: 'req-1',
  provider: 'openrouter',
  model: 'moonshotai/kimi-k2',
  tier: 'standard',
  chaining: false,
  input: [{ type: 'message', role: 'user', content: 'Open source/cli.tsx' }],
  tools: [
    {
      id: 'direct:read_file',
      name: 'read_file',
      description: 'Read a known file',
      callPath: 'direct',
      source: 'builtin',
      parameters: { type: 'object' },
      effect: 'unspecified',
      approval: 'never',
    },
  ],
};

describe('tool-selection decision', () => {
  it('uses a versioned runtime-catalog prompt without leaking the observed selection', async () => {
    const decide = vi.fn(async (request) => ({
      answers: { case: { type: 'choice', choice: 'tool_0', confidence: 0.8 } },
      resolvedModel: request.model,
    }));
    const result = await evaluateToolSelection(decideClient(decide), '~typesafe/jev-latest', evidence);

    expect(result).toMatchObject({ selectedToolId: 'direct:read_file', confidence: 0.8 });
    const request = decide.mock.calls[0]![0];
    expect(request.state).toMatchObject({ promptVersion: TOOL_SELECTION_PROMPT_VERSION, requestId: 'req-1' });
    expect(request.questions.case.criteria).toEqual({
      tool_0: expect.stringContaining('read_file'),
      none: expect.any(String),
    });
    expect(JSON.stringify(request.state)).not.toContain('observed');
    expect(JSON.stringify(request.state)).not.toContain('selectedTool');
  });

  it('rejects choices outside the opaque runtime catalog', async () => {
    const client = decideClient(async () => ({
      answers: { case: { type: 'choice', choice: 'read_file', confidence: 1 } },
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 7,
    }));
    await expect(evaluateToolSelection(client, 'jev', evidence)).rejects.toMatchObject({
      name: 'DecisionEvaluationError',
      code: 'invalid_choice',
      resolvedModel: 'typesafe/jev-1.13',
      costUsdMicros: 7,
    });
  });
});

function decideClient(decide: DecisionClient['decide']): DecisionClient {
  return { decide };
}
