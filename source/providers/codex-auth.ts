import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolve the Codex auth file by presence only. Reading or validating the
 * token contents belongs to the runtime request path.
 */
export function resolveCodexTokenPath(): string | null {
  const candidates: string[] = [];

  if (process.env.CHATGPT_LOCAL_HOME) {
    candidates.push(path.join(process.env.CHATGPT_LOCAL_HOME, 'auth.json'));
    candidates.push(process.env.CHATGPT_LOCAL_HOME);
  }
  if (process.env.CODEX_HOME) {
    candidates.push(path.join(process.env.CODEX_HOME, 'auth.json'));
    candidates.push(process.env.CODEX_HOME);
  }

  const home = os.homedir();
  if (home) {
    candidates.push(path.join(home, '.chatgpt-local', 'auth.json'));
    candidates.push(path.join(home, '.codex', 'auth.json'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignore inaccessible candidates and continue through the precedence list.
    }
  }
  return null;
}
