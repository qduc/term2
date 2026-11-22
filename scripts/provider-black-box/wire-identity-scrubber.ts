/**
 * Capture-time scrubbing for recordings made with real account credentials (Codex over WebSocket or HTTP,
 * OpenAI over WebSocket). It runs on every handshake, header set and message **before** the frame is held
 * by the recorder, so nothing below reaches memory that is later written, let alone the disk.
 *
 * It is deliberately stronger than `sanitizeFixtureEnvelope` (which still runs afterwards and turns live
 * response/item/call ids into placeholders):
 *
 * - Headers are scrubbed by an ALLOW-list of values. A header whose name is not in
 *   {@link KEPT_HEADER_VALUES} keeps its name (so a replay can check it is sent) and loses its value. That
 *   covers `authorization`, `chatgpt-account-id`, `session-id`, `thread-id`, `x-client-request-id`,
 *   `x-codex-installation-id`, `x-codex-window-id`, `x-codex-turn-metadata`, `session_id`, `cookie`,
 *   `user-agent` (it names the OS release) and any header a later product version adds.
 * - Message bodies are scrubbed by key. A key with an identity word in it ({@link IDENTITY_KEY_WORDS}, or
 *   one of {@link IDENTITY_KEYS}) has every string under it replaced by `[REDACTED]` and every number by 0;
 *   keys, booleans and nulls are kept so the replay still sees the shape. That covers `client_metadata`
 *   (installation, session, thread, window and turn ids and the turn-metadata JSON), `prompt_cache_key`,
 *   `metadata`, `user`, `safety_identifier`, `session_id`, `conversation`, `account_id`, and the
 *   `codex.rate_limits` payload (`rate_limits`, `plan_type`, `credits`: the account's plan and usage).
 * - Credential-looking strings anywhere (a bearer token, an `sk-` key, a JWT) are replaced, whatever the key.
 * - Binary WebSocket messages are not kept: they are recorded as a byte count only.
 *
 * The secret scan in `recording-secret-scan.ts` runs on the written file afterwards and is the backstop
 * for anything a real service sends that these rules did not anticipate.
 */

export const REDACTED = '[REDACTED]';

export type ScrubReport = Array<{ path: string; reason: string }>;

/** Header names whose values carry protocol information and no identity. Every other value is dropped. */
export const KEPT_HEADER_VALUES: ReadonlySet<string> = new Set([
  'accept',
  'content-type',
  'openai-beta',
  'originator',
  'version',
  'x-codex-beta-features',
  'x-openai-internal-codex-responses-lite',
]);

/** Words that mark a body key as identifying the account, user, installation or session. */
export const IDENTITY_KEY_WORDS: ReadonlySet<string> = new Set([
  'account',
  'conversation',
  'credits',
  'device',
  'email',
  'fingerprint',
  'installation',
  'machine',
  'metadata',
  'organization',
  'plan',
  'project',
  'safety',
  'session',
  'thread',
  'trace',
  'turn',
  'user',
  'window',
  'workspace',
]);

/** Whole keys (normalised to lower snake case) that identify a caller without containing an identity word. */
export const IDENTITY_KEYS: ReadonlySet<string> = new Set(['prompt_cache_key', 'rate_limits', 'org_id', 'sid']);

const credentialPattern =
  /\bBearer\s+\S{6,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/;

/** Splits `x-codex-turnMetadata` / `session_id` / `chatgpt-account-id` into lower-case words. */
export function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isIdentityKey(key: string): boolean {
  const words = keyWords(key);
  return IDENTITY_KEYS.has(words.join('_')) || words.some((word) => IDENTITY_KEY_WORDS.has(word));
}

export function scrubHeaders(
  headers: Record<string, unknown> | undefined,
  path: string,
  report: ScrubReport,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined || value === null) continue;
    const key = name.toLowerCase();
    // Two spellings of one header (the SDK's `Authorization` and the provider's `authorization`) collapse to
    // the one name the server sees; its value is dropped either way.
    if (KEPT_HEADER_VALUES.has(key) && !credentialPattern.test(String(value))) {
      result[key] = String(value);
    } else {
      result[key] = REDACTED;
      report.push({ path: `${path}.${key}`, reason: 'header value not on the allow-list' });
    }
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

/** Path and query of a URL, never its host; query values other than protocol flags are dropped. */
export function scrubUrlPath(url: string | URL, path: string, report: ScrubReport): string {
  const parsed = new URL(String(url), 'https://recording.invalid');
  for (const key of [...new Set(parsed.searchParams.keys())]) {
    if (/^(?:model|stream|api-version)$/i.test(key)) continue;
    parsed.searchParams.set(key, REDACTED);
    report.push({ path: `${path}?${key}`, reason: 'query value not on the allow-list' });
  }
  return `${parsed.pathname}${parsed.search}`;
}

/** Scrubs one message body (already JSON-parsed where it was JSON). */
export function scrubBody(value: unknown, path: string, report: ScrubReport): unknown {
  if (typeof value === 'string') {
    if (credentialPattern.test(value)) {
      report.push({ path, reason: 'credential-shaped string' });
      return REDACTED;
    }
    // Nested JSON text (tool arguments, turn metadata in a header-like field) is scrubbed as JSON.
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.stringify(scrubBody(JSON.parse(value), path, report));
      } catch {
        /* ordinary text */
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => scrubBody(item, `${path}[${index}]`, report));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (isIdentityKey(key)) result[key] = destroyLeaves(child, childPath, report);
      else result[key] = scrubBody(child, childPath, report);
    }
    return result;
  }
  return value;
}

/** Keeps the shape, drops every string and number value. */
function destroyLeaves(value: unknown, path: string, report: ScrubReport): unknown {
  if (typeof value === 'string') {
    report.push({ path, reason: 'identity field' });
    return REDACTED;
  }
  if (typeof value === 'number') {
    report.push({ path, reason: 'identity field' });
    return 0;
  }
  if (Array.isArray(value)) return value.map((item, index) => destroyLeaves(item, `${path}[${index}]`, report));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, destroyLeaves(child, `${path}.${key}`, report)]),
    );
  return value;
}

/** Parses a text WebSocket message as JSON where it is JSON and scrubs it; a binary one keeps its size only. */
export function scrubWebSocketMessage(raw: unknown, isBinary: boolean, path: string, report: ScrubReport): unknown {
  if (isBinary) {
    const length = Buffer.isBuffer(raw) ? raw.length : Array.isArray(raw) ? Buffer.concat(raw).length : undefined;
    report.push({ path, reason: 'binary message dropped' });
    return { binaryMessageBytes: length ?? 0 };
  }
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : Array.isArray(raw)
    ? Buffer.concat(raw).toString('utf8')
    : String(raw);
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return scrubBody(value, path, report);
}
