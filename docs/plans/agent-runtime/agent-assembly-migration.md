# Agent assembly: bounded feature composition

## Decision and scope

This plan replaces the broader DI and runtime-hook migration. Its goal is to
make selected feature construction reusable and agent selection explicit, without
changing product behavior. Read it with the [implementation plan](agent-assembly-implementation.md)
and [verification plan](agent-assembly-verification.md).

The first delivery is bounded to web tools and skill activation, their affected
root/child callers, and a small typed composition seam. Completing it does not
require migrating every feature, session service, or agent construction path.
Expansion requires evidence of value from this delivery.

This is a target design, not an implementation acceptance report. Inspect current
source and branch changes before implementation. Earlier plans, prototypes and
reports describe broader work; their completion claims do not establish acceptance
of this scope. This rewrite changes documentation only and does not authorize
merging, deleting or resetting existing branch work.

## Problem and expected return

Root tool construction in `getAgentDefinition` in `source/agent.ts` combines
feature selection with construction. `SubagentToolFactory.buildToolDefinitions`
in `source/services/subagents/tool-policy.ts` constructs overlapping capabilities
under different role and scope policies. Repeating construction makes equivalent
tools easier to change inconsistently and makes agent variants harder to inspect.

Success means a maintainer can reuse a cohesive feature factory and select its
contribution through a typed assembly input, while the existing owners continue
to enforce caller-specific policy. The payoff is less duplicated construction and
more local changes when evolving those features. This work promises no immediate
improvement in answers, latency, token cost or user-facing capability.

## Deliver now

- Extract cohesive web-tool and skill-activation factories where current callers
  share construction. Reuse existing tool factories rather than wrapping them in
  a generic plugin protocol. Do not force sharing where inputs or policy differ.
- Give affected agent construction a small typed selection input. An assembly is
  explicit construction and selection code; it need not be a container, registry,
  blueprint language or dependency graph. Prefer direct imports and parameters.
- Keep profile capabilities, settings, root kill switches, role permissions and
  scope enforcement authoritative. Composition selects contributions within those
  constraints; it cannot grant additional permissions. Document the precedence in
  the owning construction code instead of adding another user setting.
- Preserve tool names, descriptions, schemas, order and execution metadata. Keep
  root and child selection and wrappers explicit at their current policy owners.
- Leave services and cleanup with current owners. Pass borrowed dependencies to
  factories; this slice should not introduce independently owned resources or a
  new disposal protocol. If extraction needs one, narrow the slice or revisit the
  design before adding lifecycle machinery.
- Remove construction wiring replaced by the extraction. Keep unaffected features
  in their current construction paths; a mixed construction root is acceptable
  when its boundary is explicit and there is no duplicate authority.

The initial factory and selection signatures follow the real callers. No public
plugin API or generic contribution interface is required in advance.

## Contracts to preserve

Keep `ApplicationRunLoop` as execution advancement owner and `ToolCallExecution`
as tool planning and settlement owner. Approval, final-effect authorization,
physical cancellation, recovery, result acceptance and persistence stay outside
optional feature contributions. No new execution interception is part of this work.

Keep public hooks observational through the existing `HookService`, `HookRegistry`
and execution lifecycle adapters; see [public hooks](../../reference/public-hooks.md). Do not
add a second emitter or change event placement, privacy or failure isolation.

Root web availability continues to follow effective profile capabilities and root
kill switches. Child web availability follows role policy and retains
`SubagentToolPolicy.wrapNetworkToolWithScope`; root toggles do not become child
restrictions. Preserve empty-scope denial, wildcard requirements and finite-host
fetch restrictions. Preserve existing skill availability and role-specific behavior
at each affected caller rather than assuming root and child selection are equal.

Preserve prompts, CLI defaults, interactive/non-interactive behavior, provider
requests, concurrency metadata, approval barriers and shutdown behavior wherever
the slice reaches them. No persisted-format change or new default product policy
is in scope. Consult [conversation core](../../architecture/conversation-core.md) and
[conversation loop](../../architecture/conversation-loop.md) when tracing affected owners.

## Deferred capabilities and reasons to revisit

These are separate future decisions, not unfinished acceptance criteria for this
plan. A trigger justifies a bounded proposal and production experiment, not automatic
adoption of the entire former architecture.

| Defer | Cost avoided now | Evidence that would justify reconsidering it |
| --- | --- | --- |
| General DI container and order-independent dependency resolution | Container knowledge, registration rules and runtime resolution failures | Multiple real contributions share a dependency graph whose explicit wiring repeatedly duplicates construction or causes ordering/lifetime defects; compare a container slice with direct factories. |
| Common piece protocol, catalogs and configurable blueprints | A framework contract and another configuration layer | Additional production features reveal a stable common contract, and actual agent variants need more than a typed list or explicit construction. Show a real change becoming simpler. |
| Behavior-changing model/tool hooks, including rewrite, denial and replacement | New execution states, ordering, approval and evidence semantics | A named production requirement needs interception that a local factory, wrapper or existing policy owner cannot express cleanly. Define final-effect authorization, failure and evidence semantics before implementation. |
| Generic shared/agent resource scopes and disposal | Partial-startup, shutdown and rebuild protocols | Real features require different owned lifetimes, and existing session/agent owners demonstrably cannot manage them clearly. Prove borrowed-resource safety and failure cleanup in a bounded slice. |
| Piece-owned extension hooks and configurable handler order | Extension dependencies and order-sensitive behavior | Two real features need to extend the same feature at a stable seam, and direct collaboration is inadequate. Demonstrate why order must vary. |
| Migration of every tool group and session/subagent service | Broad churn and parity verification | The first delivery shows reuse and lower caller burden, and another named group has the same construction problem. Migrate one group at a time. |
| Dynamic package discovery or untrusted plugins | Loading, compatibility and isolation obligations | An explicit product requirement for external extensions, with a separate trust and compatibility design. |

Awilix and Tapable are not required by this scope. Existing adoption on a branch
is evidence to inspect, not a reason to retain them. Existing profiles and public
observational hooks remain; this plan does not replace them.

## Decision gate and stop conditions

Before expanding, demonstrate both initial features through affected product
paths, and show one concrete feature change or agent selection example against
the prior construction. Record duplicated construction removed, edits needed,
remaining policy knowledge at callers, and any new concepts the maintainer must
learn. Smaller core files or avoiding edits to `ApplicationRunLoop` alone do not
prove value: tool registration already sits outside that loop.

Accept the bounded delivery when the selected features are reusable, typed
selection works through real construction, and preservation evidence passes.
Stop there unless another present need justifies expansion. If factories provide
the benefit without a shared assembly abstraction, keep the factories and omit
that abstraction. If composition adds more indirection than it removes, reduce it.

## Existing work and authority

Preserve useful extraction work from existing attempts, but assess each part
against this scope. Separate reusable factories from optional framework/runtime
changes before choosing what to integrate. Do not require repairs to out-of-scope
mechanisms solely to complete this plan; exclude them from the proposed integration
when safely separable. Any retained execution or lifecycle changes require their
own justification and risk-appropriate verification.

Keep one implementing owner. Do not invoke coordinator workflows, spawn subagents
or launch Term2 workers without explicit human authorization. Independent
verification remains required for high-risk changes under repository policy;
obtain authorization for that reviewer if needed. Prior prototype and implementation
reports remain historical evidence, not current production acceptance.
