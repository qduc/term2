/**
 * Internal core seam for composing a session runtime.
 *
 * Keep this entry free of CLI, Ink, React, and terminal construction. The
 * implementation remains in the existing session composition root until a
 * narrower external session port is justified.
 */
export { createSessionRuntime } from '../services/session/session-composition.js';
//# sourceMappingURL=session-runtime.js.map