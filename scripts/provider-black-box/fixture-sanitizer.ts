import { sanitizeHeaders } from '../../source/utils/header-sanitizer.js';
import type { FixtureEnvelopeV1, FixtureFrame } from './fixture-envelope.js';

export type SanitizationReport = {
  redactions: Array<{ path: string; reason: string }>;
  placeholders: Record<string, string>;
};

const secretHeader = /^(authorization|cookie|x-api-key|api-key|proxy-authorization)$/i;
const dynamicValue = /^(?:resp(?:onse)?[_-][\w-]+|call[_-][\w-]+|chatcmpl[_-][\w-]+|msg[_-][\w-]+|req[_-][\w-]+)$/i;
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
      for (const [key, child] of Object.entries(value)) {
        if (/authorization|cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|secret/i.test(key)) {
          result[key] = '[REDACTED]';
          report.redactions.push({ path: `${path}.${key}`, reason: 'credential field redacted' });
        } else {
          result[key] = sanitize(child, `${path}.${key}`);
        }
      }
      return result;
    }
    return value;
  };
  const frames = input.turns.map((turn, turnIndex) => ({
    frames: turn.frames.map((frame, frameIndex) =>
      sanitizeFrame(frame, `turns[${turnIndex}].frames[${frameIndex}]`, sanitize, report),
    ),
  }));
  const envelope: FixtureEnvelopeV1 = { ...input, turns: frames, placeholders: report.placeholders };
  return { envelope, report };
}

function sanitizeFrame(
  frame: FixtureFrame,
  path: string,
  sanitize: (value: unknown, path: string) => unknown,
  report: SanitizationReport,
): FixtureFrame {
  if (frame.kind === 'http-request') {
    const headers = sanitizeHeaders(frame.headers) ?? {};
    for (const key of Object.keys(frame.headers))
      if (secretHeader.test(key))
        report.redactions.push({ path: `${path}.headers.${key}`, reason: 'secret header redacted' });
    return { ...frame, headers, body: sanitize(frame.body, `${path}.body`) };
  }
  if (frame.kind === 'http-response-head') return { ...frame, headers: sanitizeHeaders(frame.headers) ?? {} };
  if (frame.kind === 'json-body') return { ...frame, body: sanitize(frame.body, `${path}.body`) };
  if (frame.kind === 'sse-event') return { ...frame, data: String(sanitize(frame.data, `${path}.data`)) };
  return { ...frame, data: sanitize(frame.data, `${path}.data`) };
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
        !/<\d+>/.test(item)
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
