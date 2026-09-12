import { createHmac, randomUUID } from 'node:crypto';
import { SAFE_LOG_OPERATIONS, SAFE_LOG_REASONS, type GatewaySafeLogMetadata } from './contracts.js';

// The allowlists live in contracts.ts as const tuples so the union type and the
// runtime set cannot drift: both derive from the same declaration.
const OPERATIONS = new Set<string>(SAFE_LOG_OPERATIONS);
const OUTCOMES = new Set<GatewaySafeLogMetadata['outcome']>(['allowed', 'denied', 'failed', 'interrupted']);

const REASONS = new Set<string>(SAFE_LOG_REASONS);
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'sessionId',
  'workspaceId',
  'grantVersion',
  'access',
  'principalRef',
  'providerId',
  'modelId',
  'correlationId',
  'operation',
  'outcome',
  'reasonCode',
]);

export class GatewayLogError extends Error {
  constructor() {
    super('gateway log metadata rejected');
    this.name = 'GatewayLogError';
  }
}

export function principalRef(ownerUserId: string, key: string | Buffer): string {
  return createHmac('sha256', key).update(ownerUserId).digest('base64url').slice(0, 32);
}

export function createSafeLogMetadata(
  input: Omit<GatewaySafeLogMetadata, 'schemaVersion' | 'correlationId'> & {
    correlationId?: string;
  },
): GatewaySafeLogMetadata {
  const value = { schemaVersion: 1, correlationId: input.correlationId ?? randomUUID(), ...input } as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(value)) if (!ALLOWED_KEYS.has(key)) throw new GatewayLogError();
  if (value.schemaVersion !== 1 || typeof value.correlationId !== 'string' || !value.correlationId)
    throw new GatewayLogError();
  if (
    !OPERATIONS.has(value.operation as GatewaySafeLogMetadata['operation']) ||
    !OUTCOMES.has(value.outcome as GatewaySafeLogMetadata['outcome'])
  ) {
    throw new GatewayLogError();
  }
  if (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || !REASONS.has(value.reasonCode)))
    throw new GatewayLogError();
  if (value.grantVersion !== undefined && (!Number.isInteger(value.grantVersion) || (value.grantVersion as number) < 0))
    throw new GatewayLogError();
  if (value.access !== undefined && value.access !== 'read' && value.access !== 'read_write')
    throw new GatewayLogError();
  for (const key of ['sessionId', 'workspaceId', 'principalRef', 'providerId', 'modelId']) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== 'string' || value[key].length > 200 || /[\u0000\r\n]/.test(value[key] as string))
    )
      throw new GatewayLogError();
  }
  return Object.freeze(value as GatewaySafeLogMetadata);
}

export type GatewayAuditWriter = (record: GatewaySafeLogMetadata) => Promise<void>;

export class GatewayAuditLog {
  constructor(private readonly writer: GatewayAuditWriter) {}
  async write(record: GatewaySafeLogMetadata): Promise<void> {
    const result = this.writer(record);
    if (!result || typeof result.then !== 'function') throw new GatewayLogError();
    await result;
  }
}
