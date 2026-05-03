import type { ProviderDefinition } from '../providers/registry.js';

type ProviderCapabilities = ProviderDefinition['capabilities'];

export function shouldPreferPatchEditingModel(model: string): boolean {
  return model.toLowerCase().includes('gpt-5');
}

export function shouldUseNativePatchTool({
  providerId,
  model,
  capabilities,
}: {
  providerId: string;
  model: string;
  capabilities?: ProviderCapabilities;
}): boolean {
  const modelPrefixes = capabilities?.nativePatchModelPrefixes;
  if (modelPrefixes && modelPrefixes.length > 0) {
    return modelPrefixes.some((prefix) => model.startsWith(prefix));
  }

  return providerId === 'openai' && model.startsWith('gpt-5.1');
}

export function shouldUseStrictToolSchema({
  providerId,
  capabilities,
}: {
  providerId: string;
  capabilities?: ProviderCapabilities;
}): boolean {
  if (capabilities?.usesStrictToolSchema !== undefined) {
    return capabilities.usesStrictToolSchema;
  }

  return providerId === 'openai';
}
