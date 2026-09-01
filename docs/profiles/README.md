# Profile architecture specification

Status: **approved design; Milestone 1 is not implemented.**

This directory specifies the Profile architecture that will replace term2's
hard-coded built-in mode composition. The first implementation milestone is a
behavior-preserving reconstruction of Standard, Lite, Plan, Mentor, and
Orchestrator on that architecture. User Profile discovery and sharing follow in
later milestones.

## Decision summary

- A **Profile** is the complete composition currently represented by a built-in
  mode.
- A **block** is one typed part of that composition. Built-in and future
  user-created Profiles use the same block contracts and resolver.
- A Profile may be complete or extend exactly one parent Profile.
- Blocks may be Profile-local or reusable registry entries.
- Each block type owns its merge semantics.
- Root instructions have named customizable slots. Harness safety and tool
  contracts remain system-owned.
- Profiles do not select the main model, provider, reasoning effort,
  temperature, or active skills.
- Tool blocks control model-visible capability groups, not authority.
- Enforcement blocks may add registered restrictions but cannot weaken global
  approval, sandbox, filesystem, network, or parent-agent authority.
- Profile and block files are declarative. They do not execute code.
- `activeProfileId` becomes the sole internal mode-selection authority.
- Built-ins and custom Profiles differ by provenance, not representation.

## Documents

1. [Concepts and boundaries](./01-concepts-and-boundaries.md) — vocabulary,
   goals, ownership, and non-goals.
2. [Block contracts](./02-block-contracts.md) — instruction, context, tool,
   enforcement, integration, presentation, and requirement blocks.
3. [Definition and resolution](./03-definition-and-resolution.md) — manifest,
   references, inheritance, merge rules, validation, and resolved output.
4. [Built-in parity](./04-builtin-profile-parity.md) — the current behavior each
   built-in Profile must reconstruct.
5. [Activation, persistence, and trust](./05-activation-persistence-and-trust.md)
   — switching, prompt-cache behavior, saved conversations, provenance, and
   authority.
6. [Milestone 1](./06-milestone-1.md) — implementation boundary, sequence,
   compatibility work, tests, and acceptance criteria.

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are normative. Statements under
"Current behavior" describe the repository at the time this specification was
written; they are parity evidence, not permanent product requirements beyond
Milestone 1.

## Governing principle

The architecture is successful only when built-in Profiles travel through the
same definition, resolution, and consumption path intended for future custom
Profiles. A descriptive Profile registry layered beside mode booleans does not
satisfy this specification.
