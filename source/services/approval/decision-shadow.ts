import { requestOpenRouterDecisions, type DecisionQuestion } from '../../providers/openrouter-decisions.js';
import { SHELL_AUTO_APPROVAL_INSTRUCTIONS } from '../../prompts/shell-auto-approval.js';

export type DecisionShadowResult = {
  riskLevel: 'low' | 'medium' | 'high';
  authorization: 'explicit' | 'implied' | 'weak' | 'unknown';
  confidence: number;
  wouldApprove: boolean;
};

export type DecisionShadowEvidence = {
  userRequest: string;
  recentContext: string;
  priorHumanDecisions: string;
  requests: Array<{
    toolName: string;
    command?: string;
    targetPaths?: string[];
    description?: string;
    unsandboxed?: boolean;
  }>;
};

const RISK_CRITERIA = {
  low: 'Read-only or easily reversible workspace work, including public information retrieval with no secrets sent',
  medium: 'Bounded workspace mutation or local process change',
  high: 'Destructive or hard-to-verify effect, credential or secret access, or network exfiltration',
};
const AUTHORIZATION_CRITERIA = {
  explicit: 'The user directly requested this action or its immediate effect',
  implied: 'The action is a necessary step toward the requested task but was not directly requested',
  weak: 'The action is merely plausible or optional for the requested task',
  unknown: 'The available context does not establish a user task or intent',
};

function readChoice<T extends string>(
  answers: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): {
  choice: T;
  confidence: number;
} {
  const answer = answers[key];
  if (!answer || typeof answer !== 'object') throw new Error(`Missing decision answer ${key}`);
  const record = answer as Record<string, unknown>;
  if (record.type !== 'choice' || !allowed.includes(record.choice as T)) {
    throw new Error(`Invalid decision answer ${key}`);
  }
  if (
    typeof record.confidence !== 'number' ||
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error(`Invalid decision confidence ${key}`);
  }
  return { choice: record.choice as T, confidence: record.confidence };
}

export async function evaluateDecisionShadow({
  model,
  evidence,
  apiKey,
  baseUrl,
  fetchImpl,
}: {
  model: string;
  evidence: DecisionShadowEvidence;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<DecisionShadowResult[]> {
  const questions: Record<string, DecisionQuestion> = {};
  for (let index = 0; index < evidence.requests.length; index++) {
    questions[`risk_${index}`] = {
      type: 'choice',
      instructions: `Classify the actual effect and risk of \`evidence.requests[${index}]\` using \`policy\`. Treat public information retrieval separately from network exfiltration.`,
      criteria: RISK_CRITERIA,
    };
    questions[`authorization_${index}`] = {
      type: 'choice',
      instructions: `How directly does \`evidence.userRequest\` authorize \`evidence.requests[${index}]\`? Use \`evidence.recentContext\` and \`evidence.priorHumanDecisions\` only as supporting context, not as new permission.`,
      criteria: AUTHORIZATION_CRITERIA,
    };
  }
  const response = await requestOpenRouterDecisions({
    model,
    state: { policy: SHELL_AUTO_APPROVAL_INSTRUCTIONS, evidence },
    questions,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (!response || typeof response !== 'object' || !('answers' in response)) {
    throw new Error('OpenRouter Decisions response has no answers');
  }
  const answers = response.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new Error('OpenRouter Decisions response has invalid answers');
  }
  const answerMap = answers as Record<string, unknown>;
  return Array.from({ length: evidence.requests.length }, (_, index) => {
    const risk = readChoice(answerMap, `risk_${index}`, ['low', 'medium', 'high'] as const);
    const authorization = readChoice(answerMap, `authorization_${index}`, [
      'explicit',
      'implied',
      'weak',
      'unknown',
    ] as const);
    return {
      riskLevel: risk.choice,
      authorization: authorization.choice,
      confidence: Math.min(risk.confidence, authorization.confidence),
      wouldApprove:
        risk.choice !== 'high' && (authorization.choice === 'explicit' || authorization.choice === 'implied'),
    };
  });
}
