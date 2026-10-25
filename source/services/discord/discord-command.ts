import fs from 'node:fs';
import { discordConfigPath, loadDiscordToken, promptDiscordToken, saveDiscordToken } from './discord-credentials.js';
import { setTimeout } from 'node:timers/promises';
import { DiscordBridge, discordStateErrorCode, parseDiscordBridgeConfig } from './discord-bridge.js';

/** Run the opt-in bridge until SIGINT/SIGTERM; credentials stay at the bridge boundary and are never logged. */
export async function runDiscordBridge(argv: string[]): Promise<void> {
  let bridge: DiscordBridge | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  try {
    const enroll = argv[0] === '--save-token';
    const args = enroll ? argv.slice(1) : argv;
    if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) throw new Error('Invalid arguments');
    const configPath = discordConfigPath(args[0]);
    if (enroll) {
      saveDiscordToken(configPath, await promptDiscordToken());
      process.stderr.write('[discord] Token saved privately.\n');
      return;
    }
    const token = loadDiscordToken(configPath);
    const config = parseDiscordBridgeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    bridge = new DiscordBridge(config, token, {
      runtimeDir: process.env.XDG_RUNTIME_DIR ?? '',
      warn: (message) => process.stderr.write(`[discord] ${message}\n`),
    });
    bridge.open();
    await bridge.listenOutbound();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    while (!stopping) {
      await bridge.tick();
      if (!stopping) await setTimeout(1000);
    }
  } catch (error) {
    // Fixed guidance only: never echo config values, credentials or arbitrary error text.
    const code = discordStateErrorCode(error);
    const guidance =
      code === 'pinned_session_schema'
        ? 'the pinned-session config schema was replaced; remove "sessions" from config, archive the old state directory unchanged and use a fresh stateDir'
        : code === 'journal_state'
        ? 'journal version, shape or config fingerprint mismatch; archive the existing state directory unchanged and use a fresh stateDir'
        : 'check config, private state directory, credentials and attached sessions. Enroll on a TTY with term2 discord --save-token [absolute-config-path]';
    process.stderr.write(`[discord] Bridge stopped: ${guidance}. Credentials and payloads redacted.\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    bridge?.close();
  }
}
