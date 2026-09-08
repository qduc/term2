# Type-checked TypeScript in run_code

## Resume here

User decision (2026-09-08): add type-checked scripts to the
[Stage 3 specification](tool-interface-stage3.md), not just syntax stripping
or typed documentation. This is a draft contract, not a runtime implementation
or authorization to launch paid measurements.

Proposed split: Stage 3A defines explicit semantic rejection; Stage 3B adds
TypeScript checking against that contract. Keep the treatments independently
reviewable and measurable. TypeScript is not a reason to reopen Stage 2 native
structured returns. Successful JSON-string returns remain strings.

## Goal and limits

Before a TypeScript script executes, check its syntax and statically knowable
tool contracts. On blocking diagnostics, execute none of that invocation's
script and dispatch none of its nested tool calls. Return actionable diagnostics
against the submitted source so the model can repair it without replaying work.

This is an authoring aid, not a security boundary or effect guarantee. TypeScript
cannot prove that an operation will succeed, that a target is correct, that
permissions are available, or that a result will serialize. Type assertions,
`any`, compiler suppression comments, and dynamic data can evade static checks.
Runtime schema validation, approval, sandbox isolation, output validation, and
host receipts remain authoritative. TypeScript does not have checked exceptions:
a return type cannot force a caller to handle a rejected Promise.

## Verified starting points

Source inspection at `e2b329cb`:

- `SandboxedCodeHostImpl.run` accepts JavaScript source, checks its byte bound,
  and creates the disposable worker; `host-worker.ts` owns execution bindings
  and realm isolation. These paths do not provide semantic TypeScript checking.
- Tool definitions in `source/tools/types.ts` expose schema objects and optional
  `canonicalParameters`; `scriptedReturnShape` is prose, not a machine-readable
  type contract. Do not parse it to invent types.
- `namespaceBinding` constructs catchable Error objects inside the vm realm.
  Stage 3A's failure discriminants must be settled before declaring them to
  TypeScript callers. Host objects must not be installed in that realm.
- `package.json` lists `typescript`, `typescript-7`, and `tsx` as development
  dependencies. A shipped checker needs an explicit production dependency and
  packaging decision; a local development installation is not proof of support.
- The package supports Node >=20. Native type stripping in newer Node releases
  is neither a portable implementation nor semantic type checking.

Read the Resume sections of [one sandboxed code host](sandboxed-code-host.md),
[authoring friction](run-code-authoring-friction.md), and
[nested approval](run-code-nested-approval.md) before implementation.

## Proposed public contract

- Add an explicit language selection to `run_code`: JavaScript remains the
  default; TypeScript opts into the checked path. Finalize the schema field
  during implementation design. No syntax autodetection or automatic retry as
  JavaScript after a failed check.
- Retain the current async-function-body grammar: await and return at the
  submitted top level are valid. The virtual checker wrapper and runtime wrapper
  must agree on bindings, scope, and return behavior.
- Initial scope is self-contained scripts: no static/dynamic imports, exports,
  package resolution, JSX, filesystem references, or workspace tsconfig. Do not
  expose Node or browser APIs merely because their ambient types are installed.
- Use one pinned compiler/configuration for checking and emission. Require
  semantic checking, not only transpilation or syntax diagnostics. Proposed
  baseline is strict checking, including unknown catch variables. Compiler
  version, supported language features, and options are implementation blockers.
- Only checked emitted JavaScript enters the existing execution host. Never
  execute source during checking; type discovery and emission must not invoke
  tools, project code, package scripts, plugins, or project config.
- On failure, report a distinct checking result, source positions, diagnostic
  codes, bounded messages, and that this invocation dispatched no nested calls.
  An empty action ledger is not a whole-task success claim.
- On success, normal execution, approval, failure, and receipt contracts apply.
  A successful check is not a successful action. Default JavaScript scripts
  acquire no TypeScript diagnostics; Stage 3A rejection is language-independent.

## Authoritative tool types

Declarations must describe the exact runtime-visible namespace for that
invocation, including synthetic members such as describe where exposed. A tool
being declared does not grant approval or make it directly callable. Runtime
policy is still evaluated at the existing authority boundary.

Input types must model accepted input, not just normalized schema output:
coercions, optional/defaulted fields, unions, and refinements need a fidelity
audit. Reuse canonical schemas where faithful. A lossy conversion must disclose
its limitation; it must not substitute an empty parameter object or claim
refinement checks have been proved statically.

Return types need a machine-readable, owner-reviewed contract distinct from
`scriptedReturnShape` prose. Reuse existing type/schema ownership where possible;
do not maintain a handwritten second catalog detached from executor behavior.
Represent JSON strings as string, genuinely structured results by their actual
shape, and uncertain results as unknown, not permissive any. An unknown fallback
allows the call but requires narrowing before property access and must be visible
in discovery. The coverage matrix must name precise versus fallback contracts;
do not claim catalog-wide precise checking without it.

Stage 3A rejection discriminants must match the actual sandbox error shape.
Catch variables remain unknown until narrowed. Built-in `JSON.parse` and explicit
casts can erase guarantees; this slice does not claim a sound proof system or
introduce a new parser helper to hide that limitation.

Declarations must not leak hidden tools or expose process, require, filesystem,
network, or host constructors. Tests must compare declared members against the
bound registry, including worktree/profile variations where applicable.

## Compiler isolation and lifecycle

Use a controlled virtual source/declaration environment. Module/reference
resolution must not fall back to the workspace, home directory, installed
`@types`, network, or arbitrary disk paths. Loading compiler-owned bundled
libraries is distinct from allowing user-directed file reads. Script-supplied
ambient declarations may spoof types but cannot create runtime bindings or
authorize capabilities; checking remains outside the security claim.

Checking adversarial source can consume substantial CPU/memory even without
executing it. It must be cancellable without blocking the interactive event
loop. Choose an isolated compiler lifecycle after measuring cold/warm checking,
large valid scripts, and pathological type expansion. Do not add another code
execution engine or expose the compiler API as a sandbox binding.

The invocation's configured execution allowance must cover checking and
execution; do not reset it after compilation. Source and emitted-code bounds
must both be enforced under a reviewed policy. How compilation shares existing
timeout/memory owners, and whether extra containment is justified, are open
guard-design items. No arbitrary compiler budget is chosen here. Compilation
cancellation/timeout means this invocation executed no script; runtime
termination after dispatch retains existing uncertain-effect semantics.

Map diagnostics and runtime exceptions back to submitted source, hiding wrapper
offsets and generated helper locations. Use compiler position/source-map
metadata rather than fragile line arithmetic alone. Preserve source identity
without logging arbitrary source or secrets by default. If caching is needed,
key it by source, compiler/options, declaration snapshot, and wrapper version.
Do not allow stale types to describe a different bound registry. A cache or
persistent compiler is not required for the first slice.

## Acceptance and measurement

Tests through the public tool boundary must establish:

- Valid typed async scripts execute; invalid argument types, missing required
  fields, unknown tool names, and misuse of known return shapes are diagnosed.
- A type error textually after a mutation prevents that mutation: no script
  body, approval prompt, or nested dispatch occurs before checking.
- Checking uses accepted input contracts and honest unknown fallbacks, including
  legitimate coercions and dynamic-value runtime validation.
- Caught Stage 3A errors narrow using the real error contract; types do not
  fabricate effect certainty or require exceptions to be caught.
- Locations survive the async wrapper, TypeScript emission, and runtime failure.
  Imports/references/ambient-library attempts cannot expand checker access or
  runtime capabilities.
- Existing realm-escape, approval, output-bound, receipt, cancellation, and
  JavaScript compatibility tests remain green. Compiler failures settle without
  tool effects; runtime failures retain truthful partial-work evidence.
- Cold/warm overhead, cancellation, pathological types, and declaration growth
  meet a reviewed guard contract based on measurements.
- An installed production package without development dependencies works on
  supported Node versions, without workspace tsconfig or local types.

Run required focused, related, changed, typecheck, isolated full-suite, and
applicable provider black-box gates. Compiler packaging and shared-host changes
require integration coverage, not only unit tests.

Measure Stage 3B separately from Stage 3A across the three required models with
reviewed routes, limits, and stopping rules before paid execution. Models must
author scripts and respond to real diagnostics; do not feed handpicked corrected
scripts or count diagnostic presence as improvement. Freeze tasks exercising
invalid arguments, return-shape mistakes, recoverable semantic failures,
dynamic-data limits, and successful controls. Compare against accepted Stage 3A
to avoid attributing receipt/rejection gains to types.

Primary measures: task correctness, false completion claims, unnecessary action
replay, and whether statically preventable invalid calls were stopped before
dispatch. Secondary measures: repair turns, tool calls, tokens, checker time/
memory, end-to-end latency, and distribution size. A checker can prevent a bad
call yet cost more recovery turns; report both rather than equating static
rejection with model success.

## Remaining engineering decisions

1. Pin the compiler and production packaging; prove real semantic checking.
2. Inventory authoritative input/return types and explicit unknown fallbacks.
3. Finalize language schema, virtual wrapper/libs, and diagnostic/error shape.
4. Set compiler isolation/resource policy from measured legitimate and
   adversarial inputs; review the full guard ledger before implementation.
5. Produce red tests and a preregistered Stage 3B live protocol.

No additional user preference is needed to investigate these items. The selected
goal is type-checked TypeScript, not transpile-only execution.
