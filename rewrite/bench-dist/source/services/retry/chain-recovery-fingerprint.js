const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const itemType = (item) => {
    const record = asRecord(item);
    const raw = record ? asRecord(record.rawItem) ?? record : null;
    return typeof raw?.type === 'string' ? raw.type : 'unknown';
};
const itemCallId = (item) => {
    const record = asRecord(item);
    const raw = record ? asRecord(record.rawItem) ?? record : null;
    const callId = raw?.call_id ?? raw?.callId ?? raw?.tool_call_id ?? raw?.id;
    return typeof callId === 'string' ? callId : '';
};
/** Stable identity of a rejected chain-state request. Never includes text or tool output bodies. */
export function fingerprintChainRequest(input) {
    return JSON.stringify({
        provider: input.provider,
        model: input.model,
        previousResponseId: input.previousResponseId ?? null,
        itemKeys: input.input.map((item) => `${itemType(item)}:${itemCallId(item)}`),
        recoveryClass: input.recoveryClass,
    });
}
//# sourceMappingURL=chain-recovery-fingerprint.js.map