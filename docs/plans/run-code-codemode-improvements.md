# `run_code` lifecycle and contract improvements

## Resume here

Status: Milestones 0–2 merged in `89e7e0ab` and `c52c67d1` (2026-09-12); Milestone 3 is in progress.

This plan follows a comparison of Term2's current `run_code` behavior with the
reverse-engineered `CodeMode Specification.md` for
`@opencode-ai/codemode` 1.18.30. The external document is comparative evidence,
not an authoritative contract for Term2 or a source that overrides the live
code.

Milestone 0 confirmed the unfinished-call settlement defect through the public
`run_code` boundary. Start with Milestone 1 and turn the eight expected-failure
contract tests in `run-code.test.ts` green; do not weaken their assertions to
match the current early-settlement behavior.

Before touching this area, also read:

- [One sandboxed code host](sandboxed-code-host.md) for the realm-isolation rule
  and the rejected process/socket design.
- [`run_code` authoring friction](run-code-authoring-friction.md) for measured
  failure classes and decisions already shipped.
- [Inline approval for nested `run_code` calls](run-code-nested-approval.md) for
  approval continuation, authority revalidation, and clock ownership.
- [Type-checked TypeScript in `run_code`](run-code-typescript.md) before changing
  the accepted language or generating tool declarations.

Use the `architecture`, `testing`, and `guard-design` skills for implementation.
Changes to the shared sandboxed host also require the applicable integration
coverage described by the repository test policy.

## Goal

Make a `run_code` invocation have one explicit, machine-readable lifecycle from
source acceptance through nested-call settlement and final rendering, while
preserving the product behavior that is already stronger than the compared
runtime:

- inline nested approval and post-wait authority revalidation;
- host-observed action receipts and honest uncertain-effect reporting;
- safe default call, concurrency, source, output, console, media, and time
  bounds;
- serial execution for tools that are not declared parallel-safe;
- attachment preservation and large-output recovery artifacts;
- privacy-safe completion telemetry.

The target boundary should let execution, telemetry, tests, and terminal
rendering consume the same structured outcome. Human-readable strings remain a
presentation surface, not the source of semantic classifications.

## Non-goals

- Do not replace the Node worker/VM with a custom JavaScript interpreter in this
  program. That would be a separate security architecture decision with its own
  language-conformance cost.
- Do not revive the rejected child-process/Unix-socket sandbox. The failures
  recorded in `sandboxed-code-host.md` remain applicable unless separately
  disproved.
- Do not add transpile-only TypeScript support. The existing TypeScript plan
  requires semantic checking after its evidence gate.
- Do not remove approval, move authorization into model-authored code, or treat
  catalog visibility as authority.
- Do not add an OpenAPI adapter without a concrete registry consumer.
- Do not infer whole-task success from script success or from an empty action
  ledger.

## Verified starting point

The following claims were checked against the source on 2026-09-12. Recheck
their symbols before implementation because line positions and surrounding
ownership may move.

- `createRunCodeToolDefinition` in `run-code.ts` binds the final wrapped tool
  registry, validates nested inputs, evaluates approval, brokers inline approval,
  records nested calls and selected action semantics, captures media, emits
  telemetry, and renders the model-visible result.
- `SandboxedCodeHostImpl.run` owns the disposable worker lifecycle, active-work
  and long-stop clocks, parent cancellation, output checks, and per-capability
  admission ledgers.
- `WORKER_TEMPLATE` in `host-worker.ts` creates capability wrappers inside the VM
  realm, tracks worker-local in-flight request IDs, and emits
  `workflow.complete` after the submitted async-function body resolves.
- `HostResult` and `HostErrorCode` in `host-types.ts` are structured internally,
  but `renderResult` turns them into text for the outer tool result.
- `isUnsuccessfulRunCodeOutput` and parts of
  `classifyRunCodeCompletionTelemetry` recover semantics from rendered message
  text or message prefixes.
- `renderToolsHeader` renders selected full signatures and compact entries;
  `tools.describe` requires the exact tool name and returns its input schema plus
  the `scriptedReturnContract` state/schema and optional legacy
  `scriptedReturnShape` guidance. There is no catalog budget, namespace-fair
  selection, or search protocol.
- `scriptedReturnShape` remains descriptive migration prose. Tool definitions
  now optionally expose `scriptedReturnSchema`, whose value is the exact
  script-visible result after script-path normalization. Missing schemas are an
  explicit unknown state; discovery does not interpret the prose.
- Explicit `ACTION_SEMANTICS` adapters currently cover
  `configure_task_check_in` and `cancel_run`. Other calls still receive generic
  call outcomes, but their domain-level applied/not-applied semantics are not
  inferred.

## Design principles

1. **Admission creates settlement debt.** Every admitted nested call must appear
   in the terminal invocation outcome as settled or explicitly unknown.
2. **A deadline is not a drain extension.** Normal completion may drain admitted
   work; timeout, deadline, and parent cancellation retain their existing owners
   and must not wait indefinitely for cleanup.
3. **Host evidence outranks script claims.** A script may catch a failure or
   return misleading text, but it cannot rewrite call or action receipts.
4. **Rendering is downstream of semantics.** Telemetry and tests consume typed
   outcomes, not terminal prose.
5. **Unknown is an honest contract.** A tool without a precise output schema is
   exposed as unknown rather than assigned an invented type.
6. **Discovery and authority stay separate.** Search results describe callable
   paths but do not pre-approve them.
7. **Measure before adding catalog machinery.** The current flat registry may not
   justify a search subsystem until header size or failed discovery crosses a
   recorded threshold.

## Milestone 0 — Pin pending-call behavior and settle the contract

### Questions to answer with tests

Exercise the public `run_code` boundary with controlled capabilities for:

1. an unawaited nested call that succeeds after the script body returns;
2. an unawaited nested call that rejects after the body returns;
3. a script-level throw while another admitted call remains pending;
4. `Promise.race` with a slow successful loser;
5. `Promise.race` with a slow mutating loser;
6. parent cancellation and configured timeout with a call in flight;
7. an unawaited call waiting for interactive approval.

Record whether each call executes, is aborted, settles after the outer result,
or disappears from the final call/action evidence. Tests that demonstrate an
undesired current behavior must be red before production changes.

### Contract to approve before Milestone 1

- Resolving or rejecting the script body closes nested-call admission.
- On normal script completion or script-level failure, the host drains every
  already-admitted call within the invocation's existing clocks.
- A rejected promise that the script never observes changes an otherwise
  successful invocation to an `unhandled_nested_failure` diagnostic.
- Successful unobserved calls remain visible in the call ledger and any
  applicable action ledger.
- `Promise.race` does not automatically claim that losing mutations were
  cancelled. Initial behavior should drain losers; changing to active loser
  cancellation requires separate evidence and effect semantics.
- Timeout, deadline, or parent cancellation aborts in-flight work and records any
  call that cannot prove settlement as `unknown`; draining does not reset or
  extend the guard.
- An admitted approval-waiting call remains part of the invocation. The active
  work clock may pause under the existing predicate, while the long-stop clock
  remains authoritative.

### Done condition

The current behavior matrix and the intended contract are test-pinned, and any
guard change has a reviewed `guard-design` contract before implementation.

### Milestone 0 evidence (merged in `89e7e0ab`)

The `admitted nested-call settlement` block in
`source/tools/system/run-code/run-code.test.ts` exercises the public tool
definition with controlled capabilities. Eight `it.fails` cases preserve the
intended assertions without making the branch permanently red; Milestone 1 must
remove `.fails` rather than rewrite the assertions.

| Scenario | Observed before Milestone 1 |
| --- | --- |
| Unawaited successful call | The outer invocation returns before the capability is released, and the call is absent from the final call summary. |
| Unawaited rejected call | The outer invocation reports script success; the later nested failure and call are absent. |
| Script throw with a pending call | The script error returns before the capability settles, and the admitted call is absent. |
| Slow successful `Promise.race` loser | The race winner completes the outer invocation; the loser is not drained into final evidence. |
| Slow mutating `Promise.race` loser | The action receipt remains `unknown` and the call is absent when the outer invocation returns. |
| Parent cancellation with a call in flight | Cancellation aborts the run and preserves an `unknown` action receipt, but the admitted call is absent from the call ledger. |
| Configured timeout with a call in flight | Timeout aborts the run and preserves an `unknown` action receipt, but the admitted call is absent from the call ledger. |
| Unawaited interactive approval wait | Once the script's separately awaited barrier completes, the outer invocation returns and aborts the pending approval instead of keeping it attached. |

Red/characterization proof:

```text
pnpm test source/tools/system/run-code/run-code.test.ts \
  source/services/sandboxed-code-host/sandboxed-code-host.test.ts \
  source/services/sandboxed-code-host/host-worker.test.ts
PASS: 138 tests; 8 expected failures (the settlement contract pins)

pnpm test:changed
PASS: 103 tests; 8 expected failures

pnpm typecheck
PASS
```

### Guard-design contract for Milestone 1

```text
Harm prevented: an invocation reporting terminal success or failure while an
  admitted nested call can still settle, mutate state, or disappear from final
  evidence.
Scope and execution paths: normal completion and script failure in the shared
  SandboxedCodeHost capability lifecycle; timeout, deadline, parent cancellation,
  nested approval, serial lanes, and parallel-safe lanes retain their existing
  execution paths.
Guard class: lifecycle settlement barrier with containment-budget interaction.
Enforcement owner: SandboxedCodeHostImpl.run and the worker protocol it owns.
Recovery owner: SandboxedCodeHostImpl.run for abort/terminal settlement; each
  capability adapter remains the owner of its call and action evidence.
Measured signal and observation boundary: worker-reported script-body terminal
  state plus the host's direct count of admitted calls that lack terminal
  outcomes.
Direct evidence or proxy: both signals are direct lifecycle evidence. Elapsed
  time remains only the existing containment proxy.
Legitimate work that can produce the same signal: slow successful tools,
  Promise.race losers, serial-lane waiters, and interactive approval waits.
Configuration sources and precedence: unchanged invocation timeout and parent
  signal, with the existing host long-stop deadline; no new setting or override.
Effective default and clamping: unchanged.
Action and why the signal justifies it: close admission when the script body
  settles; on ordinary script success or failure, delay terminal rendering until
  every admitted call settles. Timeout, deadline, and cancellation abort instead
  of extending the drain.
Partial-work settlement: every admitted call receives a stable terminal or
  unknown record; host-observed action receipts remain authoritative.
Retry, fallback, and provider-continuity semantics: unchanged; an unobserved
  nested rejection becomes unhandled_nested_failure and is not replayed
  automatically.
Observability fields: existing host error code, call identities/outcomes, action
  receipts, and completion telemetry; Milestone 2 owns the fuller structured
  execution outcome.
Persisted-setting migration, if any: none.
Rollback boundary: the host/worker settlement-barrier change and the conversion
  of the eight expected-failure pins to ordinary passing tests.
Ledger row: confirmed defect — admitted nested-call early settlement.
```

## Milestone 1 — Make admitted-call settlement a host invariant

Move completion gating into the shared host lifecycle rather than relying on
model instructions to await every promise. The worker/host protocol needs an
explicit distinction between:

- script body resolved or rejected;
- nested admission closed;
- admitted calls still pending;
- nested results observed by script code;
- all settlement debt discharged;
- invocation terminal.

Do not infer observation solely from promise creation. The transport wrapper must
know whether a rejected nested result was consumed by `await`, `catch`,
`allSettled`, or another supported JavaScript path before classifying it as
unhandled. Preserve ordinary JavaScript behavior where possible and document any
intentional difference.

The final result must include stable call identities and terminal or unknown
outcomes for every admitted call. A timeout/cancellation race must not turn an
unsettled mutation into success merely because the script body returned first.

### Acceptance criteria

- All Milestone 0 scenarios match the approved contract.
- No admitted call is absent from terminal host evidence.
- An unawaited nested rejection cannot produce an outer success.
- Normal draining respects parallel-safe and serial lanes.
- Approval waits retain the current pause predicate and long-stop behavior.
- Timeout, deadline, and cancellation remain distinguishable.
- Existing action receipts remain host-owned and cannot be forged by the script.

## Milestone 2 — Introduce one structured execution outcome

Define an internal `RunCodeExecution` contract owned below terminal rendering. A
candidate shape is:

```ts
interface RunCodeExecution {
  script:
    | { status: 'succeeded'; value: JsonValue; voidOutput: boolean }
    | { status: 'failed'; diagnostic: RunCodeDiagnostic };
  calls: RunCodeCallRecord[];
  actions: RunCodeActionReceipt[];
  console: JsonValue[][];
  attachments: RunCodeAttachment[];
  truncation?: RunCodeTruncation;
}
```

The exact names are implementation decisions, but diagnostics need stable
discriminants for at least syntax, runtime, unknown tool, invalid nested input,
invalid nested output, nested tool failure, unhandled nested failure, call
budget, invalid script return, timeout, deadline, cancellation, oversized code,
and sandbox unavailability.

`renderResult` should consume this structure and preserve the current useful
terminal prose, console policy, media parts, retrieval notes, refusal summary,
and action receipts. `emitRunCodeCompletionTelemetry` should consume the same
structure directly. Remove semantic dependence on `FAILURE_PREFIXES`,
`isUnsuccessfulRunCodeOutput`, and message-substring classification once all
callers have migrated.

### Acceptance criteria

- Changing diagnostic wording cannot change telemetry classification or the
  persisted success bit.
- Script success, nested-call outcomes, action outcomes, lifecycle completion,
  and whole-task success remain explicitly distinct.
- Existing model-visible text and content-part behavior is compatibility-tested.
- Diagnostic details remain bounded and do not expose private host causes, raw
  scripts, arguments, or paths through telemetry.

## Milestone 3 — Add authoritative nested-output contracts

Add an optional machine-readable contract for the exact value a tool exposes to
script code. Reuse an existing schema owner where faithful; do not parse
`scriptedReturnShape` prose or create a detached handwritten type catalog.

The migration must support three honest states:

1. precise output schema, validated before the value crosses into the VM;
2. explicit `unknown` fallback for a scriptable tool without a precise contract;
3. legacy prose retained temporarily for model guidance while owners migrate.

Generated discovery text and any future TypeScript declaration must come from
the authoritative contract. Input coercions, transforms, direct-call formatting,
and script-specific structured returns need explicit coverage; the schema must
describe what the script receives, not an adjacent internal or terminal shape.

### Acceptance criteria

- A tool that violates its declared script output fails as
  `invalid_tool_output` before invalid data enters the VM.
- Output validation failure records completed effect evidence and does not invite
  blind replay.
- Tools without precise contracts remain usable but discoverably return unknown.
- Registry tests prevent a claimed precise contract from silently disappearing.
- `run-code-typescript.md` can consume the contract without interpreting prose.

## Milestone 4 — Measure and, if justified, improve discovery

### Measurement gate

Before changing the catalog, record for representative profiles and tool
registries:

- rendered `run_code` description characters and estimated tokens;
- number of scriptable tools and any natural namespace groupings;
- frequency of `tools.describe` calls;
- unknown-tool and wrong-tool-name failures;
- turns spent discovering tools not already in the essential set;
- projected growth from planned MCP or OpenAPI consumers.

If the catalog remains small and discovery failures remain rare, close this
milestone with evidence and keep `tools.describe`. Do not build search merely for
conformance with the compared runtime.

### Conditional implementation

If the measurement demonstrates a material problem, add:

- a catalog budget with explicit complete/partial labels;
- representation for every namespace even when no full signature fits;
- deterministic, namespace-fair signature selection;
- searchable names, descriptions, and input field names;
- exact lookup by model-visible callable path;
- bounded pagination returning callable paths and complete signatures.

Search remains metadata: it does not consume the nested execution-call budget,
grant approval, or bypass the invocation's wrapped registry snapshot. Reserved
namespace/name handling must be explicit before nested namespaces ship.

### Acceptance criteria

- Catalog output stays within its declared budget and states omissions honestly.
- A namespace cannot monopolize the signature budget.
- Search results correspond exactly to members callable in that invocation.
- Hidden or prohibited tools do not leak through catalog or search.
- Approval and physical-path authority are still evaluated only at dispatch.

## Milestone 5 — Harden and document the confinement boundary

Keep the current worker/VM architecture for this milestone. Audit it against the
repository's established invariant: every value exposed to model-authored code is
created in the VM realm or serialized across the boundary.

Expand adversarial coverage for constructors, prototypes, getters, proxies,
errors, promises and async continuations, newly exposed built-ins, capability
names, and result deserialization. Include an independent security review of the
binding site in `WORKER_TEMPLATE`.

Document the exact claim: the disposable worker provides lifecycle isolation and
termination, and the VM provides a confined capability surface, but neither is an
OS/container boundary. If product requirements later demand hostile-code
containment as a security boundary, open a separate architecture decision to
compare an owned interpreter, an isolate runtime, and an OS-contained process.
Do not make that decision inside this incremental plan.

### Acceptance criteria

- Realm ownership is asserted directly, not approximated by checks such as
  `typeof process === 'undefined'`.
- No host-realm callable or object is reachable from submitted code.
- Capability arguments and results cross through the reviewed plain-data/media
  contracts.
- New bindings have a test that would fail if their constructor chain reached a
  host capability.
- The documented security claim matches the mechanism and names its limits.

## Milestone 6 — Deepen the product/runtime boundary

After Milestones 1–3 stabilize the contracts, evaluate a cohesive runtime object
for one snapshotted, wrapped tool surface. It should own discovery, admission,
settlement, structured ledgers, result normalization, and attachment references.
The outer `run_code` tool definition should retain the model-facing parameter
schema, session wiring, and terminal presentation.

A candidate interface is illustrative, not prescribed:

```ts
const runtime = createRunCodeRuntime({
  tools: wrappedToolSnapshot,
  authority,
  limits,
  telemetry,
});

runtime.discovery();
runtime.execute({ code, signal, approvalOwner });
```

Use the deletion test from the architecture guidance. Extract only if removing
the runtime would spread lifecycle policy and invariants back across callers; do
not split `run-code.ts` into pass-through wrappers merely to reduce file size.

### Acceptance criteria

- Registry filtering and approval policy still use the final wrapped tool graph.
- Session/UI concerns do not enter the shared execution host.
- Common execution does not require callers to manually sequence admission,
  draining, normalization, and receipt finalization.
- `run_agent_workflow` behavior is unchanged unless a shared-host invariant is
  deliberately migrated with its own tests.

## Deferred follow-ups

### TypeScript

Continue the telemetry threshold and decisions in `run-code-typescript.md`.
Milestones 2 and 3 supply prerequisites—stable diagnostics and machine-readable
returns—but do not authorize a compiler. If the evidence gate opens, implement
checked TypeScript before execution; do not silently strip types and run code
that failed semantic checking.

### OpenAPI and large external catalogs

An OpenAPI adapter belongs in a separate plan when a concrete host integration
needs it. It must skip unsupported encodings rather than guess, keep
authentication host-side, and feed the same wrapped registry and discovery
contracts as native tools. Milestone 4 may be pulled forward if that consumer
makes the current catalog materially too large.

### Broader action semantics

Do not infer domain success from generic resolved promises. Add an
`ACTION_SEMANTICS` adapter only when the tool owner can define applied, not
applied, failed, and unknown from its actual result contract. Track coverage and
prioritize mutating tools whose ambiguous settlement creates replay risk.

## Validation strategy

Each milestone must start with a focused baseline and red evidence for any bug it
claims to fix. During implementation, run the owning focused suites, including as
applicable:

- `source/services/sandboxed-code-host/sandboxed-code-host.test.ts`
- `source/services/sandboxed-code-host/host-worker.test.ts`
- `source/services/sandboxed-code-host/sandboxed-code-host.e2e.test.ts`
- `source/tools/system/run-code/run-code.test.ts`
- `source/tools/system/run-code/run-code-action-receipts.test.ts`
- `source/tools/system/run-code/run-code-telemetry.test.ts`
- `source/tools/system/run-code/run-code.physical-binding.test.ts`
- `source/tools/system/run-code/scripted-e2e.test.ts`
- registry/model-surface tests when discovery or binding changes.

After a coherent source change, run `pnpm test:related`. For a narrow handoff,
run `pnpm test:changed` and `pnpm typecheck`. Shared-host lifecycle, protocol,
package, or broad registry changes may justify the wider gates in `AGENTS.md`;
record the concrete trigger before launching them. Provider black-box coverage is
required only when the changed boundary reaches provider, run-loop, registry, or
non-interactive behavior under the `provider-testing` guidance.

For documentation-only edits to this plan, Prettier checking is sufficient.

## Program exit criteria

This plan is complete when:

1. every admitted nested call has terminal or explicitly unknown host evidence;
2. unobserved nested failures cannot be reported as successful invocations;
3. execution, telemetry, persistence success, and terminal rendering consume one
   structured outcome rather than parsing prose;
4. precise nested-output contracts are runtime-validated and unknown fallbacks
   remain honest;
5. discovery is either improved or explicitly retained based on recorded
   measurements;
6. the current confinement boundary has adversarial tests and an accurately
   scoped security claim;
7. the product/runtime boundary owns lifecycle invariants without introducing
   shallow pass-through modules; and
8. TypeScript, OpenAPI, and any stronger isolation mechanism remain separate,
   evidence-gated decisions.
