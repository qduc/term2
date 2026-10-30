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

Pair is instruction-only: it retains the former Standard tool/context composition and enforcement. Approval
and step size are model instructions, not additional runtime restrictions. Switch
back to the default with `/profile bare`. The workflow is restored with the saved profile.

## Bare profile and unattended runs

Bare is the default for fresh sessions, including interactive and auto-approved runs.
`--profile bare` explicitly selects it; CLI overrides do not persist. Standard is
retired, not offered in the picker, and has no selectable full-context definition.
Old `--profile standard`, `--profile full`, `/profile standard`, `/profile full`,
and saved `builtin:standard` selections resolve to canonical `builtin:bare`.
Old sessions without a profile or enabled legacy mode also use Bare. History and
settings files are not bulk-rewritten: runtime selection and new session headers
use Bare, including resume and rollover. Unknown profile IDs still fail normally.

Explicit Plan, Pair, Mentor, and Orchestrator selections retain their previous
full-context/tool compositions; they do not inherit Bare's minimal composition.
Configured profiles are honored even for positional prompts without
`--auto-approve`. Leaving Plan/Mentor/Orchestrator returns to Bare; `/bare` and
`/lite` are idempotent while Bare is active. Changes to/from Bare still require
clearing existing interactive history through the confirmation flow.

Lite was merged into Bare on 2026-10-24. Every Lite entry point now selects
`builtin:bare`: `--lite`, `--profile lite`, `/lite` (alongside `/bare`),
`app.liteMode: true`, a persisted `app.activeProfileId: "builtin:lite"`, resumed
sessions recorded as Lite, and gateway mode `lite`. The legacy `app.liteMode` flag
reads `true` while Bare is active. The [merge notes](./lite-bare-merge.md) record
the rationale, request-size measurements, and known gaps.

Bare uses a short prompt and injects local project/global AGENTS.md instructions.
For remote sessions, project instructions are read through the remote shell. Bare includes the skills catalog
(the model loads a skill by reading its SKILL.md through the shell) and a short
environment line (OS, shell, cwd, home, date; no top-level tree). Delegation uses
the existing subagent runtime when the session supplies it; authority restrictions still apply.
Missing capabilities must be reported, not silently skipped.

Bare's ordinary context defaults stay unchanged. A host-local, project-scoped
`personal-context.json` opt-in in the project memory store can add only a bounded
personal-memory section, refreshed before each provider request, without the
full-context/global-memory prompt. See [personal memory context](../reference/personal-memory-context.md)
for scope, opt-out and privacy; no profile switch is required.

Bare carries no tool for what the shell can do: file reads, search, edits, and
skill loading all go through the shell, so the sandbox is Bare's write boundary.
The model-facing tools are the shell, `goal_check` (root sessions), `run_code`, and,
in interactive sessions, `session_rollover`, which scripts cannot call. Web, memory,
sessions, MCP, and background-job tools have no shell equivalent; they are
script-only `tools.*` members of `run_code`, listed by name, and the model calls
`tools.describe(name)` for a schema. Script calls keep the same approval prompts
and enforcement as direct calls.

The shell advertises a compact option set: `background` and `monitor` appear only
when the session has a background job registry (interactive roots), so headless
Bare stays foreground-only. Runtime normalization and approval still use the
complete canonical shell schema. Bare's task-neutral guidance
encourages batching known steps and filtering output locally without dropping
checks or failure evidence. The
[token-efficiency measurements](../research/bare-token-efficiency-20261024.md)
record the tested scope, failures, and limits rather than promise a universal gain.

Root sessions also expose `goal_check`. A supplied `--goal` uses the existing
request-time goal context, stop checks, and configured completion verification.
Bare does not waive required review. Ordinary replies without an active goal do
not trigger goal verification. When required review cannot run through the
available tools, report the missing capability or needed handoff and leave
completion unverified; do not silently switch profiles/models or launch agents.
Sandbox authority, approval policy, cancellation, output bounds, request deadlines,
and compaction remain authoritative. `agent.completionVerification=false` remains
an explicit operator override of the runtime completion gate.

Bare's profile version is `2.0.0` (the Lite merge and `run_code`; `1.3.0` was the last direct-surface version). Its original minimal definition and comparison
protocol are recorded in
[the Bare experiment notes (historical)](https://github.com/qduc/term2/blob/1cca21b541b3d2e9a55ddd81e3514c17ff5e1503/experiments/bare-profile/README.md). Skills were
restored after the cheap-additions experiment: on one skill-discovery task, three
fresh paired runs used 34–66% fewer tokens with skills. That task is narrow, and
one skills run overwrote a file without reading it first, so no general token
saving or quality equivalence is claimed. Environment context was restored next: in two
completed paired runs it used 45% and 50% fewer tokens
([retry notes (historical)](https://github.com/qduc/term2/blob/1cca21b541b3d2e9a55ddd81e3514c17ff5e1503/experiments/bare-profile/cheap-additions-retry.md)).

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
Interactive Bare uses the configured completion gate; other
profiles retain their interactive verification behavior.

`agent.backgroundWaitTimeoutMs` bounds the overall headless background drain,
including notification turns. It defaults to one hour and accepts 1–86,400,000 ms.
Expiration cancels unfinished work and reports its name (or task/ID) in text and
structured output. This containment limit does not infer whether work made progress.
Term2 has no application-owned worktree removal operation or per-run output folder;
worktree cleanup performed through arbitrary shell commands belongs to the invoking
workflow, which must save tracked and untracked changes before removing a worktree.
