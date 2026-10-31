import { randomUUID } from 'node:crypto';
import type { Connection } from '../../host/index.js';
import type { WireCommandResult } from '../../protocol/index.js';

function accepted(result: WireCommandResult): void {
  if (!result.ok) throw new Error(result.message);
}

/** Send a fresh user submission; success means admission, not turn completion. */
export async function submitText(connection: Connection, text: string): Promise<void> {
  accepted(await connection.send({ type: 'submit', requestId: randomUUID(), text }));
}

/** Request foreground cancellation without closing the connection. */
export async function cancelForeground(connection: Connection): Promise<void> {
  accepted(await connection.send({ type: 'cancel' }));
}
