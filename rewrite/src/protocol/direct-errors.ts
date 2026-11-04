import type { WireCommandErrorCode } from './direct-wire.js';

/** A deliberately public command failure. Unexpected exceptions do not leak runtime details. */
export class DirectProtocolError extends Error {
  constructor(
    readonly code: Exclude<WireCommandErrorCode, 'command_rejected' | 'command_interrupted'>,
    message: string,
  ) {
    super(message);
  }
}
