# Agent assembly: bounded verification plan

## Scope and evidence standard

Verify the [bounded design](agent-assembly-migration.md) and its
[implementation sequence](agent-assembly-implementation.md). This plan replaces
the former whole-migration acceptance matrix. It does not accept existing code or
require implementing deferred capabilities to exercise them.

The [evidence-driven development policy](../experiments/evidence-driven-development/README.md)
and repository verification/testing skills govern execution. No permanent unit
tests; temporary probes may supplement actual product workflows. Classify risk
from reachable behavior, not from the smaller name of the task. High-risk changes
still require direct evidence, a failure-path check and an independent verifier;
obtain explicit human authorization before spawning that reviewer.

## Claims and discriminating evidence

Capture relevant before-state evidence before editing and compare the same affected
inputs after extraction. Retain the exact revision, fixtures, commands, outputs and
coverage limits. Default behavior comparisons use default selection; reduced
assemblies are controlled demonstrations, not new product defaults.

| Claim | Evidence required |
| --- | --- |
| Default tool exposure is preserved | Compare ordered names, descriptions, schemas and metadata for affected root profiles and child roles, including enabled and disabled states. |
| Shared construction retains caller policy | Exercise root capability/kill-switch combinations separately from child role and host-scope combinations. Check undefined, empty, wildcard and finite scopes for child web tools, including search restrictions and fetch redirect restrictions. Compare skill availability for each affected caller. |
| Selection works in production | Run affected real agent construction with default and reduced selections. Observe exposed tools and execute controlled allowed calls; verify that selection cannot enable a policy-disabled feature. Calling a standalone composition helper is insufficient. |
| Actual entry paths preserve behavior | Exercise interactive and non-interactive root paths and affected child construction using controlled tools/provider fixtures. Confirm successful feature use and disabled/denied behavior through those paths. Record any path not exercised as pending. |
| Execution contracts survive extraction | Exercise affected tools and compare approval behavior, result acceptance and public lifecycle evidence. Verify execution metadata survives the composed path; if dispatch eligibility changes or wrappers are replaced, directly check affected concurrent/serial behavior. |
| No new lifetime ownership is introduced | Inspect the proposed diff and dependencies: existing owners retain resources, factories borrow them, and the slice adds no disposal protocol. If retained changes alter startup, rebuild or cleanup, require direct normal and failure-path evidence and reassess scope/risk. |
| Composition earns its indirection | Show a concrete feature edit or selection change before/after, including files and policy knowledge required. Record duplicated construction removed and new concepts added. Tool omission without editing the core loop alone is insufficient. |
| Proposed integration is bounded | Inspect the final diff for unrelated runtime interception, containers, dependency graphs, new resource scopes or persisted formats. Exclude deferred work or justify it separately; do not assume the existing migration branch is the intended diff. |

Typecheck and lint remain required for TypeScript changes. Run applicable existing
integration, e2e and provider black-box checks according to the affected boundaries;
static checks alone cannot establish behavioral preservation. Do not require an
unrelated whole-app baseline catalog before a bounded extraction can proceed.

## Acceptance and limits

Accept only when both initial features are consumed through their affected real
construction paths, selection and caller-policy evidence pass, required independent
verification is complete, and the concrete maintenance example supports the claimed
benefit. A simpler direct-factory result may satisfy the scope without a general
assembly abstraction.

Report unexercised workflows as pending rather than declaring behavioral completion.
If no maintenance benefit is demonstrated, keep independently useful extraction
and reduce the abstraction before expanding.

No proof of arbitrary hook ordering, rewrite/deny/replacement semantics, generic
resource scopes, dynamic plugins or whole-catalog migration is required: those
capabilities are deferred. If any are retained in the proposed production diff,
they need separate requirements and verification; this smaller matrix does not
waive their risks. Historical reports and prototype runs do not establish parity
for the final integration revision.
