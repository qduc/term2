import type { TuiConnection, TuiIntegration } from './integration.js';

/** `!command` runs a shell command in the workspace without a model turn; every refusal is an Error the composer keeps. */
export async function runBangShell(
  integration: TuiIntegration,
  connection: TuiConnection,
  input: string,
  hasAttachments: boolean,
  turnActive: boolean,
): Promise<string> {
  const command = input.slice(1).trim();
  if (!command) throw new Error('Enter a shell command after !.');
  if (!integration.shell) throw new Error('Direct shell is not available in this session.');
  if (hasAttachments) throw new Error('Remove attachments before running a shell command.');
  if (turnActive) throw new Error('Wait for the current turn to finish before running a shell command.');
  return integration.shell(connection.sessionId, command);
}
