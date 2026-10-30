/**
 * Generic adapter for the source tool definitions that the old application
 * already assembled for a model/profile/mode. This module does not assemble a
 * second tool graph or reimplement individual tools.
 */
import { z } from 'zod';
import { normalizeToolInput } from '../../../../source/lib/tool-invoke.js';
import { isCancellationError, isHarnessInvariantError } from '../../../../source/lib/harness-invariant-error.js';
import { coerceToText } from '../../../../source/tools/format-helpers.js';
let nextDisplayCallId = 0;
function isZodSchema(schema) {
    return typeof schema?.safeParse === 'function';
}
function runtimeSchema(definition) {
    if (definition.canonicalParameters)
        return definition.canonicalParameters;
    return isZodSchema(definition.parameters) ? definition.parameters : undefined;
}
function asJsonSchema(definition) {
    if (!isZodSchema(definition.parameters))
        return definition.parameters;
    return z.toJSONSchema(definition.parameters);
}
function toolSpec(definition) {
    return {
        name: definition.name,
        description: definition.description,
        inputSchema: asJsonSchema(definition),
        ...(definition.modelTool ? { modelTool: definition.modelTool } : {}),
    };
}
function parseToolInput(definition, raw) {
    const schema = runtimeSchema(definition);
    let parsed;
    if (typeof raw === 'string' && definition.parseModelArguments) {
        parsed = definition.parseModelArguments(raw);
    }
    else {
        const normalized = normalizeToolInput(raw, schema, definition.argumentParsing ?? 'repair');
        try {
            parsed = JSON.parse(normalized);
        }
        catch (error) {
            throw new Error(`Invalid JSON arguments for ${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!schema)
        return parsed;
    const result = schema.safeParse(parsed);
    if (!result.success)
        throw new Error(`Tool input did not match schema for ${definition.name}: ${result.error.message}`);
    return result.data;
}
function defaultInvocation(toolContext) {
    return {
        context: {
            context: undefined,
            approvals: undefined,
            signal: toolContext.signal,
        },
    };
}
function approvalFor(definition, input, toolContext, options) {
    const invocation = options.invocation?.(toolContext, definition, input) ?? defaultInvocation(toolContext);
    const approval = definition.needsApproval(input, invocation.context);
    const wrap = (requiresApproval) => {
        if (!requiresApproval)
            return { kind: 'none' };
        const serialized = JSON.stringify(input);
        return {
            kind: 'ask',
            summary: definition.name,
            ...(serialized ? { detail: serialized } : {}),
        };
    };
    return Promise.resolve(approval).then(wrap);
}
function displayFor(definition, input, result, details) {
    const output = coerceToText(result);
    const detailRecord = details && typeof details === 'object' ? details : undefined;
    const toolCall = detailRecord?.toolCall;
    const suppliedCallId = toolCall && typeof toolCall === 'object' ? toolCall.callId : undefined;
    const callId = typeof suppliedCallId === 'string' && suppliedCallId.length > 0
        ? suppliedCallId
        : `adopted:${definition.name}:${(nextDisplayCallId++).toString(36)}`;
    const item = {
        type: 'function_call_output',
        toolName: definition.name,
        callId,
        arguments: input,
        output,
    };
    const messages = definition.formatCommandMessage(item, 0, new Map([[callId, input]]));
    return definition.approvalPresentation
        ? { messages, approvalPresentation: definition.approvalPresentation }
        : messages;
}
function isProviderOutput(value) {
    if (!Array.isArray(value) || value.length === 0)
        return false;
    return value.every((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part))
            return false;
        const record = part;
        if (record.type === 'text')
            return typeof record.text === 'string';
        if (record.type === 'image') {
            if (!('image' in record))
                return false;
            const image = record.image;
            if (typeof image === 'string' || image === undefined)
                return true;
            if (!image || typeof image !== 'object' || Array.isArray(image))
                return false;
            const reference = image;
            return (typeof reference.id === 'string' ||
                typeof reference.url === 'string' ||
                typeof reference.fileId === 'string' ||
                typeof reference.data === 'string' ||
                reference.data instanceof Uint8Array);
        }
        if (record.type === 'file') {
            if (!('file' in record))
                return false;
            const file = record.file;
            if (typeof file === 'string')
                return true;
            if (!file || typeof file !== 'object' || Array.isArray(file))
                return false;
            const reference = file;
            return (typeof reference.id === 'string' ||
                typeof reference.url === 'string' ||
                ((typeof reference.data === 'string' || reference.data instanceof Uint8Array) &&
                    typeof reference.mediaType === 'string' &&
                    typeof reference.filename === 'string'));
        }
        return false;
    });
}
function displaySafely(definition, input, result, details) {
    try {
        return displayFor(definition, input, result, details);
    }
    catch {
        // Presentation is passive: a formatter failure must not retry a completed side effect.
        return undefined;
    }
}
function adaptTool(definition, options) {
    return {
        spec: toolSpec(definition),
        parse: (raw) => parseToolInput(definition, raw),
        approval: (input, toolContext) => approvalFor(definition, input, toolContext, options),
        async execute(input, toolContext) {
            const invocation = options.invocation?.(toolContext, definition, input) ?? defaultInvocation(toolContext);
            let result;
            try {
                result = await definition.execute(input, invocation.context, invocation.details);
            }
            catch (error) {
                if (toolContext.signal.aborted ||
                    isCancellationError(error) ||
                    isHarnessInvariantError(error) ||
                    options.isMaxTurnsExceeded?.(error)) {
                    throw error;
                }
                return {
                    output: `Error: ${error instanceof Error ? error.message : String(error)}`,
                    isError: true,
                    display: displaySafely(definition, input, error, invocation.details),
                };
            }
            return {
                output: coerceToText(result),
                isError: typeof result === 'object' &&
                    result !== null &&
                    'isError' in result &&
                    typeof result.isError === 'boolean'
                    ? Boolean(result.isError)
                    : false,
                ...(isProviderOutput(result) ? { providerOutput: result } : {}),
                display: displaySafely(definition, input, result, invocation.details),
            };
        },
    };
}
/** Adapt the original assembled tool objects in order, preserving their identity for C1. */
export function createAdoptedToolRegistry(definitions, options = {}) {
    let originals = new Map();
    let adapted = new Map();
    const replaceGeneration = (next) => {
        const nextOriginals = new Map();
        const nextAdapted = new Map();
        for (const definition of next) {
            if (nextOriginals.has(definition.name))
                throw new Error(`Duplicate assembled tool name: ${definition.name}`);
            nextOriginals.set(definition.name, definition);
            nextAdapted.set(definition.name, adaptTool(definition, options));
        }
        originals = nextOriginals;
        adapted = nextAdapted;
    };
    replaceGeneration(definitions);
    return {
        get: (name) => adapted.get(name),
        available: () => [...adapted.values()],
        original: (name) => originals.get(name),
        replaceGeneration,
        originals: (names) => names.map((name) => {
            const definition = originals.get(name);
            if (!definition)
                throw new Error(`Configured tool "${name}" is missing from the assembled tool registry`);
            return definition;
        }),
    };
}
//# sourceMappingURL=index.js.map