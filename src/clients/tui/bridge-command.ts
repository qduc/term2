import type { TuiIntegration } from './integration.js';
import { displaySessionId } from '../../protocol/session-id.js';

/** Run `/bridge [status|connect [name]|disconnect]` and return the notice to show. */
export async function runBridgeCommand(integration: TuiIntegration, input: string): Promise<string> {
  const tokens = input.trim().split(/\s+/).slice(1);
  const action = tokens[0] ?? 'status';
  if (!integration.bridge) throw new Error('Runtime session attachment is unavailable in this app.');
  if (!['status', 'connect', 'disconnect'].includes(action) || tokens.length > (action === 'connect' ? 2 : 1))
    throw new Error('Usage: /bridge [status|connect [name]|disconnect]');
  const name = tokens[1] ?? 'coord';
  if (action === 'connect' && !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    throw new Error('Invalid bridge socket name. Use 1–64 letters, digits, _ or -.');
  const status =
    action === 'connect'
      ? await integration.bridge.connect(name)
      : action === 'disconnect'
      ? await integration.bridge.disconnect()
      : await integration.bridge.status();
  return status.attachment
    ? `Session attached: ${status.attachment.name}; local control socket ${
        status.attachment.socketPath
      }; Discord input ${
        status.attachment.discordInputEnabled ? 'enabled' : 'disabled'
      } (Discord connectivity not verified); session ${displaySessionId(status.sessionId)}${
        status.startup ? '; startup socket' : ''
      }.`
    : `Session not attached; session ${displaySessionId(
        status.sessionId,
      )}. To enable remote input, use /bridge connect [name].`;
}
