import path from 'node:path';
import type { Command } from 'unbash';
import { getActiveWorkspaceRoot } from '../../../../services/workspace/active-workspace-root.js';
import { SafetyStatus, SYSTEM_PATHS } from '../constants.js';
import { SANDBOX_TEMP_DIR } from '../../temp-dir.js';
import type { CommandHandler, CommandHandlerHelpers, CommandHandlerResult } from './types.js';

const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  '.git',
  '.env',
]);

const DANGEROUS_TARGETS = new Set(['/', '/*', '~', '~/*', '$HOME', '*', '.*', '.', '..']);

function isDangerousTarget(target: string): boolean {
  if (DANGEROUS_TARGETS.has(target)) return true;
  if (target === '..' || target.startsWith('../') || target.includes('/..')) return true;
  if (target.startsWith('/*')) return true;
  return false;
}

export const rmHandler: CommandHandler = {
  handle(node: Command, helpers: CommandHandlerHelpers): CommandHandlerResult {
    const { extractWordText, isSessionCreatedFile } = helpers;
    const reasons: string[] = [];
    const suffix = node.suffix ?? [];

    const pathArgs: string[] = [];
    for (const arg of suffix) {
      const text = extractWordText(arg);
      if (!text) {
        return {
          status: SafetyStatus.RED,
          reasons: ['opaque or unparseable argument to rm'],
        };
      }
      if (text.startsWith('-')) {
        continue;
      }
      pathArgs.push(text);
    }

    if (pathArgs.length === 0) {
      return {
        status: SafetyStatus.RED,
        reasons: ['rm with no target paths'],
      };
    }

    const cwd = getActiveWorkspaceRoot();

    for (const target of pathArgs) {
      const trimmed = target.trim();
      if (!trimmed || isDangerousTarget(trimmed)) {
        return {
          status: SafetyStatus.RED,
          reasons: [`dangerous rm target: ${trimmed || '<empty>'}`],
        };
      }

      const resolvedTarget = path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(cwd, trimmed);

      // Block deletion of root or root-level system paths
      if (SYSTEM_PATHS.some((sys) => resolvedTarget === sys || resolvedTarget.startsWith(sys + path.sep))) {
        return {
          status: SafetyStatus.RED,
          reasons: [`rm on system path: ${trimmed}`],
        };
      }

      // Block deletion targeting sensitive dot-directories or env files
      const segments = resolvedTarget.split(/[\\/]+/).filter(Boolean);
      if (segments.some((seg) => SENSITIVE_SEGMENTS.has(seg))) {
        return {
          status: SafetyStatus.RED,
          reasons: [`rm on sensitive path segment: ${trimmed}`],
        };
      }

      // Check if target is inside SANDBOX_TEMP_DIR
      const isInsideSandboxTemp =
        resolvedTarget === SANDBOX_TEMP_DIR || resolvedTarget.startsWith(SANDBOX_TEMP_DIR + path.sep);

      // Check if target was created in this session
      const isCreatedInSession = isSessionCreatedFile?.(resolvedTarget) ?? false;

      if (isInsideSandboxTemp || isCreatedInSession) {
        reasons.push(`rm scratch path: ${trimmed}`);
        continue;
      }

      // Any pre-existing workspace file or unverified path must be RED
      return {
        status: SafetyStatus.RED,
        reasons: [`rm targeting pre-existing or unverified path ${trimmed} requires approval`],
      };
    }

    return {
      status: SafetyStatus.YELLOW,
      reasons,
    };
  },
};
