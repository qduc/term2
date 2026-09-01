# Profile definition and resolution

This document defines the logical schema. The exact TypeScript declaration and
serialized field spelling may be refined during implementation, but the
identity, ownership, merge, validation, and resolution semantics are normative.

## Definition shape

```ts
interface ProfileDefinition {
  schemaVersion: 1;
  /** Local, portable identity; the registry adds provenance. */
  id: string;
  version: string;
  name: string;
  description?: string;
  extends?: string;
  blocks: ProfileBlocks;
  requires?: ProfileRequirements;
}
```

Illustrative serialized form:

```yaml
schemaVersion: 1
id: architecture-review
version: 1.0.0
name: Architecture Review
description: Read-only architectural analysis with mentor consultation
extends: builtin:plan

blocks:
  instructions:
    identity:
      use: ./instructions/identity.md
    workflow:
      operation: replace
      use: ./instructions/workflow.md

  context:
    operation: merge
    use: ./blocks/context.yaml

  tools:
    operation: merge
    use: ./blocks/tools.yaml

  integrations:
    - use: builtin:integration/mentor
      required: false

  presentation:
    label: ARCH
    color: cyan
```

The future external manifest SHOULD use YAML because the repository already
depends on a YAML parser and the format is intended for human authorship. The
loader MUST validate parsed data through a strict versioned schema. Unknown
fields are errors, not warnings, so misspellings cannot silently alter behavior.
Parsing also uses system-owned limits for input bytes, YAML aliases, nesting
depth, collection size, and diagnostic count so discovery cannot become an
unbounded resource sink.

Milestone 1 may define bundled Profiles and blocks as typed data while the
external file contract remains unimplemented. Bundled definitions still MUST
pass through the same schema validation and resolver entry point intended for
external definitions.

## References

A block reference is one of:

1. registered built-in, such as `builtin:context/full`;
2. Profile-local relative path, such as `./blocks/context.yaml`; or
3. installed shared block ID, such as `user:acme-context/company-defaults`.

Relative references resolve against the declaring Profile root, not the process
working directory or parent Profile root. A reusable block resolves its own
relative references against that block's package root. Resolution rejects
absolute paths, root escapes, symlink escapes, missing files, unsupported file
kinds, and kind mismatches.

Registry provenance owns the namespace. External definitions declare portable
local IDs and cannot place a provenance separator in that field. The loader
constructs the resolved ID from the registry source, so project and user content
cannot claim `builtin:` identity. This check happens before duplicate-ID
resolution.

Milestone 1 implements registered built-in references. Profile-local and shared
installed references are reserved by the type model but are not discovered.

## Inheritance

- A Profile may extend zero or one parent.
- A complete Profile with no parent must resolve every required semantic field,
  either directly or through registered system defaults.
- A child inherits the fully resolved parent, then applies its block operations.
- Parent lookup uses stable Profile ID, not display name.
- Inheritance cycles are fatal and report the complete cycle.
- Missing or unavailable parents are fatal.
- Multiple inheritance and Profile stacking are unsupported.
- System-owned limits bound parent-chain depth and total referenced block count;
  exceeding either limit is a resolution error.

Single-parent inheritance makes ordering deterministic and avoids diamond
conflicts. Reusable blocks provide composition without adding a second parent
axis.

## Type-specific merge matrix

| Block or slot | Default behavior |
| --- | --- |
| Instruction `identity` | Replace |
| Instruction `workflow` | Replace |
| Instruction `guidance` | Ordered append |
| Instruction `output` | Replace |
| Context | Merge by source ID |
| Tool surface | Apply capability-set operation |
| Enforcement | Restrictive accumulation |
| Runtime integrations | Merge by integration ID |
| Presentation | Replace individual fields |
| Requirements | Accumulate |

The resolver dispatches to the owning block resolver. It MUST NOT use recursive
object merge as a fallback for known or unknown block kinds.

## Resolution pipeline

The deterministic pipeline is:

```text
select Profile ID
→ load definition with provenance
→ validate schema
→ resolve parent chain
→ resolve block references
→ apply block-type merge operations
→ validate cross-block compatibility
→ evaluate requirements and integration availability
→ intersect requested surface with runtime authority
→ render immutable ResolvedProfile
→ compute semantic digest
```

Resolution is side-effect-free. It does not switch providers, rebuild agents,
queue notices, modify settings, or install integrations. Activation owns those
effects after successful resolution.

## Resolved representation

The resolved value exposes semantics rather than source syntax:

```ts
interface ResolvedProfile {
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
```

Runtime consumers MUST NOT inspect source paths, merge operations, or parent
definitions. They also SHOULD ask semantic questions rather than compare a
built-in ID. Examples:

```ts
profile.enforcement.denials.has('filesystem-mutation')
profile.integrations.has('builtin:integration/mentor')
profile.tools.capabilities.has('subagents')
```

Comparing `profile.identity.id` is appropriate for selection, display,
persistence, compatibility aliases, and diagnostics—not for implementing Plan,
Mentor, or Lite behavior.

## Validation failures

Resolution fails before activation for:

- unknown schema version;
- duplicate Profile or block identity within one registry scope;
- malformed or unnamespaced ID;
- missing parent;
- inheritance cycle;
- unknown block type;
- unknown merge operation for the block type;
- unknown capability, policy, integration, or context source;
- block-reference kind mismatch;
- conflicting integration configuration;
- unsatisfied required integration;
- context path escape; or
- Profile or block resource-limit exhaustion; or
- a complete definition that cannot produce all required resolved semantics.

Errors include the Profile ID, source provenance, block path, and failing
reference or field. The resolver does not silently fall back to Standard after
the user selected a malformed Profile.

## Digest

The digest covers behaviorally relevant resolved data and referenced inert file
content. It excludes source location, display-only diagnostics, current model,
credentials, and global security settings. Equivalent resolved Profiles produce
the same digest regardless of whether blocks were inherited or declared
directly.

The digest supports saved-conversation compatibility and transition comparison;
it is not a signature or trust proof.
