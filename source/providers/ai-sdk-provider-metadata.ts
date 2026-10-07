// Pure helper for reading provider metadata off AI SDK results. Separate from
// ai-sdk-streamed-model.ts so the run loop does not load the AI SDK for it.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Extract provider-reported upstream provider name (e.g. OpenRouter upstream routing)
 * from AI SDK provider metadata when present.
 */
export function extractAiSdkUpstreamProvider(providerMetadata?: Record<string, unknown>): string | undefined {
  if (!providerMetadata || typeof providerMetadata !== 'object') return undefined;

  const openrouter = asRecord(providerMetadata.openrouter);
  if (openrouter) {
    if (typeof openrouter.provider === 'string' && openrouter.provider.trim().length > 0) {
      return openrouter.provider.trim();
    }
    if (typeof openrouter.provider_name === 'string' && openrouter.provider_name.trim().length > 0) {
      return openrouter.provider_name.trim();
    }
  }

  if (typeof providerMetadata.provider === 'string' && providerMetadata.provider.trim().length > 0) {
    return providerMetadata.provider.trim();
  }
  if (typeof providerMetadata.provider_name === 'string' && providerMetadata.provider_name.trim().length > 0) {
    return providerMetadata.provider_name.trim();
  }

  for (const [key, value] of Object.entries(providerMetadata)) {
    if (key === 'model' || key === 'responseId') continue;
    const record = asRecord(value);
    if (record) {
      if (typeof record.provider === 'string' && record.provider.trim().length > 0) {
        return record.provider.trim();
      }
      if (typeof record.provider_name === 'string' && record.provider_name.trim().length > 0) {
        return record.provider_name.trim();
      }
    }
  }

  return undefined;
}
