import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { DiscordBridge, parseDiscordBridgeConfig } from './discord-bridge.js';

/** Run the opt-in bridge until SIGINT/SIGTERM; tokens are environment-only and never logged. */
export async function runDiscordBridge(argv: string[]): Promise<void> {
  if (argv.length !== 1 || !argv[0]) throw new Error('Usage: term2 discord /absolute/path/config.json');
  let bridge: DiscordBridge | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  try {
    const config = parseDiscordBridgeConfig(JSON.parse(fs.readFileSync(argv[0], 'utf8')));
    bridge = new DiscordBridge(config, process.env.TERM2_DISCORD_BOT_TOKEN ?? '', {
      runtimeDir: process.env.XDG_RUNTIME_DIR ?? '',
      warn: (message) => process.stderr.write(`[discord] ${message}\n`),
    });
    bridge.open();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    while (!stopping) {
      await bridge.tick();
      if (!stopping) await setTimeout(1000);
    }
  } catch {
    process.stderr.write(
      '[discord] Bridge stopped: check config, private state directory, token environment and session mappings. Credentials and payloads redacted.\n',
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    bridge?.close();
  }
}
