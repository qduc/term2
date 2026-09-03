# Status: E1 LANDED (commit ba428dd7, merged 5c118dcb — user-authorized
# autonomous completion of the spec→implement→review pipeline). E2–E4 remain
# HELD (no implementation authorized). This section records the E1 receipt;
# the E2/E3 gates and E4 decline below are unchanged.

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
   adopted: inner calls execute ONLY through a single host-owned dispatch
   primitive that applies, indivisibly per inner call: schema normalization
   against the callee's schema, plan-mode and registered interceptors,
   execution/lifecycle hooks, effect + run-budget accounting, and
   immutable (structured-cloned) argument snapshots with stable child call
   IDs and journaled results (no replay of completed calls). Tools whose
   policy result requires interactive approval are REJECTED with
   `approval_required` (the `run_agent_workflow` policy, verified
   `workflow-evaluator.ts:292-300`) — never suspended, since no nested pause
   protocol exists. Rationale: prior admission of a capability NAME does not
   admit future ARGUMENTS constructed mid-program (e.g. a patch path or
   shell string built at runtime); the check must happen at the inner call
   boundary with the concrete arguments. No nested pause protocol is
   proposed; that would be a run-loop feature, out of scope here. E4 remains
   declined, so this broker is specified but NOT built; the honest
   disposition is 'deferred to a new threat-assessed spec'.- SEV-2 ACCEPTED. `execute-shell.ts:507` (stdin closed at spawn in the
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
  foreground did not before E1 — `shell.ts:912-918`). V1 M1 is therefore
  dropped in full, not reframed. The foreground-clamp asymmetry became E1
  below (now landed; see Status).

Where the reviewer was NOT followed: nothing material. The review's code
citations verified clean; disagreements would be recorded here with
citations, but there are none.

## Revised experiments (independent, unordered; each shippable or stoppable)

- E1 — Foreground output-budget clamp. Clamp foreground `max_output_length`
  to `shell.maxOutputChars` like the background path. STATUS: LANDED
  (ba428dd7). Evidence receipt (RETRACTS AND REPLACES the 287/4728 claim
  committed in 2fcdb902, which is withdrawn: its top buckets exceeded its
  numerator and neither count reproduces): preregistered query over frozen
  window provider-traffic/2026-{08-27..08-31,09-01..09-03} (21,228 files) +
  app-log term2-2026-{08-27..09-03}. Traffic: 9,547 dedup shell calls
  (6 unparseable args counted separately), 9,427 foreground, 638 over-cap
  requests (6.8%; distribution 50000×486, 60000×104, 100000×17, …). App-log:
  8,850 executions, 571 with effective maxOutputLength >40k (6.5%). Query +
  aggregate retained at docs/research/evidence/e1-clamp-measurement.json.
  HONEST SCOPE: the metric is a REQUEST signal — both root
  (`agent-factory.ts:184,205`) and nested (`tool-policy.ts:1050,1059`)
  wrappers already outer-trim to the configured max, so no escaped-volume
  claim is made. The incremental value is the shell-specific spool seam:
  over-cap foreground executions now enter `formatShellExecutionOutput`
  with a capped threshold so excess is trimmed AND spooled to a retrievable
  artifact, which the generic outer trim does not provide. Scope is
  per-stream trim threshold (stdout/stderr trimmed independently, then
  concatenated — a total-result bound is explicitly NOT claimed); units are
  characters (UTF-16 code units); equality untrimmed per the exceeding-only
  contract. Reduction-only; approval untouched.
- E2 — Poll-only yield/resume on the existing registry (rescoped M2, no
  stdin). A foreground shell call may return early with `{jobId,…}` and a
  later poll call reads output; empty-input keepalive only. Reuses
  `BackgroundShellRegistry` + existing monitor/watch machinery; no new
  lifecycle. Gate (READING A — measure existing usage BEFORE building; the
  v2 text was ambiguous): eligible denominator = background shell calls in
  a 30-day window; join rule = poll call referencing a live job id from an
  earlier launch call in the same session; cancelled/failed jobs excluded;
  telemetry source = provider-traffic tool-call records. Build E2 only if
  ≥5% of background calls already show multi-call poll patterns; else do
  not build. The stall-complaint conjunct is DROPPED (no collection source
  exists). If built, enrich-resume decision after 30 days exposure needs a
  new gate.
- E3 — Patch-input containment (rescoped M3, containment not cure).
  Reduction-only per-call argument cap for file-write parameters, explicitly
  NOT raising maxToolArgumentCharacters (still held). Gate: a named
  chained-state experiment must first run and show residual runaways
  (denominator: chained Luna apply_patch calls; threshold: ≥1 runaway in a
  14-day window after the mitigation lands); AND user authorizes the
  file-tool change (still held; authority prerequisite, not efficacy gate).
  Chunked continuation is REJECTED as a bypass of the total bound (review:
  partial-effect hazard, `apply-patch.ts:622` sequential retention).
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

E1's clamp changes no user-visible outcome beyond the spool seam (stated
above). E2's Ink rendering is undesigned. The chained-state prime suspect
(repro doc) is untouched by all four experiments. E2–E4: no implementation
authorized.
