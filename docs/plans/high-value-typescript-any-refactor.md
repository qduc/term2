# High-Value TypeScript `any` Refactor Plan

**Status:** Complete through WS11; final verification caveats are recorded in `Resume here`.  
**Coordinator:** primary agent  
**Execution model:** at most three implementation agents plus the coordinator; every implementation stream uses its own worktree and commit  
**Goal:** remove the `any` usages that currently hide runtime, safety, persistence, and cross-module contract errors. This is not a project-wide zero-`any` campaign.

## Resume here

- **P0a resolution:** Verified `source/services/agent-runtime/legacy-compat.ts` was renamed/reorganized to `source/services/agent-runtime/legacy-adapter.ts` on base, with `bridgeBackToTurn` exported in `source/providers/agents-model-bridge.ts`.
- **Wave 1 Complete:**
  - **WS0 OpenAI streamed-model contract:** Merged (commit `4ca11ade`).
  - **WS1 Conversation-event typing:** Merged (commit `51792415`).
  - **WS2 Approval-input decoding:** Merged (commit `687f9c6a`).
- **Wave 2 Complete:**
  - **WS3 AI SDK boundary types:** Merged (commit `2276c680`).
  - **WS4 Settings JSON/env boundary:** Merged (commit `ff31f9e4`).
  - **WS5 Shell AST safety:** Merged (commit `aada81e5`).
- **Wave 3 Complete:**
  - **WS6 Typed settings API:** Merged (commit `48bd7265`). Statically typed setting keys/values (`SettingKey`, `SettingValue<K>`) and explicit dynamic fallback methods (`getDynamic`/`setDynamic`/`setPersistentDynamic`).
- **Wave 4 Complete (all merged serially):**
  - **WS8 Message-union wiring:** Merged (feature `4d23dc72`, merge `d135d564`). `Message` discriminated union through `MessageList`/`ChatMessage`/`SubagentActivityMessage`.
  - **WS7 Persisted replay decoder:** Merged (feature `43ad0e46`, merge `b9a74dc1`). `SavedMessage = Message`; storage-only `PersistedLogEvent = LogEvent | TruncatedLogEvent`; new `conversation-decoder.ts` (`decodeLogEnvelope`/`decodeSavedMessage`) validates envelopes as `unknown` before replay; `as Message[]` removed from the `cli.tsx` handoff. Note: `'truncated' in event && event.truncated` does NOT narrow under TS 6.0.3 — the bare `'truncated' in event` or an `is TruncatedLogEvent` predicate does (used in `applyEvent` and the `replayEvents` usage loop).
  - **WS9 Provider settings decoder:** Merged (feature `876fcb45`, merge `e01da415`). Reads `providers` via `getDynamic` → `unknown`, decodes once into `StoredCustomProviderConfig[]` in `custom-provider-normalization.ts`; legacy name-alias lookup restored; `ISettingsService` now imported from `service-interfaces.ts` (post-WS6 home).
  - WS7/WS9 merges introduced **zero** new test failures and **fixed 28** pre-existing ones (5 `cli.integration` + 23 `provider-service`).
- **Integration follow-up complete:** merged as `80b89605`; the WS6 settings mock-contract fallout was resolved before Wave 5.
- **Wave 5 complete:** WS10a–WS10e are merged serially. The final schema-derived tool contract removed `LegacyToolDefinition`, made `ToolDefinition` schema-driven by default, made `AnyToolDefinition` explicit, and normalized erased registry invocation before execution.
- **Wave 6 complete:** WS11 is merged (`6345c483`), with final lint/config follow-ups through `14b25f9a`. Seven cleaned production modules now enforce `@typescript-eslint/no-explicit-any: error`.

Final verification:
- `pnpm typecheck`: passed.
- Vitest excluding the terminal E2E: **4,859 passed, 1 skipped** across 386 passed files and 1 skipped file.
- Historical verification had one environment-sensitive timeout in `source/cli.e2e.test.ts` while waiting for terminal UI output. It is not a current baseline failure; see the 2026-08-13 [validation baseline](./validation-baseline-2026-08-13.md).
- ESLint: 0 errors and one pre-existing `require-yield` warning in `source/lib/agent-client.dispose.test.ts`.
- Tracked-file formatting and `git diff --check`: passed. Literal `pnpm lint` is blocked only by the preserved unrelated untracked `source/providers/openrouter.provider.test.ts`, which was not modified.
- Final explicit-`any` inventory: 3,777 occurrences (3,009 in tests; 768 in non-test files across 138 files). This plan intentionally does not pursue zero `any`.

No further implementation wave is pending. The plan document's original dirty-state entries remain preserved in the primary checkout.

Post-completion review follow-ups:

- WS10e: apply Zod defaults at the tool-invocation boundary, or make schema-derived executor input reflect the raw-input runtime contract; `.default()` fields currently type as required without runtime default application.
- WS5: add a `never` assertion/default fail-closed branch to `traverseNode` so future `unbash` AST node variants cannot silently classify as GREEN.

Primary-checkout dirty state to preserve (never sweep into a stream commit):

- `M source/providers/codex-responses-model.test.ts`
- `?? source/providers/openrouter.provider.test.ts`
- `?? .pi/subagents.json` (harness-generated)
- `?? docs/plans/high-value-typescript-any-refactor.md` (this document)

Unrelated worktree left alone: `.worktrees/codex-subagent-app-owned-types` (SDK-decoupling leftovers). Completed stream worktrees were removed; ESLint and Prettier now ignore generated `.worktrees/**`, `.pi/**`, `.pnpm-store/**`, and `dist.bak/**` paths.

The SDK-decoupling plan is complete. Read its **Resume here** section before changing provider, run-loop, approval, or tool-registration code. Preserve the application-owned contracts it established.

## Baseline

Baseline inventory (before this plan) from ESLint with `@typescript-eslint/no-explicit-any` temporarily enabled reported:

- 3,954 explicit `any` occurrences under `source/`
- 2,978 in `*.test.*` and `*.spec.*` files
- 976 in other files, including some test-helper modules
- 160 non-test-named files with at least one occurrence

`tsconfig.json` already enables `strict` and `noImplicitAny`; explicit `any` is the escape hatch. At baseline, `eslint.config.js` configured the rule as `off`; WS11 now enables it as an error for seven cleaned production modules.

## Outcomes

This plan is complete when:

1. OpenAI's application-owned provider factory returns a real `StreamedModelTurn` with an executable `.stream()` method.
2. Safety-sensitive approval and shell-AST inputs enter the application through typed `unknown` decoders.
3. Existing conversation-event unions reach the orchestration/UI boundary without `any` erasure.
4. AI SDK provider normalization retains upstream and application-owned types.
5. Settings JSON, environment, keyed access, and custom-provider persistence have typed boundaries.
6. Persisted conversation replay decodes legacy data before lifecycle logic consumes it.
7. `ToolDefinition` derives executor parameters from its schema and preserves result types through wrappers.
8. Cleaned production modules are protected by a narrow ESLint ratchet.

## Non-goals

- Do not mechanically replace every `any` with `unknown`.
- Do not attempt a blanket cleanup of `source/providers/codex-responses-model.ts`; introduce local wire request/event unions only when a behavioral slice needs them.
- Do not clean all tests, logging metadata, or `catch (error: any)` sites.
- Do not broaden or redesign the completed SDK-decoupling architecture.
- Do not upgrade Zod, Marked, OpenAI, AI SDK, or other dependencies as part of this plan.
- Do not push branches or open pull requests without explicit authorization.

## Coordination rules

### Worktree isolation

For every implementation workstream:

```sh
git worktree add .worktrees/<slug> -b codex/<slug>
ln -s ../../node_modules .worktrees/<slug>/node_modules
```

Use the symlink only when `pnpm-lock.yaml` matches the primary checkout. Do not run `pnpm install` through it. If dependencies change, stop and ask the coordinator for a dependency decision.

Each agent must:

- edit only its exclusive ownership set;
- stop before touching another stream's files;
- preserve runtime behavior unless its task explicitly fixes a characterized bug;
- add or strengthen focused tests before declaring completion;
- run its focused suite, typecheck, and `git diff --check`;
- commit only owned files and report the commit hash, tests, residual risks, and any justified remaining `any`;
- never merge, remove worktrees, or push.

The coordinator alone:

- records the starting commit and dirty-file list;
- creates or authorizes worktrees from the intended base;
- serializes merges with `git merge --no-ff`;
- reruns focused verification after every merge;
- resolves integration issues through explicit follow-up work, never by stashing another agent's changes;
- removes merged worktrees and branches only after verification.

### File ownership and contract rules

- Ownership is exclusive even when worktrees make concurrent edits physically possible.
- No Wave 1 or Wave 2 agent edits `source/contracts/model.ts`, `source/contracts/streamed-model-turn.ts`, or `source/tools/types.ts` unless its workstream explicitly owns that file.
- Adapters conform to existing application-owned contracts; shared-contract changes require a coordinator decision and a new serialized task.
- Agents may inspect any file but must request an ownership expansion before editing it.

## Execution map

```text
Wave 1: WS0 OpenAI contract ───────┐
        WS1 conversation events ───┼─ merge serially, WS0 first
        WS2 approval parsing ──────┘

Wave 2: WS3 AI SDK boundary ───────┐
        WS4 settings input ─────────┼─ independent typed boundaries
        WS5 shell AST safety ──────┘

Wave 3: WS6 settings API ──────────── serialized; compiler-fallout manifest first

Wave 4: WS7 replay decoder ────────┐
        WS8 message rendering ──────┼─ broad but disjoint ownership
        WS9 provider settings ─────┘

Wave 5: WS10a-e ToolDefinition migration slices

Wave 6: WS11 ESLint ratchet and final verification
```

Merges are always serial, even when development is parallel.

## Wave 1 — correctness and contained safety boundaries

Run WS0, WS1, and WS2 concurrently. Merge WS0 first.

### WS0 — OpenAI streamed-model contract

**Branch/worktree:** `codex/any-openai-stream-contract` / `.worktrees/any-openai-stream-contract`  
**Priority:** P0

Exclusive ownership:

- `source/providers/openai.provider.ts`
- `source/providers/openai.provider.test.ts`
- `source/providers/registry.test.ts`

Prerequisite-owned files, available only after P0a is resolved:

- `source/services/agent-runtime/legacy-compat.ts`
- `source/services/agent-runtime/legacy-compat.test.ts`

`source/providers/openai-responses-model.ts` is inspect-only. Expanding into it requires coordinator approval based on a failing regression.

Implementation:

- Remove the `as unknown as StreamedModelTurn` factory cast.
- Reuse the existing `adaptLegacyModel(selectedModel)` seam at the provider factory boundary so the returned object implements `stream(StreamedModelTurnRequest): AsyncIterable<StreamedModelTurnEvent>`.
- Preserve the existing `getResponse` / `getStreamedResponse` transport classes. Do not add a second streaming protocol or rewrite HTTP/WebSocket event normalization for this fix.
- Preserve HTTP/WebSocket selection, request-prefix binding, lifecycle capture, and existing continuation semantics.
- Do not edit Codex transport code.

Acceptance criteria:

- The factory result statically satisfies `StreamedModelTurn`.
- A regression test constructs the factory result and executes `.stream()`; checking only that the factory exists is insufficient.
- The test covers text delta and terminal completion. Cover reasoning and tool-call conversion where the existing adapter supports them.
- No compatibility cast in the OpenAI factory can hide a missing required method.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/providers/openai.provider.test.ts \
  source/providers/registry.test.ts \
  source/services/agent-runtime/legacy-compat.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts
pnpm typecheck
git diff --check
```

After WS0 merges, the coordinator runs the full suite before admitting later provider changes.

### WS1 — conversation-event typing

**Branch/worktree:** `codex/any-conversation-events` / `.worktrees/any-conversation-events`

Exclusive ownership:

- `source/services/conversation/conversation-orchestrator.ts`
- `source/services/conversation/conversation-orchestrator.types.ts`
- `source/hooks/use-conversation.ts`
- `source/services/conversation/conversation-orchestrator.test.ts`
- `source/services/conversation/conversation-orchestrator.subagent-notifications.test.ts`
- `source/hooks/use-conversation.background-tasks.test.tsx`
- `source/hooks/use-conversation.approval-pending-filter.test.ts`

Implementation:

- Carry `ConversationEvent` through `createOnEventHandler` and both handler directions.
- Type log appends with `LogEvent` or a narrow `Pick<ConversationLogWriter, 'append'>`.
- Remove redundant casts on final events and existing `ApprovalDescriptor` fields.
- Narrow payload access using event discriminants.

Acceptance criteria:

- Queue, approval, abort-consumed message, thinking/tool indicator, and async-subagent completion behavior remains covered.
- No explicit `any` remains in the owned production event/logger boundary.
- No event payload is widened merely to make a handler compile.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/services/conversation/conversation-orchestrator.test.ts \
  source/services/conversation/conversation-orchestrator.subagent-notifications.test.ts \
  source/hooks/use-conversation.background-tasks.test.tsx \
  source/hooks/use-conversation.approval-pending-filter.test.ts
pnpm typecheck
git diff --check
```

### WS2 — approval-input decoding

**Branch/worktree:** `codex/any-approval-inputs` / `.worktrees/any-approval-inputs`

Exclusive ownership:

- `source/components/prompt/ApprovalPrompt.tsx`
- Existing `ApprovalPrompt*.test.tsx` files
- One new focused parser/shell-safety test if useful

Implementation:

- Add one `unknown -> ShellApprovalArgs | null` parser for `argumentsText` and `rawInterruption.arguments`.
- Treat arrays, null, malformed JSON, and partial objects as invalid without throwing.
- Add `command?: string` to the owned prompt argument type instead of casting.

Acceptance criteria:

- Unsandboxed and Docker-host-control detection retains current behavior for both argument sources.
- Malformed input fails safely and does not change approval wording or interaction flow.
- No explicit `any` remains in the owned production component.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/components/prompt/ApprovalPrompt.ask-user.test.tsx \
  source/components/prompt/ApprovalPrompt.read-file.test.tsx \
  source/components/prompt/ApprovalPrompt.denied-read.test.tsx
pnpm typecheck
git diff --check
```

## Wave 2 — independent provider, settings, and shell boundaries

Start only after Wave 1 merges. Run WS3, WS4, and WS5 concurrently.

### WS3 — AI SDK boundary types

**Branch/worktree:** `codex/any-ai-sdk-boundary` / `.worktrees/any-ai-sdk-boundary`

Exclusive ownership:

- `source/providers/ai-sdk-message-normalizer.ts`
- `source/providers/ai-sdk-streamed-model.ts`
- `source/providers/ai-sdk-message-normalizer.test.ts`
- `source/providers/ai-sdk-streamed-model.test.ts`

The three provider tests in the verification command are run-only unless the coordinator grants ownership expansion.

Implementation:

- Retain `LanguageModelV3` and call-option types instead of recreating an `any`-based model interface.
- Derive unary results from `LanguageModelV3['doGenerate']`.
- Type output accumulation as `StreamedModelTurnOutput[]`.
- Admit vendor reasoning/tool-call extensions through one small guarded record/union.

Acceptance criteria:

- Assistant-message merge order, reasoning-only messages, tool calls, usage, and terminal completion remain unchanged.
- No explicit `any` remains except a documented upstream type defect that cannot be isolated further.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/providers/ai-sdk-message-normalizer.test.ts \
  source/providers/ai-sdk-streamed-model.test.ts \
  source/providers/ai-sdk-openrouter.provider.test.ts \
  source/providers/ai-sdk-google.provider.test.ts \
  source/providers/ai-sdk-anthropic.provider.test.ts
pnpm typecheck
git diff --check
```

### WS4 — settings JSON/env boundary

**Branch/worktree:** `codex/any-settings-boundary` / `.worktrees/any-settings-boundary`

Exclusive ownership:

- `source/services/settings/settings-persistence.ts`
- `source/services/settings/settings-merger.ts`
- `source/services/settings/settings-env.ts`
- Optional internal record/decoder helper under `source/services/settings/`
- `source/services/settings/settings-persistence.test.ts`
- `source/services/settings/settings-merger.test.ts`
- `source/services/settings/settings-env.test.ts`
- `source/services/settings/settings-schema.test.ts`

Implementation:

- Capture parsed JSON as `unknown` and decode records explicitly.
- Use Zod's typed issues and inferred output.
- Replace recursive `any` helpers with guarded records or a suitable `DeepPartial<SettingsData>`.
- Build environment sections as typed partial settings.

Acceptance criteria:

- Invalid top-level sections fail closed while valid-section salvage still works.
- Precedence remains CLI > environment > file > defaults.
- Arrays are not recursively treated as objects.
- Sensitive fields remain absent from persisted output.
- Semantically unchanged settings files are not rewritten.
- No explicit `any` remains in the owned production files.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/services/settings/settings-persistence.test.ts \
  source/services/settings/settings-merger.test.ts \
  source/services/settings/settings-env.test.ts \
  source/services/settings/settings-schema.test.ts
pnpm typecheck
git diff --check
```

### WS5 — shell safety and RTK AST types

**Branch/worktree:** `codex/any-shell-ast` / `.worktrees/any-shell-ast`

Exclusive ownership:

- `source/utils/shell/command-safety/index.ts`
- `source/utils/shell/command-safety/utils.ts`
- `source/utils/shell/command-safety/find-helpers.ts`
- `source/utils/shell/command-safety/handlers/*.ts`
- `source/services/rtk-service.ts`
- `source/utils/shell/command-safety.test.ts`
- `source/utils/shell/command-safety.red-yellow-policy.test.ts`
- `source/utils/shell/command-safety.evaluator-false-positives.test.ts`
- `source/utils/shell/command-safety.find.test.ts`
- `source/utils/shell/command-safety.git.test.ts`
- `source/utils/shell/command-safety.path.test.ts`
- `source/utils/shell/command-safety.specialized-handlers.test.ts`
- `source/services/rtk-service.test.ts`

Implementation:

- Use `unbash`'s exported `Script`, `Node`, `Command`, `Word`, `Redirect`, and word-part types.
- Define deliberate typed traversal instead of generic object recursion.
- Make policy-dependent node switches exhaustive.
- Share AST vocabulary, not policy, between safety classification and RTK rewriting.

Acceptance criteria:

- Parser errors and trailing unparsed input remain fail-closed.
- RED/YELLOW/GREEN behavior remains unchanged.
- Redirects, expansions, compounds, `find -exec`, and specialized git handling retain coverage.
- RTK never rewrites a command unless the typed AST proves eligibility.
- No explicit `any` remains in the owned production files.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/utils/shell/command-safety.test.ts \
  source/utils/shell/command-safety.red-yellow-policy.test.ts \
  source/utils/shell/command-safety.evaluator-false-positives.test.ts \
  source/utils/shell/command-safety.find.test.ts \
  source/utils/shell/command-safety.git.test.ts \
  source/utils/shell/command-safety.path.test.ts \
  source/utils/shell/command-safety.specialized-handlers.test.ts \
  source/services/rtk-service.test.ts
pnpm typecheck
git diff --check
```

All dangerous command examples remain data inside test fixtures. Do not probe them with inline shell, `node -e`, `tsx -e`, or `sh -c`.

## Wave 3 — typed settings API

WS6 runs as the only implementation stream after Wave 2. Read-only agents may review the type design and compiler fallout, but no other agent edits application code until WS6 merges.

### WS6 — typed settings key/value API

**Branch/worktree:** `codex/any-settings-api` / `.worktrees/any-settings-api`  
**Dependency:** WS4

Exclusive ownership:

- One new setting key/value type module
- `source/services/settings/settings-schema.ts`
- `source/services/settings/settings-service.ts`
- Settings declarations in `source/services/service-interfaces.ts`
- Settings-specific tests
- Every call site required to adopt the typed API, based on the compiler-fallout manifest described below

Before implementation, the owner prototypes the signature change in its worktree, runs `pnpm typecheck`, and reports the exact fallout file list. The coordinator records that list as WS6's temporary exclusive ownership manifest before further edits. This prevents the settings migration from colliding with provider, tool, hook, or command work.

Implementation:

- Derive `SettingKey` and `SettingValue<K>` from `SettingsData` and the existing key registry; do not create a second runtime registry.
- Infer values for known literal keys in `get`, `set`, and `setPersistent`.
- Expose genuinely dynamic paths through an explicitly named API returning `unknown`.
- Remove caller-selected `get<T>` assertions for known literal keys rather than retaining a compatibility generic that still permits caller lies.
- Preserve runtime Zod validation, sensitivity checks, and runtime-modifiability checks.

Acceptance criteria:

- Literal keys infer string, boolean, number, array, and nested-object values correctly.
- Caller lies such as `get<boolean>('agent.model')` fail at compile time.
- Wrong key/value pairs fail at compile time.
- Runtime provider-extension keys still have an explicit supported path.
- No explicit `any` remains in the typed API surface.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/services/settings/settings-service.test.ts \
  source/services/settings/settings-schema.test.ts \
  source/services/settings/settings-sources.test.ts \
  source/services/settings/setting-schema-utils.test.ts \
  source/utils/settings-command.test.ts
pnpm typecheck
git diff --check
```

## Wave 4 — broad but disjoint application boundaries

Run WS7, WS8, and WS9 concurrently after WS6 merges.

### WS7 — persisted conversation replay decoder

**Branch/worktree:** `codex/any-replay-decoder` / `.worktrees/any-replay-decoder`

Exclusive ownership:

- `source/services/conversation/conversation-persistence-types.ts`
- `source/services/conversation/conversation-persistence.ts`
- `source/services/conversation/conversation-replay.ts`
- `source/services/logging/conversation-log-events.ts`
- `source/services/logging/conversation-log-writer.ts`
- `source/cli.tsx`, limited to the restored-message handoff around the existing `as Message[]` cast
- Optional decoder module under `source/services/conversation/`
- `source/services/conversation/conversation-persistence.test.ts`
- `source/services/conversation/conversation-replay.test.ts`

`conversation-history-repair.test.ts` and `conversation-clear-save.test.ts` are run-only unless the coordinator grants ownership expansion.

Implementation:

- Parse JSONL values as `unknown` and minimally validate envelopes before replay.
- Introduce a version-tolerant persisted-message union or decoder.
- Represent writer truncation with a storage-only union such as `PersistedLogEvent = LogEvent | TruncatedLogEvent`; `ConversationLogWriter.append` must continue accepting only application `LogEvent`.
- Keep unknown legacy fields opaque at the boundary; do not reject forward-compatible records unnecessarily.
- Carry validated restored messages through the CLI handoff without `as Message[]`.

Acceptance criteria:

- Replay accesses subagent identity, abort-consumption state, and command call IDs without `any` casts.
- Legacy logs, corrupt-line skipping, undo counts, interrupted-turn recovery, subagent reconstruction, and command-message dedupe remain covered.
- The decoder is permissive about unknown fields but strict about fields used for lifecycle decisions.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/services/conversation/conversation-persistence.test.ts \
  source/services/conversation/conversation-replay.test.ts \
  source/services/conversation/conversation-history-repair.test.ts \
  source/services/conversation/conversation-clear-save.test.ts
pnpm typecheck
git diff --check
```

### WS8 — existing message-union wiring

**Branch/worktree:** `codex/any-message-rendering` / `.worktrees/any-message-rendering`

Exclusive ownership:

- `source/components/message/MessageList.tsx`
- `source/components/message/ChatMessage.tsx`
- `source/components/message/SubagentActivityMessage.tsx`
- `source/components/message/MessageList.test.tsx`
- `source/components/message/ChatMessage.test.tsx`
- `source/components/message/SubagentActivityMessage.test.tsx`

Implementation:

- Carry the existing `Message` discriminated union through the component and render-dispatch boundary.
- Type mixed static/dynamic collections explicitly.
- Type subagent tool entries with the existing command-message type.
- Preserve deliberately structural `MessageLike` generics used by exported static-history helpers; do not force lightweight helper callers to construct the full application union.

Acceptance criteria:

- Sender-specific fields are accessed only after discrimination.
- Static-history splitting, bot continuations, commands, and subagent activity render unchanged.
- No explicit `any` remains in the owned production files.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/components/message/MessageList.test.tsx \
  source/components/message/ChatMessage.test.tsx \
  source/components/message/SubagentActivityMessage.test.tsx
pnpm typecheck
git diff --check
```

### WS9 — provider settings decoder

**Branch/worktree:** `codex/any-provider-settings` / `.worktrees/any-provider-settings`

Exclusive ownership:

- `source/providers/provider-service.ts`
- `source/services/settings/custom-provider-normalization.ts`
- The stored-config lookup only in `source/providers/openai-compatible.provider.ts`
- `source/providers/provider-service.test.ts`
- Stored-config cases only in `source/providers/openai-compatible.provider.test.ts`

Implementation:

- Read the `providers` setting through the typed/dynamic boundary as `unknown`.
- Decode once into `StoredCustomProviderConfig`.
- Preserve legacy aliases and current identifier normalization.
- Keep malformed entries away from registry construction and credential/base-URL handling.

Acceptance criteria:

- No `get<any[]>`, `filter((provider: any))`, or untyped new provider entry remains.
- Add/edit/delete/rename behavior, active-provider rename, built-in keys, API keys, and base URLs retain coverage.
- The malformed-entry policy is explicit and tested.

Verification:

```sh
pnpm exec vitest run --reporter=minimal \
  source/providers/provider-service.test.ts \
  source/providers/openai-compatible.provider.test.ts
pnpm typecheck
git diff --check
```

## Wave 5 — central tool contract migration

This is a serialized migration program, not one oversized workstream. WS10a through WS10e each use a fresh branch/worktree based on the previously merged slice and produce a separately reviewable commit. Only one implementation agent edits at a time; two other agents may perform read-only compiler-fallout inventory and review.

Before WS10a, make a prototype contract change, run `pnpm typecheck`, and record the exact affected-file manifest. The coordinator assigns every affected file to one of the slices below before implementation continues.

### WS10a compiler-fallout manifest (recorded from the prototype)

Prototype (schema-derived `ToolDefinition<TSchema extends ZodTypeAny>` with `z.infer` params, results `unknown`, only `source/tools/types.ts` changed) → **586 errors / 41 files (21 production, 20 test)**. Error groups: G1 explicit non-schema type args in factory signatures (~33); G2 typed definitions not assignable into a `ZodTypeAny`-erased registry under Zod 4 (`z.infer<ZodTypeAny>` = `unknown`, contravariance; ~37); G3 params no longer infer in `needsApproval`/`execute` bodies; G4 executor results `unknown` at consumers (241+ TS18046, mostly tests); G5 `parameters` member now schema-typed breaking `safeParse`/`normalizeObjectParams` consumers; G6 `toOpenAIStrictToolSchema`/`AnyZodObject` narrowing (2).

**Manifest assignment (coordinator-recorded):**
- **WS10b:** `ask-mentor.ts`+test, `ask-orchestrator.ts`+test, `run-subagent.ts`+test, `run-subagent-async.ts`+test, `activate-skill.ts`, `web-search.ts`, `web-fetch.ts`+test, `memory-tools.ts`+test, `read-file.ts`+test (unless WS10a's proof tool), `glob.ts`+test, `grep.ts`+test, `code-context.ts`+test, `run-agent-workflow.ts`+test, `memory-capabilities.test.ts`
- **WS10c:** `apply-patch.ts`+test, `create-file.ts`+test, `search-replace.ts`+test
- **WS10d:** `agent.ts`+`agent.test.ts`, `shell.ts`+`shell.test.ts`, `tool-policy.ts` (its test is clean)
- **WS10e:** `application-run-loop.test.ts`, `post-execute-pause-capability.ts` (signature fix already applied in WS10a — WS10e inherits), plus its existing plan ownership
- **WS10a (expanded ownership):** `source/tools/types.ts`, `source/lib/agent-factory.ts`+test, `source/lib/tool-invoke.ts`+test, `source/lib/openai-strict-tool-schema.ts` (widen `AnyZodObject` → `ZodTypeAny` + guard), `source/services/session/post-execute-pause-capability.ts` (the `forTool` signature line only), `source/tools/tool-parameter-schema.test.ts` (contract-conformance proof), plus ONE representative proof tool + its test (WS10b list minus it)
- **Notably clean (no changes needed):** `tool-invoke.ts`+test, `application-run-loop.ts`, `memory-capabilities.ts`, `format-helpers.ts`, `command-message-formatters.ts`, `ask-user.ts`, providers, `edit-healing.ts`, `search-replace-matcher.ts`

**Design constraint (recorded):** merges are serial and typecheck must pass after every merge, so WS10a's shipped contract must be **backward-compatible for unmigrated factories** (which still write `ToolDefinition<SomeParams>`). The schema-derived typed path and erased registry land additively; WS10b-e tighten their factories slice-by-slice; WS10e removes the permissive default so "schema is the source of truth" holds at the end. No casts added solely to silence variance (risk register). The coordinator chose `unknown`-erasure for executor results in the contract (no `TResult` generic for now); wrappers may preserve result types where they already do. Runtime behavior of `parameters` JSON-schema substitution on the strict path (`agent-factory.ts` `z.toJSONSchema(...) as any`) must be preserved; the cast may be tightened to a named type only.

The dirty `source/services/agent-runtime/legacy-compat.ts` and untracked `legacy-compat.test.ts` are a hard gate for WS10e. They may be edited only if their current owner has integrated them or explicitly transferred ownership. Otherwise WS10e excludes them and the coordinator creates a later named integration task.

### WS10a — merged (`04983515`, merge `9edc5953`)

Shipped contract: conditional `ToolDefinition<TParams = any>` — concrete schema type args resolve to `SchemaToolDefinition<T>` (params `z.infer<T>`, results `unknown`); non-schema type args (and bare `ToolDefinition`) resolve to a byte-for-byte `LegacyToolDefinition<Params>` (the documented permissive migration default, results `Promise<any>|any` only on the legacy path, removed at WS10e); explicit erased registry entry `AnyToolDefinition` (params deliberately erased to `any`, results `unknown`) + `ToolRegistry = readonly AnyToolDefinition[]`. `PostExecutePauseCapability.forTool` now schema-typed. G6 fixed by widening `toOpenAIStrictToolSchema` to `ZodTypeAny` (+ non-object pass-through guard, no observable behavior change). Proof tool: `read-file.ts`+test. Full suite at merge: 4857 passed / 0 failed; typecheck + diff-check clean. Note: cli.integration tests need a `dist/` build (gitignored) — they fail in fresh worktrees without one; primary checkout keeps one.

**Ownership reassignment (coordinator-recorded):** `source/tools/memory/memory-tools.ts` was migrated in WS10a (its generic `definition<P>` helper is structurally incompatible with the conditional type; migrated to `SchemaToolDefinition<S extends z.ZodObject<any>>`). WS10b excludes it; WS10b still owns `memory-tools.test.ts` if the manifest requires.

**Migration recipe for WS10b/c/d (from the WS10a worker):** `ToolDefinition<SomeParams>` → `ToolDefinition<typeof schema>` (concrete schemas resolve to the schema form); narrow execute-result consumers in tests (`as string`/`JSON.parse`) as demonstrated in `read-file.test.ts`; generic schema-constrained code should use `SchemaToolDefinition<...>` directly (the conditional is unreliable for generic type args). WS10d's `agent.ts`/`tool-policy.ts` can adopt `ToolRegistry` once factories are migrated. WS10e tightens: drop `LegacyToolDefinition`, make the default schema-driven, make `AnyToolDefinition['parameters']` honest (`ZodTypeAny | JsonSchemaObject` or relocate the strict-path substitution), and switch `ApplicationAgent.tools` to `ToolRegistry`.

### WS10b — merged (`20a94703`, merge `f62922ec`)

Migrated read-oriented families: agent/ask/run-subagent/run-subagent-async/activate-skill, web-search/web-fetch (resolved the `Partial<WebFetchParams>` drift — schema is now the source of truth, incl. `.default()`-required `max_chars`/`heading`), glob/grep/code-context, run-agent-workflow; `code-context.ts` tightened `getFormatterArgs(item: any)` → `ToolResultItem`. `memory-tools.test.ts`/`memory-capabilities.test.ts` verified untouched (still legacy `ToolDefinition[]`). Remaining `any`: 12 catch-clause sites + 2 error-formatter helpers (documented, plan non-goals). Full suite at merge: 4857 passed / 0 failed.

**Note for WS10e (from WS10b):** the run-loop invoke boundary does NOT apply Zod `.default()`s before `execute`, so web-fetch's `z.infer` (required `max_chars`/`heading`) is stricter than runtime; the executor's destructure fallback is load-bearing for raw-model calls. If WS10e enforces schema-at-invoke, the loop must schema-parse (applying defaults) before `execute`.

### WS10a — contract and erased registry

**Branch/worktree:** `codex/any-tool-contract` / `.worktrees/any-tool-contract`

Primary ownership:

- `source/tools/types.ts`
- `source/lib/agent-factory.ts`
- `source/lib/agent-factory.test.ts`
- `source/lib/tool-invoke.ts`
- `source/lib/tool-invoke.test.ts`

Implementation:

- Define the schema-derived generic and explicit erased heterogeneous registry type.
- Derive `needsApproval` and `execute` parameters from the Zod schema.
- Preserve executor results or deliberately erase them to `unknown`, never `any`.
- Prove the shape with one representative typed tool before migrating the remaining families.

### WS10b — agent, web, memory, and read-only tools

**Branch/worktree:** `codex/any-tool-read-families` / `.worktrees/any-tool-read-families`

Ownership is limited to the exact files in the compiler manifest under:

- `source/tools/agent/`
- `source/tools/web/`
- `source/tools/memory/`
- read-only factories under `source/tools/file/`
- their directly corresponding tests

### WS10c — mutating file tools

**Completed:** merged as WS10c production commit `af8cb32f` plus test compiler-fallout fix `76b5d429`; focused tests and typecheck pass.

**Branch/worktree:** `codex/any-tool-write-families` / `.worktrees/any-tool-write-families`

Ownership is limited to the compiler-manifest files for apply-patch, search-replace, create-file, edit-healing, and their tests under `source/tools/file/`.

### WS10d — shell, agent assembly, and subagent policy

**Completed:** merged as `c0e81542` (merge `3bb449e2`); focused tests and typecheck pass. Shell defaults and approval/scope behavior were preserved.

**Branch/worktree:** `codex/any-tool-policy` / `.worktrees/any-tool-policy`

Primary ownership:

- `source/agent.ts`
- `source/tools/system/shell.ts`
- `source/tools/system/shell.test.ts`
- `source/services/subagents/tool-policy.ts`
- `source/services/subagents/tool-policy.test.ts`
- additional subagent files only when named in the recorded compiler manifest

Type subagent callbacks with existing result, status, handle, and acknowledgement types. Preserve schema/result types through filesystem, network, shell, nested-approval, and read/write-scope wrappers.

### WS10e — runtime and post-execute integration

**Completed:** merged as `2a2342fe` (merge `9b895376`). Final contract tightening also required direct compiler-fallout updates in `agent-factory`, `tool-invoke`, subagent runners/policy, role loading, and memory test consumers. Typecheck passed; the non-E2E suite passed with the environment E2E caveat recorded above.

**Branch/worktree:** `codex/any-tool-runtime` / `.worktrees/any-tool-runtime`

Primary ownership:

- `source/services/agent-runtime/application-run-loop.ts`
- `source/services/agent-runtime/application-run-loop.test.ts`
- `source/services/session/post-execute-pause-capability.ts`
- `source/services/session/post-execute-pause-policy.ts`
- `source/services/session/post-execute-pause-policy.test.ts`
- `source/services/agent-runtime/legacy-adapter.ts` and `.test.ts` only if runtime integration requires changes (the adapter is already clean and landed)

Acceptance criteria:

- A tool schema is the source of truth for executor and approval parameters.
- Heterogeneous registries cannot invoke an executor without normalization/narrowing.
- Post-execute and approval wrappers preserve parameter and result types.
- No casts are added solely to suppress generic variance errors.
- Security behavior for shell, filesystem, network, approval, and nested tools remains covered.

Verification:

```sh
pnpm typecheck
pnpm exec vitest run --reporter=minimal \
  source/tools \
  source/services/subagents/tool-policy.test.ts \
  source/services/agent-runtime/application-run-loop.test.ts \
  source/services/agent-runtime/legacy-adapter.test.ts \
  source/services/session/post-execute-pause-policy.test.ts
pnpm test
git diff --check
```

The legacy-adapter test is included because the adapter is now the application-owned compatibility seam; no legacy-file gate remains unresolved.

## Wave 6 — ESLint ratchet and final integration

### WS11 — module-scoped `no-explicit-any`

**Completed:** merged as `faf8c583` (merge `6345c483`). Final integration added generated-path ignores and formatting-only cleanup through `14b25f9a`; the ratchet probe confirmed reintroduced `any` fails lint.

**Branch/worktree:** `codex/any-eslint-ratchet` / `.worktrees/any-eslint-ratchet`  
**Dependency:** all accepted cleanup workstreams

Exclusive ownership:

- `eslint.config.js`
- A narrow lint-regression fixture only if needed

Implementation:

- Correct the inaccurate comment describing the current rule state.
- Run an exact explicit-`any` inventory for every candidate production file.
- Add a late flat-config override that sets `@typescript-eslint/no-explicit-any: error` only for individual files with zero remaining occurrences.
- Keep untouched production areas and tests permissive for now.

Acceptance criteria:

- Reintroducing `any` in a cleaned module fails lint.
- Untouched source does not produce a project-wide warning flood.
- No ignore or disable is added merely to make the ratchet pass.

Before repository-wide lint, remove completed worktrees; root lint can otherwise traverse sibling worktrees and produce misleading project-boundary failures.

Final verification:

```sh
pnpm typecheck
pnpm test
pnpm lint
git diff --check
```

Also rerun the explicit-any inventory and record:

- total remaining occurrences;
- occurrences removed from production modules;
- any intentional boundary exceptions, with owner and rationale.

## Merge order and gates

Merge order is fixed unless the coordinator records a reason to change it:

1. P0a resolve or transfer the existing legacy-adapter export/test
2. WS0 OpenAI streamed-model contract, then full suite
3. WS1 conversation-event typing
4. WS2 approval-input decoding
5. WS3 AI SDK boundary types
6. WS4 settings JSON/env boundary
7. WS5 shell AST safety
8. WS6 typed settings API, serialized after its fallout manifest
9. WS8 message-union wiring
10. WS7 persisted replay decoder
11. WS9 provider settings decoder, then full suite
12. WS10a contract/registry
13. WS10b read-oriented tool families
14. WS10c mutating tool families
15. WS10d shell/subagent policy
16. WS10e runtime/post-execute integration, then full suite
17. WS11 ESLint ratchet

After every merge:

1. Confirm the primary checkout still contains the pre-existing unrelated changes.
2. Run the merged stream's focused tests.
3. Run `pnpm typecheck`.
4. Run `git diff --check`.
5. Only then remove its worktree and branch and admit the next dependent stream.

If a merge exposes a compile error in another stream's owned files, do not broaden the merging branch retroactively. Create a named integration follow-up with explicit ownership.

## Risk register

| Risk | Signal | Mitigation |
|---|---|---|
| Type-only cleanup changes runtime semantics | snapshots/output ordering changes | Characterize first; preserve object construction and ordering; review diffs for more than annotations/guards |
| Parallel agents choose incompatible shared types | competing edits to contracts or `tools/types.ts` | Exclusive ownership; shared contracts serialized; coordinator approval required |
| Settings typing breaks dynamic providers | runtime-defined key cannot be represented | Explicit dynamic API returning `unknown`; decode at provider boundary |
| Legacy replay becomes too strict | old logs stop loading | Version-tolerant decoder; validate only lifecycle-critical fields; keep unknown fields opaque |
| Shell typing makes policy more permissive | unknown node falls through as safe | Exhaustive/fail-closed handling and focused RED/YELLOW policy tests |
| Tool generics trigger cast proliferation | many new `as unknown as` assertions | Define erased registry type first; reject casts added only to silence variance |
| Existing dirty work is absorbed | unrelated files appear in a stream commit | Worktrees from recorded base; exclusive staging; coordinator checks every commit |
| Lint ratchet creates noise | thousands of warnings outside cleaned scope | Module-scoped error override added last |

## Deferred candidates

These remain useful but are intentionally outside this plan's completion gate:

- typed Marked AST handling in `source/components/MarkdownRenderer.tsx`;
- tool-output renderer decoders in `source/tools/format-helpers.ts` and command-message helpers;
- `ProviderFetch` alignment with `typeof fetch`;
- retry/error classification normalization;
- stream-event and token-usage compatibility funnels;
- general test-fixture typing;
- logging metadata and mechanical `unknown` catch conversion;
- local Codex request/event unions beyond behavior-driven slices.
