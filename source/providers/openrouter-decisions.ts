export type DecisionQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

export async function requestOpenRouterDecisions({
  model,
  state,
  questions,
  apiKey,
  baseUrl = 'https://openrouter.ai/api/v1',
  fetchImpl = fetch,
}: {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown> {
  if (!apiKey) throw new Error('OpenRouter Decisions requires an API key');
  const url = new URL('/api/alpha/decisions', baseUrl).toString();
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
  });
  if (!response.ok) throw new Error(`OpenRouter Decisions returned HTTP ${response.status}`);
  return response.json();
}
