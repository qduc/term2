/**
 * The adopted session-fact union and its validator. Production no longer
 * writes these facts; the offline v3 conversation migration
 * (scripts/conversation-migration/v3-input.mjs) imports `validateSessionFact`
 * from the emitted module to check old canonical logs before converting them.
 */
import {
  validateSettingsBaseline,
  type SessionSettingsInitialized,
} from '../../config/settings/session-runtime-settings.js';
import { validateNetworkFact, type NetworkFact } from './network.js';
import type { ModelRef } from '../../model/index.js';
import type { Workspace } from '../../tools/index.js';
import {
  sanitizePendingInteractionDto,
  type PendingInteractionDto,
} from '../../shared/gateway/interaction-protocol.js';
import type { LogEvent } from '../logging/conversation-log-events.js';
import { decodeLogEnvelope } from '../conversation/conversation-decoder.js';

export type { PendingInteractionDto };
export type SessionBinding = {
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly grantVersion: string;
  readonly fingerprint: string;
};

export type SessionLifecycleFact =
  | {
      readonly type: 'session_bound';
      readonly version: 1;
      readonly workspace: Workspace;
      readonly model: ModelRef;
      readonly binding?: SessionBinding;
    }
  | {
      readonly type: 'session_admitted';
      readonly version: 1;
      readonly clientRequestId: string;
      readonly normalizedBodyHash: string;
      readonly turnId: string;
      readonly disposition: 'started' | 'queued';
      readonly createdAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly type: 'session_admission_settled';
      readonly version: 1;
      readonly clientRequestId: string;
      readonly turnId: string;
      readonly result: 'accepted' | 'failed' | 'aborted' | 'queue_discarded';
    }
  | {
      readonly type: 'session_turn_started';
      readonly version: 1;
      readonly turnId: string;
      readonly clientRequestId: string | null;
    }
  | {
      readonly type: 'session_turn_ended';
      readonly version: 1;
      readonly turnId: string;
      readonly outcome: 'completed' | 'cancelled' | 'failed' | 'budget_exhausted';
    }
  | {
      readonly type: 'session_interaction_pending';
      readonly version: 1;
      readonly turnId: string;
      readonly interaction: PendingInteractionDto;
      readonly generation: string;
      readonly settleOnRecovery?: 'child_interrupted';
      readonly child?: { readonly agentId: string; readonly role: string };
    }
  | {
      readonly type: 'session_interaction_recovered';
      readonly version: 1;
      readonly turnId: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly generation: string;
      readonly reason: 'daemon_restart';
    }
  | {
      readonly type: 'session_interaction_resolved';
      readonly version: 1;
      readonly turnId: string;
      readonly interactionId: string;
      readonly revision: number;
      readonly generation: string;
      readonly outcome: 'answered' | 'cancelled' | 'expired';
      readonly answer?: {
        readonly choiceId?: string;
        readonly answers?: readonly (string | readonly string[])[];
        readonly rejectionReason?: string;
      };
    }
  | {
      readonly type: 'session_interrupted';
      readonly version: 1;
      readonly turnId: string | null;
      readonly reason: 'daemon_restart' | 'forced_shutdown';
      readonly interruptedAt: string;
    }
  | {
      readonly type: 'session_closed';
      readonly version: 1;
      readonly closedAt: string;
      readonly retentionEligibleAt: string;
    };

export type SessionFact = LogEvent | SessionLifecycleFact | SessionSettingsInitialized | NetworkFact;
/** Unknown and truncated legacy events are retained verbatim at the decoder boundary. */
const LIFECYCLE_TYPES = new Set([
  'session_settings_initialized',
  'session_network_requested',
  'session_network_resolved',
  'session_bound',
  'session_admitted',
  'session_admission_settled',
  'session_turn_started',
  'session_turn_ended',
  'session_interaction_pending',
  'session_interaction_recovered',
  'session_interaction_resolved',
  'session_interrupted',
  'session_closed',
]);
const NON_EMPTY = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const SHA256 = /^[0-9a-f]{64}$/;
const ADOPTED_USER_TURN_HASH = /^adopted-user-turn-v1:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/;
const isUtcTime = (value: unknown): value is string =>
  typeof value === 'string' && UTC.test(value) && Number.isFinite(Date.parse(value));
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isWorkspace = (value: unknown): value is Workspace =>
  isObject(value) &&
  typeof value['root'] === 'string' &&
  (value['access'] === 'read' || value['access'] === 'read_write') &&
  (value['target'] === 'local' || value['target'] === 'ssh');
const isModel = (value: unknown): value is ModelRef =>
  isObject(value) && typeof value['provider'] === 'string' && typeof value['model'] === 'string';

/** Validate and sanitize lifecycle records at both append and recovery boundaries. */
export function validateSessionFact(value: unknown): asserts value is SessionFact {
  if (!isObject(value) || typeof value['type'] !== 'string')
    throw new Error('session fact must be an object with a type');
  if (!LIFECYCLE_TYPES.has(value['type'])) {
    if (value['truncated'] === true) throw new Error('truncated markers cannot be appended as session facts');
    if (value['type'] === 'session_fact_batch') throw new Error('storage batches cannot be nested as session facts');
    const decoded = decodeLogEnvelope({
      v: 3,
      seq: 1,
      ts: new Date(0).toISOString(),
      logId: 'validate',
      eventId: 'validate',
      event: value,
    });
    if (!decoded) throw new Error(`invalid conversation log fact ${value['type']}`);
    return;
  }
  if (value['version'] !== 1) throw new Error(`invalid ${value['type']} fact version`);
  switch (value['type']) {
    case 'session_settings_initialized':
      validateSettingsBaseline(value);
      return;
    case 'session_network_requested':
    case 'session_network_resolved':
      validateNetworkFact(value);
      return;
    case 'session_bound': {
      if (!isWorkspace(value['workspace']) || !isModel(value['model']))
        throw new Error('invalid session_bound workspace/model');
      const binding = value['binding'];
      if (
        binding !== undefined &&
        (!isObject(binding) ||
          !NON_EMPTY(binding['ownerUserId']) ||
          !NON_EMPTY(binding['workspaceId']) ||
          !NON_EMPTY(binding['grantVersion']) ||
          !NON_EMPTY(binding['fingerprint']))
      )
        throw new Error('invalid session_bound binding');
      return;
    }
    case 'session_admitted':
      if (
        !NON_EMPTY(value['clientRequestId']) ||
        !(
          SHA256.test(String(value['normalizedBodyHash'])) ||
          ADOPTED_USER_TURN_HASH.test(String(value['normalizedBodyHash']))
        ) ||
        !NON_EMPTY(value['turnId']) ||
        !['started', 'queued'].includes(String(value['disposition'])) ||
        !isUtcTime(value['createdAt']) ||
        !isUtcTime(value['expiresAt']) ||
        Date.parse(value['expiresAt']) <= Date.parse(value['createdAt'])
      )
        throw new Error('invalid session_admitted fact');
      return;
    case 'session_admission_settled':
      if (
        !NON_EMPTY(value['clientRequestId']) ||
        !NON_EMPTY(value['turnId']) ||
        !['accepted', 'failed', 'aborted', 'queue_discarded'].includes(String(value['result']))
      )
        throw new Error('invalid session_admission_settled fact');
      return;
    case 'session_turn_started':
      if (!NON_EMPTY(value['turnId']) || !(value['clientRequestId'] === null || NON_EMPTY(value['clientRequestId'])))
        throw new Error('invalid session_turn_started fact');
      return;
    case 'session_turn_ended':
      if (
        !NON_EMPTY(value['turnId']) ||
        !['completed', 'cancelled', 'failed', 'budget_exhausted'].includes(String(value['outcome']))
      )
        throw new Error('invalid session_turn_ended fact');
      return;
    case 'session_interaction_pending': {
      if (!NON_EMPTY(value['turnId']) || !NON_EMPTY(value['generation']))
        throw new Error('invalid session_interaction_pending identity');
      const interaction = sanitizePendingInteractionDto(value['interaction']);
      value['interaction'] = interaction;
      if (value['settleOnRecovery'] !== undefined && value['settleOnRecovery'] !== 'child_interrupted')
        throw new Error('invalid interaction recovery mode');
      if (
        value['child'] !== undefined &&
        (!isObject(value['child']) || !NON_EMPTY(value['child']['agentId']) || !NON_EMPTY(value['child']['role']))
      )
        throw new Error('invalid interaction child metadata');
      return;
    }
    case 'session_interaction_recovered':
      if (
        !NON_EMPTY(value['turnId']) ||
        !NON_EMPTY(value['interactionId']) ||
        !isRevision(value['revision']) ||
        !NON_EMPTY(value['generation']) ||
        value['reason'] !== 'daemon_restart'
      )
        throw new Error('invalid session_interaction_recovered fact');
      return;
    case 'session_interaction_resolved': {
      if (
        !NON_EMPTY(value['turnId']) ||
        !NON_EMPTY(value['interactionId']) ||
        !isRevision(value['revision']) ||
        !NON_EMPTY(value['generation']) ||
        !['answered', 'cancelled', 'expired'].includes(String(value['outcome']))
      )
        throw new Error('invalid session_interaction_resolved fact');
      if (value['answer'] !== undefined) {
        const answer = value['answer'];
        if (
          !isObject(answer) ||
          Object.keys(answer).some((key) => !['choiceId', 'answers', 'rejectionReason'].includes(key))
        )
          throw new Error('invalid interaction answer');
        if (answer['choiceId'] !== undefined && !NON_EMPTY(answer['choiceId']))
          throw new Error('invalid interaction choice');
        if (answer['rejectionReason'] !== undefined && typeof answer['rejectionReason'] !== 'string')
          throw new Error('invalid interaction rejection reason');
        if (
          answer['answers'] !== undefined &&
          (!Array.isArray(answer['answers']) ||
            !answer['answers'].every(
              (item) =>
                typeof item === 'string' || (Array.isArray(item) && item.every((child) => typeof child === 'string')),
            ))
        )
          throw new Error('invalid interaction answers');
      }
      return;
    }
    case 'session_interrupted':
      if (
        !(value['turnId'] === null || NON_EMPTY(value['turnId'])) ||
        !['daemon_restart', 'forced_shutdown'].includes(String(value['reason'])) ||
        !isUtcTime(value['interruptedAt'])
      )
        throw new Error('invalid session_interrupted fact');
      return;
    case 'session_closed':
      if (!isUtcTime(value['closedAt']) || !isUtcTime(value['retentionEligibleAt']))
        throw new Error('invalid session_closed fact');
      return;
  }
}
