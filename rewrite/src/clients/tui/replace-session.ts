import { randomUUID } from 'node:crypto';
import type { TuiConnection } from './integration.js';
import { receiptNotice, resetSession, sendNativeCommand } from './commands.js';

export const WELCOME = 'Welcome to term²! Type a message to start chatting.';

/**
 * `/clear` or `/rollover`: create the replacement session, then attach it.
 * Returns a notice (and attaches nothing) when a rollover did not finish; null on success.
 * `begin` arms the new conversation's opening before the reset, which can publish the new session before it
 * answers, and cancels it when the reset fails.
 */
export async function replaceSession(
  connection: TuiConnection,
  command: '/clear' | '/rollover',
  switchSession: ((sessionId: string, notice?: string, opening?: readonly string[]) => Promise<void>) | undefined,
  opening: readonly string[] | undefined = command === '/clear' ? [WELCOME] : undefined,
  begin?: (lines: readonly string[] | null) => void,
): Promise<string | null> {
  if (opening) begin?.(opening);
  try {
    const failure = await attach(connection, command, switchSession, opening);
    if (failure !== null) begin?.(null);
    return failure;
  } catch (error) {
    begin?.(null);
    throw error;
  }
}

async function attach(
  connection: TuiConnection,
  command: '/clear' | '/rollover',
  switchSession: ((sessionId: string, notice?: string, opening?: readonly string[]) => Promise<void>) | undefined,
  opening: readonly string[] | undefined,
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
    // Legacy /clear (clear-command.ts) opens the new conversation with its welcome line.
    await switchSession(sessionId, undefined, opening);
  } catch (error) {
    throw new Error(
      `Session ${sessionId} was created; switching reported: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
}
