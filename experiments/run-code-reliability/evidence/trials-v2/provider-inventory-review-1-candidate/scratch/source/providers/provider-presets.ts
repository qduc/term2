import { z } from 'zod';
import { KNOWN_CUSTOM_PROVIDER_TYPES } from '../services/settings/settings-schema.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const inventory = require('./provider-presets.json');

const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
});
const presetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][-a-z0-9]*$/),
    name: z.string().min(1),
    category: z.enum(['model-api', 'gateway', 'inference', 'local', 'subscription']),
    docsUrl: httpUrl,
    builtinProviderId: z.string().min(1).optional(),
    type: z.enum(KNOWN_CUSTOM_PROVIDER_TYPES).optional(),
    baseUrl: httpUrl.optional(),
  })
  .strict()
  .refine((preset) =>
    preset.builtinProviderId ? !preset.type && !preset.baseUrl : Boolean(preset.type && preset.baseUrl),
  );

const inventorySchema = z
  .object({ schemaVersion: z.literal(1), presets: z.array(presetSchema) })
  .strict()
  .refine(({ presets }) => new Set(presets.map((preset) => preset.id)).size === presets.length, {
    message: 'Preset IDs must be unique',
  });

export type ProviderPreset = z.infer<typeof presetSchema>;

/** Validate a declarative setup inventory; unknown fields and unsupported adapters fail closed. */
export function parseProviderInventory(value: unknown): ProviderPreset[] {
  return inventorySchema.parse(value).presets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export const PROVIDER_PRESETS = parseProviderInventory(inventory);
