/**
 * OSC 7501 program status: a program tells its terminal whether it is idle,
 * working, blocked or finished, so terminals and multiplexers (Ghostty, Rex, hc)
 * can show it without screen scraping.
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 *
 * Only write after the terminal answered `PROGRAM_STATUS_QUERY`. Each report
 * replaces the program's whole record, so every report carries `app`.
 */

export type ProgramState = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export type ProgramBlockedKind = 'permission' | 'question' | 'auth';

/** Feature-detection query; send it before a DA1 query, which bounds the wait. */
export const PROGRAM_STATUS_QUERY = '\u001B]7501;?\u001B\\';
/** Any reply to the query means the terminal speaks the protocol. */
export const PROGRAM_STATUS_REPLY = /\u001B\]7501;\?/;

const APP = /^[A-Za-z0-9_.+-]{1,32}$/;

function programStatusSequence(app: string, state: ProgramState, kind?: ProgramBlockedKind): string {
  if (!APP.test(app)) throw new Error(`Invalid OSC 7501 app name: ${app}`);
  const kindPart = state === 'blocked' && kind ? `:kind=${kind}` : '';
  return `\u001B]7501;state=${state}${kindPart}:app=${app}\u001B\\`;
}

/** `clear` is not a state: without an id it removes every record this terminal holds. */
const PROGRAM_STATUS_CLEAR = '\u001B]7501;state=clear\u001B\\';

export interface ProgramStatusReporter {
  report(state: ProgramState, kind?: ProgramBlockedKind): void;
  clear(): void;
  /** Resolves once every queued report was written or dropped. */
  settled(): Promise<void>;
}

/**
 * Queues reports behind the terminal's answer, in call order. Reports made
 * before the answer arrives are written once it does, or dropped if it never
 * does. A failing write is dropped: status must never break the program.
 */
export function createProgramStatusReporter(
  supported: Promise<boolean>,
  write: (data: string) => void,
  app: string,
): ProgramStatusReporter {
  let queue: Promise<boolean> = supported.catch(() => false);
  const send = (data: string) => {
    queue = queue.then((ok) => {
      if (ok) {
        try {
          write(data);
        } catch {
          // The terminal went away; status is best effort.
        }
      }
      return ok;
    });
  };
  return {
    report: (state, kind) => send(programStatusSequence(app, state, kind)),
    clear: () => send(PROGRAM_STATUS_CLEAR),
    settled: () => queue.then(() => undefined),
  };
}
