import type { TuiConnection } from './integration.js';
import { resetSession } from './commands.js';
import { displaySessionId } from '../../protocol/session-id.js';

const WELCOME = 'Welcome to term²! Type a message to start chatting.';

/**
 * `/clear`: create the replacement session, then attach it. Returns null on success.
 * `leave` runs first (legacy prints usage as a conversation is left). `begin` arms the new conversation's opening
 * before the reset, which can publish the new session before it answers, and cancels it when the reset fails.
 */
export async function replaceSession(
  connection: TuiConnection,
  switchSession: ((sessionId: string, notice?: string, opening?: readonly string[]) => Promise<void>) | undefined,
  opening: readonly string[] = [WELCOME],
  hooks: {
    readonly leave?: () => Promise<void>;
    readonly begin?: (lines: readonly string[] | null) => void;
  } = {},
): Promise<string | null> {
  const { leave, begin } = hooks;
  await leave?.();
  begin?.(opening);
  try {
    const failure = await attach(connection, switchSession, opening);
    if (failure !== null) begin?.(null);
    return failure;
  } catch (error) {
    begin?.(null);
    throw error;
  }
}

async function attach(
  connection: TuiConnection,
  switchSession: ((sessionId: string, notice?: string, opening?: readonly string[]) => Promise<void>) | undefined,
  opening: readonly string[],
): Promise<string | null> {
  if (!switchSession) throw new Error('Session switching is unavailable in this app.');
  const sessionId = await resetSession(connection);
  try {
    // Legacy /clear (clear-command.ts) opens the new conversation with its welcome line.
    await switchSession(sessionId, undefined, opening);
  } catch (error) {
    throw new Error(
      `Session ${displaySessionId(sessionId)} was created; switching reported: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return null;
}
