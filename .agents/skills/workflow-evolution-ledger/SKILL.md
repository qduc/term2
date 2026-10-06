---
name: workflow-evolution-ledger
description: Record one bounded workflow-improvement experiment in Term2 with frozen criteria, independent Reviewer evidence, explicit promotion authority, and subsequent loaded-method verification. Use when asked to improve a repeatedly used method; not for ordinary task correction or PR correctness review.
---

# Workflow evolution ledger

Compose the public [agentic-loop](https://github.com/qduc/skills/blob/b29db03f876a0a5965767785c185357577e3488d/skills/agentic-loop/SKILL.md)
and [workflow-evolution](https://github.com/qduc/skills/blob/b29db03f876a0a5965767785c185357577e3488d/skills/workflow-evolution/SKILL.md)
methods. This skill supplies the Term2 recording adapter; it does not replace
those methods or confer authority. Read [the invocation and trust contract](../../../docs/workflow-evolution.md).

1. Do useful ordinary work with the incumbent. Retain artifact/check traces,
   outcomes, retry counts and human interventions. Record the exact harness
   commit, resolved method source, version and loaded body. Do not infer the
   loaded body by reading a changed file: SkillsService caches bodies and
   project skills override user skills. Capture the activation response or
   `snapshotLoadedSkill` from the existing service result.
2. Before trials, freeze at least three distinct task inputs, required checks,
   conditions (including tool/model/resource envelope and resource hashes),
   minimum pairs and minimum meaningful wins in an `init` event. Include
   ordinary work records. Without two distinct inputs exhibiting a weakness,
   improve observability instead of proposing a candidate.
3. Propose one small versioned mutation supported by those run IDs. Save its
   body separately. Do not overwrite the method governing the current task or
   relax safety, authority, required artifacts or checks. Freeze one candidate;
   do not retry the experiment with a succession of rewritten candidates.
4. Run the incumbent and candidate on each frozen task under comparable
   conditions. Isolate task artifacts so one trial cannot change the next.
   Record each as `benchmark`. Stop on missing authority or resource exhaustion;
   use uncertain outcomes, not invented success. Scope this invocation to one
   experiment and one paired run per task, with no automatic retries. Existing
   run budgets and approvals remain authoritative; the ledger launches no work.
5. From the **main agent**, invoke the existing `run_subagent` Reviewer role in
   a fresh session. Give it the ledger, frozen criteria, both sets of artifacts,
   and check/activation/condition traces. Ask it to independently verify every
   check and metric, obtain missing evidence through its bounded explorers,
   and return the `compare` event. Do not supply a preferred verdict. Preserve
   its actual run/session identifier and report artifact as evidence. The
   ledger checks identity separation but cannot authenticate a supplied role.
   Optional `run_agent_workflow` can run bounded disposable trials with explicit
   instruction bodies; its children cannot attach skills or nest a Reviewer.
   Never try to nest Reviewer from those children.
6. Append the reviewed event using the ledger CLI. It computes
   `keep | reject | inconclusive` from frozen paired check results and the
   correctness/intervention/retry vector. A correctness regression or increased
   retries/interventions rejects; missing coverage, uncertain outcomes,
   incomparable revisions or too few meaningful wins are inconclusive.
   Preserve the incumbent in either case. PR correctness is a separate review.
7. A `keep` is only an adoption recommendation. Honor the user's existing
   authority and host approval rules. If adoption is authorized, record its
   candidate- and review-specific approval reference in `promote`, then let the
   authorized operator install/reload the task-local method. The CLI changes a
   selection record, not governing skill files or the runtime. Do not fabricate
   approvals or treat a ledger reference as a host permission grant.
8. On subsequent ordinary work, capture the resolved loaded method again and
   record `run`. A matching active identity establishes adoption, regardless of
   whether that task succeeds. Evaluate efficacy separately. On regression,
   record `rollback` with evidence and have the authorized operator restore and
   reload the incumbent. The ledger preserves the promotion and adoption chain.

Use `.term2/evolution/<experiment-id>/experiment.json` for local records; this
path is already ignored by Git. Keep private inputs and credentials out of
public commits. A new experiment gets a new ledger, carrying prior evidence
references and the actually loaded incumbent. Do not edit an old event history
to change the definition of better.
