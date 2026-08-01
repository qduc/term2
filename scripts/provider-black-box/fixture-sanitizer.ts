import { sanitizeHeaders } from '../../source/utils/header-sanitizer.js';
import type { FixtureEnvelopeV1, FixtureFrame } from './fixture-envelope.js';

export type SanitizationReport = {
  redactions: Array<{ path: string; reason: string }>;
  placeholders: Record<string, string>;
};

const secretHeader = /^(authorization|cookie|x-api-key|api-key|proxy-authorization)$/i;
const dynamicValue = /^(?:resp(?:onse)?|call|chatcmpl|msg|req|rs|fc|gen)[_-][\w-]+$/i;
const secretValue = /^(?:bearer\s+|sk-[A-Za-z0-9_-]{12,})/i;

export function sanitizeFixtureEnvelope(input: FixtureEnvelopeV1): {
  envelope: FixtureEnvelopeV1;
  report: SanitizationReport;
} {
  const report: SanitizationReport = { redactions: [], placeholders: { ...input.placeholders } };
  const mapping = new Map(Object.entries(input.placeholders));
  let next = Object.values(input.placeholders).length + 1;
  const mapDynamic = (value: string, path: string): string => {
    const existing = mapping.get(value);
    if (existing) return existing;
    if (dynamicValue.test(value)) {
      const stable = `${value.split(/[_-]/, 1)[0] || 'value'}_<${next++}>`;
      mapping.set(value, stable);
      report.placeholders[value] = stable;
      report.redactions.push({ path, reason: 'dynamic identifier canonicalized' });
      return stable;
    }
    if (secretValue.test(value)) {
      report.redactions.push({ path, reason: 'credential redacted' });
      return '[REDACTED]';
    }
    return value;
  };
  const sanitize = (value: unknown, path: string): unknown => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return JSON.stringify(sanitize(JSON.parse(value), path));
        } catch {
          /* ordinary text */
        }
      }
      return mapDynamic(value, path);
    }
    if (Array.isArray(value)) return value.map((item, index) => sanitize(item, `${path}[${index}]`));
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      const isThoughtPart = (value as Record<string, unknown>).thought === true;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${path}.${key}`;
        if (
          /\.choices\[\d+\]\.delta\.reasoning$/.test(childPath) ||
          /\.choices\[\d+\]\.delta\.reasoning_content$/.test(childPath) ||
          /\.reasoning_details\[\d+\]\.text$/.test(childPath) ||
          /\.delta\.thinking$/.test(childPath) ||
          /\.content_block\.thinking$/.test(childPath) ||
          (isThoughtPart && key === 'text')
        ) {
          result[key] = '[REDACTED]';
          report.redactions.push({ path: childPath, reason: 'model reasoning redacted' });
        } else if (/^system_fingerprint$/i.test(key)) {
          result[key] = '[REDACTED]';
          report.redactions.push({ path: childPath, reason: 'provider fingerprint redacted' });
        } else if (/^(?:thoughtSignature|signature)$/i.test(key)) {
          result[key] = '[REDACTED]';
          report.redactions.push({ path: childPath, reason: 'opaque provider signature redacted' });
        } else if (
          /authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|encrypted[-_]?content|secret/i.test(key)
        ) {
          result[key] = '[REDACTED]';
          report.redactions.push({ path: childPath, reason: 'credential field redacted' });
        } else {
          result[key] = sanitize(child, childPath);
        }
      }
      return result;
    }
    return value;
  };
  const frames = input.turns.map((turn, turnIndex) => ({
    frames: turn.frames.map((frame, frameIndex) =>
      sanitizeFrame(frame, `turns[${turnIndex}].frames[${frameIndex}]`, sanitize, mapDynamic, report),
    ),
  }));
  const envelope: FixtureEnvelopeV1 = { ...input, turns: frames, placeholders: report.placeholders };
  return { envelope, report };
}

function sanitizeFrame(
  frame: FixtureFrame,
  path: string,
  sanitize: (value: unknown, path: string) => unknown,
  mapDynamic: (value: string, path: string) => string,
  report: SanitizationReport,
): FixtureFrame {
  if (frame.kind === 'http-request') {
    const headers = sanitizeHeaders(frame.headers) ?? {};
    for (const key of Object.keys(frame.headers)) {
      if (secretHeader.test(key)) {
        report.redactions.push({ path: `${path}.headers.${key}`, reason: 'secret header redacted' });
      } else if (/^x-opencode-session$/i.test(key)) {
        headers[key] = '[REDACTED]';
        report.redactions.push({ path: `${path}.headers.${key}`, reason: 'provider session redacted' });
      }
    }
    return {
      ...frame,
      urlPath: sanitizeUrlPath(frame.urlPath, `${path}.urlPath`, report),
      headers,
      body: sanitize(frame.body, `${path}.body`),
    };
  }
  if (frame.kind === 'http-response-head') {
    const headers = sanitizeHeaders(frame.headers) ?? {};
    const sanitizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => {
        if (/organization|project|account|cf-ray/i.test(key)) {
          report.redactions.push({ path: `${path}.headers.${key}`, reason: 'provider identifier redacted' });
          return [key, '[REDACTED]'];
        }
        return [key, mapDynamic(value, `${path}.headers.${key}`)];
      }),
    );
    return { ...frame, headers: sanitizedHeaders };
  }
  if (frame.kind === 'json-body') return { ...frame, body: sanitize(frame.body, `${path}.body`) };
  if (frame.kind === 'sse-event') return { ...frame, data: String(sanitize(frame.data, `${path}.data`)) };
  return { ...frame, data: sanitize(frame.data, `${path}.data`) };
}

function sanitizeUrlPath(urlPath: string, path: string, report: SanitizationReport): string {
  try {
    const url = new URL(urlPath, 'https://fixture.invalid');
    let changed = false;
    for (const [key] of url.searchParams) {
      if (!/^(?:api[-_]?key|key|access[-_]?token|refresh[-_]?token|token|authorization|secret)$/i.test(key)) continue;
      url.searchParams.set(key, '[REDACTED]');
      report.redactions.push({ path: `${path}.${key}`, reason: 'credential query parameter redacted' });
      changed = true;
    }
    return changed ? `${url.pathname}${url.search}${url.hash}` : urlPath;
  } catch {
    return urlPath;
  }
}

export type SecretFinding = { path: string; kind: 'bearer-token' | 'api-key' | 'pem' | 'high-entropy' };
export function scanFixtureSecrets(value: unknown): { safe: boolean; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  const visit = (item: unknown, path: string): void => {
    if (typeof item === 'string') {
      // SSE data often contains an escaped JSON object. Inspect its fields so
      // protocol punctuation is not mistaken for a high-entropy secret.
      if (item.trim().startsWith('{') || item.trim().startsWith('[')) {
        try {
          visit(JSON.parse(item), path);
          return;
        } catch {
          /* inspect as text */
        }
      }
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(item)) findings.push({ path, kind: 'pem' });
      else if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i.test(item)) findings.push({ path, kind: 'bearer-token' });
      else if (/(?:^|\W)sk-[A-Za-z0-9_-]{12,}/.test(item)) findings.push({ path, kind: 'api-key' });
      else if (
        item.length >= 40 &&
        /[A-Za-z]/.test(item) &&
        /\d/.test(item) &&
        /[^A-Za-z0-9\s]/.test(item) &&
        !/<\d+>/.test(item) &&
        // Real credentials are token-shaped (no spaces). Requiring no whitespace
        // keeps ordinary prose with numbers and punctuation from false-positiving.
        !/\s/.test(item) &&
        // URLs and relative URL paths are not credentials; the dedicated sk-/Bearer
        // patterns and URL query redaction still catch keys embedded in them.
        !/^https?:\/\//.test(item) &&
        !/^\/[^\s]*$/.test(item)
      )
        findings.push({ path, kind: 'high-entropy' });
      return;
    }
    if (Array.isArray(item)) return item.forEach((child, index) => visit(child, `${path}[${index}]`));
    if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) visit(child, `${path}.${key}`);
  };
  visit(value, '$');
  return { safe: findings.length === 0, findings };
}
