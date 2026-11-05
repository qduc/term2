/** Physical log rotation keeps the SAME logical Session and its live task/queue owners. */
import { z } from 'zod';
import type { TurnId } from '../engine/index.js';
import type { ContentPart } from '../model/index.js';
import type { DirectCommandOutcome, DirectRolloverRequest } from './command-types.js';
import {
  directConfigurationFactSchema,
  parseDirectConfigurationFact,
  type DirectPreparedConfiguration,
} from './configuration.js';

const identifier = z.string().min(1);
const backingId = z.string().regex(/^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** First accepted line in a successor physical file, continuing the predecessor's real seq.
 * This is neither another session_started nor task/queue snapshots. The same logical
 * projection keeps all background and input ownership while clearing provider context. */
export const directSessionRotationSchema = z
  .object({
    type: z.literal('session_rotated'),
    logicalSessionId: backingId,
    sessionId: backingId,
    predecessor: z.object({ sessionId: backingId, throughSeq: z.number().int().nonnegative().safe() }).strict(),
    commandId: identifier,
    configuration: directConfigurationFactSchema.shape.configuration,
    intent: directConfigurationFactSchema.shape.intent,
    profile: directConfigurationFactSchema.shape.profile,
    history: z.tuple([]),
    handoff: z
      .object({
        clientRequestId: identifier,
        messageId: identifier,
        turnId: identifier.transform((value) => value as TurnId),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DirectSessionRotationFact = z.infer<typeof directSessionRotationSchema>;

/** App prepares only: allocate an unused backing ID, a real replacement graph using
 * the existing native context/memory port, and optional control-origin brief parts.
 * No log, Session, goal copy or model turn may be created before native acceptance.
 * The existing generation install/dispose contract owns retained old graph lifetimes. */
export type DirectPreparedRollover = {
  readonly kind: 'prepared';
  readonly successorId: string;
  readonly generation: DirectPreparedConfiguration;
  readonly handoff?: readonly ContentPart[];
};
export type DirectRolloverPreparer = (
  request: DirectRolloverRequest | undefined,
  signal: AbortSignal,
) => Promise<DirectPreparedRollover | Extract<DirectCommandOutcome, { kind: 'rejected' }>>;

/** Decode only data; reopening never invokes a rollover callback or restarts a task. */
export function parseDirectSessionRotation(raw: unknown): DirectSessionRotationFact {
  const fact = directSessionRotationSchema.parse(raw);
  parseDirectConfigurationFact({
    type: 'configuration_changed',
    configuration: fact.configuration,
    intent: fact.intent,
    profile: fact.profile,
  });
  return fact;
}
