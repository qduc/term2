# Agent assembly: bounded implementation plan

## Scope

Implement the [bounded feature-composition design](agent-assembly-migration.md).
This plan replaces the previous whole-runtime migration sequence. Web tools and
skill activation are the initial delivery; broader DI, lifecycle and hook work is
deferred under the design's explicit reconsideration criteria.

This document grants no production acceptance. Inspect current source and existing
work before choosing the implementation diff. Historical report verdicts apply to
their inspected revisions, not automatically to current code.

## 1. Bound the proposed change

Inspect `getAgentDefinition` in `source/agent.ts`,
`SubagentToolFactory.buildToolDefinitions` and `SubagentToolPolicy` in
`source/services/subagents/tool-policy.ts`, and their reachable construction callers.
For each initial feature, record selection inputs, shared construction, tool order,
metadata and caller-specific policy. Do not invent child support where none exists.

Inspect the existing migration attempt without modifying another agent's work.
Classify its changes as useful factory extraction, needed typed selection, or
outside this scope. Prepare a bounded integration proposal; do not merge the
broader branch merely because it contains useful extractions. Keep potentially
coupled execution/lifecycle changes out unless separately justified and verified.
If they cannot be separated safely, report that integration constraint.

Code changes use an isolated worktree under `.worktrees/` with its own dependency
installation, following [parallel work isolation](../agent-context.md#parallel-work-isolation).
Keep the primary branch and unrelated changes intact. One implementing owner
handles this work; no workers or subagents without explicit human authorization.

Deliverable: a bounded diff scope and claim-to-evidence map, with before-state
observations captured before edits where comparison needs them.

## 2. Extract and consume feature factories

Extract shared construction for web tools, then skill activation, through existing
factories and explicit parameters. Preserve selection at existing policy owners,
including child scope wrappers and root capability/kill-switch checks. Preserve
names, descriptions, schemas, order, `parallelSafe`, `needsApproval` and
`terminateAfterExecution` metadata where present.

Wire each extraction into its affected production callers and remove the replaced
construction. Verify each feature before expanding. Leave unaffected groups alone.
Factories borrow dependencies; keep their lifetimes with existing owners.

Deliverable: production-consumed factories with observable preservation evidence.

## 3. Make selection explicit with the smallest useful interface

Use the extracted callers to choose a small typed selection input. Keep ordinary
construction order explicit. Reuse existing capability/profile decisions rather
than creating a parallel permission system or user-facing settings.

Demonstrate default and deliberately reduced feature selection through real agent
construction. Selection may omit a feature but must not override a caller's policy
to enable one. Keep tool registration order stable. If direct factories already
satisfy the goal and an extra assembly type adds no value, omit it and explain why.

No general piece protocol, container, hook bus or new resource owner is required.
A need for one is a reason to revisit the design, not silently expand this slice.

Deliverable: understandable selection at the affected construction seam, with no
mandatory changes to execution advancement, settlement or persistence.

## 4. Demonstrate the payoff and finish

Follow the [verification plan](agent-assembly-verification.md) for affected root,
child and entry-surface workflows. Compare a concrete change to one of the extracted
features or its selection with the previous construction. Record what gets easier
and what policy remains at callers. Do not claim general maintainability gains
from line counts, framework installation or a standalone prototype.

Integrate only the verified bounded change under the repository's normal procedure.
Retain revision, diff, checks, outputs and remaining uncertainty; reverify when
integration changes the verified code. Update ownership documentation if necessary
and record completion in the experiment ledger.

Completion means this bounded delivery works and has demonstrated value. It does
not require migrating other features. Any follow-up names its present need and
the corresponding reconsideration evidence from the design's deferral table.
