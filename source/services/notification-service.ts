import { getTtyWriter as defaultGetTtyWriter, writeOscSequence, type TtyWriter } from '../utils/output/tty-osc.js';

/**
 * Best-effort terminal notification support.
 *
 * OSC 777 format:
 *   ESC ] 777 ; notify ; <title> ; <message> BEL
 *
 * OSC 9 fallback:
 *   ESC ] 9 ; <message> BEL
 *
 * Bell fallback:
 *   BEL
 *
 * Notes:
 * - kitty is intentionally excluded from OSC 777. It uses OSC 99 and legacy OSC 9.
 * - Bell is not a real desktop notification protocol; it is only an attention signal.
 * - Detection may fail inside tmux/screen/ssh because TERM/TERM_PROGRAM can be rewritten.
 */

type NotificationMethod = 'osc777' | 'osc9' | 'bell' | undefined;

const OSC777_TERM_PROGRAMS = new Set(['ghostty', 'wezterm', 'foot', 'warpterminal']);

const OSC777_TERM_EXACT = new Set(['foot']);

const OSC777_TERM_PREFIXES = ['xterm-ghostty', 'foot'];

const OSC9_TERM_PROGRAMS = new Set(['iterm.app', 'wezterm', 'warpterminal']);

const OSC9_TERM_EXACT = new Set(['rio']);

const OSC9_TERM_PREFIXES = ['wezterm', 'rio'];

export interface NotificationOptions {
  env?: NodeJS.ProcessEnv;
  stream?: NodeJS.WriteStream;
  getTtyWriter?: () => TtyWriter | null;
  logger?: {
    info: (msg: string, meta?: any) => void;
    debug: (msg: string, meta?: any) => void;
    warn: (msg: string, meta?: any) => void;
  };
}

function supportsOsc777(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  if (termProgram && OSC777_TERM_PROGRAMS.has(termProgram)) {
    return true;
  }

  const term = env.TERM?.toLowerCase();
  if (term) {
    if (OSC777_TERM_EXACT.has(term)) return true;
    if (OSC777_TERM_PREFIXES.some((prefix) => term.startsWith(prefix))) {
      return true;
    }
  }

  return false;
}

function canUseBell(env: NodeJS.ProcessEnv = process.env, stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY && !env.CI);
}

function supportsOsc9(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  if (termProgram && OSC9_TERM_PROGRAMS.has(termProgram)) {
    return true;
  }

  const term = env.TERM?.toLowerCase();
  if (term) {
    if (OSC9_TERM_EXACT.has(term)) return true;
    if (OSC9_TERM_PREFIXES.some((prefix) => term.startsWith(prefix))) {
      return true;
    }
  }

  return false;
}

function getNotificationMethod(
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stdout,
): NotificationMethod {
  if (env.CI) return undefined;
  if (supportsOsc777(env)) return 'osc777';
  if (supportsOsc9(env)) return 'osc9';
  if (canUseBell(env, stream)) return 'bell';
  return undefined;
}

function escapeOsc(value: string): string {
  return value.replace(/\x1b/g, '').replace(/\x07/g, '').replace(/;/g, ',');
}

function buildNotificationSequence(
  title: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stdout,
): string {
  const method = getNotificationMethod(env, stream);

  if (method === 'osc777') {
    return `\x1b]777;notify;${escapeOsc(title)};${escapeOsc(message)}\x07`;
  }

  if (method === 'osc9') {
    return `\x1b]9;${escapeOsc(message)}\x07`;
  }

  if (method === 'bell') {
    return '\x07';
  }

  return '';
}

function notify(
  title: string,
  message: string,
  options: {
    env?: NodeJS.ProcessEnv;
    stream?: NodeJS.WriteStream;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  const stream = options.stream ?? process.stdout;

  const method = getNotificationMethod(env, stream);

  if (method === 'osc777') {
    stream.write(`\x1b]777;notify;${escapeOsc(title)};${escapeOsc(message)}\x07`);
    return true;
  }

  if (method === 'osc9') {
    stream.write(`\x1b]9;${escapeOsc(message)}\x07`);
    return true;
  }

  if (method === 'bell') {
    stream.write('\x07');
    return true;
  }

  return false;
}

function sendNotification(title: string, message: string, opts: NotificationOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const logger = opts.logger;
  const stream = opts.stream ?? process.stdout;

  if (logger) {
    logger.debug('sendNotification called', {
      title,
      message,
      termProgram: env.TERM_PROGRAM,
      term: env.TERM,
      supportsOsc777: supportsOsc777(env),
      supportsOsc9: supportsOsc9(env),
      canUseBell: canUseBell(env, stream),
    });
  }

  const getWriter = opts.getTtyWriter ?? defaultGetTtyWriter;
  const writer = getWriter();
  if (!writer) return false;

  const sequence = buildNotificationSequence(title, message, env, stream);
  if (!sequence) return false;

  if (sequence === '\x07') {
    writer(sequence);
    return true;
  }

  writeOscSequence(sequence, { env, getTtyWriter: () => writer });
  return true;
}

export {
  notify,
  supportsOsc777,
  supportsOsc9,
  canUseBell,
  getNotificationMethod,
  buildNotificationSequence,
  sendNotification,
};

export type { NotificationMethod };
