import type { ISettingsService } from '../../services/service-interfaces.js';

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export function getOpenRouterBaseUrl(settingsService: ISettingsService): string {
  return settingsService.get('agent.openrouter.baseUrl') || 'https://openrouter.ai/api/v1';
}

export function normalizeUsage(openRouterUsage: any): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  // OpenRouter returns: { prompt_tokens, completion_tokens, total_tokens }
  // SDK expects: { inputTokens, outputTokens, totalTokens }
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
