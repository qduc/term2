# Lens report: null-hypothesis
Codebase: /Users/qduc/src/term2  |  Scope: whole repo (source/)  |  Date: 2026-08-01

## Note on inputs
`audit/invariants.md` did not exist at the start of this pass (only `audit/reports/` was present, empty). I proceeded without it, building ground truth directly from the codebase, `docs/plans/`, `git log`, and the repo's own `architecture` skill (`.claude/skills/architecture/`). Findings below are sourced accordingly; where I'd normally cite an invariant entry, I cite the skill/doc instead and mark "Invariant impact: none (file absent)".

## Summary
Most of what a first-pass critic would flag as "too many layers" or "suspiciously large file" in this codebase survives scrutiny once you read `docs/plans/turn_coordinator_refactor.md`, `docs/plans/decouple-from-openai-agents-sdk.md`, and `docs/plans/provider-bug-sweep.md`: the layering in the turn path was built to a written plan with named invariants (one owner per mutable state, stale-generation safety, single retry/recovery vocabulary), and the two largest files (`turn-workflow.ts`, `conversation-replay.ts`) each hide their complexity behind a tiny public surface, which is exactly the "deep module" shape this repo's own architecture doctrine asks for. The defensive/redundant-looking guard code in providers is not paranoia — `provider-bug-sweep.md` documents ten real, live-reproduced bugs (silently dropped output, silently faked success, lost tool-continuation state) that this class of guard exists to prevent. That said, a few things do not have a clean defense: a 24-field dependency object on `TurnWorkflow`, a documented (by the project's own docs) fragility in approval-state durability, and one stale doc claim in `AGENTS.md` about open bugs that the project's own plan file says are fixed.

## Defenses

### D-null-001: Layered turn path (ConversationAdapter / ConversationOrchestrator / TurnCoordinator / TurnWorkflow) is over-engineered
- **Severity**: high
- **Confidence**: high
- **Location**: `source/services/conversation/conversation-adapter.ts`, `source/services/conversation/conversation-orchestrator.ts`, `source/services/session/turn-coordinator.ts`, `source/services/session/turn-workflow.ts`; plan: `docs/plans/turn_coordinator_refactor.md`
- **Claim**: A critic will say four names in one call path (Adapter → Coordinator → Workflow, plus a separate Orchestrator) is unnecessary indirection for what is "send a message, get a response."
- **Evidence**: These are not four generic wrappers around one another — they are four distinct owners with non-overlapping responsibility, verified by reading each: `ConversationOrchestrator` (`conversation-orchestrator.ts:120`) wraps `ConversationService` and owns UI-facing concerns (rewind, `goToPreviousQuestion`/`goToNextQuestion`, usage accumulation, notification delivery) — instantiated only once, in `source/hooks/use-conversation.ts:167`. It never references `ConversationAdapter`. `ConversationAdapter` (`conversation-adapter.ts:107`) owns queue admission and terminal-result collection for turn execution. `TurnCoordinator` (`turn-coordinator.ts`, 111 lines) is deliberately reduced to status-machine sequencing — it literally has the four dependencies (`TurnStatusMachine`, `TurnWorkflow`, `ApprovalFlowCoordinator`, `ProviderContinuity`) that `turn_coordinator_refactor.md` Step 13 names as the target, and a grep gate in that same doc (`rg -n "AgentStream|RunState|SessionInputPlanner|..." source/services/turn-coordinator.ts`) is specifically designed to keep it that thin. `TurnWorkflow` is where the actual stream/retry/approval logic lives, by design ("Move the body of `TurnCoordinator.#executeRun()` into ... `InitialTurnRunner`", Step 11). This is not four layers doing the same job; it's a written decomposition where each name owns a distinct, testable invariant.
- **Verify by**: Read `turn-coordinator.ts` end to end (111 lines) — it contains no stream/retry/history logic, matching the plan's exit criteria. Run `rg -n "AgentStream|RunState|SessionInputPlanner|SessionStreamProcessor|ProviderContinuity|ConversationStore|buildConversationResult|ConversationLogger" source/services/session/turn-coordinator.ts` and confirm zero matches (this is the plan's own acceptance gate).
- **Invariant impact**: would map to an "entry points/turn lifecycle" invariant; none present in invariants.md (absent). Matches `.claude/skills/architecture/reference/runtime-path.md` step 5–10 description exactly.

### D-null-002: `turn-workflow.ts` at 1092 lines is a god object
- **Severity**: high
- **Confidence**: high
- **Location**: `source/services/session/turn-workflow.ts`
- **Claim**: A single 1092-line file/class is unmaintainable and should be split further.
- **Evidence**: Public surface is small: `executeInitial`, `executeContinuation`, `continuePostExecute`, `abortLiveRun`, plus two protected-looking helpers (`executeInitialAttempt`, `executeContinuationAttempt`) used by recovery collaborators. Everything else (~20 methods) is private (`#`-prefixed), confirmed by `grep -n "^\s*(async )?\*?#" turn-workflow.ts`. This is the "deep module" pattern this repo's own `architecture` skill explicitly sanctions: *"`TurnWorkflow` may be internally complex as long as it keeps the turn lifecycle local and testable through its public methods."* (`.claude/skills/architecture/SKILL.md`, "Where things belong" section). The size reflects real irreducible state machine complexity — generation tokens, retry/recovery, approval continuation, auto-approval batching, post-execute pause — that `turn_coordinator_refactor.md` spent 15 numbered steps deliberately relocating here rather than leaving scattered across `TurnCoordinator`/`SessionRetryOrchestrator`/ad hoc call sites.
- **Verify by**: `grep -n "^\s*\(async \*\?\)\?[a-zA-Z#]" source/services/session/turn-workflow.ts` and count non-`#`-prefixed method names — 4-6 genuinely public entry points versus ~20 private ones is the deep-module signature, not a flat procedural dump.
- **Invariant impact**: none in invariants.md (absent); consistent with architecture skill's explicit exception for this file.

### D-null-003: `conversation-replay.ts` at 1163 lines is bloated
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/services/conversation/conversation-replay.ts`
- **Claim**: A 1163-line file is a maintenance hazard regardless of internal shape.
- **Evidence**: `grep -n "^export " conversation-replay.ts` returns exactly one function (`replayEvents`) and one data interface (`RestoredState`) — the entire file is reachable only through one entry point. The size is driven by a genuine event-sourcing reducer over ~22 distinct persisted log-event kinds (`session_init`, `settings_changed`, `user_message`, `assistant_journal_delta`, `tool_started`, `tool_result`, `approval_required`, `subagent_started`, `undo`, `session_cleared`, etc. — verified via `grep -n "case '" conversation-replay.ts`). Reconstructing conversation state from an on-disk JSONL log across all these event kinds is inherent domain complexity, not accidental. `git log --oneline -- conversation-replay.ts` shows real bugfix commits against this exact logic (`0687575f fix: missing reasoning_content after interrupted`, `31083974 fix: missing turnId`, `57a47a79 Recovery and resume should preserve everything the assistant produced during a turn, not just tool calls`) — evidence this is load-bearing correctness logic that has actually caught real defects, not speculative generality.
- **Verify by**: `grep -n "^export " source/services/conversation/conversation-replay.ts` (one function + one type). `git log --oneline -- source/services/conversation/conversation-replay.ts | grep -i fix`.
- **Invariant impact**: none in invariants.md (absent).

### D-null-004: Defensive/redundant-looking guard clauses across `source/providers/*` are paranoid boilerplate
- **Severity**: critical
- **Confidence**: high
- **Location**: `source/providers/codex-responses-model.ts`, `source/providers/openai-responses-model.ts`, `source/providers/agents-model-bridge.ts`, `source/providers/openai-chat-completions-model.ts`; evidence doc `docs/plans/provider-bug-sweep.md`
- **Claim**: Repeated null/empty/error checks scattered across near-identical provider files look like copy-pasted defensive noise that adds no value ("if (!completion) throw", explicit `error`/`close` frame handling, etc.).
- **Evidence**: `provider-bug-sweep.md` documents ten real bugs found by live-testing every provider against real APIs, each of exactly this shape: silently dropped tool-call arguments (bug 3, affected "every provider on this transport"), a bridge that turned a hard failure into "a fake empty `{type:'completion', output:[]}` instead of an error" because a completion-existence check was missing (bug 7B), a WS loop that `continue`-d past `error`/`close` frames instead of throwing (bug 7B), and Codex silently losing tool-continuation state across turns because a per-call model instance wasn't cached (bug 8). Every fix in that document was proven with the stash-based "fails without fix, passes with fix" protocol described in AGENTS.md's provider black-box conventions. This is a terminal agent that executes real shell commands and burns real API credits per turn; a silent-failure-to-success conversion is a correctness incident, not an aesthetic one. The apparent redundancy across provider files is because each provider integrates a genuinely different wire protocol (WS vs SSE vs REST, different item-type vocabularies) and each was independently found to be missing this guard — the fix being repeated per-file is a symptom of provider diversity, not unnecessary caution.
- **Verify by**: Read `docs/plans/provider-bug-sweep.md` bugs #3, #7, #8 and the associated commits/tests (`openai-chat-completions-model.test.ts`, `agents-model-bridge.test.ts`, `codex.provider.test.ts`). Confirm each has a red-before/green-after test per AGENTS.md's provider black-box "red-proof" convention.
- **Invariant impact**: relates to the "Provider Black-Box Suite" section of `AGENTS.md` (checked into the repo, not invariants.md, which is absent).

### D-null-005: Uniform module shapes across `source/services/*` (many small single-purpose files, e.g. 13 files in `services/approval/`) is over-fragmentation ("ravioli code")
- **Severity**: medium
- **Confidence**: medium
- **Location**: `source/services/approval/` (13 non-test files: `approval-decision-policy.ts`, `approval-flow-coordinator.ts`, `approval-presentation-policy.ts`, `approval-replay.ts`, `approval-state.ts`, `session-read-access.ts`, `shell-auto-approval-evaluator.ts`, `shell-auto-approval-resolver.ts`, `shell-sandbox-approval.ts`, `tool-approval-batch-coordinator.ts`, `tool-approval-policy-registry.ts`, `tool-owner.ts`, `tool-ownership-registry.ts`)
- **Claim**: 13 files for "approval" is excessive splitting of what could be one class.
- **Evidence**: AGENTS.md's own ownership table assigns "Approval decisions" as a unit to `services/approval/` (not to any single file), meaning the directory, not any one file, is the cohesive unit — consistent with the architecture skill's deletion test ("if deleting it would spread policy or invariants across callers, the module is earning its keep"). Each file name maps to a distinct decision point in a high-consequence flow (deciding vs. presenting vs. storing vs. replaying an approval; auto-approval evaluation vs. resolution; tool *ownership* tracking, which `decouple-from-openai-agents-sdk.md` §3 explicitly identifies as replacing ~80 lines of "SDK reach-in archaeology" from `_pendingAgentToolRuns`). This is the single highest-consequence decision point in the app (whether a shell command runs without a human in the loop), which raises rather than lowers the bar for granular, individually testable policy modules.
- **Verify by**: For each file in `services/approval/`, confirm it has a colocated `*.test.ts` targeting a distinct policy question (not a thin pass-through) — e.g. `shell-auto-approval-evaluator.test.ts` vs `shell-auto-approval-resolver.test.ts` should test different concerns, not duplicate coverage.
- **Invariant impact**: none in invariants.md (absent); matches AGENTS.md's explicit ownership table.

### D-null-006: Config/settings sprawl (`settings-schema.ts` at 960 lines, ~80 top-level fields)
- **Severity**: low
- **Confidence**: medium
- **Location**: `source/services/settings/settings-schema.ts`
- **Claim**: An 80-field, 960-line settings schema is bloat for a CLI tool.
- **Evidence**: `provider-bug-sweep.md` alone documents live testing against 8 distinct provider families (`codex`, `openai`, `deepseek`, `grok`, `opencode`, `openrouter`, `anthropic`, `gemini`), each needing its own model/auth/transport settings; the app additionally supports SSH remote mode, sandbox policy, multiple UI modes (mentor/plan/orchestrator/lite per AGENTS.md's WIP references), and a memory feature (`docs/plans/memory_feature.md`). Given that surface area, 80 fields is proportionate breadth, not padding — the schema is flat and field-per-concern rather than deeply nested speculative structure.
- **Verify by**: Cross-reference field count against product surface: count distinct provider identifiers in `source/providers/registry.ts` and distinct top-level settings-schema fields; the ratio should look like breadth-driven, not padding-driven growth.
- **Invariant impact**: none in invariants.md (absent).

### D-null-007: Bridge/adapter-shaped code in `providers/agents-model-bridge.ts` looks like unnecessary glue between two systems
- **Severity**: low
- **Confidence**: high
- **Location**: `source/providers/agents-model-bridge.ts:1-40`
- **Claim**: A file named `agents-model-bridge.ts` implies the app still straddles two competing SDKs (leftover complexity from an incomplete migration).
- **Evidence**: `docs/plans/decouple-from-openai-agents-sdk.md` (status: "Complete", last updated 2026-08-01) confirms the `@openai/agents*` packages were fully removed from `package.json`/`pnpm-lock.yaml` with "zero `@openai/agents*` references" across `source/`. Reading the file itself confirms this: its types (`AgentInputItem`, `AgentOutputItem`, `FunctionCallResultItem`, `ResponseStreamEvent`, `ResponseDoneEvent`) are locally declared as `any` (lines 12-16), not imported from any package — the "bridge" now converts between two *application-owned* shapes (the app's `StreamedModelTurn` contract and a legacy-shaped request object some `Model` implementations still expect), not between the app and a third-party SDK. This is naming debt (should probably be renamed post-decoupling), not architectural coupling.
- **Verify by**: `grep -n "from '@openai" source/providers/agents-model-bridge.ts` → no matches. `grep -n "@openai/agents" package.json pnpm-lock.yaml` → no matches (per the plan doc's own final verification).
- **Invariant impact**: none in invariants.md (absent).

### D-null-008: Low inline TODO/FIXME count could mean debt is hidden rather than absent
- **Severity**: low
- **Confidence**: medium
- **Location**: repo-wide (`grep -rn "TODO\|FIXME\|HACK\|XXX" source --include="*.ts" --include="*.tsx"` → 1 hit outside tests)
- **Claim**: A critic might read near-zero inline TODOs as evidence the team suppresses or hides debt rather than tracking it.
- **Evidence**: The repo tracks debt in `docs/plans/` instead — 47 files present, including live, actively-updated ones like `provider-bug-sweep.md` and `decouple-from-openai-agents-sdk.md`, each with dated status headers, "Resume here" sections, and explicit "Open questions"/unresolved-item sections (e.g. bug #10 in `provider-bug-sweep.md` was explicitly logged as "not yet investigated at all" before later being fixed and the doc updated same-day). This is a more durable debt-tracking mechanism than inline comments, which rot silently as code moves; a structured, dated plan doc is closer to an ADR log than to debt-hiding.
- **Verify by**: `ls docs/plans/ | wc -l` and spot-check 2-3 for dated status headers and explicit open-items sections.
- **Invariant impact**: none in invariants.md (absent).

## Non-findings
Patterns I looked at and concluded genuinely have no defense needed because they aren't actually a problem:
- Colocated `*.test.ts` files next to every production file — this is a stated repo convention (`testing` skill references), not accidental sprawl; file counts in `wc -l` sweeps above are inflated by counting these pairs, which a naive "big directory = bloat" read would over-count.
- `ConversationOrchestrator` and `ConversationAdapter` "look like duplicates by name similarity" — verified by grep that neither references the other; they sit at different altitudes (UI-facing vs turn-execution-facing) and are each singly instantiated (`use-conversation.ts:167` and `session-composition.ts` respectively).

## Concessions
These are the things I could not build a good defense for:

1. **`TurnWorkflowDeps` has 24 fields** (`source/services/session/turn-workflow.ts:71-97`). Even granting that `TurnWorkflow` is a legitimate deep module, a 24-field dependency-injection interface is a real cost: anyone extending this class needs to hold 24 collaborators' worth of context, and the class constructor is a genuine fan-in bottleneck. The mitigation is real but partial — tests don't hand-construct the 24 deps; they go through the single composition root (`createSessionRuntimeInternals` in `session-composition.ts`, reused directly by `turn-workflow.test.ts`) — but that mitigates the *testing* cost, not the *comprehension* cost of the class itself. I would not fight a finding that this constructor is at the edge of what "internally complex but cohesive" can justify.

2. **Approval/sandbox override state is process-memory-only and does not survive a process restart** — and this is not a discovery I'm making, it's admitted in the project's own `decouple-from-openai-agents-sdk.md` §1: `ExecutionOverrideStore`, `DeniedReadStore`, and session-scoped Docker grants are in-memory `Map`s; "a turn serialized and resumed in a fresh process finds these maps empty, and either re-prompts or executes with different sandbox permissions than the user approved." For a tool whose central safety mechanism is human-approved shell execution, this is a real fragility, not a stylistic nit. It is scoped/known rather than hidden, but a critic flagging "the approval-override plumbing looks fragile" is correct, and I can't argue otherwise.

3. **`AGENTS.md`'s "Work In Progress" section is stale relative to the project's own plan doc, as of the same date.** AGENTS.md (read as ground context for this very audit) states two provider bugs are still open ("codex loses tool-continuation state across turns, reasoning effort no-ops for Anthropic/Google") plus an "uninvestigated hang in the openai provider." `docs/plans/provider-bug-sweep.md`, dated the same day (2026-08-01), states all three are fixed and verified ("Items #8, #9, and #10 are fixed and verified... The sweep is complete"). This means any lens that used AGENTS.md's WIP section to justify current provider complexity as "necessitated by known open bugs" is working from stale information — worth flagging to synthesis so it isn't double-counted as both "unresolved bug" and "complexity justified by that bug."

4. **One leftover commented-out debug line**: `source/components/MarkdownRenderer.tsx:622` (`// console.log(\`Unknown token type: ${token.type}\`);`). Trivial, but genuinely just leftover debug scaffolding with no defense beyond "harmless."

## Blocked
- `audit/invariants.md` did not exist at the start of this pass — I could not cross-check my defenses against a pre-verified invariants ledger, per-item "Invariant impact" fields above are therefore marked "none (absent)" throughout rather than pointing to real entries. If this file is populated before synthesis, this report's invariant-impact fields should be re-checked against it.
- I did not have access to the other lenses' findings (by design) and could not target rebuttals at their specific claims; defenses above are anticipatory based on what a critic reading this codebase cold would plausibly flag, per the task instructions.
- I did not run the test suite or provider black-box suite (read-only investigation); claims about tests passing/failing are sourced from `docs/plans/*.md` status notes and `git log`, not from executing anything myself.
