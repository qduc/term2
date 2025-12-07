import type {ZodTypeAny} from 'zod';

export interface ToolDefinition<Params = any> {
    name: string;
    description: string;
    parameters: ZodTypeAny;
    needsApproval: (
        params: Params,
        context?: unknown,
    ) => Promise<boolean> | boolean;
    execute: (params: Params, context?: unknown) => Promise<any> | any;
}
