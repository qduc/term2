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
  timeoutMs = 10_000,
}: {
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<unknown> {
  if (!apiKey) throw new Error('OpenRouter Decisions requires an API key');
  const endpoint = new URL(baseUrl);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  endpoint.pathname = `${basePath.replace(/\/api\/v1$/, '')}/api/alpha/decisions`;
  const url = endpoint.toString();
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('OpenRouter Decisions shadow deadline exceeded')),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter Decisions returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(deadline);
  }
}
