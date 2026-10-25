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
      const [action = 'status', ...rest] = args.trim().split(/\s+/);
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
              `Bridge connected: ${connected.name} (${connected.socketPath}). Discord input is enabled: remote human input can reach this session; approvals and questions remain terminal-only.`,
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
      input.addSystemMessage(
        server
          ? `Bridge connected: ${server.name} (${server.socketPath}); Discord input ${
              server.discordInputEnabled ? 'enabled' : 'disabled'
            }; session ${input.getSessionId()}; startup socket ${input.isStartup ? 'yes' : 'no'}.`
          : `Bridge disconnected; session ${input.getSessionId()}; startup socket no.`,
      );
      return true;
    },
  };
}
