import { randomUUID } from 'node:crypto';
import { SAFE_LOG_OPERATIONS, SAFE_LOG_REASONS } from './contracts.js';
// The allowlists live in contracts.ts as const tuples so the union type and the
// runtime set cannot drift: both derive from the same declaration.
const OPERATIONS = new Set(SAFE_LOG_OPERATIONS);
const OUTCOMES = new Set(['allowed', 'denied', 'failed', 'interrupted']);
const REASONS = new Set(SAFE_LOG_REASONS);
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
export function createSafeLogMetadata(input) {
    const value = { schemaVersion: 1, correlationId: input.correlationId ?? randomUUID(), ...input };
    for (const key of Object.keys(value))
        if (!ALLOWED_KEYS.has(key))
            throw new GatewayLogError();
    if (value.schemaVersion !== 1 || typeof value.correlationId !== 'string' || !value.correlationId)
        throw new GatewayLogError();
    if (!OPERATIONS.has(value.operation) ||
        !OUTCOMES.has(value.outcome)) {
        throw new GatewayLogError();
    }
    if (value.reasonCode !== undefined && (typeof value.reasonCode !== 'string' || !REASONS.has(value.reasonCode)))
        throw new GatewayLogError();
    if (value.grantVersion !== undefined && (!Number.isInteger(value.grantVersion) || value.grantVersion < 0))
        throw new GatewayLogError();
    if (value.access !== undefined && value.access !== 'read' && value.access !== 'read_write')
        throw new GatewayLogError();
    for (const key of ['sessionId', 'workspaceId', 'principalRef', 'providerId', 'modelId']) {
        if (value[key] !== undefined &&
            (typeof value[key] !== 'string' || value[key].length > 200 || /[\u0000\r\n]/.test(value[key])))
            throw new GatewayLogError();
    }
    return Object.freeze(value);
}
export class GatewayAuditLog {
    writer;
    constructor(writer) {
        this.writer = writer;
    }
    async write(record) {
        const result = this.writer(record);
        if (!result || typeof result.then !== 'function')
            throw new GatewayLogError();
        await result;
    }
}
//# sourceMappingURL=safe-log.js.map