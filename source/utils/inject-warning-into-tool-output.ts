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
          if (typeof lastItem === 'string' || (lastItem && typeof lastItem === 'object' && !Array.isArray(lastItem))) {
            obj.output[lastIdx] = appendToValue(lastItem);
          } else {
            obj.output.push({ success: true, stdout: warning });
          }
        } else {
          obj.output.push({ success: true, stdout: warning });
        }
        return JSON.stringify(obj);
      }

      if (Array.isArray(parsed)) {
        if (parsed.length > 0) {
          const lastIdx = parsed.length - 1;
          const lastItem = parsed[lastIdx];
          if (typeof lastItem === 'string' || (lastItem && typeof lastItem === 'object' && !Array.isArray(lastItem))) {
            parsed[lastIdx] = appendToValue(lastItem);
          } else {
            parsed.push(warning);
          }
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
