import { backgroundModeFromRgb, parseOsc11Response, type BackgroundMode } from './resolve-theme.js';

const OSC11_QUERY = '\u001B]11;?\u001B\\';
/** Primary Device Attributes: every terminal answers it, so it marks "the replies are done". */
const DA1_QUERY = '\u001B[c';
const DA1_REPLY = /\u001B\[\?[\d;]*c/;

export const DEFAULT_DETECTION_TIMEOUT_MS = 150;

type DetectionStdin = Pick<
  NodeJS.ReadStream,
  'isTTY' | 'isRaw' | 'resume' | 'pause' | 'on' | 'off' | 'readableFlowing'
> & {
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (encoding: BufferEncoding) => unknown;
};
type DetectionStdout = Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;

export interface DetectTerminalBackgroundOptions {
  stdin: DetectionStdin;
  stdout: DetectionStdout;
  timeoutMs?: number;
}

/**
 * Asks the terminal whether its background is light or dark (OSC 11), without
 * ever hanging or leaking bytes.
 *
 * The colour query is followed by a Device Attributes query. Terminals answer
 * requests in order and every terminal answers DA1, so receiving the DA1 reply
 * means any colour reply has already arrived. A terminal that ignores OSC 11
 * therefore costs one round trip rather than the full timeout, and its DA1
 * reply is consumed here instead of landing in the prompt later. The timeout
 * is only the backstop for a terminal that is silent or a link that drops it.
 *
 * Must run before the Ink app takes over stdin: the replies arrive as input.
 * Resolves `undefined` whenever the answer is unknown, never throws.
 */
export function detectTerminalBackground(
  options: DetectTerminalBackgroundOptions,
): Promise<BackgroundMode | undefined> {
  const { stdin, stdout, timeoutMs = DEFAULT_DETECTION_TIMEOUT_MS } = options;

  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.resolve(undefined);
  }
  const setRawMode = stdin.setRawMode.bind(stdin);

  return new Promise((resolve) => {
    const wasRaw = Boolean(stdin.isRaw);
    const wasFlowing = stdin.readableFlowing === true;
    let buffer = '';
    let mode: BackgroundMode | undefined;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        setRawMode(wasRaw);
      } catch {
        // Terminal went away; nothing to restore.
      }
      if (!wasFlowing) stdin.pause();
      resolve(mode);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const rgb = parseOsc11Response(buffer);
      if (rgb) {
        mode = backgroundModeFromRgb(rgb);
      }
      if (DA1_REPLY.test(buffer)) {
        finish();
      }
    };

    // Armed before the query goes out, so `finish` can always cancel it.
    const timer = setTimeout(finish, timeoutMs);

    try {
      setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.write(OSC11_QUERY + DA1_QUERY);
    } catch {
      finish();
    }
  });
}
