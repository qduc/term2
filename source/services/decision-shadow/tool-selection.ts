import type { ServiceTier } from '../cost/model-cost.js';
import type { CallableToolDescriptor } from './callable-tool-catalog.js';
import { readDecisionChoice, withDecisionResponseMetadata, type DecisionClient } from './decision-client.js';

export const TOOL_SELECTION_PROMPT_VERSION = 'tool-selection-v2-runtime-catalog' as const;

export type ToolSelectionEvidence = {
  readonly requestId: string;
  readonly provider?: string;
  readonly model: string;
  readonly tier: ServiceTier;
  readonly chaining: boolean;
  readonly input: readonly unknown[];
  readonly tools: readonly CallableToolDescriptor[];
};

export type ToolSelectionPrediction = {
  readonly selectedToolId?: string;
  readonly confidence: number;
  readonly requestedModel: string;
  readonly resolvedModel?: string;
  readonly costUsdMicros?: number;
};

const INSTRUCTIONS =
  'Pick the listed executable capability whose job best matches the latest request. Each choice token maps to one actual direct or run_code capability in state.tools. Choose none when the request needs no tool, is vague, or the capability is absent. Prefer a specialized capability over a general process or scripting capability when both fit. Predict only the primary first logical capability; do not infer an arbitrary multi-tool plan.';

export async function evaluateToolSelection(
  client: DecisionClient,
  model: string,
  evidence: ToolSelectionEvidence,
): Promise<ToolSelectionPrediction> {
  const tokenToId = new Map<string, string>();
  const criteria: Record<string, string> = {};
  evidence.tools.forEach((tool, index) => {
    const token = `tool_${index}`;
    tokenToId.set(token, tool.id);
    criteria[token] = `${tool.name} via ${tool.callPath} (${tool.source}): ${tool.description}`;
  });
  criteria.none = 'No listed executable capability should be selected for the latest request.';
  const response = await client.decide({
    model,
    state: {
      promptVersion: TOOL_SELECTION_PROMPT_VERSION,
      requestId: evidence.requestId,
      request: {
        provider: evidence.provider,
        model: evidence.model,
        tier: evidence.tier,
        chaining: evidence.chaining,
        input: evidence.input,
      },
      tools: evidence.tools,
    },
    questions: { case: { type: 'choice', instructions: INSTRUCTIONS, criteria } },
  });
  const allowed = [...tokenToId.keys(), 'none'] as string[];
  let answer: ReturnType<typeof readDecisionChoice<string>>;
  try {
    answer = readDecisionChoice(response.answers, 'case', allowed);
  } catch (error) {
    throw withDecisionResponseMetadata(error, 'invalid_choice', response);
  }
  return {
    ...(answer.choice === 'none' ? {} : { selectedToolId: tokenToId.get(answer.choice)! }),
    confidence: answer.confidence,
    requestedModel: model,
    ...(response.resolvedModel ? { resolvedModel: response.resolvedModel } : {}),
    ...(response.costUsdMicros !== undefined ? { costUsdMicros: response.costUsdMicros } : {}),
  };
}
