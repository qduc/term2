import { gitHandler } from './git-handler.js';
import { findHandler } from './find-handler.js';
import { sedHandler } from './sed-handler.js';
import { rmHandler } from './rm-handler.js';
/**
 * Registry of command-specific handlers
 */
export const commandHandlers = new Map([
    ['git', gitHandler],
    ['find', findHandler],
    ['sed', sedHandler],
    ['rm', rmHandler],
    ['rmdir', rmHandler],
]);
/**
 * Get a handler for a specific command
 * @param commandName The command name
 * @returns The handler if one exists, undefined otherwise
 */
export function getCommandHandler(commandName) {
    return commandHandlers.get(commandName);
}
//# sourceMappingURL=index.js.map