---
name: god-object-refactor
description: Identifies, analyzes, and decomposes God Objects, god classes, blob classes, monolithic classes, oversized modules, and tightly coupled source files into cohesive, single-responsibility components. Trigger this when the user asks to break up, untangle, simplify, modularize, restructure, or refactor a large class/module/file, or when they say something does too many things, is hard to test, has grown too large, or mixes unrelated responsibilities.
---

# God Object Refactor Skill

## Purpose

Help decompose God Objects safely.

The goal is not smaller files for their own sake. The goal is better ownership: cohesive components that own meaningful responsibilities, expose narrow interfaces, preserve existing behavior, and reduce centralized decision-making.

Use judgment based on the language, framework, architecture, tests, and user goal. Do not turn architectural refactoring into a mechanical checklist.

---

## Required Capabilities

Use the available harness capabilities to inspect files, search call sites, run project verification, edit files, and create new files.

If an important capability is unavailable, state the limitation and adapt the plan.

---

## God Object Candidate Signals

Treat the target as a God Object candidate when one or more of these signals appear:

* It is unusually large for the project.
* It has many public methods, helper methods, fields, or dependencies.
* It mixes unrelated responsibilities such as persistence, validation, rendering, networking, business rules, authentication, caching, logging, and workflow coordination.
* It is hard to test because unrelated behaviors are coupled together.
* Its constructor or initialization requires many unrelated inputs.
* Changes for unrelated features frequently touch the same file.
* It has a vague name such as `Manager`, `Service`, `Handler`, `Helper`, `Utils`, or similar.
* The user calls it a God Object, god class, blob class, monolith, massive class, or similar.

If the target does not appear to be a God Object, say so and suggest a smaller cleanup or modularization path instead.

---

## Core Rules

Preserve observable behavior unless the user explicitly asks for behavior changes.

When the user wants behavior changes and refactoring together, sequence them separately: first perform a behavior-preserving refactor, verify it, then make the behavior change and verify again.

Prefer cohesive ownership over simple extraction.

Preserve public APIs during the initial migration unless the user approves a breaking change.

Prefer composition and narrow interfaces over inheritance or broad shared objects.

Refactor incrementally. Stop if verification regresses.

Call out uncertainty when dynamic behavior, reflection, framework magic, metaprogramming, or weak test coverage makes analysis incomplete.

---

## Anti-Goal: Do Not Create a God Orchestrator

A bad God Object refactor can turn one large object into many small classes controlled by one giant coordinator. Avoid this.

The original class or module may temporarily act as a compatibility facade, but it should not remain the permanent owner of all workflows, dependencies, sequencing rules, and business decisions.

Flag a God Orchestrator risk if the original class or module:

* Instantiates or owns most extracted components directly without a migration plan.
* Contains long methods that call many extracted services in sequence.
* Knows detailed ordering rules across multiple domains.
* Passes data through many components without owning the underlying responsibility.
* Becomes the only place where the business workflow is understandable.
* Continues to grow whenever new behavior is added.
* Has extracted helpers, but still makes all important decisions itself.

Each extraction should reduce centralized responsibility, not merely move private helper code elsewhere.

Prefer moving workflow ownership to the component, domain service, application service, use-case object, command handler, policy, or strategy that naturally owns that behavior.

Only introduce an orchestrator when orchestration itself is the single clear responsibility. Avoid vague coordinators such as `MainCoordinator`, `WorkflowManager`, or `EverythingService`.

---

## Workflow

### 1. Understand the Target

Read enough of the target to understand its public API, state, dependencies, side effects, domain concepts, responsibilities, and call sites.

For very large files, do not fail just because the file is too large to inspect comfortably. Start with public API, imports, fields, constructor/init logic, and top-level structure. Then inspect method clusters and call sites as needed until the architecture is clear enough to make a safe plan.

Collect useful signals such as size, method count, field count, dependency count, responsibility count, and testability concerns. Prefer language-aware analysis when available. Shell commands and text search are acceptable fallbacks, not mandatory rituals.

---

### 2. Establish a Safety Baseline

Before changing production code, determine how the project verifies behavior.

Use available tests, type checks, linters, formatters, build commands, package scripts, task runners, or CI configuration.

Record the baseline. If tests already fail, record which tests fail. Compare failure identities after changes, not just pass/fail counts.

If no useful tests exist, warn the user and recommend characterization tests for current public behavior before refactoring. When appropriate, create minimal characterization or smoke tests before changing production code.

When version control is available, check for existing user changes before editing. Avoid mixing unrelated changes into the refactor.

---

### 3. Identify Responsibility Clusters

Group behavior by real cohesion, not superficial naming.

Use these signals:

* Shared state or fields
* Shared dependencies
* Shared domain concept
* Shared side-effect boundary
* Shared lifecycle
* Shared validation rules
* Shared persistence model
* Shared external API or infrastructure concern
* Methods that change for the same reason

A field-access matrix can be useful for large classes with many instance fields, but it is a tool, not the goal. Build the most accurate map possible with the tools available.

Identify seam methods that touch multiple clusters or coordinate workflows. These may need to remain temporarily as facade methods, or they may indicate a missing use-case/application-service abstraction.

---

### 4. Propose the Architecture Before Major Edits

Before invasive production-code edits, present a concise blueprint.

Include:

* Why the target is or is not a God Object candidate.
* Major responsibilities found.
* Proposed extracted components.
* Which methods and state each component should own.
* Which public methods remain as compatibility delegates.
* Which workflows need a better owner.
* God Orchestrator risks.
* Test and verification plan.
* Unknowns or coverage gaps.

Proceed with edits if the user already gave a clear mandate. Otherwise, ask for confirmation before broad architectural changes.

---

### 5. Extract Incrementally

Extract one cohesive responsibility at a time.

Start with the most isolated cluster. Leave the most cross-cutting or workflow-heavy cluster until later.

For each extraction:

* Create a focused component with one clear reason to change.
* Move the state and behavior that naturally belong together.
* Preserve existing public behavior.
* Keep original public methods as thin delegates when needed.
* Avoid circular dependencies.
* Avoid making the old object the permanent orchestrator.
* Update imports, construction, and call sites carefully.
* Run relevant verification.
* Stop if verification regresses.

Private helpers may be moved when call sites are updated and behavior is preserved. Public or externally callable methods should not be deleted during the initial extraction unless the user approves an API-breaking change.

When version control is available, offer to commit or checkpoint after each verified extraction.

---

### 6. Reassign Workflow Ownership

After extracting low-level responsibilities, evaluate whether workflows are still centralized in the original object.

If the original object still controls too much sequencing or business decision-making, move workflow ownership to a better-named owner, such as:

* `CheckoutUseCase`
* `InvoiceApprovalService`
* `ReportGenerationWorkflow`
* `UserRegistrationHandler`
* `PaymentRetryPolicy`

The owner should describe the use case or policy it owns, not act as a generic coordinator.

---

### 7. Preserve Compatibility, Then Offer Cleanup

The original class or module may retain compatibility delegates as part of a strangler-fig migration. That is acceptable as a temporary bridge.

After safe extraction and stable verification, offer cleanup:

* Search for external callers of facade methods.
* Remove zero-caller delegates only when safe.
* Update direct callers to use new components where appropriate.
* Run final verification.

Do not remove compatibility methods blindly.

---

## Architecture Blueprint Template

### God Object Assessment

* Target:
* Candidate status:
* Key signals:
* Current verification baseline:
* Existing risks or unknowns:

### Responsibilities Found

* Responsibility 1:
* Responsibility 2:
* Responsibility 3:

### Proposed Target Architecture

* `NewComponentA`

  * Owns:
  * Moves:
  * State/dependencies:
  * Reason to change:

* `NewComponentB`

  * Owns:
  * Moves:
  * State/dependencies:
  * Reason to change:

* `OriginalClassOrModule`

  * Temporary compatibility role:
  * Public delegates retained:
  * Logic that should no longer live here:
  * God Orchestrator risk:

### Migration Plan

1. Establish or confirm verification baseline.
2. Extract the most isolated responsibility first.
3. Preserve public behavior with thin delegates where needed.
4. Run verification.
5. Repeat for the next cohesive responsibility.
6. Reassign workflow ownership if the original object is becoming an orchestrator.
7. Run final verification.
8. Offer optional cleanup of unused compatibility methods.
