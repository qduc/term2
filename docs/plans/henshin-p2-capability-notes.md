# Henshin P2 capability — implementation notes (working)

Assignment: docs/plans/henshin-p2-capability-assignment.md. Implement script-only host agent
capability in run_code over the committed phase-1 prerequisites (HEAD 91fe70db).

## Verified facts (all read from source in this worktree)

- Sandbox host (source/services/sandboxed-code-host/sandboxed-code-host.ts) supports MULTIPLE
  capabilities per run; comment states: "One admission ledger per capability: a script reading
  200 files and a workflow spawning 8 agents want different budgets, so they never share."
  Ledger admission (ledger.admit()) is synchronous => atomic; admission happens in host message
  loop AFTER prepare() and BEFORE concurrency permit + invoke(). Rejected calls reply via
  overBudget without touching accepted calls. markUnsettledUnknown -> handler.onAborted fires
  for calls that don't settle before run end. Host WAITS for all invoked (admitted) calls to
  settle before closing worker even after body-complete.
- Worker template (host-worker.ts) binds each capability as a top-level global. Namespace kind
  => agent.run(...)/agent.start(...). Namespace member errors reject with
  'tools.' + member + ' failed: ...' — hardcoded 'tools.' prefix is WRONG for a second
  namespace; fix to use capability name (identical output for name==='tools').
- run_code runtime (run-code-runtime.ts): createRunCodeRuntime(options).execute builds the
  'tools' CapabilityHandler per execute. RUN_CODE_LIMITS = maxCalls 200, maxConcurrency 8.
- Bridge (source/lib/subagent-bridge.ts) has runResolvedSubagent(params: ResolvedSubagentLaunch,
  _context?, details?) -> NestedSubagentResult (foreground, bridge .signal = per-turn) and
  runResolvedSubagentAsync(params) -> SubagentRunHandle (backgroundSignal = conversation scope),
  getSubagentResult({runId}, _ctx, details.signal), getSubagentStatus({runId?}),
  cancelSubagentRun({target}). ResolvedSubagentLaunch = { resolvedDefinition:
  AgentSpecBoundaryResult | ResolvedAgentDefinition | SubagentDefinition, task?, worktree?,
  name?, continue_run_id? }; boundary result carries spec.goal as task + validated worktree.
  normalizeResolvedLaunch throws for ok:false boundary results and empty task.
- permission-boundary.ts: resolveAgentSpecForChild(rawSpec, { settings, logger, parent,
  readOnly, planMode, worktree }) -> AgentSpecBoundaryResult (SYNC). createRootAgentAuthoritySnapshot
  builds the snapshot; getRunCodeAgentSpecAuthority(tool) reads the bound snapshot (run-code.ts
  AGENT_SPEC_AUTHORITY symbol; options.agentSpecAuthority already flows from agent.ts).
- nested-runner.runAsTool: worktree pin via pinWorkerWorktree; details {resumeState?, signal?,
  toolCall?{callId}}; composites details.signal with request.signal (bridge turn signal); child
  tool approvals are policy-wrapped by child definition (auto within scope, denied outside);
  non-adopted approval pause returns {status:'interrupted',interrupted:true} and settles lease.
  Foreground leases are listed by listForegroundSubagentCandidates (script-launched runs get
  session move-to-background for free). Worktree failures return failed result (not throw).
- agent.ts: getAgentDefinition deps already receive runSubagent/runSubagentAsync/getSubagentResult/
  getSubagentStatus/sendSubagentMessage/cancelSubagentRun; run_code is created in the
  hasCapability('shell') block with agentSpecAuthority (only when NOT lite mixed authority).
  runResolvedSubagent/runResolvedSubagentAsync are NOT yet in deps — must be added to
  getAgentDefinition deps, AgentFactoryDeps (agent-factory.ts passes through in buildAgent),
  and AgentConfiguration.#buildFactoryDeps (source/lib/agent-configuration.ts ~line 262 wires
  bridge callbacks).
- run_agent_workflow precedent: WorkflowEvaluatorImpl builds CapabilityHandler with prepare
  validate -> onAdmitted bookkeeping -> invoke runs child; own limits maxRuns/maxConcurrency.
- Tests: run-code.test.ts (129 tests, baseline green) uses createRunCodeToolDefinition +
  execute({code, timeout_ms, description}). subagent-bridge.test.ts uses REAL SubagentBridge +
  injected mock SubagentManager (createMockManager pattern, trackRunAsTool captures
  {args, context, details}). Catalog test appRegistries() builds full getAgentDefinition.
- Docs run-code-nested-approval.md already revised for Henshin (agent execution permitted,
  others prohibited). No guard-ledger.md exists in this worktree (only references to it).
- Prompt: getScriptPrimaryToolsAddendum (source/prompts/tool-surface-guidance.ts) is the
  run_code prompt section; orchestrator.md mentions async tools inside run_code.

## DESIGN (decided)

1. Second capability namespace 'agent' in run_code (NOT nested tools.agent.* — VM binds
   capabilities as flat top-level globals; document naming deviation vs plan's
   'tools.agent.run' fallback). Members: run, start, status, result, cancel.
2. New limits in RUN_CODE_LIMITS: maxAgentStarts (per-script agent launches, default 16),
   maxAgentConcurrency (parallel foreground runs, default 4), maxAgentCalls (total agent
   capability calls incl. lifecycle, default 200 = host ledger maxCalls for the capability).
3. New module source/tools/system/run-code/run-code-agent-capability.ts:
   createRunCodeAgentCapability(deps, invocation) -> CapabilityHandler.
   - deps: authority snapshot, settings, logger, runResolvedSubagent, runResolvedSubagentAsync,
     getSubagentResult, getSubagentStatus, cancelSubagentRun (async quartet optional as group).
   - prepare: member run/start => params { spec, worktree?, name?, continue_run_id? };
     starts-cap check+increment synchronously BEFORE resolveAgentSpecForChild (atomic in JS,
     pre-side-effect); resolution failure => {ok:false,error:'Agent specification rejected: ...'}
     result outcome (script-catchable). Controls: light param checks.
   - lane: run/start => 'default' (maxAgentConcurrency permits cap parallel races); lifecycle
     => 'serial' (never blocked behind foreground runs).
   - invoke foreground: runResolvedSubagent({resolvedDefinition: boundary, worktree?}, input.context,
     { toolCall:{callId: bridgeRunId+':agent:'+callId}, signal: callContext.signal }) — host
     controller signal aborts child on script timeout/cancel. Project result (drop costRecords,
     nestedRunResult). Catch non-abort errors to {ok:false,error} envelope.
   - invoke start: runResolvedSubagentAsync (uses bridge backgroundSignal — NOT script signal)
     -> {runId, name?, status:'running', role}.
   - status/result/cancel: delegate to bridge methods (result gets callContext.signal).
   - overBudget: script-catchable result outcome (not run-fatal fail).
4. run-code-runtime.ts: RunCodeRuntimeOptions += agentBridge?; execute adds capabilities.agent
   when present.
5. run-code.ts: CreateRunCodeToolOptions += agentSpecBridge? {settings, runResolvedSubagent,
   runResolvedSubagentAsync?, getSubagentResult?, getSubagentStatus?, cancelSubagentRun?}.
   Capability exists iff agentSpecAuthority && agentSpecBridge && (run || async-quartet present);
   members computed from present callbacks. Description getter appends an 'Agent capability'
   section only when present.
6. host-worker.ts template: use capability name in member rejection message ('name.member failed').
7. Wiring: AgentFactoryDeps += runResolvedSubagent?/runResolvedSubagentAsync? (types from
   subagent-bridge.js); agent-configuration wires to #getSubagentBridge(); agent-factory
   buildAgent passes through; getAgentDefinition computes script bridge only when
   hasCapability('subagents') && agentSpecAuthority present, passes as agentSpecBridge.
8. Tests (NEW FILE source/tools/system/run-code/run-code-agent-capability.test.ts), real
   SubagentBridge + mock manager + real resolveAgentSpecForChild + real sandbox worker:
   - foreground await + Promise.all fan-out; resolvedDefinition (not raw spec) reaches manager;
     raw bridge.runSubagent/runSubagentAsync spies NOT called.
   - attenuation: out-of-parent-scope write pattern / web with finite network rejected.
   - worktree: outside scope rejected pre-launch; in-scope forwarded.
   - admission: starts > maxAgentStarts concurrently — extra reject with cap message BEFORE
     manager launch; admitted siblings complete untouched.
   - concurrency: max parallel manager.runAsTool <= maxAgentConcurrency.
   - separate from maxCalls: tools.* calls unaffected by agent starts; agent lifecycle loop
     bounded by maxAgentCalls.
   - cancellation distinct: script timeout aborts foreground child details.signal; background
     run unaffected (bridge.backgroundSignal not aborted, run retained).
   - async lifecycle: start/status/result/cancel shapes.
   - description: section present iff capability bound.
   - unhandled-rejection template message uses 'agent.' prefix (host-worker template).
9. Report to /tmp/henshin-p2-capability-report.md; update plan doc + report; gates: focused,
   related, changed, typecheck, provider black-box (provider-testing skill); commit in this
   worktree (henshin-p2-capability). Naming deviation + prompt/catalog updates documented.

## Status (2026-09-29)
- Implemented per DESIGN, with these deviations:
  - Attenuation rejection for a widened write pattern surfaces as the resolver's
    `permission_denied` ('Filesystem write scope is explicitly empty.') rather than the
    boundary's exact-match message: the resolver empties the out-of-scope pattern before the
    exact-match check runs. Per-call rejection behavior is unchanged.
  - A spec-resolution failure consumes its start admission (increment precedes resolution
    by design), so the cap counts admissions, not launches; message says 'admitted'.
  - Agent capability calls are not added to the run_code execution call ledger (the `tools`
    ledger records only); limits are enforced by the host per-capability ledger.
- Tests: run-code-agent-capability.test.ts 14/14 green (real bridge + mock manager + real
  worker). host-worker.test.ts template snapshot updated for the prefix fix. Related gate
  60 files, 1252 passed after snapshot update; test:changed 1253 passed; typecheck clean.
- Provider black-box suite: 20 files passed, 178 passed / 1 skipped (exit 0).
- All assignment gates green. Report: /tmp/henshin-p2-capability-report.md. Committed in this
  worktree on henshin-p2-capability.
