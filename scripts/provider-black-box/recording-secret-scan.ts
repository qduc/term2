import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { scanFixtureSecrets } from './fixture-sanitizer.js';

/**
 * The backstop after capture-time scrubbing (`wire-identity-scrubber.ts`) and `sanitizeFixtureEnvelope`:
 * a recording made with real credentials is written under a temporary name beside its final one, read back
 * from disk, and scanned; only a file that passes is renamed into place. If anything matches, the temporary
 * files are deleted (an earlier recording at the final path is left alone) and the recorder exits non-zero,
 * naming what matched and where, never the value. A crash before the rename leaves nothing under the final
 * name; at most a hidden `.<name>.<pid>-<random>.unscanned` file, which is never a recording to send.
 *
 * It looks for:
 * - every literal the run could have leaked ({@link SensitiveLiteral}): the access, refresh and id tokens
 *   and account id from each Codex credential file the recorder can see (term2's own store, every account in
 *   it, and the Codex CLI's `auth.json`), each JWT's three segments, every string claim inside the JWTs
 *   apart from {@link BENIGN_JWT_CLAIMS} (subject, email, name, nickname, picture, account/user/organization
 *   ids, ...), the Codex installation id, an API key passed to the recording, and the home directory path.
 *   Each JSON string (and object key) is decoded first, nested JSON text included, and compared ignoring
 *   case, URL-decoded too; the literal's URL-encoded form and its base64 forms (standard and url-safe, at
 *   every byte offset) are looked for as well;
 * - anything JWT-shaped (`eyJ….eyJ…`), whoever issued it;
 * - the shared patterns of `scanFixtureSecrets` (bearer tokens, `sk-` keys, PEM blocks, high-entropy strings).
 */

/** `shortWord`: a 4-7 character value (a JWT claim) matched as a whole word only, so it cannot match inside one. */
export type SensitiveLiteral = { label: string; value: string; shortWord?: boolean };
export type LeakFinding = { label: string; path: string; file?: string };

/** Values shorter than this are not scanned for: they would match ordinary text (`true`, a short word). */
const MIN_LITERAL_LENGTH = 8;
/** JWT claims as short as this are scanned for, as whole words (a 4-letter given name is still a name). */
const MIN_CLAIM_LENGTH = 4;
/** JWT claims that name the issuer, audience, key, scopes or sign-in method: the same for every account. */
export const BENIGN_JWT_CLAIMS: ReadonlySet<string> = new Set([
  'iss',
  'aud',
  'alg',
  'typ',
  'kid',
  'scp',
  'scope',
  'amr',
  'role',
]);
const jwtShape = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}/;

export class RecordingLeakError extends Error {
  constructor(readonly file: string, readonly findings: LeakFinding[]) {
    super(
      `Secret scan failed; nothing was written to ${displayPath(
        file,
      )} (a file already there is untouched). Matched:\n${findings
        .map((finding) => `  - ${finding.label} at ${finding.path}${finding.file ? ` (in ${finding.file})` : ''}`)
        .join('\n')}`,
    );
  }
}

/** A path for the terminal: under the home directory it starts with `~`, so the account name is not printed. */
export function displayPath(path: string): string {
  const home = homedir();
  if (home && home !== sep && (path === home || path.startsWith(home + sep))) return `~${path.slice(home.length)}`;
  return path;
}

export function addLiteral(literals: SensitiveLiteral[], label: string, value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_LITERAL_LENGTH) return;
  if (!literals.some((literal) => literal.value === trimmed)) literals.push({ label, value: trimmed });
}

function addClaimLiteral(literals: SensitiveLiteral[], label: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length >= MIN_LITERAL_LENGTH) return addLiteral(literals, label, trimmed);
  if (trimmed.length < MIN_CLAIM_LENGTH) return;
  if (!literals.some((literal) => literal.value === trimmed)) literals.push({ label, value: trimmed, shortWord: true });
}

/** Adds a JWT, each of its segments, and every string claim inside it except {@link BENIGN_JWT_CLAIMS}. */
export function addJwtLiterals(literals: SensitiveLiteral[], label: string, token: unknown): void {
  if (typeof token !== 'string') return;
  addLiteral(literals, label, token);
  const segments = token.split('.');
  if (segments.length < 2) return;
  segments.forEach((segment, index) => addLiteral(literals, `${label} (segment ${index + 1})`, segment));
  try {
    const claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as unknown;
    const visit = (value: unknown, key: string): void => {
      if (BENIGN_JWT_CLAIMS.has(key)) return;
      if (typeof value === 'string') {
        addClaimLiteral(literals, `${label} claim '${key}'`, value);
        // A provider-prefixed subject (`google-oauth2|1048…`) carries an account number a recording could echo alone.
        if (value.includes('|'))
          for (const part of value.split('|')) addClaimLiteral(literals, `${label} claim '${key}' (part)`, part);
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
  const leaves = decodedLeaves(parsed);
  for (const literal of literals) {
    const match = literalMatcher(literal);
    const leaf = leaves.find(match);
    if (leaf || match({ path: '', text, variants: [text.toLowerCase()] }))
      findings.push({ label: literal.label, path: leaf?.path || '(raw file text)' });
  }
  if (jwtShape.test(text) || leaves.some((leaf) => jwtShape.test(leaf.text)))
    findings.push({
      label: 'JWT-shaped string',
      path: leaves.find((leaf) => jwtShape.test(leaf.text))?.path || '(raw file text)',
    });
  if (options.fixturePatterns !== false)
    for (const finding of scanFixtureSecrets(parsed).findings)
      findings.push({ label: `${finding.kind} pattern`, path: finding.path });
  return findings;
}

type DecodedLeaf = { path: string; text: string; variants: string[] };

/** Every string value and object key, with nested JSON text expanded; `variants` are lower-cased and URL-decoded. */
function decodedLeaves(value: unknown, path = '$', out: DecodedLeaf[] = [], depth = 0): DecodedLeaf[] {
  if (typeof value === 'string') {
    const variants = [value.toLowerCase()];
    if (value.includes('%'))
      try {
        variants.push(decodeURIComponent(value.replace(/\+/g, ' ')).toLowerCase());
      } catch {
        /* not URL-encoded */
      }
    out.push({ path, text: value, variants });
    const trimmed = value.trim();
    if (depth < 6 && /^["{[]/.test(trimmed))
      try {
        decodedLeaves(JSON.parse(trimmed), `${path} (nested JSON)`, out, depth + 1);
      } catch {
        /* ordinary text */
      }
  } else if (Array.isArray(value)) value.forEach((item, index) => decodedLeaves(item, `${path}[${index}]`, out, depth));
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      decodedLeaves(key, `${path} (an object key)`, out, depth);
      decodedLeaves(child, `${path}.${key}`, out, depth);
    }
  return out;
}

function literalMatcher(literal: SensitiveLiteral): (leaf: DecodedLeaf) => boolean {
  const lower = literal.value.toLowerCase();
  if (literal.shortWord) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
    return (leaf) => leaf.variants.some((variant) => word.test(variant));
  }
  const plain = [lower, encodeURIComponent(literal.value).toLowerCase()];
  const encoded = base64Forms(literal.value);
  return (leaf) =>
    leaf.variants.some((variant) => plain.some((needle) => variant.includes(needle))) ||
    encoded.some((needle) => leaf.text.includes(needle));
}

/**
 * The base64 text (standard and url-safe) that encodes `value` wherever it sits in a longer byte string: for
 * each of the three byte offsets, the characters that depend only on the value's own bytes.
 */
function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms: string[] = [];
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes])
      .toString('base64')
      .replace(/=+$/, '');
    const remainder = (offset + bytes.length) % 3;
    const core = encoded.slice([0, 2, 3][offset], encoded.length - (remainder ? remainder + 1 : 0));
    if (core.length < MIN_LITERAL_LENGTH) continue;
    forms.push(core, core.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  return [...new Set(forms)];
}

/**
 * Writes `content` to `file` through the scan: see {@link writeScannedRecordings}. `fixturePatterns: false`
 * skips the high-entropy and other `scanFixtureSecrets` patterns (the redaction report is a list of JSON
 * paths, which that heuristic reads as tokens); the literal and JWT checks always run.
 */
export async function writeScannedRecording(
  file: string,
  content: string,
  literals: readonly SensitiveLiteral[],
  options: { fixturePatterns?: boolean } = {},
): Promise<void> {
  await writeScannedRecordings([{ file, content, ...options }], literals);
}

/**
 * Writes each file under a temporary name in its own directory, reads every one back and scans it, and only
 * when all pass renames them into place. On any finding (or any error) the temporary files are deleted, the
 * final paths are not touched, and a {@link RecordingLeakError} names the first file.
 */
export async function writeScannedRecordings(
  files: ReadonlyArray<{ file: string; content: string; fixturePatterns?: boolean }>,
  literals: readonly SensitiveLiteral[],
): Promise<void> {
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const temps = files.map(({ file }) => join(dirname(file), `.${basename(file)}.${suffix}.unscanned`));
  // Ctrl-C (or a terminal closing) mid-scan must not leave an unscanned copy beside the recordings to send.
  const interrupted = (signal: NodeJS.Signals): void => {
    for (const temp of temps) rmSync(temp, { force: true });
    process.kill(process.pid, signal);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const signal of signals) process.once(signal, interrupted);
  try {
    for (const [index, { content }] of files.entries()) await writeFile(temps[index]!, content, { flag: 'wx' });
    const findings: LeakFinding[] = [];
    for (const [index, entry] of files.entries())
      for (const finding of scanRecordingText(await readFile(temps[index]!, 'utf8'), literals, entry))
        findings.push({ ...finding, ...(index ? { file: basename(entry.file) } : {}) });
    if (findings.length) throw new RecordingLeakError(files[0]!.file, findings);
    for (const [index, { file }] of files.entries()) await rename(temps[index]!, file);
  } finally {
    for (const signal of signals) process.off(signal, interrupted);
    for (const temp of temps) await rm(temp, { force: true });
  }
}

/** Replaces known literals in text meant for the terminal (an error message), so a failure never prints one. */
export function redactLiterals(text: string, literals: readonly SensitiveLiteral[]): string {
  let result = text;
  for (const literal of [...literals].sort((a, b) => b.value.length - a.value.length))
    result = result.split(literal.value).join(`[${literal.label}]`);
  return result.replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_.-]+/g, '[JWT]');
}
