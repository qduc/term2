import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  readCodexCliTokens,
  readStoredCodexTokens,
  resolveCodexTokenPath,
  resolveTerm2CodexAuthPath,
} from '../../src/model/providers/codex-auth.js';
import type { FixtureEnvelopeV1 } from './fixture-envelope.js';
import { sanitizeFixtureEnvelope } from './fixture-sanitizer.js';
import {
  addCredentialFileLiterals,
  addEnvironmentLiterals,
  addLiteral,
  writeScannedRecordings,
  type SensitiveLiteral,
} from './recording-secret-scan.js';
import type { ScrubReport } from './wire-identity-scrubber.js';

/**
 * The parts of `provider:record` that only apply to recordings made with an account's own credentials
 * (Codex over WebSocket or HTTP, OpenAI over WebSocket): finding the login, knowing every secret it could
 * leak, and writing a recording that is sanitized and secret-scanned before it is kept.
 */

export type CodexLogin = { sources: string[]; literals: SensitiveLiteral[] };

/**
 * Finds the Codex login the way term2 does (`CodexTokenManager`): term2's own `codex-auth.json` under the
 * config dir (`$TERM2_CONFIG_DIR`), else the Codex CLI's `auth.json` (`$CHATGPT_LOCAL_HOME`, `$CODEX_HOME`,
 * `~/.chatgpt-local`, `~/.codex`). Returns undefined when neither holds an access token. Never returns or
 * prints a token; the literals are only for the secret scan.
 */
export function findCodexLogin(): CodexLogin | undefined {
  const term2Path = resolveTerm2CodexAuthPath();
  const cliPath = resolveCodexTokenPath();
  let stored = null;
  try {
    stored = readStoredCodexTokens(term2Path);
  } catch {
    stored = null;
  }
  const imported = cliPath ? readCodexCliTokens(cliPath) : null;
  if (!stored && !imported) return undefined;
  const sources = [stored ? term2Path : undefined, imported ? cliPath! : undefined].filter(
    (value): value is string => !!value,
  );
  return { sources, literals: codexSecretLiterals() };
}

export function codexLoginLocations(): string {
  const cliPath = resolveCodexTokenPath();
  return `term2's login at ${resolveTerm2CodexAuthPath()}, and the Codex CLI's at ${
    cliPath ?? '$CHATGPT_LOCAL_HOME/auth.json, $CODEX_HOME/auth.json, ~/.chatgpt-local/auth.json or ~/.codex/auth.json'
  }`;
}

/**
 * Every secret the Codex credential files on this machine hold, read afresh (a refresh during the run
 * writes new tokens to term2's store, so this is called again after the run).
 */
export function codexSecretLiterals(): SensitiveLiteral[] {
  const literals: SensitiveLiteral[] = [];
  const term2Path = resolveTerm2CodexAuthPath();
  const cliPath = resolveCodexTokenPath();
  if (existsSync(term2Path)) addCredentialFileLiterals(literals, term2Path);
  if (cliPath) {
    addCredentialFileLiterals(literals, cliPath);
    // The installation id is a Codex CLI artifact read from beside its auth file (CodexTokenManager).
    try {
      addLiteral(literals, 'Codex installation id', readFileSync(join(dirname(cliPath), 'installation_id'), 'utf8'));
    } catch {
      /* no installation id */
    }
  }
  addEnvironmentLiterals(literals);
  return literals;
}

/** The fixed session the recorder runs the probe in, as the CLI runs every turn in one. */
export function recordingSessionContext(startedAt: string) {
  const context = { sessionId: 'provider-record-probe', sessionStartedAt: startedAt };
  return {
    runWithContext: <T>(_context: unknown, fn: () => T): T => fn(),
    getContext: () => context,
  };
}

/**
 * Counts HTTP requests to a Responses endpoint while a WebSocket recording runs. A non-zero count means the
 * model fell back from WebSocket to HTTP and the recording is not the WebSocket exchange it claims to be.
 * The wrapper passes every request through unchanged and records nothing.
 */
export function observeResponsesHttpFallback(): { count(): number; restore(): void } {
  const nativeFetch = globalThis.fetch;
  let count = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (/\/responses(?:\/|$)/.test(url.pathname)) count++;
    } catch {
      /* not an absolute URL; the request itself decides what happens */
    }
    return nativeFetch(input, init);
  }) as typeof fetch;
  return {
    count: () => count,
    restore: () => {
      globalThis.fetch = nativeFetch;
    },
  };
}

/**
 * Sanitizes a scrubbed envelope (live ids become placeholders, encrypted reasoning and signatures are
 * dropped), then writes it and its redaction report (paths and reasons only, no values, no live-id table)
 * through the secret scan. Both are written under temporary names and renamed into place only when both
 * pass; either failing leaves the final paths untouched (no new file, an earlier one kept) and throws.
 */
export async function writeCredentialedRecording(options: {
  envelope: FixtureEnvelopeV1;
  file: string;
  captureReport: ScrubReport;
  literals: SensitiveLiteral[];
}): Promise<{ file: string; reportFile: string }> {
  const { envelope, report } = sanitizeFixtureEnvelope(options.envelope);
  const reportFile = options.file.replace(/\.json$/, '.redactions.json');
  const redactions = {
    note: 'Paths scrubbed at capture time and by sanitizeFixtureEnvelope. Values are not recorded here.',
    capture: options.captureReport,
    sanitizer: report.redactions,
  };
  await writeScannedRecordings(
    [
      { file: options.file, content: `${JSON.stringify(envelope, null, 2)}\n` },
      { file: reportFile, content: `${JSON.stringify(redactions, null, 2)}\n`, fixturePatterns: false },
    ],
    options.literals,
  );
  return { file: options.file, reportFile };
}
