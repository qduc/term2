# Lens report: duplication
Codebase: /Users/qduc/src/term2  |  Scope: whole repo (source/)  |  Date: 2026-08-01

## Summary
`jscpd` (via `pnpm dlx jscpd`) found 32 clones across the TS/TSX/markdown tree; most are small (15-40 lines) but several sit in behaviorally sensitive paths — provider history replay, subagent result formatting, and provider-definition wiring — where the two copies have already diverged rather than staying identical. The most serious finding is a fully dead, parallel `createOpenAICompatibleProviderDefinition` implementation that duplicates ~90 lines of the live one. A second-tier pattern is self-documented-but-unresolved duplication (a comment literally says two classes share "identical logic"), plus routine small dupes in approval, queue, and logging code. Tool-level duplication (remote-vs-local file I/O, workspace-boundary checks, per-language regex symbol extraction) is present but mostly acknowledged/structural rather than accidental drift.

## Findings

### F-duplication-001: Two live, diverged `createOpenAICompatibleProviderDefinition` implementations; one is mostly dead code
- **Severity**: high
- **Confidence**: high
- **Location**: `source/providers/openai-compatible.provider.ts:291-387` (second implementation) vs `source/providers/openai-compatible-lazy.ts:9-115` (first implementation, actually wired up)
- **Claim**: Both files export a top-level function named `createOpenAICompatibleProviderDefinition` that builds a `ProviderDefinition` for custom providers; `provider-service.ts` and `settings-service.ts` import only the `openai-compatible-lazy.ts` version, and `openai-compatible-lazy.ts` dynamically imports the `openai-compatible.provider.ts` version solely to reuse its `.fetchModels` — so that version's `createStreamedModel`/`createRunner` (lines 299-326, ~28 lines) are built and then discarded, never invoked.
- **Evidence**: `grep -rn "createOpenAICompatibleProviderDefinition"` shows only `provider-service.ts:3` and `settings-service.ts:6` importing from `openai-compatible-lazy.js`; nothing imports the `.provider.js` symbol directly except `openai-compatible-lazy.ts:100` inside `fetchModels`, which only reads `realDef.fetchModels`. `openai-compatible-lazy.ts` additionally contains a ~30-line commented-out "legacy factory removed" block (lines 41-71) that is a third, dead copy of the same config-resolution logic.
- **Verify by**: Search the repo for any import of `createOpenAICompatibleProviderDefinition` from `./openai-compatible.provider.js` other than the dynamic import in `openai-compatible-lazy.ts:100`; confirm none exists, then check whether `createStreamedModel`/`createRunner` defined at `openai-compatible.provider.ts:299-326` are ever called at runtime (they are not reachable from `registry.ts`).
- **Invariant impact**: relates to "New providers must be registered through the provider registry" — this isn't a registry bypass, but it is a second, unreachable code path implementing provider construction that could silently diverge from the reachable one during future edits.

### F-duplication-002: `run_subagent`'s result formatter is a diverged private copy of the shared, canonical one
- **Severity**: high
- **Confidence**: high
- **Location**: `source/tools/agent/run-subagent.ts:34-81` (`truncatePreview`, `formatSubagentResult`, private/non-exported) vs `source/services/subagents/utils.ts:154-236` (same-named, exported canonical versions)
- **Claim**: `run-subagent.ts` re-implements `truncatePreview` and `formatSubagentResult` locally instead of importing them from `services/subagents/utils.ts`, and its local `formatSubagentResult` has drifted: it omits the `Validation:` and `Diff stat:` sections that the canonical version emits.
- **Evidence**: Canonical `formatSubagentResult` (`services/subagents/utils.ts:187-230`) has blocks for `result.validation` (`Validation: ${v.command} → exit ${v.exitStatus}` plus output excerpt) and `result.diffStat` (`Diff stat:` per-file `+N/-N`) that the local copy in `run-subagent.ts:57-81` does not have at all. `source/tools/agent/run-subagent-async.ts:12` correctly imports `formatSubagentResult`/`truncatePreview` from `../../services/subagents/utils.js`, and `services/subagents/subagent-notification-store.ts:8` does the same — so the sync `run_subagent` tool is the outlier with weaker, stale output.
- **Verify by**: Trigger a subagent run whose result includes `validation` or `diffStat` (e.g. a worker role that runs a validation command) via the synchronous `run_subagent` tool vs the async path, and diff the model-facing report text — the sync path should be missing the Validation/Diff stat lines the async path shows.
- **Invariant impact**: none directly named in invariants.md, but this is exactly the "tool description/behavior" surface AGENTS.md calls out as product behavior, not documentation — the model receives materially less evidence through one call path than the other for the same underlying `SubagentResult`.

### F-duplication-003: Codex-specific "delta start" scan duplicates the general chained-input-filter algorithm, with a diverged predicate
- **Severity**: medium-high
- **Confidence**: high
- **Location**: `source/providers/codex-responses-model.ts:391-412` (`findServerManagedDeltaStart`) vs `source/lib/chained-input-filter.ts:112-128` (`findChainedDeltaStart`)
- **Claim**: Both functions implement the identical algorithm (walk backward over trailing "continuation" items; if none, return the index of the last user message; else 0), but use different predicates for what counts as a "continuation" item (`isToolContinuationItem` in codex-responses-model.ts vs `isToolResultItem` in chained-input-filter.ts), and the difference is deliberate per an adjacent comment about Codex websocket function-call items.
- **Evidence**: `codex-responses-model.ts:391-412` vs `chained-input-filter.ts:112-128` are structurally identical (same loop shape, same two-stage fallback, same `return 0` default); jscpd flagged the shared 16-line span verbatim. The comment at `codex-responses-model.ts:383-388` explains why Codex needs a broader predicate.
- **Verify by**: Diff the two function bodies directly; check whether a bug fix landed in one (e.g. via `git log -p` on `chained-input-filter.ts` for `findChainedDeltaStart`) without a corresponding change to `findServerManagedDeltaStart`, or vice versa.
- **Invariant impact**: touches the provider/history-replay area the invariants doc calls out as recently regression-prone ("provider bug sweep ... dropped tool calls ... incomplete stream"); two independently-maintained copies of delta-boundary logic is exactly the kind of place that class of bug recurs in.

### F-duplication-004: Reasoning-history reconstruction helpers are byte-identical or near-identical across three conversation-replay files
- **Severity**: high
- **Confidence**: high
- **Location**: `source/services/conversation/conversation-replay.ts:188-206` vs `source/services/conversation/journal-to-ledger.ts:59-77` (identical `withMissingReasoningPrefix`, `hasToolResultForCall`, `appendToolResultIfMissing`); reasoning-item construction (stripping `reasoning_content` from `providerMetadata`, building the `{type:'reasoning', content:[...], rawContent:[...], providerData}` shape) also appears a third time in `source/services/conversation/conversation-turn-items.ts:94-105`
- **Claim**: The same three small helper functions are defined verbatim in both `conversation-replay.ts` and `journal-to-ledger.ts`, and the reasoning-item-shape-plus-strip-reasoning_content logic is independently reimplemented a third time in `conversation-turn-items.ts`.
- **Evidence**: `withMissingReasoningPrefix`/`hasToolResultForCall`/`appendToolResultIfMissing` bodies at `conversation-replay.ts:188-206` and `journal-to-ledger.ts:59-77` are line-for-line identical (jscpd flagged the 21-line span). The reasoning object literal (`type: 'reasoning'`, conditional `id`, `content`/`rawContent` from `item.text`, conditional `providerData`) recurs at `conversation-replay.ts` (via `makeHistoryItemForReasoning` at line 185, which delegates to `projectPersistedAssistantItemToProviderHistory`), `journal-to-ledger.ts:44-57`, and `conversation-turn-items.ts:94-105`, with `journal-to-ledger.ts` using a local `clone()` helper vs `conversation-turn-items.ts` using `cloneRecord()`.
- **Verify by**: `grep -n "withMissingReasoningPrefix\|hasToolResultForCall\|appendToolResultIfMissing" source/services/conversation/*.ts` and diff the matched bodies; separately diff the three reasoning-item-construction blocks for behavioral equivalence (they are currently equivalent, but nothing enforces that).
- **Invariant impact**: git log shows a very recent, directly relevant commit — `a331fbf8 fix(runtime): normalize restored provider history` — landed in this exact area. Triplicated reconstruction logic is the kind of surface where that class of regression reappears if only one copy gets the next fix.

### F-duplication-005: Remote-vs-local file I/O branch hand-rolled independently in three file tools
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/tools/file/create-file.ts:173-199`, `source/tools/file/apply-patch.ts:321-340`, `source/tools/file/search-replace.ts:369-383`
- **Claim**: All three tools independently implement the same `isRemote && sshService ? sshService.X(...) : fs.X(...)` branching for `readFile`/`writeFile`/`mkdir`, with no shared helper.
- **Evidence**: `apply-patch.ts:327-340` and `search-replace.ts:375-383` define near-identical `readFileFn`/`writeFileFn`/`mkdirFn` closures; `create-file.ts:173-175` and `:197-199` inline the same `if (isRemote && sshService) { await sshService.mkdir(...); await sshService.writeFile(...) } else { ... }` shape twice within its own file as well. `grep -rln "isRemote && sshService" source/tools` returns exactly these three files.
- **Verify by**: Confirm no shared `resolveFileIO(executionContext)` (or similar) utility exists under `source/tools/` or `source/utils/`; check whether a bug fix to remote-mode file I/O (e.g. error handling, encoding) was applied to only one of the three tools by searching recent commit history touching these files.
- **Invariant impact**: none named directly; falls under `source/tools/` ownership generally, no boundary violation — purely mechanical duplication risk.

### F-duplication-006: `#runAgentWithProvider` is a self-documented, byte-identical duplicate between two collaborator classes
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/lib/agent-chat-service.ts:32-63` vs `source/lib/agent-run-orchestrator.ts:502-533`
- **Claim**: `AgentChatService` and `AgentRunOrchestrator` each define a private `#runAgentWithProvider` method with identical bodies (tracing-disable logic, runner-missing error, `runner.run(...)` dispatch), and the duplication is called out in a doc comment rather than resolved.
- **Evidence**: `agent-chat-service.ts:18-24` doc comment: "Uses the same `#runAgentWithProvider` and `#extractResponse` helpers with identical logic — the only difference is that references to `this.#agentConfig`, ... are routed through the injected deps object." The two method bodies (lines 32-63 and 502-533) are line-for-line identical including comments.
- **Verify by**: Read both method bodies side by side (already done); confirm both classes are instantiated together from `source/lib/agent-client.ts`, meaning both copies are live and must be kept in sync manually.
- **Invariant impact**: none named; this is decision-debt the codebase already knows about (comment admits it) but has not resolved — falls squarely under "if you cannot reconstruct why something exists, that IS a finding," except here the reason (`deps` vs `this`) is documented and the fix (shared base/mixin/function) was apparently not done.

### F-duplication-007: `QueueController` duplicates its "start next queue item" transition in two private methods
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/services/queue/queue-controller.ts:521-541` (`#acceptPreflight`) vs `source/services/queue/queue-controller.ts:~603-628` (unnamed-in-excerpt sibling method)
- **Claim**: The sequence "shift queue item → freeze `{executionId, item, snapshot: structuredClone(...)}` as active → set phase running → persist → `driver.start(active)` → on failure requeue item, clear active, set phase paused/pauseReason failure → persist" is duplicated verbatim across two methods instead of being one shared private helper.
- **Evidence**: Both blocks build the identical `active` object shape via `freeze({ executionId: this.#executionId() as ExecutionId, item, snapshot: freeze(structuredClone(this.#snapshotFactory(item))) })` and the identical catch-block recovery (`this.#queue.unshift(item); this.#active = undefined; this.#phase = 'paused'; this.#pauseReason = 'failure'; await this.#persist();`).
- **Verify by**: Read `queue-controller.ts:521-628` in full to name the second method and confirm both are reachable from distinct call sites (preflight-accept vs normal-accept paths), then check whether a future fix to failure-recovery (e.g. different `pauseReason`) would need to land in both.
- **Invariant impact**: none named; `queue-controller.ts` is called out in invariants.md as one of the largest files worth a closer look — this is a concrete instance of that.

### F-duplication-008: Turn-workflow duplicates the `auto_approve` outcome-handling block across two outcome-processing paths
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/services/session/turn-workflow.ts:326-342` vs `source/services/session/turn-workflow.ts:839-855`
- **Claim**: The block that marks a tool call as LLM-auto-approved and emits the `approval.auto_approved` debug log (with identical field set: `eventType`, `category`, `phase`, `sessionId`, `traceId`, `callId`, `command`, `model`, `reasoning`) is duplicated verbatim in two different outcome-handling branches.
- **Evidence**: Both spans open with `if (outcome.kind === 'auto_approve') { if (outcome.advisory?.source === 'llm') { markToolCallAsLlmAutoApproved(outcome.callId); } this.deps.logger.debug('Shell command auto-approved by LLM', {...same 9 fields...})`.
- **Verify by**: Read the surrounding methods to confirm they are genuinely two different call sites (not one calling the other), then check whether `auto_approve` handling has ever been changed in only one of the two spots.
- **Invariant impact**: touches the approval boundary ("Approval decisions belong in `services/approval/`") only tangentially — this is turn-workflow *reacting to* an approval decision, not making one, but duplicated reaction logic in an approval-adjacent path is still worth flagging for drift risk.

### F-duplication-009: `shell-sandbox-approval.ts` repeats the Docker-approval-check expression inside two functions
- **Severity**: low-medium
- **Confidence**: high
- **Location**: `source/services/approval/shell-sandbox-approval.ts:27-33` (inside `isDockerHostControlShellApproval`) vs `:58-63` (inside `requiresHumanShellApproval`)
- **Claim**: The expression `sessionAccess?.requiresDockerApproval(command) ?? nestedCompatibility?.docker.requiresApproval(sessionId, command) ?? false` (guarded by `typeof command === 'string'`) is duplicated verbatim rather than `requiresHumanShellApproval` calling `isDockerHostControlShellApproval`.
- **Evidence**: Both functions independently extract `command` from `args` and apply the identical fallback chain; `requiresHumanShellApproval` does not call `isDockerHostControlShellApproval` despite the file's own doc comment (lines 12-17) stressing "Single source of truth" for this exact check.
- **Verify by**: Read `shell-sandbox-approval.ts:1-65` in full and confirm `requiresHumanShellApproval` doesn't delegate to `isDockerHostControlShellApproval`; if it did, this duplication would disappear.
- **Invariant impact**: the file's own comment states the Docker-approval check must have "single source of truth" between the UI descriptor and the resume gate — this duplication is inside the gate side itself, i.e. the "single source" is currently two sources that happen to agree.

### F-duplication-010: `PendingApprovalContext` and `AbortedApprovalContext` are fully identical type literals
- **Severity**: low
- **Confidence**: high
- **Location**: `source/services/approval/approval-state.ts:10-24` vs `:26-40`
- **Claim**: The two exported types have identical field lists (14 lines each, same names/types), defined as two separate object-type literals rather than one type aliased to the other (or a shared base type).
- **Evidence**: Direct comparison of lines 10-24 and 26-40 in `approval-state.ts` shows the same 14 fields (`state`, `interruption`, `interruptions?`, `decisionsByCallId?`, `promptedCallId?`, `emittedCommandIds`, `toolCallArgumentsById`, `owner`, `token?`, `inputMode?`, `cumulativeUsage?`, `cumulativeCommandMessages?`, `cumulativeTurnItems?`) verbatim.
- **Verify by**: `diff <(sed -n '10,24p' approval-state.ts) <(sed -n '26,40p' approval-state.ts)` after stripping the type name — the field bodies match.
- **Invariant impact**: none; likely intentional forward-compatibility (allowing the two states to diverge later) but currently pure duplication — decision-debt if no divergence is planned.

### F-duplication-011: `provider-traffic.ts` rebuilds the same request-metadata object independently in multiple logging methods
- **Severity**: low-medium
- **Confidence**: medium
- **Location**: `source/services/logging/provider-traffic.ts` around lines 960-997 and 1014-1036 (jscpd also flags 1017-1036 vs 1157-1176)
- **Claim**: The `baseMeta` object (`requestId`, `traceId`, `sessionId`, `sessionStartedAt`, `firstUserMessagePreview`, `mode`, `provider`, `model`, `modelClass`, `modelWrapperClass`) is constructed inline, field-for-field identically, in at least two separate methods rather than via one shared builder.
- **Evidence**: jscpd flagged two clone pairs within this single file (17 lines / 60 tokens and 20 lines / 106 tokens); manual read of the surrounding request-start and response-received methods confirms the same 10-field object literal recurs.
- **Verify by**: `grep -n "traceId: trafficContext?.traceId" source/services/logging/provider-traffic.ts` to count occurrences of the pattern and confirm they build the same field set.
- **Invariant impact**: none named; this is the app's central provider-traffic logger, a reasonable place to want one canonical metadata builder given how many call sites already exist (~1400-line file).

### F-duplication-012: Per-language symbol extractors in `tools/languages/` independently reimplement the same regex-scan control flow
- **Severity**: medium
- **Confidence**: medium
- **Location**: `source/tools/languages/{cpp,csharp,go,java,php,python,ruby,rust,typescript}.ts` (9 files, ~2000 lines total); jscpd specifically flagged `csharp.ts:133-151` vs `java.ts:69-87`
- **Claim**: Each language file hand-rolls the same shape of logic — per-line regex match for method/constructor/class declarations, extract `visibility`/`returnType`/`name`, filter against an `excludedNames`/`excludedReturnTypes` set, return a `{name, kind, line, exported}` object — with only the regexes and keyword sets differing; there is no shared parsing engine, and `tools/languages/utils.ts` (82 lines) only offers low-level string helpers (`escapeRegExp`, `normalizeRelativePath`, import resolution), not a shared symbol-scan primitive.
- **Evidence**: `csharp.ts:131-148` (method match, then constructor match) and `java.ts:67-87` (same two-stage match) share identical control flow and near-identical destructuring/filtering, differing only in the modifier keywords and generic-syntax regex. No `tree-sitter`/AST-parsing dependency exists in `package.json` (checked: no `tree-sitter`, `acorn`, `@babel/parser`, or similar; only `typescript` as a devDependency for the build, not used here).
- **Verify by**: Read two or three of the 9 language files side by side; note that the multi-language, dependency-free design may be a deliberate tradeoff (this is a plausibility call for synthesis, not this lens) — but the amount of copy-pasted control flow (not just similar regexes) is the concrete, falsifiable part.
- **Invariant impact**: none named.

### F-duplication-013: Two full base system-prompt files share ~85 lines of near-identical body text
- **Severity**: medium
- **Confidence**: high
- **Location**: `source/prompts/gpt-5-modern.md` (116 lines) vs `source/prompts/gpt-5.4-mini.md` (113 lines); referenced by `source/prompts/prompt-profiles.ts:46` and `:52,57`
- **Claim**: `gpt-5-modern.md:32-116` and `gpt-5.4-mini.md:29-113` are near-verbatim duplicates (jscpd: 85 lines / 1814 tokens, ~10% of all markdown token volume in the repo), i.e. two separately-maintained "base profile" files carry the same guidance text instead of sharing it through the prompt-constructor's fragment-composition mechanism.
- **Evidence**: jscpd markdown clone report: `prompts/gpt-5-modern.md [32:195-116:52]` clones `prompts/gpt-5.4-mini.md [29:97-113:52]`; a second, smaller clone covers the files' opening lines too.
- **Verify by**: Diff the two files directly (`diff source/prompts/gpt-5-modern.md source/prompts/gpt-5.4-mini.md`) and check `prompt-constructor.ts` to see whether the "base profile + conditional fragments" architecture described in AGENTS.md could have expressed this shared block as one fragment instead of two independent base files.
- **Invariant impact**: directly touches "`source/prompts/` ... are product behavior, not documentation. Treat edits there as behavior changes." A guidance fix applied to one file and not the other silently changes behavior only for models routed to the unfixed profile.

### F-duplication-014: Four superseded prompt files remain in `source/prompts/` unreferenced by any profile
- **Severity**: low-medium
- **Confidence**: high
- **Location**: `source/prompts/simple.md` (53 lines), `simple_prev.md` (33), `simple_v2.md` (84), `simple_v3.md` (267) — none referenced as a `basePromptFile`; only `simple_v4.md` is live (`prompt-profiles.ts:67`)
- **Claim**: These four files are dead, superseded copies of the same base prompt (naming convention `simple`, `simple_prev`, `simple_v2`, `simple_v3`, `simple_v4` strongly implies iterative versions), never wired into `prompt-profiles.ts`, yet still shipped: `package.json`'s `post-build` script does `cp -r source/prompts dist/`, so all 437 dead lines ship in the built CLI.
- **Evidence**: `grep -n "basePromptFile" source/prompts/prompt-profiles.ts` lists only `lite.md`, `orchestrator.md`, `anthropic.md`, `codex.md` (x2), `gpt-5.6.md`, `gpt-5.5.md`, `gpt-5.4-mini.md`, `gpt-5-modern.md` (x2), `kimi.md`, `simple_v4.md` — `simple.md`/`simple_prev.md`/`simple_v2.md`/`simple_v3.md` do not appear anywhere except inside each other's own file and are otherwise unreferenced in `source/`.
- **Verify by**: `grep -rn "simple_prev\.md\|simple_v2\.md\|simple_v3\.md\|'simple\.md'\|\"simple\.md\"" source/` — only the files' own filenames should turn up (no importer).
- **Invariant impact**: relates to "`source/prompts/` ... are product behavior" only in that leaving 4 unreachable, differently-worded versions of the same prompt around is a trap for a future edit landing in the wrong (dead) file.

### F-duplication-015: Two selection-list hooks duplicate the same fixed-window auto-scroll effect
- **Severity**: low
- **Confidence**: high
- **Location**: `source/hooks/use-model-selection.ts:155-163` vs `source/hooks/use-path-completion.ts:137-145`
- **Claim**: Both hooks implement the identical `useEffect` that keeps a `selectedIndex` within a hardcoded `maxHeight = 10` visible window by adjusting `scrollOffset`, plus an identical "reset scroll to top on query change" effect immediately above it.
- **Evidence**: Both files have `const maxHeight = 10; if (selectedIndex < scrollOffset) { setScrollOffset(selectedIndex); } else if (selectedIndex >= scrollOffset + maxHeight) { setScrollOffset(selectedIndex - maxHeight + 1); }` verbatim, and both have the preceding `useEffect(() => { setScrollOffset(0); }, [query])`.
- **Verify by**: Grep both files for `maxHeight = 10` and compare the surrounding effect bodies.
- **Invariant impact**: none named.

### F-duplication-016: Four confirmation-prompt components hand-roll the same yes/no keyboard-select pattern
- **Severity**: low-medium
- **Confidence**: medium
- **Location**: `source/components/prompt/HandoffConfirmationPrompt.tsx`, `StandardModeConfirmationPrompt.tsx`, `InputSurgeConfirmationPrompt.tsx`, `LargeUncachedConfirmationPrompt.tsx`
- **Claim**: All four implement the same `useInput` handler shape (up/down toggles a 0/1 `selectedIndex`, Enter dispatches confirm/decline based on index, `y`/`n` shortcuts, Escape cancels) and the same two-line "❯ Yes / No" rendering, with no shared `<YesNoPrompt>` component.
- **Evidence**: jscpd flagged two clone pairs among these four files (`Handoff` × `StandardMode`, 32 lines / 132 tokens; `InputSurge` × `LargeUncached`, two overlapping clones of 29-31 lines). Manual read of `HandoffConfirmationPrompt.tsx:10-48` shows the full pattern; the other three files were not individually re-read line-by-line but the jscpd match spans confirm at least pairwise duplication.
- **Verify by**: Read all four `useInput` handlers side by side; check whether prompt copy/wording is the only intended difference.
- **Invariant impact**: none named.

## Non-findings
- Retry/backoff logic is properly centralized: `RetryingModel` (`source/providers/retrying-model.ts`) delegates classification and delay computation to `source/services/retry/upstream-retry-policy.ts` and `retry-error-classification.ts` rather than reimplementing backoff math per provider. No competing hand-rolled retry loop was found elsewhere in `source/providers/`.
- No hand-rolled deep-clone utility: the queue controller and other state-snapshotting code use the native `structuredClone`, not a reinvented JSON round-trip or custom deep-copy function.
- No hand-rolled debounce implementation found anywhere in `source/`.
- Schema validation is consistently done via `zod` (44 files import it); no parallel hand-rolled validators were found.
- The two `padStart(2, '0')` hits outside the primary clone set (`utils/resume-list.ts`, `components/layout/BackgroundTasksPanel.tsx`) format different things (absolute date vs elapsed duration) and are not meaningful duplication.
- `glob.ts` and `grep.ts` share an identical workspace-boundary `needsApproval` check, but the duplication is self-aware — a comment in `grep.ts` explicitly says "Mirrors the glob tool's boundary check" — so it is decision-debt already flagged in-code rather than an accidental drift risk. Listed here rather than as a separate finding since it does not meet the "unacknowledged" bar the higher-severity findings do.

## Blocked
None. `jscpd` was unavailable via `npx` (devEngines/pnpm version mismatch) but ran successfully via `pnpm dlx jscpd`, so the full detector pass completed (`source/`, `--min-lines 15 --min-tokens 50`, test files excluded).
