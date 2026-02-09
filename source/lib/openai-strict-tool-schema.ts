import { z } from 'zod';

type AnyZodObject = z.ZodObject<any, any>;

const isZodOptional = (schema: z.ZodTypeAny): schema is z.ZodOptional<any> => schema instanceof z.ZodOptional;

/**
 * OpenAI strict tool schemas require every property to be listed in `required`.
 * To keep tool definitions ergonomic (optional params), we convert optional fields
 * into nullable fields with a null default only for OpenAI tool registration.
 */
export const toOpenAIStrictToolSchema = <T extends AnyZodObject>(schema: T): AnyZodObject => {
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
  const def: any = (schema as any)._def;

  if (def?.unknownKeys === 'passthrough') {
    return result.passthrough();
  }

  if (def?.unknownKeys === 'strict') {
    return result.strict();
  }

  return result;
};
