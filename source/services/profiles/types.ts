import type { z } from 'zod';

export type ProfileId = `builtin:${string}` | `user:${string}` | `project:${string}`;
export type BlockId = ProfileId;
export type BlockKind =
  | 'instructions'
  | 'context'
  | 'tools'
  | 'enforcement'
  | 'integrations'
  | 'presentation'
  | 'requirements';

export interface BlockReference {
  use: string;
  /** Optional assertion which is checked against the registry entry. */
  kind?: BlockKind;
}

export type InstructionContent = { kind: 'model-family-base' } | { kind: 'markdown'; content: string };

export interface InstructionEntry {
  id?: string;
  use?: string;
  content?: string;
  systemOwned?: 'model-family-base';
  operation?: 'replace' | 'before' | 'after' | 'remove';
}

export interface InstructionsBlock {
  kind: 'instructions';
  identity?: InstructionEntry;
  workflow?: InstructionEntry;
  guidance?: InstructionEntry[];
  output?: InstructionEntry;
}

export interface ContextSource {
  id: string;
  source: string;
  enabled?: boolean;
  priority?: number;
  limit?: number;
  anchor?: string;
  remove?: boolean;
}

export interface ContextBlock {
  kind: 'context';
  operation?: 'merge' | 'replace';
  sources: ContextSource[];
}

export interface ToolsBlock {
  kind: 'tools';
  operation?: 'merge' | 'replace';
  include?: string[];
  exclude?: string[];
}

export interface EnforcementPolicyDefinition {
  id: string;
  kind: 'enforcement';
  denials: string[];
  conflicts?: string[];
  handoffRestriction?: string;
}

export interface EnforcementBlock {
  kind: 'enforcement';
  policies: string[];
}

export interface IntegrationDefinition {
  id: string;
  kind: 'integrations';
  conflicts?: string[];
  /** Trusted registry metadata; Profile data itself remains declarative. */
  availableByDefault?: boolean;
}

export interface IntegrationReference {
  use: string;
  required: boolean;
  config?: Record<string, unknown>;
}

export interface IntegrationsBlock {
  kind: 'integrations';
  integrations: IntegrationReference[];
}

export interface PresentationBlock {
  kind: 'presentation';
  displayName?: string;
  description?: string;
  label?: string;
  color?: string;
  marker?: string;
}

export type RequirementKind = 'schema-version' | 'term2-version' | 'capability' | 'integration' | 'setting';
export interface Requirement {
  kind: RequirementKind;
  value: string;
}
export interface RequirementsBlock {
  kind: 'requirements';
  requirements: Requirement[];
}

export type ProfileBlock =
  | InstructionsBlock
  | ContextBlock
  | ToolsBlock
  | EnforcementBlock
  | IntegrationsBlock
  | PresentationBlock
  | RequirementsBlock
  | BlockReference;

export interface ProfileBlocks {
  instructions?: ProfileBlock;
  context?: ProfileBlock;
  tools?: ProfileBlock;
  enforcement?: ProfileBlock;
  integrations?: ProfileBlock;
  presentation?: ProfileBlock;
  requirements?: ProfileBlock;
}

export interface ProfileRegistry {
  readonly profiles: ReadonlyMap<string, ProfileDefinition>;
  readonly blocks: ReadonlyMap<string, RegisteredBlock>;
  readonly policies: ReadonlyMap<string, EnforcementPolicyDefinition>;
  readonly integrations: ReadonlyMap<string, IntegrationDefinition>;
}

export interface ProfileDefinition {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description?: string;
  extends?: string;
  blocks: ProfileBlocks;
  requires?: Requirement[];
}

export interface RegisteredBlock {
  id: string;
  kind: BlockKind;
  definition: ProfileBlock | EnforcementPolicyDefinition | IntegrationDefinition;
}

export interface ProfileProvenance {
  namespace: 'builtin' | 'user' | 'project';
  source: string;
}

export interface ResolvedInstructionEntry {
  readonly id: string;
  readonly content: InstructionContent;
}
export interface ResolvedInstructions {
  readonly identity: InstructionContent;
  readonly workflow?: InstructionContent;
  readonly guidance: readonly ResolvedInstructionEntry[];
  readonly output?: InstructionContent;
}
export interface ResolvedContextSource {
  readonly id: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly limit?: number;
}
export interface ResolvedContextPolicy {
  readonly sources: readonly ResolvedContextSource[];
}
export interface ResolvedToolSurface {
  readonly capabilities: ReadonlySet<string>;
}
export interface ResolvedEnforcementPolicy {
  readonly policies: ReadonlySet<string>;
  readonly denials: ReadonlySet<string>;
  readonly handoffRestrictions: ReadonlySet<string>;
}
export interface ResolvedIntegration {
  readonly id: string;
  readonly required: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly available: boolean;
}
export interface ResolvedPresentation {
  readonly displayName?: string;
  readonly description?: string;
  readonly label?: string;
  readonly color?: string;
  readonly marker?: string;
}
export interface ResolvedRequirements {
  readonly requirements: readonly Requirement[];
}
export interface ProfileAvailabilityDiagnostic {
  readonly code: 'unavailable-integration' | 'unsatisfied-requirement';
  readonly message: string;
  readonly reference: string;
}
export interface ProfileAvailability {
  readonly available: boolean;
  readonly diagnostics: readonly ProfileAvailabilityDiagnostic[];
}
export interface ResolvedProfile {
  readonly identity: {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly provenance: ProfileProvenance;
    readonly parentIds: readonly string[];
  };
  readonly instructions: ResolvedInstructions;
  readonly context: ResolvedContextPolicy;
  readonly tools: ResolvedToolSurface;
  readonly enforcement: ResolvedEnforcementPolicy;
  readonly integrations: ReadonlyMap<string, ResolvedIntegration>;
  readonly presentation: ResolvedPresentation;
  readonly requirements: ResolvedRequirements;
  readonly availability: ProfileAvailability;
}

export interface ResolveOptions {
  maxParentDepth?: number;
  maxBlocks?: number;
  availableCapabilities?: Iterable<string>;
  availableIntegrations?: Iterable<string> | ReadonlyMap<string, boolean>;
  availableSettings?: Iterable<string>;
  term2Version?: string;
}

export interface ProfileResolutionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export class ProfileResolutionError extends Error {
  readonly diagnostics: readonly ProfileResolutionDiagnostic[];

  constructor(message: string, diagnostics: readonly ProfileResolutionDiagnostic[] = []) {
    super(message);
    this.name = 'ProfileResolutionError';
    this.diagnostics = diagnostics;
  }
}

/** Kept local to this module so legacy consumers can migrate without a dependency cycle. */
export interface SavedAppMode {
  mentorMode: boolean;
  liteMode: boolean;
  planMode: boolean;
  orchestratorMode?: boolean;
}

export type ProfileSchema = z.ZodType<ProfileDefinition>;
