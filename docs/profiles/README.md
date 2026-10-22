# Profile architecture specification

Status: **Milestone 1 implemented and merged.** Built-in profile architecture and legacy mode removal merged in `b1ddd32a` (2026-09-02); Pair profile added in `37523fac` (2026-09-03).

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

## Pair profile

Use `/profile pair` (or choose Pair in the profile picker) for human-led coding.
The assistant orients you in the code, asks about unresolved decisions, requests
approval for one small change, implements and verifies it, then returns control.
Interfaces and consequential design decisions remain yours to author.

Pair is instruction-only: it inherits Standard's tools and enforcement. Approval
and step size are model instructions, not additional runtime restrictions. Switch
back with `/profile standard`. The workflow is restored with the saved profile.

## Bare profile and unattended runs

`--profile bare` selects an opt-in shell-and-editor surface. Persist it with
`app.activeProfileId: "builtin:bare"` in settings.json. `--profile full` selects
`builtin:standard` for the session. CLI overrides do not persist. The configured
default remains Standard; the existing implicit Lite selection for positional
prompts without `--auto-approve` is unchanged, except an explicitly configured Bare
profile takes precedence.

Bare uses a short coding prompt with shell and file editors. Local sessions include
applicable global/project AGENTS.md without clipping them to the prompt budget;
the prompt directs the model to read scoped instructions before editing. Remote
sessions do not inject local AGENTS.md: the model must read the remote checkout's
instructions through shell. Bare includes the skills catalog and `activate_skill`.
Memory, environment catalogs, delegation, and JavaScript workflows remain omitted.
Missing capabilities must be reported, not silently skipped.

Root sessions also expose `goal_check`. A supplied `--goal` uses the existing
request-time goal context, stop checks, and configured completion verification.
Bare does not waive required review. Ordinary replies without an active goal do
not trigger goal verification. When required review cannot run through the
available tools, report the missing capability or needed handoff and leave
completion unverified; do not silently switch profiles/models or launch agents.
Sandbox authority, approval policy, cancellation, output bounds, request deadlines,
and compaction remain authoritative. `agent.completionVerification=false` remains
an explicit operator override of the runtime completion gate.

Bare's profile version is `1.2.0`. Its original minimal definition is retained as
an experiment fixture; the comparison protocol and measurement limitations are in
[the Bare experiment notes](../../experiments/bare-profile/README.md). Skills were
restored after the cheap-additions experiment: on one skill-discovery task, three
fresh paired runs used 34–66% fewer tokens with skills. That task is narrow, and
one skills run overwrote a file without reading it first, so no general token
saving or quality equivalence is claimed.

Every CLI session prints its profile on stderr. Headless NDJSON begins with a
`session_start` carrying `activeProfileId`, and persisted conversation headers
record the same canonical profile ID. CLI session headers also carry
`activeProfileVersion` and `activeProfileDigest` for composition comparisons; the
digest excludes project instruction contents and runtime settings.

All headless profiles receive instructions to choose reasonable interpretations,
continue within existing permissions, and state assumptions in the final response
instead of asking questions. Material missing requirements or authorization call
for an explicit blocked result; unavailable required review remains unverified. Ambiguous `--model` matches select the highest-ranked
candidate and print the assumption. Tool and budget permissions remain enforced.

`verifier.model` selects the independent completion verifier's model ID on the
session provider; the default empty string uses the session model. When verification
is unavailable or inconclusive, Bare goal-driven runs block completion (exit 2),
report the cause, and retain the active goal. Other headless profiles finish with
“independent verification not performed” and retain an active durable goal. A
concrete verification failure still requests repair or blocks completion.
Interactive Bare uses the same configured completion gate as Standard; other
profiles retain their interactive verification behavior.

`agent.backgroundWaitTimeoutMs` bounds the overall headless background drain,
including notification turns. It defaults to one hour and accepts 1–86,400,000 ms.
Expiration cancels unfinished work and reports its name (or task/ID) in text and
structured output. This containment limit does not infer whether work made progress.
Term2 has no application-owned worktree removal operation or per-run output folder;
worktree cleanup performed through arbitrary shell commands belongs to the invoking
workflow, which must save tracked and untracked changes before removing a worktree.
