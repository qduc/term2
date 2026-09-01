# Profile block contracts

Each block type defines its accepted data, merge operation, validation, and
resolved representation. Generic deep-merge is forbidden: it would make policy
fields order-sensitive and let security behavior change accidentally when a
schema grows.

## Instruction block

### Customizable slots

The instruction block has four named slots:

| Slot | Purpose | Required in a complete Profile | Default child operation |
| --- | --- | --- | --- |
| `identity` | High-level identity and mission | No; Standard supplies the fallback | Replace |
| `workflow` | How the agent approaches work | No | Replace |
| `guidance` | Ordered supplementary guidance | No | Append |
| `output` | Final deliverable requirements | No | Replace |

An instruction entry contains Markdown directly or references a Markdown block.
Supported operations are constrained by slot:

- `identity`: `replace`;
- `workflow`: `replace`, `before`, or `after`;
- `guidance`: `replace`, `before`, `after`, or `remove` by stable entry ID; and
- `output`: `replace`.

A child-supplied workflow defaults to `replace`. Inheriting two complete
workflows implicitly is more likely to create contradictory behavior than a
useful composition.

### System-owned instruction material

The resolved Profile instructions are composed with system-generated material
that a Profile cannot replace:

- approval semantics;
- sandbox semantics;
- tool-call contracts;
- worktree and dirty-state safeguards supplied by the harness;
- conversation lifecycle rules;
- provider-specific compatibility guidance;
- dynamic environment facts; and
- active capability descriptions.

The renderer owns final ordering. A Profile cannot use a slot name that collides
with a system-owned section.

### Delivery

Instruction content resolves independently from delivery. The transition owner
decides whether resolved instructions belong in the stable instruction prefix,
a next-user-turn notice, or a fresh provider chain. A Profile cannot declare a
prefix-changing transition cache-safe.

## Context block

A context block selects ordered context sources. Initial registered source kinds
are:

```text
environment
workspace
project-instructions
skills-catalog
memory
session-browser
repository-guidance
profile-document
```

Each source has a stable ID, enabled state, priority, and optional limit no
larger than the owning application limit.

Profile documents:

- MUST be regular files beneath the root of the Profile or reusable block that
  declares them;
- MUST NOT escape through `..`, absolute paths, or symlink resolution;
- MUST be read as data, never executed;
- MUST NOT trigger network retrieval; and
- SHOULD be Markdown or another explicitly registered inert text format.

The loader canonicalizes and reads each accepted document once during
resolution. `ResolvedProfile` carries the bounded content and digest; activation
does not reopen the path after validation. System-owned limits cap document
count, per-file bytes, and aggregate bytes before prompt-context truncation.

Milestone 1 built-ins can select registered sources but do not add new Profile
documents.

### Context merge

- Sources merge by stable source ID.
- A child entry replaces the inherited entry with the same ID.
- A child may explicitly remove an inherited source.
- New entries retain declared order relative to an explicit anchor; otherwise
  they append.
- Final de-duplication and truncation are runtime-owned.
- Profile limits may narrow but cannot increase global source or aggregate
  limits.

The context block does not accept arbitrary project paths or glob patterns in
the first external format. Project-specific context remains available through
registered sources such as `project-instructions`; additional static documents
must be Profile-local.

## Tool-surface block

The tool-surface block selects stable capability groups rather than internal
tool names. Initial groups are:

```text
filesystem-read-workspace
filesystem-read-external
filesystem-write
shell
web
memory
sessions
skills
mentor
subagents
background-tasks
user-interaction
code-context
```

The group-to-tool mapping is owned by term2 and may vary by model, execution
context, configured service, or platform. A resolved capability means that the
Profile permits eligible tools in that group to be exposed; it does not promise
that every installation can provide them.

`filesystem-read-external` makes outside-workspace read tools eligible so the
Lite Profile can reproduce current behavior. It is still intersected with
runtime authority and does not bypass approval or sandbox policy.

### Tool merge

A child may replace the inherited capability set or apply explicit includes and
excludes. Within one operation, exclusion wins. Unknown capability groups are
validation errors.

After Profile resolution, tool construction intersects the requested surface
with available capabilities and effective authority:

```text
Profile-visible capabilities
∩ runtime-available capabilities
∩ effective authority
= exposed executable tools
```

A Profile cannot define an executable tool. Tools added by future plugin systems
must first register a capability through a separate trusted extension boundary.

## Enforcement block

An enforcement block references trusted policies registered by term2. The
initial policies are:

```text
builtin:enforcement/normal
builtin:enforcement/plan-read-only
```

`normal` adds no Profile-specific restriction. It does not disable global
guards. `plan-read-only` reproduces the current Plan enforcement surface:

- deny the current workspace file-writing tools;
- deny shell commands classified as mutating;
- deny write-capable or unknown delegated roles; and
- preserve the current Plan-specific handoff restriction.

Plan's prompt asks the model to avoid all workspace and system-state mutation,
but current runtime enforcement does not intercept every stateful tool category,
such as persistent-memory writes. Milestone 1 preserves that boundary rather
than silently strengthening it. A future comprehensive read-only policy requires
its own behavior change and regression coverage.

### Enforcement merge

- Policies accumulate restrictively.
- Child Profiles cannot remove inherited restrictions.
- Repeated policy IDs are de-duplicated.
- Incompatible policies are validation errors.
- Global approval, sandbox, filesystem, network, and parent authority remain in
  force regardless of Profile content.

The effective authority is:

```text
global authority
∩ session authority
∩ parent-agent authority
∩ Profile restrictions
```

Declarative files cannot implement enforcement. Novel executable policies
require a separately designed trusted plugin mechanism and are outside this
specification.

## Runtime-integration block

An integration block references trusted runtime behavior that cannot be
expressed as prompt or tool selection alone. Initial integrations are:

```text
builtin:integration/mentor
builtin:integration/async-subagents
builtin:integration/background-task-control
```

Integration definitions declare:

- stable ID;
- whether availability is required or optional;
- configuration schema, if any;
- availability probe;
- dependencies;
- conflict rules; and
- semantic contribution to `ResolvedProfile`.

Every integration reference declares `required: true` or `required: false`;
there is no implicit default. Mentor uses an optional reference for current
parity. Orchestrator uses a required asynchronous-subagent reference.

Integration references merge by ID. Duplicate identical references collapse;
conflicting configurations fail resolution. Profiles cannot ship integration
code.

An unavailable optional integration contributes no runtime behavior and records
an availability diagnostic. An unavailable required integration prevents
activation. Required versus optional is explicit on the resolved reference, not
inferred from the integration ID. Built-in parity determines which behavior
applies to each current mode; the resolver must not strengthen a current
optional dependency during Milestone 1.

Plan's existing tool interceptor is not a separately composable integration. It
is one enforcement mechanism owned by
`builtin:enforcement/plan-read-only`. Selecting that policy must be sufficient
to install every current Plan denial path; otherwise a Profile could claim Plan
parity without enforcing it.

## Presentation block

Presentation metadata contains:

- display name;
- description;
- short status label;
- terminal-safe color token; and
- optional terminal-safe marker.

Fields inherit independently and child values replace parent values. The stable
Profile ID is never inferred from presentation data.

All Profiles are selectable through `/profile <id>`. Existing built-in commands
remain compatibility aliases. Milestone 1 does not register arbitrary
user-supplied top-level slash commands.

## Requirements block

Requirements describe compatibility; they do not configure dependencies or
grant capabilities. Supported requirement classes are:

- Profile schema version;
- term2 version range;
- registered capability;
- registered integration; and
- presence of a setting required by existing behavior.

Requirements accumulate across inheritance. A child cannot remove a parent's
requirement. The availability result distinguishes malformed, incompatible, and
temporarily unavailable Profiles so the UI can explain why activation failed.

Milestone 1 MUST preserve the current distinction between Orchestrator and
Mentor: Orchestrator requires the complete asynchronous delegation surface,
while Mentor currently remains selectable when no smart or legacy mentor model
is configured, in which case mentor consultation is unavailable.
