/** Private Session-owned network facts and ordered projection. */
import { isSandboxNetworkHost, isSandboxNetworkPort, } from '../../../../source/utils/shell/sandbox/sandbox-network-validation.js';
const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
export const isNetworkIdentity = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/u.test(value);
export const isNetworkAnswer = (value) => typeof value === 'boolean' ||
    value === 'deny' ||
    value === 'allow-once' ||
    value === 'allow-session' ||
    value === 'allow-project';
export function validateNetworkFact(value) {
    if (value['version'] !== 1 || !isNetworkIdentity(value['requestId']) || !isNetworkIdentity(value['generation']))
        throw new Error('invalid network fact identity or version');
    if (value['type'] === 'session_network_requested') {
        if (!keys(value, ['type', 'version', 'requestId', 'generation', 'host', 'port']) ||
            !isSandboxNetworkHost(value['host']) ||
            (Object.hasOwn(value, 'port') && !isSandboxNetworkPort(value['port'])))
            throw new Error('invalid network request fact');
        return;
    }
    const resolution = value['resolution'];
    if (!keys(value, ['type', 'version', 'requestId', 'generation', 'resolution']) || !object(resolution))
        throw new Error('invalid network resolution fact');
    if (resolution['kind'] === 'answered' &&
        keys(resolution, ['kind', 'answer']) &&
        isNetworkAnswer(resolution['answer']))
        return;
    if (resolution['kind'] === 'cancelled' &&
        keys(resolution, ['kind', 'reason']) &&
        typeof resolution['reason'] === 'string' &&
        ['execution_ended', 'helper_lost', 'session_closed', 'graph_replaced'].includes(resolution['reason']))
        return;
    if (resolution['kind'] === 'recovered' &&
        keys(resolution, ['kind', 'reason']) &&
        resolution['reason'] === 'process_restarted')
        return;
    throw new Error('invalid network resolution');
}
/** Reject impossible history rather than silently making an orphan actionable. */
export function projectNetworkFacts(facts) {
    const seen = new Set();
    const pending = [];
    for (const raw of facts) {
        if (raw.type === 'session_network_requested') {
            const fact = raw;
            if (seen.has(fact.requestId))
                throw new Error('duplicate network request id');
            seen.add(fact.requestId);
            pending.push(fact);
        }
        else if (raw.type === 'session_network_resolved') {
            const fact = raw;
            const index = pending.findIndex((request) => request.requestId === fact.requestId && request.generation === fact.generation);
            if (index < 0 || (fact.resolution.kind === 'answered' && index !== 0))
                throw new Error('invalid network resolution order or identity');
            pending.splice(index, 1);
        }
    }
    return pending;
}
//# sourceMappingURL=network.js.map