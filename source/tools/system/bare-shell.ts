import type { AnyScriptedToolDefinition } from '../types.js';
import { shellParametersSchema, type ShellToolDefinition } from './shell.js';

const foregroundShellParameters = shellParametersSchema
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

const backgroundShellParameters = foregroundShellParameters.extend({
  background: shellParametersSchema.shape.background,
  monitor: shellParametersSchema.shape.monitor,
});

/**
 * Advertise a compact option set for bare. Background options appear only when
 * the session has a background job registry (interactive roots); headless runs
 * stay foreground-only. Keep the canonical schema, executor and approval policy intact.
 */
export function presentBareShell(
  tool: ShellToolDefinition,
  options: { background: boolean } = { background: false },
): AnyScriptedToolDefinition {
  return {
    ...tool,
    description:
      'Run shell commands for reads, searches and local checks. Combine known dependent steps in one command; ' +
      'batch independent reads and return only relevant evidence. Make file edits with the shell too. ' +
      (options.background
        ? 'Set background: true for long-running work; add monitor in the same call and wait for shell_output notifications instead of polling. '
        : 'Foreground execution only. ') +
      'Respect approvals; unsandboxed execution requires approval.',
    parameters: options.background ? backgroundShellParameters : foregroundShellParameters,
    canonicalParameters: shellParametersSchema,
  };
}
