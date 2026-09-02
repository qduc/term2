# Milestone 1: reconstruct built-in modes

## Objective

Reconstruct Standard, Lite, Plan, Mentor, and Orchestrator as built-in Profiles
on the new typed block architecture without intentionally changing their
current behavior.

This is a behavior-preserving architecture migration. User Profile discovery,
sharing, installation, and editing are later milestones.

## Completion boundary

Milestone 1 is complete only when `ResolvedProfile` drives production behavior.
It is not enough to add Profile definitions while mode booleans continue to
control prompts, tools, enforcement, integrations, persistence, or UI.

## Required implementation slices

### 1. Contracts and built-in registry

Add a cohesive Profile module containing:

- definition and resolved types;
- strict schema validation;
- built-in block registry;
- built-in Profile registry;
- single-parent resolver;
- block-specific merge functions;
- cross-block validation;
- semantic digest; and
- legacy mode adapter.

The likely ownership directory is `source/services/profiles/`. File boundaries
inside it should follow cohesive ownership discovered during implementation;
this specification does not require one file per type listed above.

Define all five built-ins through registry data. The built-in definitions pass
through the ordinary schema and resolver entry point.

### 2. Canonical active Profile state

Introduce `app.activeProfileId`, defaulting to `builtin:standard`. Make it the
sole internal selection authority.

At configuration and replay boundaries, map the current mode booleans through
one legacy adapter. Remove independent precedence decisions from core callers.
Do not retain synchronized booleans as a second internal state representation.

### 3. Prompt and context consumption

Refactor `buildPromptSpec()` and `getAgentDefinition()` to consume resolved
instruction and context semantics.

Preserve:

- model-family base selection for non-Lite built-ins;
- Lite's separate base prompt;
- the stable shared non-Lite prefix;
- mode stubs required by next-turn notice delivery;
- configured dynamic guidance;
- current Lite omissions and current context appended outside prompt-profile
  selection; and
- local versus remote project-instruction behavior.

This slice must not fold mode workflow bodies into the stable prefix.

### 4. Tool-surface consumption

Make agent tool construction consume resolved capability groups while retaining
model, execution-context, service-availability, and global-setting decisions.

Characterize the actual Standard and Lite tool names under representative
configurations before changing construction. Assert semantic parity rather than
relying only on broad snapshots.

### 5. Enforcement and integrations

Register current Plan enforcement behind the `plan-read-only` Profile policy.
Adapt the shell mutation policy, plan-mode tool interceptor, delegated-role
restriction, and handoff policy to consume resolved enforcement semantics rather
than `app.planMode`.

The `plan-read-only` policy owns all of those mechanisms. Do not expose the
current plan interceptor as a second block whose omission could produce a
Profile that claims Plan parity but lacks its denials. Characterize the current
boundary rather than adding interception for other stateful tool categories in
this migration.

Adapt Mentor-specific secondary prompt selection to the resolved Mentor
integration. Adapt Orchestrator's complete async-capability prerequisite to the
resolved required integration.

Do not rewrite the underlying guard or runner implementations merely to move
mode identity. The Profile layer selects existing owners; those owners continue
to enforce their contracts.

### 6. Atomic transition service

Replace command-specific toggling with a Profile transition owner that:

- resolves before mutation;
- compares current and target semantics;
- preserves existing mid-session confirmation behavior;
- prepares a replacement agent and required integrations before publication;
- commits canonical selection and prepared runtime composition together;
- queues one coherent notice;
- preserves provider continuity rules; and
- disposes replaced resources only after ownership transfers.

Retain `/lite`, `/plan`, `/mentor`, `/orchestrator`, and the current
`Shift+Tab` behavior as adapters to Profile activation. Add `/profile` for the
built-in IDs; custom discovery is not required.

### 7. Persistence, replay, gateway, and UI

Persist Profile selection in new conversation state. Decode and migrate legacy
`SavedAppMode` using the shared adapter and current precedence.

Update resume display, banner, status bar, gateway mode projection,
provider-traffic context, and conversation logging to derive identity from the
resolved Profile. Preserve external legacy projections where compatibility
requires them, but adapt them at the boundary.

### 8. Delete obsolete internal mode authority

After all consumers move, remove internal reads and normalization of the four
mode booleans. A final repository search for these keys should find only:

- legacy decoder/migration code;
- explicitly retained external compatibility adapters; and
- tests for those boundaries.

Any production behavioral branch outside those boundaries is incomplete
migration.

## Validation strategy

Follow test-driven slices. Characterize current behavior through owning public
boundaries before replacing each mode branch.

### Resolver tests

- complete Profile resolution;
- single-parent inheritance;
- each block merge rule;
- stable equivalent digest;
- missing parent and cycle diagnostics;
- unknown block, capability, policy, integration, and operation failures;
- requirements and optional integration availability; and
- built-in definitions using the same resolver path.

### Built-in parity tests

- Standard prompt/context/tool construction;
- Lite base prompt, omitted fragments, context behavior, and actual tool set;
- Plan enter/exit notice and every current mutation denial path;
- Mentor root notice, conditional mentor tool, and secondary mentor prompt;
- Orchestrator notice, direct tools, and complete async prerequisite;
- built-in presentation metadata; and
- current Standard/Plan `Shift+Tab` behavior.

### Transition tests

- alias activation and toggle back to Standard;
- failed resolution leaves the current Profile untouched;
- structural switch applies existing history confirmation;
- notice-only switch preserves the stable prefix;
- one coherent pending notice per transition;
- initial and resumed active Profiles prime the correct notice; and
- stricter enforcement cannot be lost through inheritance or transition.

### Persistence and compatibility tests

- each valid legacy flag combination maps to the expected built-in;
- malformed multiple-true state uses current precedence;
- new state round-trips Profile ID, version, and digest;
- old saved conversations remain resumable;
- gateway and CLI compatibility inputs map through the same adapter; and
- logging and traffic labels report the resolved Profile.

### Required gates

During implementation, run focused tests for each owner changed. Because this
migration affects agent/provider construction, session behavior, gateway or
non-interactive paths, the final handoff also requires:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:provider-black-box
```

Use the repository's focused-test policy during development rather than waiting
for the final broad gates.

## Acceptance criteria

1. All five current modes are represented as built-in Profile definitions.
2. Every built-in resolves through the same typed registry and resolver.
3. `app.activeProfileId` is the sole internal selection authority.
4. Prompt and context construction consume `ResolvedProfile`.
5. Tool construction consumes resolved capability groups.
6. Plan restrictions consume resolved enforcement semantics.
7. Mentor behavior consumes the resolved Mentor integration.
8. Orchestrator prerequisites consume the resolved async integration.
9. Switching is atomic and retains current command and confirmation behavior.
10. New conversations persist Profile identity and old conversations migrate.
11. UI, gateway compatibility projections, logging, and traffic show the
    effective built-in Profile.
12. Confirmed current mode behavior remains unchanged, including Lite's current
    editing capability and Mentor's optional consultation availability.
13. Focused tests and all required final gates pass.
14. No custom Profile discovery or executable extension surface is introduced.

## Out of scope

- user and project Profile discovery;
- Profile-local file loading;
- installed shared blocks;
- import, export, package registry, or marketplace;
- Profile editor or management UI;
- arbitrary custom tools, guards, hooks, or integrations;
- remote dependencies;
- multiple inheritance or Profile stacking;
- intentional mode behavior cleanup; and
- removal of external compatibility fields before their callers migrate.

## Follow-on milestone

After built-in parity is stable, the next milestone should add read-only
discovery and validation of user and project Profile packages using the same
registry interface. It should not add executable extensions. That work must also
add resolved snapshots to conversation persistence before custom Profiles are
allowed to activate.
