export function sanitizeHeaders(
  headers: HeadersInit | Record<string, any> | undefined | null,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const result: Record<string, string> = {};

  const addHeader = (key: string, value: any) => {
    const lowerKey = key.toLowerCase();
    const valStr = String(value);
    if (/authorization|key|cookie|token|secret|signature/i.test(lowerKey)) {
      result[lowerKey] = '[REDACTED]';
    } else {
      result[lowerKey] = valStr;
    }
  };

  const rawHeaders = headers as any;
  if (Array.isArray(rawHeaders)) {
    for (const item of rawHeaders) {
      if (Array.isArray(item) && item.length >= 2) {
        addHeader(String(item[0]), item[1]);
      }
    }
  } else if (typeof rawHeaders.forEach === 'function') {
    rawHeaders.forEach((v: any, k: any) => {
      addHeader(String(k), v);
    });
  } else if (typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v !== undefined && v !== null) {
        addHeader(k, v);
      }
    }
  }

  return result;
}
