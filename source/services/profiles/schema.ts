import { z } from 'zod';
import type {
  EnforcementPolicyDefinition,
  IntegrationDefinition,
  ProfileDefinition,
  ProfileBlock,
  RegisteredBlock,
} from './types.js';

const id = z.string().regex(/^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_./-]*$/i, 'must be a namespaced ID');
const localId = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const operation = z.enum(['replace', 'before', 'after', 'remove']);

const referenceSchema = z
  .object({
    use: id,
    kind: z
      .enum(['instructions', 'context', 'tools', 'enforcement', 'integrations', 'presentation', 'requirements'])
      .optional(),
  })
  .strict();
const instructionEntrySchema = z
  .object({
    id: localId.optional(),
    use: id.optional(),
    content: z.string().optional(),
    systemOwned: z.literal('model-family-base').optional(),
    operation: operation.optional(),
  })
  .strict()
  .refine(
    (entry) =>
      entry.operation === 'remove'
        ? Boolean(entry.id) && !entry.use && !entry.content && !entry.systemOwned
        : Number(Boolean(entry.use)) + Number(Boolean(entry.content)) + Number(Boolean(entry.systemOwned)) === 1,
    'entry requires exactly one of use, content, or systemOwned (or an id for remove)',
  );
const instructionsSchema = z
  .object({
    kind: z.literal('instructions'),
    identity: instructionEntrySchema.optional(),
    workflow: instructionEntrySchema.optional(),
    guidance: z.array(instructionEntrySchema).optional(),
    output: instructionEntrySchema.optional(),
  })
  .strict();
const contextSourceSchema = z
  .object({
    id: localId,
    source: z.string().min(1),
    enabled: z.boolean().optional(),
    priority: z.number().finite().optional(),
    limit: z.number().int().positive().optional(),
    anchor: localId.optional(),
    remove: z.boolean().optional(),
  })
  .strict();
const contextSchema = z
  .object({
    kind: z.literal('context'),
    operation: z.enum(['merge', 'replace']).optional(),
    sources: z.array(contextSourceSchema),
  })
  .strict();
const toolsSchema = z
  .object({
    kind: z.literal('tools'),
    operation: z.enum(['merge', 'replace']).optional(),
    include: z.array(localId).optional(),
    exclude: z.array(localId).optional(),
  })
  .strict();
const enforcementSchema = z.object({ kind: z.literal('enforcement'), policies: z.array(id) }).strict();
const integrationReferenceSchema = z
  .object({ use: id, required: z.boolean(), config: z.record(z.string(), z.unknown()).optional() })
  .strict();
const integrationsSchema = z
  .object({ kind: z.literal('integrations'), integrations: z.array(integrationReferenceSchema) })
  .strict();
const presentationSchema = z
  .object({
    kind: z.literal('presentation'),
    displayName: z.string().optional(),
    description: z.string().optional(),
    label: z.string().optional(),
    color: z.string().optional(),
    marker: z.string().optional(),
  })
  .strict();
const requirementSchema = z
  .object({
    kind: z.enum(['schema-version', 'term2-version', 'capability', 'integration', 'setting']),
    value: z.string().min(1),
  })
  .strict();
const requirementsBlockSchema = z
  .object({ kind: z.literal('requirements'), requirements: z.array(requirementSchema) })
  .strict();

export const profileBlockSchema = z.union([
  referenceSchema,
  instructionsSchema,
  contextSchema,
  toolsSchema,
  enforcementSchema,
  integrationsSchema,
  presentationSchema,
  requirementsBlockSchema,
]);

export const profileDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: localId,
    version: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    extends: id.optional(),
    blocks: z
      .object({
        instructions: profileBlockSchema.optional(),
        context: profileBlockSchema.optional(),
        tools: profileBlockSchema.optional(),
        enforcement: profileBlockSchema.optional(),
        integrations: profileBlockSchema.optional(),
        presentation: profileBlockSchema.optional(),
        requirements: profileBlockSchema.optional(),
      })
      .strict(),
    requires: z.array(requirementSchema).optional(),
  })
  .strict();

export const enforcementPolicySchema = z
  .object({
    id,
    kind: z.literal('enforcement'),
    denials: z.array(localId),
    conflicts: z.array(id).optional(),
    handoffRestriction: z.string().optional(),
  })
  .strict();
export const integrationDefinitionSchema = z
  .object({
    id,
    kind: z.literal('integrations'),
    conflicts: z.array(id).optional(),
    availableByDefault: z.boolean().optional(),
  })
  .strict();

export class ProfileValidationError extends Error {
  readonly issues: readonly z.ZodIssue[];
  constructor(message: string, issues: readonly z.ZodIssue[] = []) {
    super(message);
    this.name = 'ProfileValidationError';
    this.issues = issues;
  }
}

export function validateProfileDefinition(value: unknown): ProfileDefinition {
  const result = profileDefinitionSchema.safeParse(value);
  if (!result.success)
    throw new ProfileValidationError(`Invalid Profile definition: ${result.error.message}`, result.error.issues);
  return result.data;
}

export function validateRegisteredBlock(value: unknown): RegisteredBlock {
  const result = z
    .object({
      id,
      kind: z.enum(['instructions', 'context', 'tools', 'enforcement', 'integrations', 'presentation', 'requirements']),
      definition: z.unknown(),
    })
    .strict()
    .safeParse(value);
  if (!result.success)
    throw new ProfileValidationError(`Invalid registered block: ${result.error.message}`, result.error.issues);
  const definitionSchema = z.union([
    instructionsSchema,
    contextSchema,
    toolsSchema,
    enforcementSchema,
    integrationsSchema,
    presentationSchema,
    requirementsBlockSchema,
    enforcementPolicySchema,
    integrationDefinitionSchema,
  ]);
  const definitionResult = definitionSchema.safeParse(result.data.definition);
  if (!definitionResult.success)
    throw new ProfileValidationError(
      `Invalid registered block definition: ${definitionResult.error.message}`,
      definitionResult.error.issues,
    );
  if (definitionResult.data.kind !== result.data.kind)
    throw new ProfileValidationError(
      `Registered block kind mismatch: expected ${result.data.kind}, got ${definitionResult.data.kind}`,
    );
  return { ...result.data, definition: definitionResult.data } as RegisteredBlock;
}

export function validatePolicy(value: unknown): EnforcementPolicyDefinition {
  const result = enforcementPolicySchema.safeParse(value);
  if (!result.success)
    throw new ProfileValidationError(`Invalid enforcement policy: ${result.error.message}`, result.error.issues);
  return result.data;
}

export function validateIntegration(value: unknown): IntegrationDefinition {
  const result = integrationDefinitionSchema.safeParse(value);
  if (!result.success)
    throw new ProfileValidationError(`Invalid integration: ${result.error.message}`, result.error.issues);
  return result.data;
}

export function isBlockReference(value: ProfileBlock): value is { use: string; kind?: import('./types.js').BlockKind } {
  return 'use' in value && (!('kind' in value) || !('sources' in value));
}
