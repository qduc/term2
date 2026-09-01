import { createHash } from 'node:crypto';
import {
  isBlockReference,
  validateProfileDefinition,
  validatePolicy,
  validateRegisteredBlock,
  validateIntegration,
} from './schema.js';
import { builtinProfileRegistry, isBuiltinContextSource, isBuiltinToolCapability } from './registry.js';
import type {
  ContextBlock,
  EnforcementBlock,
  InstructionContent,
  InstructionEntry,
  InstructionsBlock,
  IntegrationsBlock,
  ProfileBlock,
  ProfileDefinition,
  ProfileRegistry,
  ProfileResolutionDiagnostic,
  ResolvedContextSource,
  ResolvedInstructionEntry,
  ResolvedProfile,
  Requirement,
  RequirementsBlock,
  ResolveOptions,
  ToolsBlock,
} from './types.js';
import { ProfileResolutionError } from './types.js';

const DEFAULT_MAX_PARENT_DEPTH = 32;
const DEFAULT_MAX_BLOCKS = 128;
const MAX_CONTEXT_LIMIT = 1_000_000;
type BlockSlot =
  | 'instructions'
  | 'context'
  | 'tools'
  | 'enforcement'
  | 'integrations'
  | 'presentation'
  | 'requirements';

interface State {
  instructions: {
    identity: InstructionContent;
    workflow?: InstructionContent;
    guidance: ResolvedInstructionEntry[];
    output?: InstructionContent;
  };
  context: ResolvedContextSource[];
  tools: Set<string>;
  policies: Set<string>;
  denials: Set<string>;
  handoffRestrictions: Set<string>;
  integrations: Map<
    string,
    { id: string; required: boolean; config?: Readonly<Record<string, unknown>>; available: boolean }
  >;
  presentation: { displayName?: string; description?: string; label?: string; color?: string; marker?: string };
  requirements: Requirement[];
}

const diagnostic = (code: string, message: string, path?: string): ProfileResolutionDiagnostic => ({
  code,
  message,
  path,
});
const cloneConfig = (value: Record<string, unknown> | undefined): Readonly<Record<string, unknown>> | undefined =>
  value ? Object.freeze({ ...value }) : undefined;
const readonlySet = <T>(values: Iterable<T>): ReadonlySet<T> => {
  const set = new Set(values);
  return Object.freeze(set);
};
const readonlyMap = <K, V>(values: Iterable<readonly [K, V]>): ReadonlyMap<K, V> => {
  const map = new Map(values);
  return Object.freeze(map);
};
const stableValue = (value: unknown): unknown => {
  if (value instanceof Set) return [...value].sort();
  if (value instanceof Map) return [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  return value;
};
const digestState = (state: State): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        stableValue({
          instructions: state.instructions,
          context: state.context,
          tools: state.tools,
          policies: state.policies,
          denials: state.denials,
          handoffRestrictions: state.handoffRestrictions,
          integrations: state.integrations,
          requirements: state.requirements,
        }),
      ),
    )
    .digest('hex');

const emptyState = (): State => ({
  instructions: { identity: { kind: 'model-family-base' }, guidance: [] },
  context: [],
  tools: new Set(),
  policies: new Set(),
  denials: new Set(),
  handoffRestrictions: new Set(),
  integrations: new Map(),
  presentation: {},
  requirements: [],
});

const appendInstruction = (left: InstructionContent | undefined, right: InstructionContent): InstructionContent => {
  if (!left) return right;
  if (left.kind === 'model-family-base' || right.kind === 'model-family-base') return right;
  return { kind: 'markdown', content: `${left.content}\n\n${right.content}` };
};
function resolveEntry(
  entry: InstructionEntry,
  slot: 'identity' | 'workflow' | 'guidance' | 'output',
  registry: ProfileRegistry,
  diagnostics: ProfileResolutionDiagnostic[],
): InstructionContent | undefined {
  if (entry.systemOwned) return { kind: 'model-family-base' };
  if (entry.content !== undefined) return { kind: 'markdown', content: entry.content };
  if (!entry.use) return undefined;
  const registered = registry.blocks.get(entry.use);
  if (!registered) {
    diagnostics.push(
      diagnostic('unknown-block', `Unknown instruction block '${entry.use}'`, `blocks.instructions.${slot}`),
    );
    return undefined;
  }
  if (registered.kind !== 'instructions') {
    diagnostics.push(
      diagnostic(
        'block-kind-mismatch',
        `Reference '${entry.use}' is not an instruction block`,
        `blocks.instructions.${slot}`,
      ),
    );
    return undefined;
  }
  const block = registered.definition as InstructionsBlock;
  const candidate = slot === 'guidance' ? block.guidance?.[0] : block[slot];
  const nested = candidate ?? block.identity ?? block.workflow;
  if (!nested) {
    diagnostics.push(
      diagnostic('empty-block', `Instruction block '${entry.use}' has no usable entry`, `blocks.instructions.${slot}`),
    );
    return undefined;
  }
  return resolveEntry(nested, slot, registry, diagnostics);
}

function resolveBlock(
  raw: ProfileBlock | undefined,
  expected: BlockSlot,
  registry: ProfileRegistry,
  diagnostics: ProfileResolutionDiagnostic[],
): ProfileBlock | undefined {
  if (!raw) return undefined;
  if (isBlockReference(raw)) {
    const registered = registry.blocks.get(raw.use);
    if (!registered) {
      diagnostics.push(diagnostic('unknown-block', `Unknown block '${raw.use}'`, `blocks.${expected}`));
      return undefined;
    }
    try {
      validateRegisteredBlock(registered);
    } catch (error) {
      diagnostics.push(
        diagnostic('invalid-block', error instanceof Error ? error.message : String(error), `blocks.${expected}`),
      );
      return undefined;
    }
    if (registered.kind !== expected || (raw.kind && raw.kind !== registered.kind)) {
      diagnostics.push(
        diagnostic(
          'block-kind-mismatch',
          `Block '${raw.use}' has kind '${registered.kind}', expected '${expected}'`,
          `blocks.${expected}`,
        ),
      );
      return undefined;
    }
    return registered.definition as ProfileBlock;
  }
  if (!('kind' in raw) || raw.kind !== expected) {
    diagnostics.push(
      diagnostic(
        'block-kind-mismatch',
        `Inline block has kind '${'kind' in raw ? raw.kind : 'unknown'}', expected '${expected}'`,
        `blocks.${expected}`,
      ),
    );
    return undefined;
  }
  return raw;
}

function mergeInstructions(
  state: State,
  block: InstructionsBlock,
  registry: ProfileRegistry,
  diagnostics: ProfileResolutionDiagnostic[],
): void {
  const slots = ['identity', 'workflow', 'output'] as const;
  for (const slot of slots) {
    const entry = block[slot];
    if (!entry) continue;
    const content = resolveEntry(entry, slot, registry, diagnostics);
    if (!content) continue;
    const operation = entry.operation ?? 'replace';
    if (operation !== 'replace' && !(slot === 'workflow' && (operation === 'before' || operation === 'after'))) {
      diagnostics.push(
        diagnostic(
          'unknown-operation',
          `Operation '${operation}' is not valid for instruction slot '${slot}'`,
          `blocks.instructions.${slot}`,
        ),
      );
      continue;
    }
    if (slot === 'identity') state.instructions.identity = content;
    else if (slot === 'workflow') {
      state.instructions.workflow =
        operation === 'before' && state.instructions.workflow
          ? appendInstruction(content, state.instructions.workflow)
          : operation === 'after'
          ? appendInstruction(state.instructions.workflow, content)
          : content;
    } else state.instructions.output = content;
  }
  for (const [index, entry] of (block.guidance ?? []).entries()) {
    if (entry.operation === 'remove') {
      if (entry.id) {
        const existing = state.instructions.guidance.findIndex((item) => item.id === entry.id);
        if (existing >= 0) state.instructions.guidance.splice(existing, 1);
      }
      continue;
    }
    const content = resolveEntry(entry, 'guidance', registry, diagnostics);
    if (!content) continue;
    const id = entry.id ?? `guidance:${content.kind === 'markdown' ? content.content : 'model-family-base'}`;
    const operation = entry.operation ?? 'after';
    const existing = state.instructions.guidance.findIndex((item) => item.id === id);
    if (!['replace', 'before', 'after'].includes(operation)) {
      diagnostics.push(
        diagnostic(
          'unknown-operation',
          `Operation '${operation}' is not valid for guidance`,
          `blocks.instructions.guidance.${index}`,
        ),
      );
      continue;
    }
    const item = { id, content };
    if (existing >= 0) state.instructions.guidance.splice(existing, 1, item);
    else if (operation === 'before') state.instructions.guidance.unshift(item);
    else state.instructions.guidance.push(item);
  }
}

function mergeContext(state: State, block: ContextBlock, diagnostics: ProfileResolutionDiagnostic[]): void {
  if (block.operation === 'replace') state.context = [];
  const byId = new Map(state.context.map((source) => [source.id, source]));
  for (const source of block.sources) {
    if (!isBuiltinContextSource(source.source)) {
      diagnostics.push(
        diagnostic(
          'unknown-context-source',
          `Unknown context source '${source.source}'`,
          `blocks.context.sources.${source.id}`,
        ),
      );
      continue;
    }
    if (source.limit !== undefined && source.limit > MAX_CONTEXT_LIMIT) {
      diagnostics.push(
        diagnostic(
          'resource-limit',
          `Context source '${source.id}' exceeds the application limit`,
          `blocks.context.sources.${source.id}.limit`,
        ),
      );
    }
    if (source.remove) {
      byId.delete(source.id);
      state.context = state.context.filter((item) => item.id !== source.id);
      continue;
    }
    const resolved: ResolvedContextSource = {
      id: source.id,
      source: source.source,
      enabled: source.enabled ?? true,
      priority: source.priority ?? 0,
      ...(source.limit === undefined ? {} : { limit: source.limit }),
    };
    const inherited = byId.get(source.id);
    if (inherited?.limit !== undefined && source.limit !== undefined && source.limit > inherited.limit) {
      diagnostics.push(
        diagnostic(
          'invalid-limit',
          `Context source '${source.id}' cannot increase its inherited limit`,
          `blocks.context.sources.${source.id}.limit`,
        ),
      );
    }
    if (byId.has(source.id)) {
      const index = state.context.findIndex((item) => item.id === source.id);
      state.context[index] = resolved;
    } else if (source.anchor) {
      const index = state.context.findIndex((item) => item.id === source.anchor);
      if (index >= 0) state.context.splice(index, 0, resolved);
      else state.context.push(resolved);
    } else state.context.push(resolved);
    byId.set(source.id, resolved);
  }
}

function mergeTools(state: State, block: ToolsBlock, diagnostics: ProfileResolutionDiagnostic[]): void {
  if (block.operation === 'replace') state.tools.clear();
  const include = new Set(block.include ?? []);
  const exclude = new Set(block.exclude ?? []);
  for (const capability of [...include, ...exclude]) {
    if (!isBuiltinToolCapability(capability)) {
      diagnostics.push(diagnostic('unknown-capability', `Unknown tool capability '${capability}'`, 'blocks.tools'));
    }
  }
  for (const capability of include) if (!exclude.has(capability)) state.tools.add(capability);
  for (const capability of exclude) state.tools.delete(capability);
}

function mergeEnforcement(
  state: State,
  block: EnforcementBlock,
  registry: ProfileRegistry,
  diagnostics: ProfileResolutionDiagnostic[],
): void {
  for (const policyId of block.policies) {
    const policy = registry.policies.get(policyId);
    if (!policy) {
      diagnostics.push(
        diagnostic('unknown-policy', `Unknown enforcement policy '${policyId}'`, 'blocks.enforcement.policies'),
      );
      continue;
    }
    try {
      validatePolicy(policy);
    } catch (error) {
      diagnostics.push(
        diagnostic('invalid-policy', error instanceof Error ? error.message : String(error), 'blocks.enforcement'),
      );
      continue;
    }
    for (const conflict of policy.conflicts ?? []) {
      if (state.policies.has(conflict))
        diagnostics.push(
          diagnostic(
            'conflicting-policy',
            `Enforcement policies '${policyId}' and '${conflict}' conflict`,
            'blocks.enforcement',
          ),
        );
    }
    state.policies.add(policyId);
    for (const denial of policy.denials) state.denials.add(denial);
    if (policy.handoffRestriction) state.handoffRestrictions.add(policy.handoffRestriction);
  }
}

function configsEqual(
  a: Record<string, unknown> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return JSON.stringify(stableValue(a ?? {})) === JSON.stringify(stableValue(b ?? {}));
}

function mergeIntegrations(
  state: State,
  block: IntegrationsBlock,
  registry: ProfileRegistry,
  available: ReadonlyMap<string, boolean>,
  diagnostics: ProfileResolutionDiagnostic[],
): void {
  for (const reference of block.integrations) {
    const definition = registry.integrations.get(reference.use);
    if (!definition) {
      diagnostics.push(
        diagnostic('unknown-integration', `Unknown runtime integration '${reference.use}'`, 'blocks.integrations'),
      );
      continue;
    }
    try {
      validateIntegration(definition);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          'invalid-integration',
          error instanceof Error ? error.message : String(error),
          'blocks.integrations',
        ),
      );
      continue;
    }
    const old = state.integrations.get(reference.use);
    if (old && (old.required !== reference.required || !configsEqual(reference.config, old.config))) {
      diagnostics.push(
        diagnostic(
          'conflicting-integration',
          `Conflicting references to integration '${reference.use}'`,
          'blocks.integrations',
        ),
      );
      continue;
    }
    if (old) continue;
    const isAvailable = available.get(reference.use) ?? definition.availableByDefault ?? false;
    state.integrations.set(reference.use, {
      id: reference.use,
      required: reference.required,
      ...(reference.config ? { config: cloneConfig(reference.config) } : {}),
      available: isAvailable,
    });
    if (definition.conflicts) {
      for (const conflict of definition.conflicts) {
        if (state.integrations.has(conflict))
          diagnostics.push(
            diagnostic(
              'conflicting-integration',
              `Integrations '${reference.use}' and '${conflict}' conflict`,
              'blocks.integrations',
            ),
          );
      }
    }
  }
}

function mergePresentation(state: State, block: ProfileBlock & { kind: 'presentation' }): void {
  state.presentation = {
    ...state.presentation,
    ...Object.fromEntries(Object.entries(block).filter(([key]) => key !== 'kind')),
  };
}

function mergeRequirements(state: State, requirements: readonly Requirement[]): void {
  for (const requirement of requirements) {
    if (!state.requirements.some((item) => item.kind === requirement.kind && item.value === requirement.value))
      state.requirements.push(requirement);
  }
}

function materializeBlock(
  state: State,
  profile: ProfileDefinition,
  registry: ProfileRegistry,
  availableIntegrations: ReadonlyMap<string, boolean>,
  diagnostics: ProfileResolutionDiagnostic[],
): number {
  let count = 0;
  const instructions = resolveBlock(profile.blocks.instructions, 'instructions', registry, diagnostics);
  if (instructions) {
    mergeInstructions(state, instructions as InstructionsBlock, registry, diagnostics);
    count++;
  }
  const context = resolveBlock(profile.blocks.context, 'context', registry, diagnostics);
  if (context) {
    mergeContext(state, context as ContextBlock, diagnostics);
    count++;
  }
  const tools = resolveBlock(profile.blocks.tools, 'tools', registry, diagnostics);
  if (tools) {
    mergeTools(state, tools as ToolsBlock, diagnostics);
    count++;
  }
  const enforcement = resolveBlock(profile.blocks.enforcement, 'enforcement', registry, diagnostics);
  if (enforcement) {
    mergeEnforcement(state, enforcement as EnforcementBlock, registry, diagnostics);
    count++;
  }
  const integrations = resolveBlock(profile.blocks.integrations, 'integrations', registry, diagnostics);
  if (integrations) {
    mergeIntegrations(state, integrations as IntegrationsBlock, registry, availableIntegrations, diagnostics);
    count++;
  }
  const presentation = resolveBlock(profile.blocks.presentation, 'presentation', registry, diagnostics);
  if (presentation) {
    mergePresentation(state, presentation as ProfileBlock & { kind: 'presentation' });
    count++;
  }
  const requirements = resolveBlock(profile.blocks.requirements, 'requirements', registry, diagnostics);
  if (requirements) {
    mergeRequirements(state, (requirements as RequirementsBlock).requirements);
    count++;
  }
  mergeRequirements(state, profile.requires ?? []);
  return count;
}

function profileKey(id: string, registry: ProfileRegistry): string {
  if (registry.profiles.has(id)) return id;
  if (!id.includes(':') && registry.profiles.has(`builtin:${id}`)) return `builtin:${id}`;
  return id;
}

function availabilityMap(
  registry: ProfileRegistry,
  options: { availableIntegrations?: Iterable<string> | ReadonlyMap<string, boolean> },
): ReadonlyMap<string, boolean> {
  if (options.availableIntegrations instanceof Map) {
    const result = new Map<string, boolean>([...registry.integrations.keys()].map((id) => [id, false]));
    for (const [id, available] of options.availableIntegrations) result.set(id, available);
    return result;
  }
  if (options.availableIntegrations) {
    const result = new Map<string, boolean>([...registry.integrations.keys()].map((id) => [id, false]));
    for (const id of options.availableIntegrations as Iterable<string>) result.set(id, true);
    return result;
  }
  return new Map(
    [...registry.integrations.values()].map((integration) => [integration.id, integration.availableByDefault ?? false]),
  );
}

function requirementSatisfied(
  requirement: Requirement,
  state: State,
  options: { availableCapabilities?: Iterable<string>; availableSettings?: Iterable<string>; term2Version?: string },
): boolean {
  if (requirement.kind === 'schema-version') return requirement.value === '1';
  if (requirement.kind === 'capability') return new Set(options.availableCapabilities ?? []).has(requirement.value);
  if (requirement.kind === 'setting') return new Set(options.availableSettings ?? []).has(requirement.value);
  if (requirement.kind === 'integration') return state.integrations.get(requirement.value)?.available === true;
  if (requirement.kind === 'term2-version') {
    if (!options.term2Version) return false;
    const requested = requirement.value.replace(/^>=\s*/, '');
    if (requirement.value.startsWith('>='))
      return options.term2Version.localeCompare(requested, undefined, { numeric: true }) >= 0;
    return options.term2Version === requested;
  }
  return false;
}

function toResolvedProfile(
  id: string,
  profile: ProfileDefinition,
  state: State,
  parentIds: readonly string[],
  diagnostics: ProfileResolutionDiagnostic[],
  _registry: ProfileRegistry,
  options: { availableCapabilities?: Iterable<string>; availableSettings?: Iterable<string>; term2Version?: string },
): ResolvedProfile {
  if (options.availableCapabilities) {
    const available = new Set(options.availableCapabilities);
    state.tools = new Set([...state.tools].filter((capability) => available.has(capability)));
  }
  const unavailable: ProfileResolutionDiagnostic[] = [];
  for (const requirement of state.requirements) {
    if (!requirementSatisfied(requirement, state, options))
      diagnostics.push(
        diagnostic(
          'unsatisfied-requirement',
          `Requirement '${requirement.kind}:${requirement.value}' is not satisfied`,
          `requires.${requirement.kind}`,
        ),
      );
  }
  for (const integration of state.integrations.values()) {
    if (!integration.available) {
      const item = diagnostic(
        'unavailable-integration',
        `Integration '${integration.id}' is unavailable`,
        'blocks.integrations',
      );
      if (integration.required) unavailable.push(item);
      else diagnostics.push(item);
    }
  }
  if (unavailable.length) {
    throw new ProfileResolutionError(
      `Profile '${id}' is unavailable: ${unavailable.map((item) => item.message).join('; ')}`,
      unavailable,
    );
  }
  const provenanceName = id.split(':', 1)[0];
  const provenance = {
    namespace: (provenanceName === 'user' || provenanceName === 'project' ? provenanceName : 'builtin') as
      | 'builtin'
      | 'user'
      | 'project',
    source: id,
  };
  const availabilityDiagnostics = diagnostics
    .filter((item) => item.code === 'unavailable-integration' || item.code === 'unsatisfied-requirement')
    .map((item) => ({
      code: item.code as 'unavailable-integration' | 'unsatisfied-requirement',
      message: item.message,
      reference: item.path ?? '',
    }));
  return Object.freeze({
    identity: Object.freeze({
      id,
      version: profile.version,
      digest: digestState(state),
      provenance,
      parentIds: [...parentIds],
    }),
    instructions: Object.freeze({
      identity: state.instructions.identity,
      ...(state.instructions.workflow ? { workflow: state.instructions.workflow } : {}),
      guidance: Object.freeze([...state.instructions.guidance]),
      ...(state.instructions.output ? { output: state.instructions.output } : {}),
    }),
    context: Object.freeze({ sources: Object.freeze([...state.context]) }),
    tools: Object.freeze({ capabilities: readonlySet(state.tools) }),
    enforcement: Object.freeze({
      policies: readonlySet(state.policies),
      denials: readonlySet(state.denials),
      handoffRestrictions: readonlySet(state.handoffRestrictions),
    }),
    integrations: readonlyMap(state.integrations),
    presentation: Object.freeze({ ...state.presentation }),
    requirements: Object.freeze({ requirements: Object.freeze([...state.requirements]) }),
    availability: Object.freeze({
      available: !availabilityDiagnostics.some((item) => item.code === 'unsatisfied-requirement'),
      diagnostics: availabilityDiagnostics,
    }),
  });
}

function resolveFrom(
  id: string,
  registry: ProfileRegistry,
  options: ResolveOptions,
  stack: string[],
  depth: number,
  blocksAlreadyReferenced = 0,
): ResolvedProfile {
  const diagnostics: ProfileResolutionDiagnostic[] = [];
  const maxDepth = options.maxParentDepth ?? DEFAULT_MAX_PARENT_DEPTH;
  if (depth > maxDepth)
    throw new ProfileResolutionError(`Profile parent-chain depth exceeds ${maxDepth}`, [
      diagnostic('resource-limit', 'Maximum parent-chain depth exceeded'),
    ]);
  const key = profileKey(id, registry);
  const cycleAt = stack.indexOf(key);
  if (cycleAt >= 0) {
    const cycle = [...stack.slice(cycleAt), key];
    throw new ProfileResolutionError(`Profile inheritance cycle: ${cycle.join(' -> ')}`, [
      diagnostic('inheritance-cycle', cycle.join(' -> '), 'extends'),
    ]);
  }
  const rawProfile = registry.profiles.get(key);
  if (!rawProfile)
    throw new ProfileResolutionError(`Missing parent or Profile '${key}'`, [
      diagnostic('missing-parent', `Profile '${key}' was not found`),
    ]);
  let profile: ProfileDefinition;
  try {
    profile = validateProfileDefinition(rawProfile);
  } catch (error) {
    throw new ProfileResolutionError(`Invalid Profile '${key}'`, [
      diagnostic('invalid-definition', error instanceof Error ? error.message : String(error)),
    ]);
  }
  const available = availabilityMap(registry, options);
  let state = emptyState();
  let parentIds: string[] = [];
  const declaredBlockCount = Object.values(profile.blocks).filter(Boolean).length;
  if (declaredBlockCount + blocksAlreadyReferenced > (options.maxBlocks ?? DEFAULT_MAX_BLOCKS))
    throw new ProfileResolutionError(`Profile '${key}' exceeds the block limit`, [
      diagnostic('resource-limit', 'Maximum referenced block count exceeded'),
    ]);
  if (profile.extends) {
    const parentKey = profileKey(profile.extends, registry);
    const parent = resolveFrom(
      parentKey,
      registry,
      options,
      [...stack, key],
      depth + 1,
      blocksAlreadyReferenced + declaredBlockCount,
    );
    state = {
      instructions: {
        identity: parent.instructions.identity,
        ...(parent.instructions.workflow ? { workflow: parent.instructions.workflow } : {}),
        guidance: [...parent.instructions.guidance],
        ...(parent.instructions.output ? { output: parent.instructions.output } : {}),
      },
      context: [...parent.context.sources],
      tools: new Set(parent.tools.capabilities),
      policies: new Set(parent.enforcement.policies),
      denials: new Set(parent.enforcement.denials),
      handoffRestrictions: new Set(parent.enforcement.handoffRestrictions),
      integrations: new Map(parent.integrations),
      presentation: { ...parent.presentation },
      requirements: [...parent.requirements.requirements],
    };
    parentIds = [parent.identity.id, ...parent.identity.parentIds];
  }
  const blocks = materializeBlock(state, profile, registry, available, diagnostics);
  if (blocks > (options.maxBlocks ?? DEFAULT_MAX_BLOCKS))
    throw new ProfileResolutionError(`Profile '${key}' exceeds the block limit`, [
      diagnostic('resource-limit', 'Maximum referenced block count exceeded'),
    ]);
  const fatal = diagnostics.filter((item) => item.code !== 'unavailable-integration');
  if (fatal.length)
    throw new ProfileResolutionError(
      `Cannot resolve Profile '${key}': ${fatal.map((item) => `${item.code}: ${item.message}`).join('; ')}`,
      fatal,
    );
  return toResolvedProfile(key, profile, state, parentIds, diagnostics, registry, options);
}

export function resolveProfile(
  profileId: string,
  registry?: ProfileRegistry,
  options?: ResolveOptions,
): ResolvedProfile;
export function resolveProfile(profileId: string, options?: ResolveOptions): ResolvedProfile;
export function resolveProfile(
  profileId: string,
  registryOrOptions: ProfileRegistry | ResolveOptions = builtinProfileRegistry,
  options: ResolveOptions = {},
): ResolvedProfile {
  const registry = 'profiles' in registryOrOptions ? registryOrOptions : builtinProfileRegistry;
  const actualOptions = 'profiles' in registryOrOptions ? options : registryOrOptions;
  return resolveFrom(profileId, registry, actualOptions, [], 0);
}

export const createProfileRegistry = (input: {
  profiles: Iterable<ProfileDefinition> | ReadonlyMap<string, ProfileDefinition>;
  blocks?: Iterable<unknown> | ReadonlyMap<string, unknown>;
  policies?: Iterable<unknown> | ReadonlyMap<string, unknown>;
  integrations?: Iterable<unknown> | ReadonlyMap<string, unknown>;
}): ProfileRegistry => {
  const entries = <T>(values: Iterable<T> | ReadonlyMap<string, T>): [string, T][] => {
    if (values instanceof Map) return [...values.entries()];
    const result: [string, T][] = [];
    for (const value of values as Iterable<T>) result.push([(value as { id: string }).id, value]);
    return result;
  };
  const profiles = entries(input.profiles).map(
    ([id, profile]) =>
      [id.includes(':') ? id : `builtin:${id}`, validateProfileDefinition(profile as unknown)] as const,
  );
  if (new Set(profiles.map(([id]) => id)).size !== profiles.length)
    throw new ProfileResolutionError('Duplicate Profile identity in registry', [
      diagnostic('duplicate-id', 'Duplicate Profile identity'),
    ]);
  const blocks = entries(input.blocks ?? []).map(([, value]) => {
    const block = validateRegisteredBlock(value);
    return [block.id, block] as const;
  });
  if (new Set(blocks.map(([id]) => id)).size !== blocks.length)
    throw new ProfileResolutionError('Duplicate block identity in registry', [
      diagnostic('duplicate-id', 'Duplicate block identity'),
    ]);
  const policies = entries(input.policies ?? []).map(([, value]) => {
    const policy = validatePolicy(value);
    return [policy.id, policy] as const;
  });
  const integrations = entries(input.integrations ?? []).map(([, value]) => {
    const integration = validateIntegration(value);
    return [integration.id, integration] as const;
  });
  if (new Set(policies.map(([id]) => id)).size !== policies.length)
    throw new ProfileResolutionError('Duplicate policy identity in registry', [
      diagnostic('duplicate-id', 'Duplicate policy identity'),
    ]);
  if (new Set(integrations.map(([id]) => id)).size !== integrations.length)
    throw new ProfileResolutionError('Duplicate integration identity in registry', [
      diagnostic('duplicate-id', 'Duplicate integration identity'),
    ]);
  return {
    profiles: new Map(profiles),
    blocks: new Map(blocks),
    policies: new Map(policies),
    integrations: new Map(integrations),
  };
};
