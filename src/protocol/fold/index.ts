/** The shared fold's public surface: the wire vocabulary and the one function that folds it. */
export * from './wire-types.js';
export type * from './wire-events.js';
export * from './wire-commands.js';
export { reduceWireEvent, type WireFoldOptions } from './wire-fold.js';
