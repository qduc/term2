import fs from 'node:fs';
import {
  DiscordConfigPathError,
  discordConfigPath,
  loadDiscordToken,
  promptDiscordToken,
  saveDiscordToken,
} from './discord-credentials.js';
import { setTimeout } from 'node:timers/promises';
import { DiscordBridge, discordStateErrorCode, parseDiscordBridgeConfig } from './discord-bridge.js';
import { DiscordGatewayNudge } from './discord-gateway.js';

const reference = 'docs/reference/discord-bridge.md';
const help = `Discord bridge (candidate) — attach existing opted-in terminal sessions.

Usage:
  term2 discord [ /absolute/path/discord.json ]
  term2 discord --save-token [ /absolute/path/discord.json ]
  term2 discord --help

Default config: $XDG_CONFIG_HOME/term2/discord.json, otherwise ~/.config/term2/discord.json.
Create JSON with channelId, humanUserId, coordinator, stateDir and optional maxHops.
Keep the token out of JSON. --save-token enrolls it with hidden input on a TTY,
stores discord.token beside the config, then exits without starting the bridge.
The config directory must be user-owned/private (0700); token file private (0600).
TERM2_DISCORD_BOT_TOKEN on the bridge process overrides the stored token.

Finish term2 provider setup first and keep an interactive term2 session running.
In that session, opt in locally with /bridge connect [name] (default: coord).
This attaches a local session; it does not verify the standalone bridge can reach Discord.
Only explicit discord_send calls post to Discord; ordinary final answers do not.
Ask: "Reply in Discord using discord_send." Status, approvals and questions stay local.

First-run checklist and reference: ${reference}
https://github.com/qduc/term2/blob/main/${reference}
Candidate: live Discord/mobile validation is still outstanding.
`;

/** Run the opt-in bridge until SIGINT/SIGTERM; credentials stay at the bridge boundary and are never logged. */
export async function runDiscordBridge(argv: string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    process.stdout.write(help);
    return;
  }
  let guidance: string | undefined;
  let bridge: DiscordBridge | undefined;
  let gateway: DiscordGatewayNudge | undefined;
  let stopping = false;
  let wake: (() => void) | undefined;
  let wakePending = false;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  try {
    const enroll = argv[0] === '--save-token';
    const args = enroll ? argv.slice(1) : argv;
    if (args.length > 1 || args.some((arg) => arg.startsWith('-'))) throw new Error('Invalid arguments');
    const configPath = discordConfigPath(args[0]);
    if (enroll) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        guidance =
          'Token enrollment requires a TTY; run term2 discord --save-token [absolute-config-path] in an interactive terminal, not a pipe';
        throw new Error('Non-TTY enrollment');
      }
      saveDiscordToken(configPath, await promptDiscordToken());
      process.stderr.write('[discord] Token saved privately.\n');
      return;
    }
    let contents: string;
    try {
      contents = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        guidance =
          'Missing config; create discord.json at the default location or pass an absolute config path (see term2 discord --help)';
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch (error) {
      if (error instanceof SyntaxError)
        guidance = 'Malformed config JSON; repair the selected discord.json using the example in the reference';
      throw error;
    }
    const config = parseDiscordBridgeConfig(value);
    let token: string;
    try {
      token = loadDiscordToken(configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        guidance =
          'Missing bot token; enroll on a TTY with term2 discord --save-token [absolute-config-path], or supply TERM2_DISCORD_BOT_TOKEN on the bridge process';
      throw error;
    }
    bridge = new DiscordBridge(config, token, {
      runtimeDir: process.env.XDG_RUNTIME_DIR ?? '',
      warn: (message) => process.stderr.write(`[discord] ${message}\n`),
    });
    bridge.open();
    await bridge.listenOutbound();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // Gateway push is a doorbell for the REST read; set TERM2_DISCORD_GATEWAY=off to poll only.
    if (process.env.TERM2_DISCORD_GATEWAY !== 'off') {
      const active = bridge;
      gateway = new DiscordGatewayNudge({
        token,
        channelId: config.channelId,
        humanUserId: config.humanUserId,
        onNudge: () => {
          active.nudge();
          if (wake) wake();
          else wakePending = true; // arrived mid-tick: skip the next sleep
        },
        onLiveChange: (live) => {
          active.setPushLive(live);
          process.stderr.write(`[discord] Gateway push ${live ? 'connected' : 'unavailable; polling every second'}.\n`);
        },
        warn: (message) => process.stderr.write(`[discord] ${message}\n`),
      });
      gateway.start();
    }
    while (!stopping) {
      await bridge.tick();
      if (stopping) break;
      if (wakePending) {
        wakePending = false;
        continue;
      }
      // Sleep one cycle, but wake immediately when the Gateway reports a new message.
      const controller = new AbortController();
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(1000, undefined, { signal: controller.signal }).then(resolve, resolve);
      });
      wake = undefined;
      controller.abort();
    }
  } catch (error) {
    // Fixed guidance only: never echo config values, credentials or arbitrary error text.
    if (error instanceof DiscordConfigPathError)
      guidance =
        'Config path must be absolute; pass /absolute/path/discord.json (XDG_CONFIG_HOME must also be absolute when used)';
    const code = discordStateErrorCode(error);
    guidance ??=
      code === 'config_schema'
        ? 'Invalid config schema; check channelId and humanUserId (numeric strings), coordinator (socket name), stateDir (absolute path) and optional maxHops (1–8) against the reference'
        : code === 'pinned_session_schema'
        ? 'the pinned-session config schema was replaced; remove "sessions" from config, archive the old state directory unchanged and use a fresh stateDir'
        : code === 'journal_state'
        ? 'journal version, shape or config fingerprint mismatch; for a legacy v2 journal, first start this version with the original config before changing coordinator; otherwise archive the existing state directory unchanged and use a fresh stateDir'
        : 'check config, private state directory, credentials and attached sessions. Enroll on a TTY with term2 discord --save-token [absolute-config-path]';
    process.stderr.write(
      `[discord] Bridge stopped: ${guidance}. See ${reference}. Credentials and payloads redacted.\n`,
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    gateway?.stop();
    bridge?.close();
  }
}
