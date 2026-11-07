import type { Command, Word, Redirect, WordPart } from 'unbash';
import { SafetyStatus } from '../constants.js';

/**
 * Result from a command handler
 */
export interface CommandHandlerResult {
  status: SafetyStatus;
  reasons: string[];
}

/**
 * Helper functions passed to command handlers
 */
export interface CommandHandlerHelpers {
  extractWordText: (arg: Word | WordPart | undefined | null) => string | undefined;
  analyzePathRisk: (path: string | undefined) => SafetyStatus;
  hasFindDangerousExecution: (suffix: (Word | Redirect)[]) => {
    dangerous: boolean;
    reason?: string;
  };
  hasFindSuspiciousFlags: (suffix: (Word | Redirect)[]) => {
    suspicious: boolean;
    reason?: string;
  };
  isSessionCreatedFile?: (path: string) => boolean;
}

/**
 * Interface for command-specific safety handlers
 */
export interface CommandHandler {
  /**
   * Handle command-specific safety analysis
   * @param node The AST node representing the command
   * @param helpers Helper functions for analysis
   * @returns Safety status and reasons
   */
  handle(node: Command, helpers: CommandHandlerHelpers): CommandHandlerResult;
}
