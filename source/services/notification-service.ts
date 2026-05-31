import { getTtyWriter, writeOscSequence, type TtyWriter } from '../utils/tty-osc.js';

export interface NotificationOptions {
  env?: NodeJS.ProcessEnv;
  getTtyWriter?: () => TtyWriter | null;
  logger?: {
    info: (msg: string, meta?: any) => void;
    debug: (msg: string, meta?: any) => void;
    warn: (msg: string, meta?: any) => void;
  };
}

/**
 * Terminals that support OSC 777 (notify;title;message).
 * Identified by TERM_PROGRAM or TERM environment variables.
 */
const OSC777_TERM_PROGRAMS = new Set(['ghostty', 'kitty', 'wezterm', 'foot', 'WarpTerminal']);
const OSC777_TERM_PREFIXES = ['xterm-kitty', 'foot'];

function supportsOsc777(env: NodeJS.ProcessEnv): boolean {
  const termProgram = env.TERM_PROGRAM?.toLowerCase();
  if (termProgram && OSC777_TERM_PROGRAMS.has(termProgram)) {
    return true;
  }
  const term = env.TERM?.toLowerCase();
  if (term) {
    if (OSC777_TERM_PROGRAMS.has(term)) return true;
    if (OSC777_TERM_PREFIXES.some((prefix) => term.startsWith(prefix))) return true;
  }
  return false;
}

/**
 * Strip characters that would break OSC sequences: ESC, BEL, and semicolons.
 * Semicolons are used as field separators in OSC 777.
 */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x1b\x07;]/g, '');
}

/**
 * Build the raw OSC escape sequence for a desktop notification.
 * Uses OSC 777 (title + message) on capable terminals, OSC 9 otherwise.
 * Does NOT apply multiplexer wrapping — use writeOscSequence for that.
 */
export function buildNotificationSequence(title: string, message: string, env: NodeJS.ProcessEnv): string {
  const safeTitle = sanitize(title);
  const safeMessage = sanitize(message);

  if (supportsOsc777(env)) {
    return `\x1b]777;notify;${safeTitle};${safeMessage}\x07`;
  }

  return `\x1b]9;${safeMessage}\x07`;
}

/**
 * Send a desktop notification via OSC escape sequence.
 * Silently does nothing if no TTY writer is available.
 */
export function sendNotification(title: string, message: string, opts: NotificationOptions = {}): void {
  const env = opts.env ?? process.env;
  const getWriter = opts.getTtyWriter ?? getTtyWriter;
  const logger = opts.logger;

  if (logger) {
    logger.debug('sendNotification called', {
      title,
      message,
      termProgram: env.TERM_PROGRAM,
      term: env.TERM,
      supportsOsc777: supportsOsc777(env),
    });
  }

  const inner = buildNotificationSequence(title, message, env);

  if (logger) {
    logger.debug('sendNotification built sequence', {
      sequence: JSON.stringify(inner),
    });
  }

  writeOscSequence(inner, { env, getTtyWriter: getWriter });
}
