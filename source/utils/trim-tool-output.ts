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

export const injectWarningIntoToolOutput = (output: string, warning: string): string => {
  if (!output) {
    return warning;
  }

  const appendToField = (record: Record<string, any>): boolean => {
    for (const field of ['stdout', 'content', 'error', 'text', 'message']) {
      if (typeof record[field] === 'string') {
        record[field] += warning;
        return true;
      }
    }

    return false;
  };

  const appendToValue = (val: unknown): unknown => {
    if (typeof val === 'string') return val + warning;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const record = val as Record<string, any>;
      if (!appendToField(record)) {
        record.warning = warning.trim();
      }
      return record;
    }
    return val;
  };

  try {
    const parsed = JSON.parse(output);

    if (typeof parsed === 'string') {
      return JSON.stringify(parsed + warning);
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, any>;

      if (Array.isArray(obj.output)) {
        if (obj.output.length > 0) {
          const lastIdx = obj.output.length - 1;
          const lastItem = obj.output[lastIdx];
          obj.output[lastIdx] = appendToValue(lastItem);
        } else {
          obj.output.push({ success: true, stdout: warning });
        }
        return JSON.stringify(obj);
      }

      if (Array.isArray(parsed)) {
        if (parsed.length > 0) {
          const lastIdx = parsed.length - 1;
          const lastItem = parsed[lastIdx];
          parsed[lastIdx] = appendToValue(lastItem);
        } else {
          parsed.push(warning);
        }
        return JSON.stringify(parsed);
      }

      if (!appendToField(obj)) {
        obj.warning = warning.trim();
      }
      return JSON.stringify(obj);
    }

    return JSON.stringify(parsed) + warning;
  } catch {
    return output + warning;
  }
};
