import type { HttpRequestFrame } from './fixture-envelope.js';

export const DEFAULT_SDK_CHURN_ALLOW_LIST = [
  'stream_options',
  'metadata',
  'parallel_tool_calls',
  'prompt_cache_retention',
  'service_tier',
  'extra_headers',
] as const;

export function canonicalizeFixtureValue(
  value: unknown,
  placeholders: Record<string, string> = {},
  path = '',
): unknown {
  if (typeof value === 'string') {
    if (placeholders[value]) return placeholders[value];
    if (/(?:^|\.)arguments$/i.test(path) && /^[\[{]/.test(value.trim())) {
      try {
        return canonicalizeFixtureValue(JSON.parse(value), placeholders, path);
      } catch {
        /* preserve malformed argument text */
      }
    }
    if (/^(?:https?:\/\/)[^/]+/.test(value)) return value.replace(/^(https?:\/\/)[^/]+/, '$1<host>');
    if (/(?:^|\.)(?:id|response_id|call_id|request_id)$/i.test(path) && value.length > 8) return '<dynamic-id>';
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => canonicalizeFixtureValue(item, placeholders, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (DEFAULT_SDK_CHURN_ALLOW_LIST.includes(key as (typeof DEFAULT_SDK_CHURN_ALLOW_LIST)[number])) continue;
      result[key] = canonicalizeFixtureValue(
        (value as Record<string, unknown>)[key],
        placeholders,
        path ? `${path}.${key}` : key,
      );
    }
    return result;
  }
  return value;
}

export type RequestComparison = { equal: boolean; diff?: string; expected: unknown; actual: unknown };
export function compareRecordedRequest(
  expected: HttpRequestFrame,
  actual: HttpRequestFrame,
  options: {
    placeholders?: Record<string, string>;
    ignoredHeaders?: readonly string[];
    sdkChurnAllowList?: readonly string[];
  } = {},
): RequestComparison {
  const ignored = new Set(
    (options.ignoredHeaders ?? ['authorization', 'cookie', 'x-api-key', 'api-key', 'user-agent']).map((key) =>
      key.toLowerCase(),
    ),
  );
  const cleanHeaders = (headers: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(headers)
        .filter(([key]) => !ignored.has(key.toLowerCase()))
        .sort(),
    );
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if ((options.sdkChurnAllowList ?? DEFAULT_SDK_CHURN_ALLOW_LIST).includes(key)) continue;
        result[key] = strip(child);
      }
      return result;
    }
    return value;
  };
  const expectedHeaders = cleanHeaders(expected.headers);
  const actualHeaders = cleanHeaders(actual.headers);
  // The fetch seam sees caller headers while an HTTP server also sees transport
  // headers (host, content-length, connection, ...). Compare the recorded
  // projection as a subset and let the SDK-churn allow-list cover known extras.
  // A recorded header the sanitizer redacted to '[REDACTED]' (e.g. any header
  // whose name contains key/token/secret) matches whatever the app actually
  // sends, since the recorded value was deliberately destroyed.
  const actualComparableHeaders = Object.fromEntries(
    Object.keys(expectedHeaders)
      .map((key) => {
        const actualValue = actualHeaders[key];
        // A redacted expected value matches any value the app actually sends,
        // but a header the app omits entirely still fails the comparison.
        if (actualValue === undefined) return [key, undefined];
        return [key, expectedHeaders[key] === '[REDACTED]' ? '[REDACTED]' : actualValue];
      })
      .filter(([, value]) => value !== undefined),
  );
  const expectedValue = {
    method: expected.method.toUpperCase(),
    urlPath: expected.urlPath,
    headers: expectedHeaders,
    body: canonicalizeFixtureValue(strip(expected.body), options.placeholders),
  };
  const actualValue = {
    method: actual.method.toUpperCase(),
    urlPath: actual.urlPath,
    headers: actualComparableHeaders,
    body: canonicalizeFixtureValue(strip(actual.body), options.placeholders),
  };
  const equal = JSON.stringify(expectedValue) === JSON.stringify(actualValue);
  return {
    equal,
    ...(equal ? {} : { diff: formatDiff(expectedValue, actualValue) }),
    expected: expectedValue,
    actual: actualValue,
  };
}

function formatDiff(expected: unknown, actual: unknown): string {
  return `Recorded request differs from actual request\nexpected: ${JSON.stringify(
    expected,
    null,
    2,
  )}\nactual: ${JSON.stringify(actual, null, 2)}`;
}
