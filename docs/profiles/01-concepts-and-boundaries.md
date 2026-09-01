# Profile concepts and boundaries

## Problem

The current built-in modes are assembled across settings flags, prompt
construction, next-turn notices, tool construction, runtime guards, specialized
subagent behavior, persistence, commands, and UI projection. No one value
describes the complete active composition.

That distribution makes a new mode a cross-cutting product change and gives
users no supported way to compose an equivalent operating environment.

## Core concepts

### Profile

A Profile is a versioned definition that selects and composes typed blocks into
one root-session operating environment.

A Profile has:

- stable identity and version;
- optional single-parent inheritance;
- references to typed blocks;
- presentation metadata;
- compatibility requirements; and
- source provenance.

A Profile is not a model preset, settings bundle, skill, or subagent role.

### Block

A block is a typed unit with a contract and type-specific merge behavior. The
initial block types are:

- instructions;
- context;
- tool surface;
- enforcement;
- runtime integration;
- presentation; and
- requirements.

Blocks can be registered built-ins, Profile-local definitions, or installed
shared definitions. A block reference cannot escape its source root.

### Resolved Profile

`ResolvedProfile` is the immutable, validated result consumed by the runtime.
It contains no inheritance operations, unresolved paths, or unvalidated block
references. Prompt construction, tool construction, enforcement, integrations,
UI projection, logging, and persistence consume this value rather than reading
mode flags.

### Profile registry

A registry supplies Profile and reusable block definitions by namespaced ID.
Milestone 1 needs only the built-in registry. Later registries may discover user
and project definitions without changing the resolver or runtime consumers.

### Active Profile

`activeProfileId` is the canonical selection for a root conversation. Standard
is represented explicitly as `builtin:standard`; it is not represented by the
absence of four other flags.

## Identity and namespaces

IDs use provenance namespaces:

```text
builtin:standard
builtin:plan
user:architecture-review
project:release-audit
```

Reusable block IDs add a kind and name within the namespace, for example:

```text
builtin:context/full
user:acme-context/company-defaults
```

The registry assigns the provenance namespace. A portable external manifest
declares a local ID such as `architecture-review`; loading it from the project
registry produces `project:architecture-review`, while installing the same
package in the user registry produces `user:architecture-review`. Built-in
definitions receive `builtin:` identities from the built-in registry.

The exact serialized separator may change before external Profile loading ships,
but resolved identity MUST preserve provenance and MUST prevent user or project
content from shadowing a built-in ID.

Display names are mutable metadata and MUST NOT be used as persistence or
reference identities.

## Ownership boundaries

### Profile-owned

Profiles own the declarative selection and composition of:

- customizable instruction slots;
- context sources;
- model-visible capability groups;
- additional registered restrictions;
- registered runtime integrations;
- presentation metadata; and
- compatibility requirements.

### System-owned

term2 retains ownership of:

- model, provider, reasoning-effort, and temperature selection;
- approval authority and auto-approval configuration;
- sandbox configuration;
- filesystem and network authority;
- parent/subagent permission ceilings;
- executable tool implementations;
- executable enforcement and integration implementations;
- active skill selection and skill installation;
- provider continuity and prompt-cache safety decisions;
- persistence mechanics and schema migration;
- Profile transition admission; and
- global resource limits.

Profiles may reference system-owned capabilities or add restrictions, but they
cannot replace these owners.

## Goals

1. Reconstruct every current built-in mode as a resolved Profile without
   changing behavior.
2. Make one resolved object describe the root session's operating composition.
3. Let future users create equivalent compositions through declarative blocks.
4. Make block merge behavior explicit and deterministic.
5. Keep shared Profiles portable across machines with different model and
   security settings.
6. Preserve provider prompt-cache and chaining constraints during transitions.
7. Establish the identity, digest, and snapshot path needed to preserve
   conversation resumption once externally loaded Profiles can change or
   disappear.

## Non-goals

- Profiles do not configure the main model.
- Profiles do not activate, install, or filter skills. A context block may
  include or omit the skills catalog as contextual material.
- Profiles are not executable plugins.
- Profiles do not grant authority.
- Profiles do not stack several parent Profiles or use multiple inheritance.
- Profiles do not fetch blocks or documents from the network during discovery
  or activation.
- Milestone 1 does not discover user or project Profiles.
- Milestone 1 does not intentionally correct inconsistencies in current mode
  behavior or documentation.

## Design test

Deleting the Profile resolver after Milestone 1 would have to redistribute
inheritance, block merging, validation, transition classification, and semantic
mode decisions across prompt, agent, settings, persistence, UI, and guard
callers. That policy concentration is what earns the module its boundary.
