export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function normalizeToolCallName(name: unknown): string {
  return typeof name === 'string' ? name.trim() : '';
}

export function normalizeUsage(openRouterUsage: any): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  return {
    inputTokens: openRouterUsage?.prompt_tokens ?? 0,
    outputTokens: openRouterUsage?.completion_tokens ?? 0,
    totalTokens: openRouterUsage?.total_tokens ?? 0,
  };
}

export function isAnthropicModel(modelId: string): boolean {
  const lowerModelId = modelId.toLowerCase();
  return lowerModelId.includes('anthropic') || lowerModelId.includes('claude');
}

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = String(baseUrl || '').trim();
  return trimmed.replace(/\/+$/g, '');
}

export function buildOpenAICompatibleUrl(baseUrl: string, path: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalized}${normalizedPath}`;
}
