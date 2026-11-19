import {
  backgroundModeFromRgb,
  parseOsc11Response,
  type BackgroundMode,
} from './tui/presentation/theme/resolve-theme.js';
import { PROGRAM_STATUS_QUERY, PROGRAM_STATUS_REPLY } from '../shared/utils/output/program-status.js';

const OSC11_QUERY = '\u001B]11;?\u001B\\';
/** Primary Device Attributes marks "the replies are done" for terminals answering DA1. */
const DA1_QUERY = '\u001B[c';
const DA1_REPLY = /\u001B\[\?[\d;]*c/;

const DEFAULT_PROBE_TIMEOUT_MS = 150;

type ProbeStdin = Pick<NodeJS.ReadStream, 'isTTY' | 'isRaw' | 'resume' | 'pause' | 'on' | 'off' | 'readableFlowing'> & {
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (encoding: BufferEncoding) => unknown;
};
type ProbeStdout = Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;

export interface ProbeTerminalOptions {
  stdin: ProbeStdin;
  stdout: ProbeStdout;
  /** Ask for the background colour (OSC 11). */
  background: boolean;
  /** Ask whether the terminal speaks OSC 7501 program status. */
  programStatus: boolean;
  timeoutMs?: number;
}

export interface TerminalProbeResult {
  /** `undefined` when not asked or unknown. */
  readonly background: BackgroundMode | undefined;
  /** True only when the terminal answered the OSC 7501 query. */
  readonly programStatus: boolean;
}

/**
 * Asks the terminal the requested questions in one round trip, without ever
 * hanging or leaking bytes.
 *
 * The queries are followed by a Device Attributes query. Terminals answer
 * requests in order and every terminal answers DA1, so receiving the DA1 reply
 * means every other reply has already arrived. A terminal that ignores a query
 * therefore costs one round trip rather than the full timeout, and its DA1
 * reply is consumed here instead of landing in the prompt later. The timeout
 * is only the backstop for a terminal that is silent or a link that drops it.
 *
 * Must run before anything else (such as the Ink app) reads stdin: the replies
 * arrive as input. Resolves "unknown" answers whenever unsure, never throws.
 */
export function probeTerminal(options: ProbeTerminalOptions): Promise<TerminalProbeResult> {
  const { stdin, stdout, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = options;
  const unknown: TerminalProbeResult = { background: undefined, programStatus: false };

  if (
    (!options.background && !options.programStatus) ||
    !stdin.isTTY ||
    !stdout.isTTY ||
    typeof stdin.setRawMode !== 'function'
  ) {
    return Promise.resolve(unknown);
  }
  const setRawMode = stdin.setRawMode.bind(stdin);

  return new Promise((resolve) => {
    const wasRaw = Boolean(stdin.isRaw);
    const wasFlowing = stdin.readableFlowing === true;
    let buffer = '';
    let background: BackgroundMode | undefined;
    let programStatus = false;
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
      resolve({ background, programStatus });
    };

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (options.background) {
        const rgb = parseOsc11Response(buffer);
        if (rgb) background = backgroundModeFromRgb(rgb);
      }
      if (options.programStatus && PROGRAM_STATUS_REPLY.test(buffer)) programStatus = true;
      if (DA1_REPLY.test(buffer)) finish();
    };

    // Armed before the query goes out, so `finish` can always cancel it. The timer
    // measures wall time, and a caller may keep the event loop busy past it while
    // the reply already waits on stdin; libuv runs due timers before it polls input.
    // Giving up from setImmediate, which runs after that poll, reads a reply that has
    // arrived instead of leaving it to land in the prompt.
    const timer = setTimeout(() => setImmediate(finish), timeoutMs);

    try {
      setRawMode(true);
      stdin.on('data', onData);
      stdin.resume();
      stdout.write(
        (options.background ? OSC11_QUERY : '') + (options.programStatus ? PROGRAM_STATUS_QUERY : '') + DA1_QUERY,
      );
    } catch {
      finish();
    }
  });
}
