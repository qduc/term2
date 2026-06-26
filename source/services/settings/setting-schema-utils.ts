import { SettingsSchema } from './settings-schema.js';

/**
 * Unwrap a Zod schema through optional/nullable/default/effects wrappers to
 * reveal the underlying type. Returns null for null/undefined input.
 *
 * Handles both modern Zod (`.def`) and older Zod (`.\_def`) property names,
 * as well as both `'type'` and `'typeName'` conventions used across Zod versions.
 */
export function unwrapSchema(schema: any): any {
  let current = schema;
  while (current) {
    const def = current.def || current._def;
    if (!def) break;
    const typeName = def.type || def.typeName;
    const isOptional = typeName === 'optional' || typeName === 'ZodOptional';
    const isNullable = typeName === 'nullable' || typeName === 'ZodNullable';
    if (isOptional || isNullable) {
      if (typeof current.unwrap === 'function') {
        current = current.unwrap();
      } else {
        current = def.innerType;
      }
    } else if (typeName === 'default' || typeName === 'ZodDefault') {
      current = def.innerType;
    } else if (typeName === 'effects' || typeName === 'ZodEffects') {
      current = def.schema;
    } else if (typeName === 'pipe' || typeName === 'ZodPipe') {
      // Zod v4: .transform() produces a ZodPipe; follow the input side.
      current = def.in || def.schema;
    } else {
      break;
    }
  }
  return current;
}

/**
 * Navigate a dotted setting key path through the SettingsSchema and return
 * the leaf schema (before unwrapping wrappers). Returns undefined if the path
 * does not exist.
 *
 * At each segment, walks into `.def.shape` for object types and unwraps
 * optional/nullable/default/effects wrappers so nested fields are reachable
 * even when a parent is marked `.optional()`.
 */
export function resolveSettingAtPath(key: string): any {
  if (!key) return undefined;
  const parts = key.split('.');
  let current: any = SettingsSchema;

  for (const part of parts) {
    if (!current) return undefined;

    // Unwrap wrappers at every level so we can reach .optional() children.
    while (current && current._def) {
      const def = current._def;
      const typeName = def.type || def.typeName;
      if (typeName === 'optional' || typeName === 'ZodOptional') {
        current = def.innerType;
      } else if (typeName === 'nullable' || typeName === 'ZodNullable') {
        current = def.innerType;
      } else if (typeName === 'default' || typeName === 'ZodDefault') {
        current = def.innerType;
      } else if (typeName === 'effects' || typeName === 'ZodEffects') {
        current = def.schema;
      } else {
        break;
      }
    }

    if (!current) return undefined;

    // Navigate into object shape.
    const shape = current?._def?.shape;
    if (typeof shape === 'function') {
      // Some Zod versions lazy-evaluate shape via a function.
      current = shape();
    }
    current = current?._def?.shape?.[part];
  }

  return current;
}
