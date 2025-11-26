import {tool} from '@openai/agents';
import {z} from 'zod';
import {exec} from 'child_process';
import util from 'util';
import {validateCommandSafety} from '../utils/command-safety.js';
import {logValidationError} from '../utils/command-logger.js';

const execPromise = util.promisify(exec);

export const bashTool = tool({
    name: 'bash',
    description:
        'Execute a bash command. Use this to run terminal commands. Assert the safety of the command; if the command does not change system state or read sensitive data, set needsApproval to false. Otherwise set needsApproval to true and wait for user approval before executing.',
    parameters: z.object({
        command: z.string().min(1, 'Command cannot be empty'),
        needsApproval: z.boolean(),
    }),
    needsApproval: async (_context, params) => {
        try {
            return params.needsApproval || validateCommandSafety(params.command);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logValidationError(`Validation failed: ${errorMessage}`);
            return true; // fail-safe: require approval on validation errors
        }
    },
    execute: async ({command}) => {
        try {
            if (
                !command ||
                typeof command !== 'string' ||
                command.trim().length === 0
            ) {
                return JSON.stringify({
                    command,
                    output: 'Error: Command cannot be empty',
                    success: false,
                });
            }

            const {stdout, stderr} = await execPromise(command);
            const output = stderr ? `Error: ${stderr}` : stdout;
            return JSON.stringify({command, output, success: !stderr});
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return JSON.stringify({
                command,
                output: `Error executing command: ${errorMessage}`,
                success: false,
            });
        }
    },
});
