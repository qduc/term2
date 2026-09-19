import { VALID_REASONING_EFFORTS, type ModelSettingsReasoningEffort } from '../services/models/reasoning-effort.js';

/**
 * Flag parsing for `term2 acp`, kept free of I/O so the launcher's
 * operator-facing contract is unit-testable. Nothing here reads files or
 * opens streams; `runAcp` owns the effectful composition.
 *
 * The accepted set is deliberately minimal — `--provider`, `--model` and
 * `--effort` are the only knobs the launcher exposes. There is no
 * `--auto-approve`: ACP sessions stay fail-closed in this milestone, so the
 * CLI's interactive auto-approve flag is rejected as an unknown option rather
 * than silently ignored.
 */

export type AcpArgs = {
  provider?: string;
  model?: string;
  effort?: ModelSettingsReasoningEffort;
};

export type AcpArgsResult = { ok: true; args: AcpArgs } | { ok: false; error: string };

const VALUE_FLAGS = new Set(['--provider', '--model', '--effort']);

export function parseAcpArgs(argv: readonly string[]): AcpArgsResult {
  const args: { provider?: string; model?: string; effort?: ModelSettingsReasoningEffort } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) return { ok: false, error: `unexpected argument "${token}"` };
    if (!VALUE_FLAGS.has(token)) return { ok: false, error: `unknown option "${token}"` };
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { ok: false, error: `${token} requires a value` };
    }
    index += 1;
    if (token === '--provider') args.provider = value;
    else if (token === '--model') args.model = value;
    else {
      if (!(VALID_REASONING_EFFORTS as readonly string[]).includes(value)) {
        return { ok: false, error: `--effort must be one of: ${VALID_REASONING_EFFORTS.join(', ')}` };
      }
      args.effort = value as ModelSettingsReasoningEffort;
    }
  }

  return { ok: true, args };
}
