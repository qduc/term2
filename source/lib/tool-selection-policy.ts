import type { ProviderDefinition } from '../providers/registry.js';

type ProviderCapabilities = ProviderDefinition['capabilities'];

type GptVersion = {
  major: number;
  minor: number;
};

function parseGptVersion(value: string): GptVersion | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^gpt-(\d+)(?:\.(\d+))?/i);
  if (!match) {
    return null;
  }
  // Reject ambiguous exact-match multi-digit versions like 'gpt-50'.
  // A valid GPT version prefix should either have a minor version or a suffix.
  const afterMatch = trimmed.slice(match[0].length);
  if (!afterMatch && match[1].length > 1 && !match[2]) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? '0'),
  };
}

function isGptVersionAtLeast(model: string, minimum: string): boolean {
  const modelVersion = parseGptVersion(model);
  const minimumVersion = parseGptVersion(minimum);
  if (!modelVersion || !minimumVersion) {
    return false;
  }

  if (modelVersion.major !== minimumVersion.major) {
    return modelVersion.major > minimumVersion.major;
  }

  return modelVersion.minor >= minimumVersion.minor;
}

function matchesNativePatchPrefix(model: string, prefix: string): boolean {
  const normalizedModel = model.trim();
  const normalizedPrefix = prefix.trim();

  if (!normalizedModel || !normalizedPrefix) {
    return false;
  }

  const modelVersion = parseGptVersion(normalizedModel);
  const prefixVersion = parseGptVersion(normalizedPrefix);
  if (modelVersion && prefixVersion) {
    return isGptVersionAtLeast(normalizedModel, normalizedPrefix);
  }

  return normalizedModel.startsWith(normalizedPrefix);
}

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
    return modelPrefixes.some((prefix) => matchesNativePatchPrefix(model, prefix));
  }

  return providerId === 'openai' && isGptVersionAtLeast(model, 'gpt-5.1');
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
