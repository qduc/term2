import { AGENT_EVENT_TYPES } from '@qduc/agent-wire';
export const TERMINAL_AGENT_EVENT_TYPES = new Set([
    'turn_completed',
    'turn_failed',
    'turn_aborted',
]);
export const FROZEN_AGENT_EVENT_TYPES = AGENT_EVENT_TYPES;
export class GatewayPersistenceError extends Error {
    code;
    constructor(code, message = 'gateway persistence rejected the operation') {
        super(message);
        this.name = 'GatewayPersistenceError';
        this.code = code;
    }
}
//# sourceMappingURL=contracts.js.map