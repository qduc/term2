import { readFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { scanFixtureSecrets } from './fixture-sanitizer.js';

/**
 * The backstop after capture-time scrubbing (`wire-identity-scrubber.ts`) and `sanitizeFixtureEnvelope`:
 * a recording made with real credentials is written, read back from disk, and scanned. If anything matches,
 * the file is deleted and the recorder exits non-zero, naming what matched and where, never the value.
 *
 * It looks for:
 * - every literal the run could have leaked ({@link SensitiveLiteral}): the access, refresh and id tokens
 *   and account id from each Codex credential file the recorder can see (term2's own store, every account in
 *   it, and the Codex CLI's `auth.json`), each JWT's three segments, the identifying claims inside the JWTs
 *   (subject, email, account/user/organization ids), the Codex installation id, an API key passed to the
 *   recording, and the home directory path;
 * - anything JWT-shaped (`eyJ….eyJ…`), whoever issued it;
 * - the shared patterns of `scanFixtureSecrets` (bearer tokens, `sk-` keys, PEM blocks, high-entropy strings).
 */

export type SensitiveLiteral = { label: string; value: string };
export type LeakFinding = { label: string; path: string };

/** Values shorter than this are not scanned for: they would match ordinary text (`true`, a short word). */
const MIN_LITERAL_LENGTH = 8;
const jwtShape = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}/;

export class RecordingLeakError extends Error {
  constructor(readonly file: string, readonly findings: LeakFinding[]) {
    super(
      `Secret scan failed; ${file} was deleted and nothing was kept. Matched:\n${findings
        .map((finding) => `  - ${finding.label} at ${finding.path}`)
        .join('\n')}`,
    );
  }
}

export function addLiteral(literals: SensitiveLiteral[], label: string, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_LITERAL_LENGTH) return;
  if (!literals.some((literal) => literal.value === trimmed)) literals.push({ label, value: trimmed });
}

/** Adds a JWT, each of its segments, and every identifying string claim inside it. */
export function addJwtLiterals(literals: SensitiveLiteral[], label: string, token: unknown): void {
  if (typeof token !== 'string') return;
  addLiteral(literals, label, token);
  const segments = token.split('.');
  if (segments.length < 2) return;
  segments.forEach((segment, index) => addLiteral(literals, `${label} (segment ${index + 1})`, segment));
  try {
    const claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as unknown;
    const visit = (value: unknown, key: string): void => {
      if (typeof value === 'string') {
        if (/(?:^sub$|email|account|user|org|sid|jti|session|_id$|^id$)/i.test(key))
          addLiteral(literals, `${label} claim '${key}'`, value);
      } else if (Array.isArray(value)) value.forEach((item) => visit(item, key));
      else if (value && typeof value === 'object')
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    };
    visit(claims, '');
  } catch {
    /* not a JWT payload */
  }
}

/** Adds the secrets in a Codex token object (`codex-auth.json` account or the Codex CLI's `tokens`). */
export function addCodexTokenLiterals(literals: SensitiveLiteral[], source: string, tokens: unknown): void {
  if (!tokens || typeof tokens !== 'object') return;
  const record = tokens as Record<string, unknown>;
  addJwtLiterals(literals, `access token from ${source}`, record.access_token);
  addJwtLiterals(literals, `id token from ${source}`, record.id_token);
  addLiteral(literals, `refresh token from ${source}`, record.refresh_token);
  addLiteral(literals, `account id from ${source}`, record.account_id);
}

/** Adds every token-shaped value in a credential file, whatever its layout (v1, v2 multi-account, CLI). */
export function addCredentialFileLiterals(literals: SensitiveLiteral[], file: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.access_token === 'string') addCodexTokenLiterals(literals, file, record);
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === 'string' && /(?:token|key|secret|account_id)/i.test(key))
        addLiteral(literals, `${key} from ${file}`, child);
      else visit(child);
    }
  };
  visit(parsed);
}

export function addEnvironmentLiterals(literals: SensitiveLiteral[]): void {
  addLiteral(literals, 'home directory path', homedir());
}

/** Scans file text; returns one finding per literal/pattern with the JSON path of its first occurrence. */
export function scanRecordingText(
  text: string,
  literals: readonly SensitiveLiteral[],
  options: { fixturePatterns?: boolean } = {},
): LeakFinding[] {
  const findings: LeakFinding[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  for (const literal of literals)
    if (text.includes(literal.value) || text.includes(JSON.stringify(literal.value).slice(1, -1)))
      findings.push({
        label: literal.label,
        path: pathOf(parsed, (value) => value.includes(literal.value)) || '(raw file text)',
      });
  if (jwtShape.test(text))
    findings.push({
      label: 'JWT-shaped string',
      path: pathOf(parsed, (value) => jwtShape.test(value)) || '(raw file text)',
    });
  if (options.fixturePatterns !== false)
    for (const finding of scanFixtureSecrets(parsed).findings)
      findings.push({ label: `${finding.kind} pattern`, path: finding.path });
  return findings;
}

/**
 * Writes `content` to `file`, reads it back and scans it. On any finding the file is deleted and a
 * {@link RecordingLeakError} is thrown; the caller exits non-zero. `fixturePatterns: false` skips the
 * high-entropy and other `scanFixtureSecrets` patterns (the redaction report is a list of JSON paths, which
 * that heuristic reads as tokens); the literal and JWT checks always run.
 */
export async function writeScannedRecording(
  file: string,
  content: string,
  literals: readonly SensitiveLiteral[],
  options: { fixturePatterns?: boolean } = {},
): Promise<void> {
  await writeFile(file, content, 'utf8');
  const findings = scanRecordingText(await readFile(file, 'utf8'), literals, options);
  if (findings.length) {
    await rm(file, { force: true });
    throw new RecordingLeakError(file, findings);
  }
}

/** Replaces known literals in text meant for the terminal (an error message), so a failure never prints one. */
export function redactLiterals(text: string, literals: readonly SensitiveLiteral[]): string {
  let result = text;
  for (const literal of [...literals].sort((a, b) => b.value.length - a.value.length))
    result = result.split(literal.value).join(`[${literal.label}]`);
  return result.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]+/g, '[JWT]');
}

function pathOf(value: unknown, match: (text: string) => boolean, path = '$'): string {
  if (typeof value === 'string') return match(value) ? path : '';
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = pathOf(item, match, `${path}[${index}]`);
      if (found) return found;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (match(key)) return `${path} (an object key)`;
      const found = pathOf(child, match, `${path}.${key}`);
      if (found) return found;
    }
  }
  return '';
}
