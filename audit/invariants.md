# Invariants and tribal knowledge — term2

Codebase: /Users/qduc/src/term2 (terminal AI assistant: React/Ink UI + OpenAI Agents SDK heritage + TypeScript + Node).

This doc is fed into every lens pass. It reflects AGENTS.md, the project's `architecture` skill,
and structural facts already verified by a prior architecture review (see "Already verified" below).
Absence of an entry for some area is not a signal either way — lenses should still investigate.

## Ownership boundaries (must hold)

- `source/prompts/` and tool `description` fields are product behavior, not documentation. Changes
  there are behavior changes and should be treated/tested as such.
- Approval decisions belong in `services/approval/`. Retry classification and recovery decisions
  belong in `services/retry/`. Provider transport details belong in `providers/` or `lib/`.
- `subagent-manager.ts` is a compatibility facade only: it emits top-level lifecycle events and
  delegates through the composition root in `runtime.ts`. It must NOT contain execution, prompt,
  cache, or tool-policy logic. That logic belongs in `mentor-runner.ts` (persistent mentor history,
  provider continuity), `execution-runner.ts` (one-shot explorer/worker/researcher), or
  `nested-runner.ts` (cached `Agent.asTool()` instances, approval interruption/resume).
- Role frontmatter, prompt selection, environment context, and tool guidance belong in
  `role-loader.ts`. Capability construction and write/shell safety policy belong in `tool-policy.ts`.
  Wiring and the nested role-tool cache stay in `runtime.ts`.
- New providers must be registered through the provider registry (`source/providers/registry.ts`),
  not constructed directly. `ProviderDefinition.createRunner`/`createStreamedModel` take
  `ProviderDeps` as an explicit dependency-injection parameter specifically so providers avoid
  importing services directly (documented workaround for ESM circular-import risk) — do not "fix"
  this by having a provider import a service module directly.
  `scripts/provider-black-box/provider-contract.test.ts` must obtain models through the registry;
  bypassing it to construct transport classes directly is a known anti-pattern to flag if seen
  reintroduced.
- New tools must be registered in `agent.ts`.
- `session-composition.ts` is the single composition root for the session path.
- Provider black-box suite (`pnpm test:provider-black-box`) is a separate, deliberately isolated
  test configuration (`vitest.provider-black-box.config.ts`) that builds `dist/` and launches the
  compiled CLI in child processes against a deterministic fake HTTP/SSE server. This duplication of
  test infrastructure (separate config, separate harness) relative to the main `pnpm test` suite is
  intentional, not accidental sprawl — it exists because ordinary unit tests cannot exercise the
  shipped CLI binary's streaming/child-process behavior.
- Provider black-box fixtures must be deterministic, minimal, harmless, and derived from sanitized
  traffic — never real credentials, real provider endpoints, or executable shell payloads.

## Architectural history (context, not necessarily current)

- The project recently completed a deliberate decoupling from `@openai/agents` (see
  `docs/plans/decouple-from-openai-agents-sdk.md`). `@openai/agents` is confirmed absent from
  `package.json`; the provider layer now runs on `ai`/`@ai-sdk/*` behind an application-owned
  `StreamedModelTurn` contract. Code and docs referencing the old SDK-Runner path, or a mix of old
  and new provider idioms in the same file, may be transitional debris worth flagging — but check
  git blame/recency before assuming it's stale, since this migration is recent and some transitional
  shims may be intentional bridges (e.g. `agents-model-bridge.ts`).
- A provider bug sweep (`docs/plans/provider-bug-sweep.md`) found and fixed ~10 real regressions
  from the decoupling (silent empty output, dropped tool calls, wrong role serialization, incomplete
  stream treated as success, etc.). Its own doc says the sweep is complete and verified
  (`tsc --noEmit` clean, full suite green, live verification against OpenAI/Codex/Gemini). Treat this
  as resolved unless you find new evidence otherwise — do not rediscover these exact symptoms without
  checking whether the fix commit already covers them.
- `AGENTS.md`'s "Work In Progress" section is known to be stale as of this audit (it claims two open
  provider bugs plus an uninvestigated hang; the plan doc and git history show the sweep completed
  and merged). This is a known documentation-hygiene gap, already flagged to the user — no need for
  lenses to re-discover it, though `overbuild`/`architecture` may still note doc/reality drift
  elsewhere as a pattern.

## Already-verified structural facts (do not re-derive, but do stress-test)

- Runtime path for a foreground turn: `app.tsx` → `use-conversation.ts` → `ConversationService` →
  `ConversationAdapter` (session-composition-built) → `QueueController` (turn admission) →
  `TurnCoordinator` (`TurnStatusMachine`, `ApprovalFlowCoordinator`) → `TurnWorkflow`
  (`InitialInputPreparer`, `SessionInputPlanner`, `SessionStreamProcessor`) → provider registry →
  streamed response → tool approval loop → `ConversationOrchestrator` projects events to UI state.
  `non-interactive.ts` runs the same conversation system without Ink.
- Components do not import `services/session` or `services/conversation` directly. A few UI files
  (`Banner.tsx`, `StatusBar.tsx`, `ModelSelectionMenu.tsx`) import from `providers/` for display
  labels only, not transport logic — treat this as acceptable unless a lens finds transport-layer
  logic (not just labels/types) crossing into components.
  `source/tools/` does not import `services/conversation/`; `shell.ts` importing session context is
  the one expected exception (shell approval needs session state).
- Largest non-test files as of this audit (candidates worth a closer look, not pre-judged as
  problems): `services/session/turn-workflow.ts` (~1092 lines), `services/conversation/
  conversation-replay.ts` (~1163 lines), `services/subagents/tool-policy.ts` (~1041 lines,
  contains both `SubagentToolPolicy` and `SubagentToolFactory`), `services/conversation/
  conversation-orchestrator.ts` (~912), `providers/codex-responses-model.ts` (~1435),
  `services/session/session-composition.ts` (~697), `services/conversation/
  conversation-adapter.ts` (~689), `services/queue/queue-controller.ts` (~720).
- Test files are colocated with production files (`*.test.ts` next to the file it tests), consistent
  with a stated TDD requirement (see the `testing` skill, not reproduced here). High test-to-code
  ratio is a deliberate project norm, not itself a finding.

## No additional tribal knowledge supplied by the user

The user was asked for unwritten rules, deliberate weirdness, or performance constraints beyond
AGENTS.md and the architecture skill, and had nothing to add. Treat the absence of further
invariants as the baseline, not as a gap to chase.
