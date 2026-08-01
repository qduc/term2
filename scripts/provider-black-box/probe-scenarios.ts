export type ProbeScenario = {
  id: string;
  description: string;
  prompt: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  toolResult: unknown;
  followUp: string;
};

export const probeScenarios: Record<string, ProbeScenario> = {
  'tool-continuation-v1': {
    id: 'tool-continuation-v1',
    description: 'Deterministic user request, harmless fixture tool call, result, and final answer.',
    prompt: 'Use the fixture tool and then summarize its result.',
    toolName: 'fixture',
    toolArguments: { a: 1 },
    toolResult: { ok: true, value: 1 },
    followUp: 'The fixture tool returned its deterministic result. Give the final summary.',
  },
};

export function getProbeScenario(id: string): ProbeScenario {
  const scenario = probeScenarios[id];
  if (!scenario)
    throw new Error(`Unknown probe scenario '${id}'. Available: ${Object.keys(probeScenarios).join(', ')}`);
  return scenario;
}
