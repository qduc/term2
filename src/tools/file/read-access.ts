import type { FileReadAccessPort, NestedReadAccessPort } from '../access-port.js';

/** Prefer root-bound authority; only legacy nested calls consult their session-keyed grant. */
export function isSessionReadGranted(
  resolvedPath: string,
  cwd: string,
  context: unknown,
  deps: { sessionAccess?: FileReadAccessPort; nestedCompatibility?: NestedReadAccessPort },
): boolean {
  if (deps.sessionAccess) return deps.sessionAccess.allowsRead(resolvedPath, cwd);
  const sessionId = getSessionIdFromToolContext(context);
  return !!sessionId && !!deps.nestedCompatibility?.allowsRead(sessionId, resolvedPath, cwd);
}

function getSessionIdFromToolContext(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const runContext = context as { context?: unknown };
  if (!runContext.context || typeof runContext.context !== 'object') return null;
  const sessionId = (runContext.context as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}
