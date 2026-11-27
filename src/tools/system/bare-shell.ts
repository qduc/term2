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
    command: shellParametersSchema.shape.command.describe('Batch related reads; filter output locally.'),
    description: shellParametersSchema.shape.description.describe('Short label shown to the user.'),
    timeout_ms: shellParametersSchema.shape.timeout_ms.describe(
      'Finite deadline in ms, sized for long work; not permission to repeat effects.',
    ),
    max_output_length: shellParametersSchema.shape.max_output_length.describe(
      'Output cap; overflow is saved to a file, so inspect ranges instead of rerunning.',
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
      'Run shell commands (reads, searches, checks, edits); batch steps, return only relevant output. ' +
      (options.background
        ? 'To wait, run a background: true command that exits when the wait is over (on success and on failure), then end your turn; its exit wakes you. Add monitor only for lines you must act on before it exits. '
        : '') +
      'Unsandboxed runs need approval.',
    parameters: options.background ? backgroundShellParameters : foregroundShellParameters,
    canonicalParameters: shellParametersSchema,
  };
}
