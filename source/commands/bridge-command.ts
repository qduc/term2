import type { SlashCommand } from '../slash-commands.js';
import type { ControlSocketServer } from '../services/control-socket/control-socket.js';
import { isControlSocketName } from '../services/control-socket/control-socket.js';

export function createBridgeCommand(input: {
  getServer: () => ControlSocketServer | undefined;
  isStartup: boolean;
  connect?: (name: string) => Promise<ControlSocketServer>;
  disconnect?: (server: ControlSocketServer) => Promise<void>;
  getSessionId: () => string;
  addSystemMessage: (text: string) => void;
}): SlashCommand {
  return {
    name: 'bridge',
    description: 'Connect or disconnect remote Discord bridge input',
    action: (args = '') => {
      const trimmed = args.trim();
      const [action = 'status', ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const server = input.getServer();
      if (action === 'connect') {
        const name = rest[0] ?? 'coord';
        if (rest.length > 1 || !isControlSocketName(name)) {
          input.addSystemMessage('Invalid bridge socket name. Use 1–64 letters, digits, _ or -.');
          return true;
        }
        if (server) {
          input.addSystemMessage(`Bridge already connected (${server.name}); disconnect it before connecting another.`);
          return true;
        }
        if (!input.connect) {
          input.addSystemMessage('Runtime bridge connection is unavailable in this session.');
          return true;
        }
        void input
          .connect(name)
          .then((connected) => {
            input.addSystemMessage(
              `Bridge connected: ${connected.name}; local control socket available at ${connected.socketPath}. Discord input enabled; Discord connectivity is not verified. Approvals and questions remain terminal-only.`,
            );
          })
          .catch((error: unknown) => {
            input.addSystemMessage(
              `Bridge connection failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return true;
      }
      if (action === 'disconnect') {
        if (!server) {
          input.addSystemMessage('Bridge is already disconnected.');
        } else if (input.isStartup || !input.disconnect) {
          input.addSystemMessage('This startup control socket cannot be disconnected at runtime.');
        } else {
          void input
            .disconnect(server)
            .then(() => {
              input.addSystemMessage(`Bridge disconnected: ${server.name}.`);
            })
            .catch((error: unknown) => {
              input.addSystemMessage(
                `Bridge disconnect failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            });
        }
        return true;
      }
      if (action !== 'status' || rest.length) {
        input.addSystemMessage('Usage: /bridge [status|connect [name]|disconnect]');
        return true;
      }
      const startupSocket = input.isStartup
        ? 'created at startup'
        : 'not created at startup (a runtime connection may still be active)';
      input.addSystemMessage(
        server
          ? `Bridge connected: ${server.name}; local control socket available at ${server.socketPath}; Discord input ${
              server.discordInputEnabled ? 'enabled' : 'disabled'
            } (Discord connectivity not verified); session ${input.getSessionId()}; startup socket ${startupSocket}.`
          : `Bridge disconnected; session ${input.getSessionId()}; startup socket ${startupSocket}. To enable remote input, use /bridge connect [name] if that socket name is available.`,
      );
      return true;
    },
  };
}
