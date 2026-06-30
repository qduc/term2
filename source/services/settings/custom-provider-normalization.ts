export const normalizeProviderIdentifier = (value: string): string => value.trim().replace(/\s+/g, '_');

export const resolveProviderId = (entry: unknown): string | undefined => {
  if (!entry || typeof entry !== 'object') return undefined;

  const record = entry as Record<string, unknown>;
  const raw =
    (typeof record.id === 'string' && record.id) ||
    (typeof record.identifier === 'string' && record.identifier) ||
    (typeof record.name === 'string' && record.name) ||
    (typeof record.displayName === 'string' && record.displayName) ||
    undefined;

  if (!raw) return undefined;
  const normalized = normalizeProviderIdentifier(raw);
  return normalized.length > 0 ? normalized : undefined;
};

export const resolveProviderName = (entry: unknown, fallbackId: string): string => {
  if (!entry || typeof entry !== 'object') return fallbackId;

  const record = entry as Record<string, unknown>;
  const raw =
    (typeof record.name === 'string' && record.name) ||
    (typeof record.displayName === 'string' && record.displayName) ||
    fallbackId;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallbackId;
};
