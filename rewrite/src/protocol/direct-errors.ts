import type { WireCommandErrorCode } from './direct-wire.js';

/** A deliberately public command failure. Unexpected exceptions do not leak runtime details. */
export class DirectProtocolError extends Error {
  constructor(readonly code: WireCommandErrorCode, message: string) { super(message); }
}
