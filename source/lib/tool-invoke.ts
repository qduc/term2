import type {Tool, FunctionTool} from '@openai/agents';

export const normalizeToolInput = (input: unknown): string => {
    if (typeof input === 'string') {
        return input;
    }

    try {
        const serialized = JSON.stringify(input);
        return typeof serialized === 'string' ? serialized : '';
    } catch {
        return '';
    }
};

export const wrapToolInvoke = <T extends Tool>(tool: T): T => {
    // Only FunctionTool has an invoke method
    if (tool.type !== 'function') {
        return tool;
    }

    const functionTool = tool as FunctionTool;
    const originalInvoke = functionTool.invoke.bind(functionTool);
    functionTool.invoke = async (context: any, input: unknown, details: any) => {
        const normalizedInput = normalizeToolInput(input);
        return originalInvoke(context, normalizedInput, details);
    };

    return tool;
};
