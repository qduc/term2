import { randomUUID } from 'node:crypto';
import type { TuiConnection } from './integration.js';
import { receiptNotice, resetSession, sendNativeCommand } from './commands.js';
import { displaySessionId } from '../../protocol/session-id.js';

/**
 * `/clear` or `/rollover`: create the replacement session, then attach it.
 * Returns a notice (and attaches nothing) when a rollover did not finish; null on success.
 */
export async function replaceSession(
  connection: TuiConnection,
  command: '/clear' | '/rollover',
  switchSession: ((sessionId: string) => Promise<void>) | undefined,
): Promise<string | null> {
  if (!switchSession) throw new Error('Session switching is unavailable in this app.');
  let sessionId: string;
  if (command === '/clear') sessionId = await resetSession(connection);
  else {
    const result = await sendNativeCommand(connection, { type: 'rollover', commandId: randomUUID() });
    if (result.kind !== 'finished' || result.receipt.outcome?.kind !== 'rolled_over') return receiptNotice(result);
    sessionId = result.receipt.outcome.sessionId;
  }
  try {
    await switchSession(sessionId);
  } catch (error) {
    throw new Error(
      `Session ${displaySessionId(sessionId)} was created; switching reported: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return null;
}
