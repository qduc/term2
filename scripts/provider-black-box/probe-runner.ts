import type { StreamedModelTurn, StreamedModelTurnRequest } from '../../src/model/streamed-model-turn.js';
import type { ProbeScenario } from './probe-scenarios.js';
import { fixtureRequest } from './provider-wire-fixtures.js';

/**
 * Drives the scripted tool-continuation probe (plan D3) through a registry model: the prompt, the model's
 * tool call, then the tool result and the follow-up in a second request. `provider:record` uses it for live
 * recordings and the WebSocket replay test uses it to replay one, so a replay sends exactly what the
 * recording sent. Two model requests per run.
 */
export type ProbeRunOptions = {
  /** The built-in `openai` Responses adapter takes the structured tool result; Codex, the AI SDK and chat adapters take its JSON text. */
  structuredToolResult: boolean;
  /** Request fields the CLI would add for this provider (Codex: `instructions`, `codex.include`). */
  requestExtras?: Partial<StreamedModelTurnRequest>;
};

export type ProbeRunResult = { firstEvents: any[]; secondEvents: any[] };

/** Codex's request fields, as the CLI sends them: an instruction string and the provider's default `include`. */
export const codexProbeInstructions =
  'You are a recording probe for a test fixture. Follow the user request exactly and keep answers short.';

/**
 * The probe options `provider:record` uses for a built-in provider. A replay must use the same ones, or the
 * request it sends differs from the recorded one. `include` is the provider's `defaultModelSettings().include`.
 */
export function probeRunOptionsFor(providerId: string, include?: readonly string[], typed = false): ProbeRunOptions {
  return {
    // Codex's turn converter takes a tool result as text or content parts, like the AI SDK adapters.
    structuredToolResult: providerId === 'openai' && !typed,
    ...(providerId === 'codex'
      ? { requestExtras: { instructions: codexProbeInstructions, codex: { include: [...(include ?? [])] } } }
      : {}),
  };
}

export async function runToolContinuationProbe(
  model: StreamedModelTurn,
  scenario: ProbeScenario,
  options: ProbeRunOptions,
): Promise<ProbeRunResult> {
  const initial = {
    ...fixtureRequest,
    ...options.requestExtras,
    input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: scenario.prompt }] }],
  } as any;
  const firstEvents: any[] = [];
  for await (const event of model.stream(initial)) firstEvents.push(event);
  const call =
    firstEvents.find((event) => event.type === 'tool_call') ??
    firstEvents
      .flatMap((event) => event.output ?? [])
      .find((item: any) => item.type === 'tool_call' || item.type === 'function_call');
  if (!call) throw new Error('Probe model did not produce the required fixture tool call');
  const callId = call.id ?? call.callId;
  const continuation = {
    ...initial,
    input: [
      ...initial.input,
      { type: 'tool_call', id: callId, name: call.name, arguments: call.arguments },
      {
        type: 'tool_result',
        id: callId,
        // AI SDK providers accept text/content parts for tool results, while
        // OpenAI Responses accepts the structured probe value directly.
        output: options.structuredToolResult ? scenario.toolResult : JSON.stringify(scenario.toolResult),
      },
      { type: 'message', role: 'user', content: [{ type: 'text', text: scenario.followUp }] },
    ],
  };
  const secondEvents: any[] = [];
  for await (const event of model.stream(continuation)) secondEvents.push(event);
  return { firstEvents, secondEvents };
}
