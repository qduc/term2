# Resume here

Codex-style exec — revised spec v2 (supersedes `codex-style-exec-spec.md` v1
at `eac0cf28` for all normative content; v1 remains as history).

Independent review (Sol, `/tmp/sol-spec-review.md`, full text, read before
touching this area) found six issues, one critical. Verified against code;
disposition per issue below. Net effect: v1's M1 is dropped (already exists),
v1's §2 mechanism is replaced, milestones are reordered as independent
experiments, and the feature as originally scoped (full JS-sandbox exec) is
NOT recommended for build. What survives is narrower.

## Review dispositions (code-verified)

- SEV-1 (critical) ACCEPTED. Approval pause is owned by
  `ApplicationRunLoop.#dispatchToolCalls` (plan → `needsApproval` →
  `PendingApproval` → `#settleToolPlan`; verified
  `application-run-loop.ts:1478-1525`), and `SchemaToolDefinition.execute`
  has no nested pause protocol (`tools/types.ts` interface carries no
  approval seam). `apply_patch.execute` resolves with
  `allowOutsideWorkspace: true` explicitly assuming `needsApproval` gated it
  (`apply-patch.ts:424-426`). `agent-factory.ts:158-164` wraps
  `needsApproval` and `execute` as independent closures — calling the latter
  never re-enters the former. V1's "capability-interposed tools.*" was
  therefore unsound as specified: any inner call needing approval either
  bypasses it (SEV-1 scenario) or cannot suspend (no protocol). Design change
  adopted: inner calls may only invoke capabilities the RUN LOOP has already
  admitted for non-interactive execution — i.e. the `run_agent_workflow`
  policy (review's cheaper alternative, verified
  `workflow-evaluator.ts:292-300`): tools requiring approval are REJECTED
  inside programs with `approval_required`, never suspended. No nested pause
  protocol is proposed; that protocol would be a run-loop feature, not an
  exec feature, and is out of scope.
- SEV-2 ACCEPTED. `execute-shell.ts:507` (stdin closed at spawn in the
  observed path) and `BackgroundShellRegistry` surface (get/cancel/observe;
  registry holds command/controller/result, no stdin writer) confirm:
  held-stdin resume does not exist here, and arbitrary stdin is a new
  unclassified channel (Python/REPL bytes are not shell). V1 M2 is rescoped
  to poll-only (E2 below); `write_stdin` with non-empty input is explicitly
  out of scope until a protocol-specific validation design exists.
- SEV-3 ACCEPTED with correction. The reviewer is right that `max_output_*`
  bounds returned output, never the model-authored argument, and that the
  paired repro weakens the schema-causal claim (recorded in the repro doc
  itself). V1's "bounded exec program" language is retracted as causal: the
  Codex A/B is now stated as correlation with a named confound (different
  lane: chaining, reasoning replay, prefix shape uncontrolled). Consequence:
  any patch-input cap must be justified as containment (defense in depth
  alongside the 100k guard), not as the trigger fix. Per-inner-call argument
  limits + cumulative inner-call limits are adopted as requirements IF a
  program tool is ever built.
- SEV-4 ACCEPTED. Verified in logs: Codex's shape is fresh-program →
  opaque numeric session id (`write_stdin({session_id:35380,…})` verbatim) →
  later-program polls; the JS program never holds a child. V1 §3's
  duplication objection is withdrawn. Required shape adopted: disposable
  evaluator + session-owned broker on the existing registry; programs receive
  opaque handles only.
- SEV-5 ACCEPTED. `workflow-sandbox.ts` + `workflow-worker.ts` +
  `workflow-types.ts` (16KB code / 64KB output / 16KB console bounds) confirm
  a disposable `node:vm` evaluator already exists. "New dependency required"
  is retracted; bare worker threads removed as sufficient isolation. Any
  program tool MUST reuse or harden this evaluator (null-prototype context,
  no string/WASM generation, host-side limits) and needs an explicit threat
  assessment before widening from one `agent()` capability to N tools. No
  such assessment is undertaken by this spec.
- SEV-6 ACCEPTED. `shellParametersSchema` already exposes model-chosen
  `max_output_length` (40k default; `shell.ts:99-131`), execution honors the
  per-call value (`shell.ts:908-918`), and real calls carry values like 12000
  (review cites replay test; background path clamps to configured max,
  foreground does not — `shell.ts:912-918`). V1 M1 is therefore dropped in
  full, not reframed. Foreground-clamp asymmetry is noted as a (separate,
  minor) hardening candidate but NOT authorized here. Abandon criteria are
  rewritten below as independent per-experiment gates with window,
  denominator, threshold.

Where the reviewer was NOT followed: nothing material. The review's code
citations verified clean; disagreements would be recorded here with
citations, but there are none.

## Revised experiments (independent, unordered; each shippable or stoppable)

- E1 — Foreground output-budget clamp (the surviving sliver of M1). Clamp
  foreground `max_output_length` to `shell.maxOutputChars` like the
  background path. MEASURED (2026-09-04, provider-traffic 08-27→09-04,
  7,209 shell calls): 4,728 foreground, of which 287 (6.1%) request >40k
  (top values 50000×415, 60000×67); background over-cap is already clamped
  by code. The >1% gate FIRES — E1 is a real, implementable hardening with
  a measured denominator. Scope: clamp reduction-only (values below max
  pass through); no approval-path change (command-only decision untouched).
- E2 — Poll-only yield/resume on the existing registry (rescoped M2, no
  stdin). A foreground shell call may return early with `{jobId,…}` and a
  later poll call reads output; empty-input keepalive only. Reuses
  `BackgroundShellRegistry` + existing monitor/watch machinery; no new
  lifecycle. Gate: 30-day window after landing; denominator: background shell
  calls; continue toward richer resume only if ≥5% of background calls use
  poll-resume AND user-visible stall complaints reference it, else stop.
- E3 — Patch-input containment (rescoped M3, containment not cure).
  Reduction-only per-call argument cap for file-write parameters, explicitly
  NOT raising maxToolArgumentCharacters (still held). Gate: only if chained-
  state mitigation (open question in repro doc) proves insufficient AND user
  authorizes the file-tool change (still held). Chunked continuation is
  REJECTED as a bypass of the total bound (review: partial-effect hazard,
  `apply-patch.ts:622` sequential retention).
- E4 — Full program tool (M4): NOT RECOMMENDED, no gate defined on purpose.
  Requires: hardened reuse of the workflow evaluator, inner-call broker with
  stable child IDs + journaled results + approval_required rejection policy,
  per-inner-call/cumulative argument limits, explicit threat assessment, and
  a lane/cache plan. If the user wants it, that is a new spec, not a
  milestone of this one.

## Recommendation

Do E1's measurement first (read-only traffic check; if the >1% condition
fails, E1 dies with no code). Then E2 only if background-shell usage shows
the need. E3 stays held. E4 is declined by this spec. The feature as
originally scoped (Codex-style exec sandbox) SHOULD NOT be built on current
evidence: the A/B is correlational, the repro falsified the content trigger,
and the safety mechanism requires run-loop surgery out of proportion to a
containment benefit.

## NOT covered / unknown

Whether E1's clamp changes any user-visible outcome. E2's Ink rendering is
undesigned. The chained-state prime suspect (repro doc) is untouched by all
four experiments. No implementation authorized.
