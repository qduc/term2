---
name: bug-to-invariant
description: >-
  Post-bug analysis workflow that converts every bug fix into a durable system improvement. Use this skill whenever a bug has been found, diagnosed, or fixed — including when the user says "fix this bug", "why did this happen", "post-mortem", "root cause", "regression", or asks how to prevent a bug from recurring. Also use after YOU fix any non-trivial bug in agent-written or human-written code, even if the user only asked for the fix: the fix is the floor, not the deliverable. Do NOT use for feature requests or pure style refactors with no defect involved.
---

# Bug → Invariant

A bug fix that only patches the local cause leaves the *class* of bug alive. This skill turns each bug into something the codebase learns from, by moving through three levels and shipping artifacts at the deepest level that's practical.

## The Three Levels

Always analyze all three, in order:

```
Level 1 — Bug:            What broke? (symptom, trigger, blast radius)
Level 2 — Root cause:     Why did it break? (the local mechanism)
Level 3 — System weakness: What ALLOWED this class of breakage to
                           exist and go unnoticed?
```

Level 3 is where the leverage is. The key question is not "why did this bug happen?" but **"why was this bug *possible*, and why wasn't it *caught*?"**

## Level 3 Interrogation Checklist

For the root cause you found, ask each of these. Skip none; write down the answer even if it's "N/A":

1. **Representability** — Why was the invalid state representable at all? Could a type, enum, newtype, or constructor make it unrepresentable?
2. **Boundary contract** — Was there a module/API boundary this crossed without an explicit contract (assertion, schema, validation)?
3. **Detection gap** — Why did no existing test exercise this path? Is the gap this one path, or a whole category of paths (e.g., all retry/error/concurrent paths)?
4. **Sibling paths** — Where else does the same pattern appear? Grep for it. List every sibling site and check each one *now*.
5. **Automation gap** — Could a lint rule, static check, CI gate, or property test have flagged this mechanically instead of relying on human review?
6. **Ownership/knowledge gap** — Did this survive review because no one knew the invariant existed? Was the invariant written down anywhere?

## Required Outputs

After fixing a bug, produce (in priority order — go as deep as the codebase allows):

1. **The fix** for the immediate defect.
2. **A regression test** — this is the *floor*, not the finish line.
3. **Sibling audit** — check every site found in checklist item 4; fix or file each.
4. **At least one structural artifact** that makes the *class* of mistake harder to repeat, chosen from:
   - a type/invariant that makes the invalid state unrepresentable
   - a runtime assertion or schema check at the boundary
   - a property-based or category-covering test (not just the one path)
   - a lint rule or CI check
   - if none of the above are feasible: a written invariant in the module's docs/CLAUDE.md, stated as a rule ("X must survive Y"), so the knowledge doesn't live only in one head or one PR.

If option 4 genuinely isn't worth it (trivial one-off bug, throwaway code), say so explicitly and state why — don't silently skip it.

## Reporting Format

Summarize back to the user in this shape:

```
Bug:             <what broke>
Root cause:      <local mechanism>
System weakness: <what made it possible + what made it invisible>
Fixed:           <patch + regression test>
Siblings:        <n sites checked, m fixed/filed>
Hardened:        <the structural artifact added, or why none>
```

## Guiding Principle

Don't teach every future contributor (human or agent) about every old bug. **Change the environment so the old mistake stops being easy to make.** A bug should happen once; afterward the codebase should be measurably harder to break the same way.
