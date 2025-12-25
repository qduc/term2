import type {CommandHandler} from './types.js';
import {gitHandler} from './git-handler.js';
import {findHandler} from './find-handler.js';
import {sedHandler} from './sed-handler.js';

/**
 * Registry of command-specific handlers
 */
export const commandHandlers = new Map<string, CommandHandler>([
    ['git', gitHandler],
    ['find', findHandler],
    ['sed', sedHandler],
]);

/**
 * Get a handler for a specific command
 * @param commandName The command name
 * @returns The handler if one exists, undefined otherwise
 */
export function getCommandHandler(
    commandName: string,
): CommandHandler | undefined {
    return commandHandlers.get(commandName);
}

// Re-export types for convenience
export type {
    CommandHandler,
    CommandHandlerHelpers,
    CommandHandlerResult,
} from './types.js';
