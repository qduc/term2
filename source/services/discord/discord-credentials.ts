import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Resolve the default config without reading it; explicit paths must remain absolute. */
export function discordConfigPath(explicit?: string): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const selected = explicit ?? path.join(base, 'term2', 'discord.json');
  if (!path.isAbsolute(selected) || (!explicit && !path.isAbsolute(base))) {
    throw new Error('Discord config path must be absolute');
  }
  return selected;
}

function privateStat(stat: fs.Stats, directory: boolean): void {
  if (
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error('Unsafe Discord credential permissions');
}

function credentialDirectory(config: string, create: boolean): string {
  const dir = path.dirname(config);
  // Reject symlinks in every component, including ancestors of the private directory.
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe credential directory');
  }
  privateStat(fs.lstatSync(dir), true);
  return dir;
}

function validToken(token: string): string {
  if (!token || /\s/.test(token)) throw new Error('Invalid Discord credential');
  return token;
}

/** Load environment first, otherwise a private no-follow regular file beside config. */
export function loadDiscordToken(config: string): string {
  if (process.env.TERM2_DISCORD_BOT_TOKEN !== undefined) {
    return validToken(process.env.TERM2_DISCORD_BOT_TOKEN);
  }
  const file = path.join(credentialDirectory(config, false), 'discord.token');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    privateStat(fs.fstatSync(fd), false);
    return validToken(fs.readFileSync(fd, 'utf8').replace(/\n$/, ''));
  } finally {
    fs.closeSync(fd);
  }
}

/** Explicit rotation: atomically replace a private credential, never chmod unsafe existing files. */
export function saveDiscordToken(config: string, token: string): void {
  validToken(token);
  const dir = credentialDirectory(config, true);
  const file = path.join(dir, 'discord.token');
  try {
    privateStat(fs.lstatSync(file), false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(dir, `.discord-token-${crypto.randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    privateStat(fs.fstatSync(fd), false);
    fs.writeFileSync(fd, token + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const parent = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** Hidden entry only on a terminal; restore terminal state and listeners on every exit path. */
export async function promptDiscordToken(): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || !process.stderr.isTTY) throw new Error('Token enrollment requires a TTY');
  const raw = input.isRaw;
  const flowing = input.readableFlowing === true;
  try {
    input.setRawMode(true);
    process.stderr.write('Discord bot token (hidden): ');
    input.resume();
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const cleanup = () => {
        input.off('data', data);
        input.off('error', cancel);
        input.off('end', cancel);
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      };
      const cancel = () => {
        cleanup();
        reject(new Error('Token enrollment canceled'));
      };
      const data = (chunk: Buffer) => {
        for (const byte of chunk) {
          if (byte === 3 || byte === 4 || byte === 27) {
            cancel();
            return;
          }
          if (byte === 13 || byte === 10) {
            cleanup();
            try {
              resolve(validToken(value));
            } catch {
              reject(new Error('Invalid Discord credential'));
            }
            return;
          }
          if (byte === 127 || byte === 8) value = value.slice(0, -1);
          else value += String.fromCharCode(byte);
        }
      };
      input.on('data', data);
      input.once('error', cancel);
      input.once('end', cancel);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
    });
  } finally {
    input.setRawMode(raw);
    if (!flowing) input.pause();
    process.stderr.write('\n');
  }
}
