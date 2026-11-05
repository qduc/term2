import { z, type ZodTypeAny } from 'zod';

const isZodOptional = (schema: z.ZodTypeAny): schema is z.ZodOptional<any> => schema instanceof z.ZodOptional;

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
export const toOpenAIStrictToolSchema = <T extends ZodTypeAny>(schema: T): ZodTypeAny => {
  if (!(schema instanceof z.ZodObject)) {
    return schema;
  }
  const shape = schema.shape;
  const nextShape: Record<string, z.ZodTypeAny> = {};
  let changed = false;

  for (const [key, value] of Object.entries(shape)) {
    const field = value as z.ZodTypeAny;
    if (isZodOptional(field)) {
      changed = true;
      const description = field.description;
      let transformed: z.ZodTypeAny = field.unwrap().nullable().default(null);
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
  const def = (schema as { _def?: { unknownKeys?: 'passthrough' | 'strict' } })._def;

  if (def?.unknownKeys === 'passthrough') {
    return result.passthrough();
  }

  if (def?.unknownKeys === 'strict') {
    return result.strict();
  }

  return result;
};
