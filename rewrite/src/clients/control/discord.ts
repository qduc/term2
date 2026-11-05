/** Discord stays an independent control-socket client. These clean leaves depend
 * only on node, ws, zod and the v1 transport, never on Session or an engine.
 * No bot is started merely by importing this module.
 */
export { runDiscordBridge } from '../discord/discord-command.js';
export {
  DiscordBridge,
  callDiscordControl,
  parseDiscordBridgeConfig,
  discordStateErrorCode,
  type DiscordBridgeConfig,
} from '../discord/discord-bridge.js';
export { DiscordGatewayNudge } from '../discord/discord-gateway.js';
export { createFailClosedDiscordSend, createSessionDiscordSend } from './discord-send.js';
export {
  sendDiscord,
  type DiscordSend,
  type DiscordSendInput,
  type DiscordSendResult,
} from '../discord/discord-outbound.js';
