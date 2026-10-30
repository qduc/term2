import { z } from 'zod';
import { isJsonValue } from '../services/agent-runtime/workflow/workflow-types.js';
export function getScriptedReturnContract(tool) {
    return tool.scriptedReturnSchema ? { kind: 'precise', schema: tool.scriptedReturnSchema } : { kind: 'unknown' };
}
/** Convert the owner schema for discovery and the future declaration generator. */
export function scriptedReturnContractJsonSchema(contract) {
    if (contract.kind === 'unknown')
        return { kind: 'unknown' };
    try {
        return { kind: 'precise', schema: z.toJSONSchema(contract.schema, { io: 'output' }) };
    }
    catch {
        // A schema can still validate at runtime when a provider-oriented JSON
        // projection cannot represent it. Discovery must not invent a type.
        return { kind: 'precise', schema: { unconvertible: true } };
    }
}
/** Validate the post-normalization value, before it is sent through the VM. */
export function validateScriptedReturn(tool, value) {
    const contract = getScriptedReturnContract(tool);
    if (contract.kind === 'unknown')
        return { ok: true, value: value };
    const parsed = contract.schema.safeParse(value);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .slice(0, 8)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        return { ok: false, message: issues || 'value did not match the declared schema' };
    }
    if (!isJsonValue(parsed.data))
        return { ok: false, message: 'validated value was not JSON-safe' };
    return { ok: true, value: parsed.data };
}
//# sourceMappingURL=scripted-return-contract.js.map