/** Prepare a new physical log generation under the same logical native Session. */
import { randomUUID } from 'node:crypto';
import {
  composeSessionRolloverBrief,
  type SessionRolloverTaskInventoryEntry,
} from '../shared/session-rollover/session-rollover-brief.js';
import type { DirectRolloverRequest } from '../session/command-types.js';
import type { DirectPreparedConfiguration } from '../session/configuration.js';
import type { DirectPreparedRollover } from '../session/session-rotation.js';

/** Prepare only: native owns the reserved rotation, control seed admission and final
 * receipt. The new graph borrows the same logical context; old graphs stay alive.
 * No Session, log, task copy, goal write or model turn is created here. */
export async function prepareSessionRollover(input: {
  readonly previousSessionId: string;
  readonly request: DirectRolloverRequest | undefined;
  readonly signal: AbortSignal;
  readonly taskInventory: () => readonly SessionRolloverTaskInventoryEntry[];
  prepare(): Promise<DirectPreparedConfiguration>;
}): Promise<DirectPreparedRollover> {
  input.signal.throwIfAborted();
  const generation = await input.prepare();
  try {
    input.signal.throwIfAborted();
    return {
      kind: 'prepared',
      successorId: `conv_${randomUUID()}`,
      generation,
      ...(input.request
        ? {
            handoff: [
              {
                type: 'text' as const,
                text: composeSessionRolloverBrief({
                  previousSessionId: input.previousSessionId,
                  request: input.request,
                  taskInventory: input.taskInventory(),
                }),
              },
            ],
          }
        : {}),
    };
  } catch (error) {
    await generation.dispose();
    throw error;
  }
}
