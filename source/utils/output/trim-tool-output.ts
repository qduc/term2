import { trimOutput } from './output-trim.js';

const tryParseJson = (value: string): unknown | null => {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const trimStringValue = (value: string, maxLines?: number, maxCharacters?: number): string => {
  if (!value) {
    return value;
  }
  return trimOutput(value, maxLines, maxCharacters);
};

const trimJsonStrings = (value: unknown, maxLines?: number, maxCharacters?: number): unknown => {
  if (typeof value === 'string') {
    return trimStringValue(value, maxLines, maxCharacters);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => trimJsonStrings(entry, maxLines, maxCharacters));
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = trimJsonStrings(entry, maxLines, maxCharacters);
    }
    return next;
  }

  return value;
};

export const trimToolOutput = (output: unknown, maxLines?: number, maxCharacters?: number): string => {
  if (typeof output !== 'string') {
    return String(output ?? '');
  }

  const parsed = tryParseJson(output);
  if (parsed !== null) {
    const trimmed = trimJsonStrings(parsed, maxLines, maxCharacters);
    try {
      return JSON.stringify(trimmed);
    } catch {
      return trimStringValue(output, maxLines, maxCharacters);
    }
  }

  return trimStringValue(output, maxLines, maxCharacters);
};
