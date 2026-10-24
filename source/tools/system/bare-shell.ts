import type { AnyScriptedToolDefinition } from '../types.js';
import { shellParametersSchema, type ShellToolDefinition } from './shell.js';

const bareShellParameters = shellParametersSchema
  .pick({
    command: true,
    description: true,
    timeout_ms: true,
    max_output_length: true,
    sandbox: true,
  })
  .extend({
    command: shellParametersSchema.shape.command.describe(
      'Shell command. Batch related reads and filter output locally.',
    ),
    description: shellParametersSchema.shape.description.describe('Short user-visible description.'),
    timeout_ms: shellParametersSchema.shape.timeout_ms.describe(
      'Finite deadline in milliseconds; size explicitly for long work. A timeout is not permission to repeat effects.',
    ),
    max_output_length: shellParametersSchema.shape.max_output_length.describe(
      'Output character limit. Overflow is saved to a file; inspect relevant ranges instead of rerunning.',
    ),
  });

/**
 * Advertise only foreground options for bare, which has no background-task
 * capability. Keep the canonical schema, executor and approval policy intact.
 */
export function presentBareShell(tool: ShellToolDefinition): AnyScriptedToolDefinition {
  return {
    ...tool,
    description:
      'Run shell commands for reads, searches and local checks. Combine known dependent steps in one command; ' +
      'batch independent reads and return only relevant evidence. Use file editors for changes. ' +
      'Foreground execution only. Respect approvals; unsandboxed execution requires approval.',
    parameters: bareShellParameters,
    canonicalParameters: shellParametersSchema,
  };
}
