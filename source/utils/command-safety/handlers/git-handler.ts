import { SafetyStatus, SAFE_GIT_COMMANDS, DANGEROUS_GIT_COMMANDS } from '../constants.js';
import type { CommandHandler, CommandHandlerHelpers, CommandHandlerResult } from './types.js';

/**
 * Handler for git command safety analysis
 */
export const gitHandler: CommandHandler = {
  handle(node: any, helpers: CommandHandlerHelpers): CommandHandlerResult {
    const { extractWordText } = helpers;
    const reasons: string[] = [];
    let status: SafetyStatus = SafetyStatus.GREEN;

    // Extract the git subcommand (first non-flag argument)
    let gitSubcommand: string | undefined;
    if (node.suffix) {
      for (const arg of node.suffix) {
        const argText = extractWordText(arg);
        if (argText && !argText.startsWith('-')) {
          gitSubcommand = argText;
          break;
        }
      }
    }

    if (!gitSubcommand) {
      // No subcommand found (e.g., just "git" or "git --version")
      return {
        status: SafetyStatus.YELLOW,
        reasons: ['git without subcommand'],
      };
    }

    // Check if it's a known dangerous command
    if (DANGEROUS_GIT_COMMANDS.has(gitSubcommand)) {
      return {
        status: SafetyStatus.YELLOW,
        reasons: [`git ${gitSubcommand} (write operation)`],
      };
    }

    // Check if it's a known safe command
    if (SAFE_GIT_COMMANDS.has(gitSubcommand)) {
      // Check for dangerous flags that might make it unsafe
      const hasDangerousFlags = node.suffix.some((arg: any) => {
        const argText = extractWordText(arg);
        if (!argText) return false;

        // Flags that might modify repository state
        return (
          argText.startsWith('--force') ||
          argText.startsWith('-f') ||
          argText.startsWith('--hard') ||
          argText.startsWith('--delete') ||
          argText.startsWith('-d') ||
          argText.startsWith('-D')
        );
      });

      if (hasDangerousFlags) {
        return {
          status: SafetyStatus.YELLOW,
          reasons: [`git ${gitSubcommand} with potentially dangerous flags`],
        };
      }
      // Otherwise stays GREEN - safe read-only git command
      return { status, reasons };
    }

    // Unknown git subcommand
    return {
      status: SafetyStatus.YELLOW,
      reasons: [`git ${gitSubcommand} (unknown subcommand)`],
    };
  },
};
