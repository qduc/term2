import { z } from 'zod';
const isZodOptional = (schema) => schema instanceof z.ZodOptional;
/**
 * OpenAI strict tool schemas require every property to be listed in `required`.
 * To keep tool definitions ergonomic (optional params), we convert optional fields
 * into nullable fields with a null default only for OpenAI tool registration.
 *
 * The parameter type is the full `ZodTypeAny` family (not just `ZodObject`)
 * because the tool contract erases `parameters` to `ZodTypeAny` in its
 * heterogeneous registry; non-object schemas cannot be converted and are passed
 * through unchanged (all current tool parameter schemas are objects).
 */
export const toOpenAIStrictToolSchema = (schema) => {
    if (!(schema instanceof z.ZodObject)) {
        return schema;
    }
    const shape = schema.shape;
    const nextShape = {};
    let changed = false;
    for (const [key, value] of Object.entries(shape)) {
        const field = value;
        if (isZodOptional(field)) {
            changed = true;
            const description = field.description;
            let transformed = field.unwrap().nullable().default(null);
            if (description) {
                transformed = transformed.describe(description);
            }
            nextShape[key] = transformed;
            continue;
        }
        nextShape[key] = field;
    }
    if (!changed) {
        return schema;
    }
    const result = z.object(nextShape);
    const def = schema._def;
    if (def?.unknownKeys === 'passthrough') {
        return result.passthrough();
    }
    if (def?.unknownKeys === 'strict') {
        return result.strict();
    }
    return result;
};
//# sourceMappingURL=openai-strict-tool-schema.js.map