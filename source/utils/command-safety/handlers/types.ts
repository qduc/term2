import {SafetyStatus} from '../constants.js';

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
    extractWordText: (arg: any) => string | undefined;
    analyzePathRisk: (path: string | undefined) => SafetyStatus;
    hasFindDangerousExecution: (suffix: any[]) => {
        dangerous: boolean;
        reason?: string;
    };
    hasFindSuspiciousFlags: (suffix: any[]) => {
        suspicious: boolean;
        reason?: string;
    };
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
    handle(node: any, helpers: CommandHandlerHelpers): CommandHandlerResult;
}
