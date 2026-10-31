import { randomUUID } from 'node:crypto';
import type { DirectConnection } from '../../host/in-process-direct-types.js';
import type { WireCommandResult, WireDecision } from '../../protocol/direct-wire.js';

function requireAccepted(result: WireCommandResult): void {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  if (result.kind !== 'accepted') throw new Error(`Unexpected command response: ${result.kind}`);
}

/** Submit a fresh message; a successful admission is not turn completion. */
export async function submitText(connection: DirectConnection, text: string): Promise<void> {
  const result = await connection.send({ type: 'submit', requestId: randomUUID(), text, origin: { kind: 'tui' } });
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  if (result.kind !== 'admitted') throw new Error(`Unexpected submit response: ${result.kind}`);
  const admission = result.admission.kind === 'duplicate' ? result.admission.original : result.admission;
  if (admission.kind === 'rejected') throw new Error(admission.reason);
}

/** Resolve exactly the identified pending request through the direct protocol. */
export async function answerInteraction(connection: DirectConnection, requestId: string, decision: WireDecision): Promise<void> {
  requireAccepted(await connection.send({ type: 'answer', requestId, decision }));
}

/** Request foreground cancellation without closing the connection. */
export async function cancelForeground(connection: DirectConnection): Promise<void> {
  requireAccepted(await connection.send({ type: 'cancel' }));
}

/** Handle slash operations with unambiguous direct wire equivalents; return false for app-owned commands. */
export async function directSlashCommand(connection: DirectConnection, input: string): Promise<boolean> {
  switch (input.trim()) {
    case '/compact': requireAccepted(await connection.send({ type: 'compact' })); return true;
    case '/retry-turn': requireAccepted(await connection.send({ type: 'retry', target: 'turn' })); return true;
    case '/retry-tool': requireAccepted(await connection.send({ type: 'retry', target: 'tool' })); return true;
    default: return false;
  }
}
