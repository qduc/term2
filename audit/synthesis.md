# Synthesis report
Inputs: audit/reports/architecture.md, audit/reports/correctness.md, audit/reports/dependencies.md,
audit/reports/duplication.md, audit/reports/null-hypothesis.md, audit/reports/overbuild.md,
audit/reports/security.md, audit/reports/tests.md, audit/invariants.md

Note on the invariants.md gap: duplication, dependencies, security, overbuild, and null-hypothesis
each ran without invariants.md on disk and fell back to AGENTS.md / the architecture skill / direct
code reading, self-reporting this in their own "Blocked" sections. Re-checking their "Invariant
impact" fields against the now-present invariants.md found no case where a finding's substance
changes — the file mainly would have supplied cross-references these lenses already approximated
correctly from AGENTS.md, plus the "AGENTS.md WIP section is stale" fact (already known and not to
be re-derived). One real consequence is noted under Contradictions resolved: F-dependencies-007's
tie-in to an "uninvestigated hang" is built on the stale AGENTS.md framing invariants.md explicitly
retires.

## Verification ledger
Every finding was re-checked by directly opening the cited file(s) — not by trusting the lens's own
"Evidence" text and not by cross-lens agreement. Verification was split between direct reads I
performed myself (security-001/002/003, correctness-001/002/003, duplication-001, tests-001/002,
overbuild-001, and spot-checks of several null-hypothesis defenses) and three parallel read-only
verification passes I delegated and then reviewed (dependencies + security-004/005; duplication-002
through 016; architecture + overbuild-002..005 + tests-003..005). All delegated results were
consistent with my own spot-checks where they overlapped.

| Finding | Status | Re-check performed | Evidence (file:line) |
|---|---|---|---|
| F-architecture-001 | verified | grep confirms `preflightEvaluator`/`completionBarrier`/`edit_queued`/`change_*_settings`/`answer_preflight` never appear in production wiring | `source/services/queue/queue-controller.ts:98-175`; `source/services/conversation/conversation-adapter.ts:179-187` |
| F-architecture-002 | verified | Read `executeInitialAttempt`/`executeContinuationAttempt` directly; inline `while(true)`-shaped control flow (staleness checks, batching, dispatch, recovery branching) confirmed not delegated | `source/services/session/turn-workflow.ts:215-402,652-768` |
| F-architecture-003 | verified | Read `prepareContinuation`; confirmed sequential independent boolean computation + interleaved per-kind side effects, no dispatch table | `source/services/approval/approval-flow-coordinator.ts:138-320` |
| F-architecture-004 | verified | Read `handleApprovalDecision`; confirmed two independently-set fields (`#postExecuteApproval`, `#approval.getPending()`) route to two different continuation methods | `source/services/conversation/conversation-adapter.ts:551-688` |
| F-correctness-001 | verified | Read `#acceptPreflight`/`#dispatch`/`#resolveAction` and the adapter's driver wiring directly; confirmed `start` is `void`-returning, never throws, `continueAfterAction` has no production implementation — both catch blocks are dead, and the live failure path (`kind:'failed'` event) drops rather than retries the item | `source/services/queue/queue-controller.ts:501-541,590-628`; `source/services/conversation/conversation-adapter.ts:165-166,407-473` |
| F-correctness-002 | verified | Grepped all 4 provider files; confirmed each imports `NULL_SESSION_CONTEXT_SERVICE` as a value, not a type, exactly as claimed | `source/providers/openai.provider.ts:11,108`; `codex.provider.ts:19,761`; `openrouter.provider.ts:7,31`; `openai-compatible.provider.ts:3,91` |
| F-correctness-003 | verified | Grepped `isConversationLocked`/`'locked'`; confirmed zero production callers outside the function's own file and test, and confirmed the real, exercised mechanism (`LockConflictError`) lives elsewhere | `source/services/conversation/conversation-persistence.ts:19-23,240`; contrast `source/services/logging/conversation-log-writer.ts` |
| F-dependencies-001 | verified | grep confirms no import statement anywhere in source/scripts/tools | `package.json:79`; `source/services/file-service.ts:44` (comment only) |
| F-dependencies-002 | verified | No babel config file; no script/import references | `package.json:95-96,114` |
| F-dependencies-003 | verified | No runtime counterpart package, zero usages | `package.json:100-101,105` |
| F-dependencies-004 | verified | `node_modules/marked/package.json` confirmed to declare its own `types` field | `package.json:83,100` |
| F-dependencies-005 | verified | Confirmed placement inside the `dependencies` block | `package.json:75` |
| F-dependencies-006 | verified | Confirmed hand-rolled `deepEqual` in structured-output.ts vs `fast-deep-equal` imports elsewhere | `source/services/agent-runtime/structured-output.ts:177-190`; `source/providers/chained-wire-state.ts:1`; `source/services/settings/settings-persistence.ts:3` |
| F-dependencies-007 | verified, with correction | `npm view` confirms staleness for all 6 packages, but `ai` is **two** majors behind (^6.0.177 vs 7.0.47 registry-latest at audit time), not one as the lens stated; the other 5 packages are one major behind as claimed | `package.json:69-92` |
| F-dependencies-008 | verified | pnpm-lock.yaml confirms exact-pinned `0.0.56`, no headroom | `package.json:72`; `pnpm-lock.yaml:235-236,424` |
| F-dependencies-009 | verified | pnpm-lock.yaml confirms locked `3.0.0`, real consumers confirmed | `package.json:88`; `source/utils/shell/command-safety/*.ts` |
| F-duplication-001 | verified | Read both files' `createOpenAICompatibleProviderDefinition` in full; confirmed `openai-compatible.provider.ts`'s own `createStreamedModel`/`createRunner` (lines 299-326) are never invoked — only `.fetchModels` is reached via the lazy file's dynamic import, and the lazy file has its own separate, independently-written `createStreamedModel`/`createRunner` plus a ~30-line commented-out third copy | `source/providers/openai-compatible.provider.ts:291-387`; `source/providers/openai-compatible-lazy.ts:1-115` |
| F-duplication-002 | verified | Local `formatSubagentResult` confirmed missing `Validation:`/`Diff stat:` sections present in the canonical version | `source/tools/agent/run-subagent.ts:34-81`; `source/services/subagents/utils.ts:154-236` |
| F-duplication-003 | verified | Structurally identical scan, confirmed different predicates, no divergence-rationale comment cross-referencing the other copy | `source/providers/codex-responses-model.ts:391-412`; `source/lib/chained-input-filter.ts:112-128` |
| F-duplication-004 | verified | Three helper functions confirmed byte-identical across both files | `source/services/conversation/conversation-replay.ts:188-206`; `journal-to-ledger.ts:59-77` |
| F-duplication-005 | verified | All three tools confirmed to hand-roll identical `isRemote && sshService` branching | `source/tools/file/create-file.ts:173-199`; `apply-patch.ts:321-340`; `search-replace.ts:369-383` |
| F-duplication-006 | verified | Both `#runAgentWithProvider` bodies confirmed identical; doc comment admits it | `source/lib/agent-chat-service.ts:32-63`; `agent-run-orchestrator.ts:502-533` |
| F-duplication-007 | verified, with correction | Duplication confirmed between `#acceptPreflight` and the equivalent block inside `#dispatch` (not a separately-named sibling method as the lens implied) — same file/lines otherwise correct. This is the same code correctness-001 identifies as dead in production; the two findings describe the same span from different angles | `source/services/queue/queue-controller.ts:521-541,610-627` |
| F-duplication-008 | verified | Both `auto_approve` logging blocks confirmed identical | `source/services/session/turn-workflow.ts:326-342,839-855` |
| F-duplication-009 | verified | Both docker-approval-check expressions confirmed duplicated verbatim despite the file's own "single source of truth" comment | `source/services/approval/shell-sandbox-approval.ts:27-33,58-63` |
| F-duplication-010 | verified | Both 14-field type literals confirmed identical | `source/services/approval/approval-state.ts:10-24,26-40` |
| F-duplication-011 | verified | Same ~10-field `baseMeta` object confirmed rebuilt inline at both locations | `source/services/logging/provider-traffic.ts:960-997,1014-1036` |
| F-duplication-012 | verified | Spot-checked csharp.ts vs java.ts; confirmed shared control-flow shape and that `utils.ts` offers only low-level string helpers | `source/tools/languages/csharp.ts:131-151`; `java.ts:69-87`; `utils.ts` |
| F-duplication-013 | verified | Direct read confirms near-total overlap across most sections (Personality, Values, Escalation, Formatting, etc.); differs mainly in model name line | `source/prompts/gpt-5-modern.md`; `gpt-5.4-mini.md` |
| F-duplication-014 | verified | Confirmed 4 files unreferenced by `basePromptFile`, and `post-build` script copies all of `source/prompts` (including dead files) into `dist/` | `source/prompts/prompt-profiles.ts`; `package.json` post-build script |
| F-duplication-015 | verified, minor caveat | Fixed-window auto-scroll effect confirmed identical in both files; the additional "reset scroll to top on query change" effect claim was not independently re-confirmed in the exact line range checked | `source/hooks/use-model-selection.ts:155-163`; `use-path-completion.ts:137-145` |
| F-duplication-016 | verified | Spot-checked 2 of 4 components; identical `useInput` yes/no pattern confirmed, no shared component | `source/components/prompt/HandoffConfirmationPrompt.tsx`; `StandardModeConfirmationPrompt.tsx` |
| F-overbuild-001 | verified | Grepped all of `source/` for `settingsService.get('ssh.*')` and any read of the five SSH setting keys outside schema/completion files — zero hits; `cli.tsx`'s SSH path confirmed driven only by CLI flags | `source/services/settings/settings-schema.ts:310-316`; `source/cli.tsx:432-534` |
| F-overbuild-002 | verified | Read the migration table and confirmed no legacy key carries a deprecated/legacy/superseded marker anywhere user-facing | `source/services/settings/ancillary-settings-migration.ts:8-38`; `source/hooks/settings-completion-config.ts:37-92` |
| F-overbuild-003 | verified | Confirmed no production construction of `{reasoning: ...}` and that `agent.reasoning.*`/`agent.reasoningModel` are absent from the schema | `source/services/agent-runtime/model-resolver.ts:47-78`; `source/services/agent-runtime/types.ts:9-13` |
| F-overbuild-004 | verified | Repo-wide grep for `subagent_async_progress` returns only the declaration site | `source/services/conversation/conversation-events.ts:26,207-213` |
| F-overbuild-005 | verified | Spot-checked 2 of the 6 cited files; identical try/catch clone pattern confirmed, no exported shared utility found repo-wide | `source/services/tool-execution-ledger.ts:52-58`; `conversation-state-projector.ts:28-32` |
| F-security-001 | verified | Traced `saveToFile()` → `saveSettingsToFile()` → `stripSensitiveSettings()`; confirmed the strip function's full body only removes `agent.openrouter.{baseUrl,referrer,title}` and `app.shellPath`, never any `apiKey` field, while `settings-env.ts` maps 4 env vars directly into `apiKey` fields that reach `this.settings` before the first `saveToFile()` call | `source/services/settings/settings-service.ts:92,116,173-191`; `settings-persistence.ts:83-155`; `settings-env.ts:18,44-47,54`; `settings-schema.ts:409-416` (unrelated `SENSITIVE_SETTING_KEYS`, also missing apiKey) |
| F-security-002 | verified | Read `resolveWorkspacePath` in full — confirmed pure `path.resolve`/`path.normalize`, no `fs.realpathSync`/`lstat` anywhere; confirmed `create-file.ts`'s `needsApproval` does a lexical `startsWith(cwd + path.sep)` check and `execute` writes through Node's symlink-following `fs.writeFile`; confirmed the same lexical `insideCwd` pattern in `search-replace.ts` and `apply-patch.ts` | `source/tools/utils.ts:10-74`; `source/tools/file/create-file.ts:102-118,156-179`; `search-replace.ts:290,302`; `apply-patch.ts:296` |
| F-security-003 | verified | Confirmed `needsApproval` returns `false` (no approval) purely on `availability.type === 'available'` (shell.ts:345-349) without running `isMutatingCommand`; confirmed `execute`'s independent re-check falls through to an unsandboxed run with only a warning log when availability degrades (shell.ts:520-525); confirmed `#initializationFailure`/`#initializedForKey` are `static` class fields shared process-wide | `source/tools/system/shell.ts:338-350,479-526`; `source/utils/shell/sandbox/shell-sandbox-runner.ts:11-13,25-30,56-78` |
| F-security-004 | verified (by delegated pass, all 5 sub-claims confirmed) | Confirmed the human-forcing gate can be lifted via `llmMayEvaluateUnsandboxed`, the batch coordinator wires it from `isUnsandboxedApprovalEligible()`, the decision policy converts LLM `approved:true` straight to `'approve'`, the tool description tells the model unsandboxed execution needs explicit approval, and the mode defaults to `'off'` (opt-in) | `source/services/approval/shell-sandbox-approval.ts:53`; `tool-approval-batch-coordinator.ts:120`; `approval-decision-policy.ts:24-29`; `source/tools/system/shell.ts:65`; `settings-schema.ts:200,864` |
| F-security-005 | reclassified: cited `picomatch` path stale; residual dependency advisories remain | A fresh audit on 2026-08-02 no longer reports the cited `picomatch` path after `fast-glob` was removed, but still reports production-path advisories for `ws` and `shell-quote` (plus a pnpm advisory). Track the current dependency set rather than the stale citation. | `package.json`; `pnpm-lock.yaml`; fresh `pnpm audit --json` |
| F-tests-001 | verified | Read all 3 test bodies — confirmed vacuous (`expect(true).toBe(true)` or zero assertions); grepped `#pendingClearSink` and confirmed it is declared, reset-to-false, and checked, but never set to `true` anywhere in the current file; `git log -p` confirms commit `ea5311de` removed the only `#pendingClearSink = true` assignment (introduced earlier in `96d5bb76`) when the buffering redesign landed, and the current `#bufferedEvents`/`#flushBufferedEvents` mechanism has zero test references | `source/lib/subagent-bridge.ts:46,78-82,216-227`; `subagent-bridge.test.ts:146-174,444-464`; `git log -p` on the file |
| F-tests-002 | verified | Read current 14-line file — matches lens's quote exactly; `git show 5824007b --stat` confirms 178 deletions / 11 insertions in that commit with message "decouple from openai agents sdk" and no body; confirmed no other test file in `source/lib/` calls `.dispose()` on an `AgentClient` (only on `AgentConfiguration` and `SubagentBridge`, different classes) | `source/lib/agent-client.dispose.test.ts` (14 lines); `agent-client.ts:328-334`; `git show 5824007b` |
| F-tests-003 | verified | Read all 3 test bodies — confirmed bare `expect(true).toBe(true)` closes each, with no filesystem/error-injection/logging observation | `source/services/logging/logging-service.test.ts:65-79,343-354`; `settings-service.test.ts:994-1003` |
| F-tests-004 | verified | Read `eslint.config.js` in full — confirmed the only `no-restricted-imports` rule is scoped to `tool-execution-ledger.js`, nothing enforces the component/registry/subagent-manager boundaries | `eslint.config.js:99-121` |
| F-tests-005 | verified | Read the test — confirmed it is a bare `instanceof` check with no behavioral assertion | `source/providers/codex-responses-model.test.ts:693-707` |
| D-null-001 | verified, with a flaw noted | `turn-coordinator.ts` confirmed 111 lines; **but** the defense's own suggested "verify by" grep (expecting zero matches for its own pattern list) is wrong as written — `ProviderContinuity` appears twice (import + field) because it's genuinely one of `TurnCoordinator`'s 4 named dependencies. The substantive claim (thin coordinator, no stream/retry/history logic) still holds; only the literal verification recipe is broken | `source/services/session/turn-coordinator.ts` (111 lines, `ProviderContinuity` at lines 7,26) |
| D-null-002 | verified (claim), but does not rebut F-architecture-002 | Confirmed `TurnWorkflow`'s public surface is small (`executeInitial`, `executeContinuation`, `continuePostExecute`, `executeInitialAttempt`, `executeContinuationAttempt`, `abortLiveRun` — 6 non-`#` methods) against private (`#`-prefixed) helpers. This defends file *size*, not the *control-flow-ownership* claim F-architecture-002 actually makes — different axis, see Contradictions resolved | `source/services/session/turn-workflow.ts` (grep for public vs `#` methods) |
| D-null-003 | verified | `grep -n "^export "` confirms one function + one type export; git log confirms real bugfix commits against this file | `source/services/conversation/conversation-replay.ts` |
| D-null-004 | verified | Consistent with invariants.md's own confirmed history of the provider-bug-sweep (10 real regressions, fix-verified) | `docs/plans/provider-bug-sweep.md` (read via invariants.md summary) |
| D-null-005 | verified | Directory listing confirms exactly 13 non-test files in `services/approval/` | `source/services/approval/*.ts` |
| D-null-006 | verified (aggregate claim), does not rebut F-overbuild-001/002 | Aggregate breadth argument is plausible at the whole-schema level, but does not address the specific, concrete dead subsets overbuild found (SSH keys, ~19 legacy model keys) — see Contradictions resolved | `source/services/settings/settings-schema.ts` |
| D-null-007 | verified | Confirmed no `@openai/agents` import in `agents-model-bridge.ts`; types are locally declared `any` | `source/providers/agents-model-bridge.ts:1-40` |
| D-null-008 | verified | grep confirms exactly 1 TODO/FIXME/HACK/XXX outside test files repo-wide | repo-wide grep |
| C-null-1 (24-field TurnWorkflowDeps) | verified, minor correction | Actual field count is 23, not 24 (close to both the null-hypothesis lens's "24" and architecture's "20" estimates) | `source/services/session/turn-workflow.ts:71-98` |
| C-null-2 (in-memory approval/sandbox override state) | verified | Consistent with the decoupling plan doc's own admission per invariants.md context; treated as verified per task instructions (pre-conceded weaknesses) | `docs/plans/decouple-from-openai-agents-sdk.md` §1 (cited, not independently re-read in full) |
| C-null-3 (AGENTS.md WIP staleness) | verified, already known | Confirmed by invariants.md itself, which explicitly pre-empts this as known and resolved — not a new finding | `AGENTS.md` "Work In Progress"; `audit/invariants.md:57-61` |
| C-null-4 (commented debug line) | verified | Confirmed the exact commented-out `console.log` line | `source/components/MarkdownRenderer.tsx:622` |

## Contradictions resolved

1. **D-null-002 ("turn-workflow.ts is a legitimate deep module") vs F-architecture-002 ("the control loop itself is undelegated").** These are not actually in conflict once read closely: D-null-002 defends the file's *size* by pointing to its small public surface (6 public methods vs ~10-20 private helpers) — a real and valid defense against a naive "1092 lines = bad" complaint. F-architecture-002 makes a narrower, different claim: that despite 20+ injected collaborators handling leaf policy, the *sequencing/branching* (the `while(true)`-shaped retry/approval/recovery loop) is still owned directly by `TurnWorkflow`'s own methods rather than by any of those collaborators. I read `executeContinuationAttempt` (turn-workflow.ts:652-768) directly and confirmed staleness checks, batching, stream-cycle dispatch, and recovery branching all live inline. Resolution: F-architecture-002 survives — D-null-002 doesn't address the axis it's about. Both can be true: the module is appropriately deep in its interface, and its internal control flow is still a concentration risk for future changes.

2. **D-null-006 ("80-field settings schema is proportionate to product breadth") vs F-overbuild-001/002 ("SSH schema is unread; ~19 legacy model-tier keys are dead").** Not a real conflict: D-null-006's argument operates at the aggregate level (many provider families, SSH, sandbox, memory feature legitimately need many settings) and that argument holds up — grep confirms most flagged settings (transport, readPolicy, displayMode, autoApproveMode, useRtkCompression) are genuinely branched on. But F-overbuild-001 and F-overbuild-002 are line-item claims about specific, named subsets that are provably unread (SSH: zero reads of `settingsService.get('ssh.*')` anywhere) or provably superseded (the migration table itself proves the team already decided 4 keys are canonical). Aggregate proportionality does not make every individual field load-bearing. Resolution: both survive as correct at their respective grain — D-null-006 is a defense of the schema as a whole, not a rebuttal of these two specific instances.

3. **F-correctness-001 ("QueueController's failure-recovery catch blocks are dead") vs F-duplication-007 ("the same block is duplicated in two methods").** Not a contradiction, but the same code read from two angles. Reading `queue-controller.ts:521-541` (`#acceptPreflight`) and the equivalent span inside `#dispatch` (`:610-627`) directly confirms both: the two blocks are structurally identical (duplication's claim) *and* both are unreachable in production because the app's only `QueueTurnDriver.start` implementation never throws (correctness's claim). Resolution: merge into one entry for the repair plan — a single dead, duplicated recovery path, not two separate problems. One correction to duplication-007: the "sibling method" is code inside `#dispatch`, not a separately named private method as the report implied.

4. **F-dependencies-007's tie to "an uninvestigated hang in the openai provider" vs invariants.md.** The dependencies lens (written without invariants.md) flagged the stale `openai@^6.9.1` pin as "worth the bug-sweep owner checking... given AGENTS.md's uninvestigated hang note." invariants.md (now confirmed present) explicitly states this exact AGENTS.md claim is stale — the provider-bug-sweep plan doc records all three previously-open items, including the hang, as fixed and verified the same day. Resolution: the version-staleness fact itself (F-dependencies-007's core claim) remains verified and stands independently; the speculative connection to an "open hang" is retracted as based on stale framing and should not be carried into the repair plan as a reason to prioritize the version bump.

## Null-hypothesis outcomes

**Rebutted / downgraded:**
- No finding from another lens is fully rebutted by a null-hypothesis defense. The closest cases (D-null-002 vs F-architecture-002, D-null-006 vs F-overbuild-001/002) were resolved above as "different axis, no actual rebuttal" — the original findings survive.
- D-null-001 defends against a "four layers is unnecessary" complaint that no lens actually made (architecture's own report explicitly agrees most layers earn their keep) — this defense knocks down a strawman, not a real finding. No entry to downgrade.

**Survived / upgraded to load-bearing:**
- F-architecture-002 (turn-workflow control-flow concentration) — survives D-null-002's size-based defense; the control-flow-ownership claim is untouched by it.
- F-overbuild-001 (SSH settings dead) and F-overbuild-002 (model-tier generations) — survive D-null-006's aggregate-breadth defense; both are concrete, provable dead/superseded subsets within an otherwise-justified schema.
- F-correctness-001 / F-duplication-007 (dead, duplicated queue recovery path) — D-null-004's general defense of "defensive code in providers is bug-preventing, not paranoid" does not extend to this case: the queue-controller catch blocks aren't defending against a documented historical bug, they're literal dead code with no test that ever exercises the throw path. Upgraded to load-bearing as an unambiguous, unrebutted finding.

**Concessions (per instructions, treated as verified findings, not re-litigated):**
- C-null-1 (24→actually 23-field `TurnWorkflowDeps`) — real comprehension cost, verified.
- C-null-2 (in-memory approval/sandbox override state doesn't survive process restart) — real, admitted, verified; elevated into the security/correctness picture below since it directly concerns the approval-safety boundary.
- C-null-3 (AGENTS.md WIP staleness) — already known per invariants.md, not a new finding; excluded from root-cause grouping as directed.
- C-null-4 (commented debug line) — real but trivial; included in Dropped/low-priority, not a root-cause symptom.

## Root-cause groups  ⚠ HYPOTHESIS — requires human confirmation

### RC-1: Settings-schema decision debt from iterative, never-cleaned-up generations
- **Symptoms**: F-overbuild-001 (SSH schema fully wired, never read), F-overbuild-002 (3-4 coexisting model-tier-selection generations, ~19 dead legacy keys), F-dependencies-005 (`@types/ssh2` misfiled as a runtime dependency — same feature area)
- **Causal story (hypothesis)**: The SSH settings sub-schema and the model-tier settings were each built out fully (schema, validation, `/settings` autocomplete, source tracking) before or in parallel with a design change that moved the *real* mechanism elsewhere (SSH connection wiring settled on CLI flags; model selection consolidated into 4 tiers with an explicit migration table). Nobody went back to delete or mark-deprecated the superseded schema surface, likely because it still validates/round-trips cleanly and deleting a schema field that might exist in someone's `settings.json` feels riskier than leaving it inert.
- **Alternative explanation**: This could instead be deliberate forward/backward-compatibility design — keeping old settings keys readable (or, in SSH's case, keeping the schema as a placeholder for a not-yet-wired future feature) rather than an oversight. The explicit migration table for model tiers supports "deliberate compatibility" more than "oversight" for that half; the SSH case has no such table and no code path at all touching `ssh.*`, which fits "oversight" better.

### RC-2: Mechanism-replacement refactors leave the superseded path (and its tests) in place instead of deleting it
- **Symptoms**: F-tests-001 (`#pendingClearSink` dead field + 3 vacuous tests describing the old, removed deferred-clear mechanism), F-tests-002 (`agent-client.dispose.test.ts` gutted to a placeholder in the SDK-decoupling commit, with zero replacement coverage of `AgentClient.dispose()`), F-correctness-001 (`QueueController`'s `driver.start()`/`continueAfterAction()` catch/recovery paths are dead code from a driver-abstraction design the production adapter never fully implements), F-correctness-003 (`isConversationLocked()`/`'locked'` status variant fully built but unreachable, superseded by a separately-implemented `LockConflictError` mechanism), F-duplication-001 (a second, ~90-line dead `createOpenAICompatibleProviderDefinition` plus a commented-out third "legacy factory removed" copy)
- **Causal story (hypothesis)**: Across at least three independently-timed refactors (the subagent async-registry redesign in `ea5311de`, the `@openai/agents` decoupling in `5824007b`, and whatever introduced the queue-driver/lock-detection abstractions), the team built and fully wired the *new* mechanism but did not follow through with deleting the old mechanism's dead fields/branches, nor did they rewrite the tests that described the old behavior — in the SDK-decoupling case, a test file was reduced to an unrelated placeholder rather than removed or rewritten to cover the new code. This suggests the team's refactor discipline covers "make the new path work and typecheck" but not "delete what the new path replaced," across multiple unrelated features — not just the SDK migration this audit was primed to look for.
- **Alternative explanation**: Ordinary codebase entropy with no single process cause — any actively-developed system accumulates orphaned branches and stale tests, and the fact that 5 instances span 3 unrelated features could be coincidence rather than a repeatable pattern. The one point against pure coincidence: `git log -p` directly shows two of these (tests-001, tests-002) were caused by the exact commit that introduced the replacement mechanism, not drift over time — the old and new code were touched in the same commit, and only the old code's cleanup was skipped.

### RC-3: Independently-evolved approval/safety-boundary code has under-hardened primitives (lexical path checks, TOCTOU-prone shared state, no single dispatch point)
- **Symptoms**: F-security-002 (workspace-boundary check is lexical, not realpath-based — symlink bypass), F-security-003 (sandbox availability backed by process-wide static state, checked twice with a fail-open branch between the checks), F-security-004 (LLM-mediated auto-approval can authorize unsandboxed execution, an explicit but under-signposted widening of the tool's documented contract), F-architecture-003 (approval-answer-kind handling is ad hoc boolean branching, not dispatched through the module's own clean `ApprovalDecisionPolicy` interface), F-architecture-004 (two independently-designed approval mechanisms — pre-execute interruption vs. post-execute promise-gate — require manual adapter-level synchronization), F-duplication-009 (the docker-approval check is duplicated instead of the "single source of truth" the file's own comment claims), C-null-2 (approval/sandbox override state is in-memory only, doesn't survive a process restart)
- **Causal story (hypothesis)**: Approval/safety logic was added per-tool and per-feature over time (file tools, shell tool, docker host-control, LLM auto-approval, denied-read escalation) with each addition implementing its own boundary check or gate rather than extending one hardened, shared primitive. `services/approval/`'s own internal design shows the team *does* know how to build a clean single-dispatch abstraction (`ApprovalDecisionPolicy`, used for the pre-prompt auto-approve gate) — but it wasn't reused for the post-answer application side or for the file-tool workspace-boundary check, suggesting the abstraction arrived after some of the call sites it should now cover already existed independently.
- **Alternative explanation**: These could be several unrelated, independently-scoped design decisions rather than one systemic cause — file-tool boundary checking, shell-sandbox availability, and LLM auto-approval are different subsystems with different owners in time, and treating them as one "root cause" may overstate the connection. The strongest evidence against pure independence: F-duplication-009 shows the *same file* failing to reuse its *own* declared single-source-of-truth function, which is hard to explain except as incremental, non-refactored accretion within one module.

### RC-4: No convention or tooling for extracting small shared utilities — repeated hand-rolled duplication
- **Symptoms**: F-duplication-002 (formatSubagentResult), F-duplication-004 (reasoning-history helpers, ×3), F-duplication-005 (remote/local file I/O branching, ×3), F-duplication-006 (self-admitted `#runAgentWithProvider` duplication), F-duplication-007 (queue start-item sequence), F-duplication-008 (auto_approve logging block), F-duplication-010 (identical type literals), F-duplication-011 (`baseMeta` builder), F-duplication-015 (scroll-window effect), F-duplication-016 (yes/no prompt pattern), F-overbuild-005 (deepClone helper, ×6), F-dependencies-006 (hand-rolled deepEqual vs. declared `fast-deep-equal`)
- **Causal story (hypothesis)**: The codebase has no shared low-level utilities module that call sites are steered toward, and the colocated-test-per-file convention (a deliberate project norm per invariants.md) may create friction against extracting shared helpers, since doing so means deciding which file "owns" the new test. Several of these duplicates have already diverged behaviorally (F-duplication-002's missing sections, F-duplication-003's different predicates), which is the concrete evidence this is a real drift risk and not just superficial pattern-matching by jscpd.
- **Alternative explanation**: Some of this may be intentional decoupling — the architecture skill's own doctrine (per null-hypothesis's framing) discourages sharing code purely because it looks similar, to avoid false coupling between call sites that might need to diverge later. This plausibly explains F-duplication-010 (two approval-context types that may be meant to diverge) and possibly F-duplication-016 (four confirmation prompts with different copy). It does not plausibly explain the cases with proven behavioral drift (002, 003) or verbatim self-admitted duplication (006).

### RC-5: Ordinary dependency-manifest drift, not migration-specific
- **Symptoms**: F-dependencies-001 through 005 (dead/orphaned packages: fast-glob, babel toolchain, orphaned @types), F-dependencies-007/008/009 (AI-provider stack, sandbox-runtime, and unbash all pinned behind current)
- **Causal story (hypothesis)**: No dependency-hygiene tooling (knip/depcheck) runs in CI or locally, so packages left behind by earlier approaches (a since-replaced fast-glob-based implementation, a since-removed babel/import-jsx toolchain, a since-extracted web-fetch implementation) are never flagged for removal, and caret-range version ceilings are never revisited once set.
- **Alternative explanation**: The version pins specifically (007/008/009), as opposed to the dead packages (001-004), could instead reflect deliberate conservatism — freshly pinning major-version bumps to an actively-changing AI-provider stack shortly after a large provider-layer migration is a reasonable risk-avoidance choice, not neglect. This doesn't extend well to `@anthropic-ai/sandbox-runtime` being 11 *patch* releases behind on a 0.0.x package (patch releases on a pre-1.0 package are unlikely to be intentionally avoided), which is the strongest single instance for the "neglect" reading.

## Dropped findings
No finding was refuted outright by re-verification — every finding from every lens held up as factually true when independently re-checked, with only minor corrections (noted in the ledger: F-dependencies-007's "one major" vs. actual "two majors" for the `ai` package; F-duplication-007/015's minor location details; C-null-1's 23 vs. claimed 24 fields; D-null-001's self-contradicting "verify by" grep recipe).

Items excluded from the root-cause groups (not refuted, just out of scope for a repair-plan narrative):
- C-null-3 (AGENTS.md WIP staleness) — already known and flagged to the user per invariants.md; not a new finding, and updating one doc section is a trivial fix, not a systemic issue.
- C-null-4 (one commented-out `console.log` in MarkdownRenderer.tsx) — real but trivial; a one-line deletion, not worth a root-cause narrative.
- D-null-001/003/004/005/007/008 — these are successful defenses against plausible-sounding but unsubstantiated criticisms; they don't correspond to any actual verified finding from another lens and are retained in the ledger for completeness but carry no repair-plan action.
- F-security-005 / F-dependencies-007-009's version-staleness — real and verified, but action here is "bump a version and re-test," not indicative of a deeper design problem; grouped in RC-5 for completeness but flagged as the lowest-narrative-value group.

---

# Current triage and security re-entry gate — updated 2026-08-02

**Verdict:** re-triage before executing the remaining-order list. The prior list contains one invalid premise (security was treated as wholly deferred) and has no executable security re-entry gate.

| Priority | Work |
|---|---|
| P0 | **F-security-002:** replace the lexical workspace approval boundary with a shared filesystem-aware boundary; cover `create_file`, `apply_patch`, and `search_replace`. |
| P0 decision | **F-security-001:** credentials are env-only and must not persist. Scrub API keys at the shared persistence boundary and migrate existing `settings.json` files. |
| P1 | **F-security-003:** if sandbox availability changes after a command was auto-approved as sandboxed, fail with an error; never run the command raw. |
| P1 completion gate | Add a synchronous `run_subagent` formatter regression for `Validation:` / `Diff stat:`. Correct the `continueAfterAction` comment: a rejected test callback does not emit a `failed` event. |
| P2 | Delete orphaned `QueueTurnDriver.continueAfterAction` after the queue change is settled; then address admitted `#runAgentWithProvider` duplication (F-duplication-006). |
| Decision gates | SSH settings (remove/migrate vs wire); prompt-profile duplication (product behavior); auto-approval of unsandboxed commands (F-security-004 remains opt-in but contradicts tool wording). |
| Park | Turn/approval refactors (F-architecture-002/003/004), Docker predicate extraction (F-duplication-009), and small duplications without a concrete behavior change. |

**Security owner:** qduc (repository owner/maintainer).  
**Temporary risk acceptance:** qduc accepts the residual F-security-004 and F-security-005 exposure only until the re-entry date below: F-security-004 remains limited to its explicit opt-in mode, and F-security-005 remains limited to the currently reported dependency advisories while they are investigated. No new credential-persistence or symlink-boundary risk is accepted.  
**Re-entry trigger/date:** reopen the deferred security tranche at the next release/security review and no later than **2026-08-16**; the fresh 2026-08-02 audit is the baseline for F-security-005 remediation. This gate is cleared only when the owner records the decision and focused regression evidence for each remaining finding.

**Current tranche status:** F-security-001 and F-security-002 are implemented with focused persistence and symlink-boundary regressions; F-security-003 is implemented with a fail-closed availability regression. The synchronous `run_subagent` formatter regression is also covered, and the orphaned `QueueTurnDriver.continueAfterAction` hook has been removed. Full tests, typecheck, lint, and provider black-box verification passed after integration. F-duplication-006 remains the next non-security cleanup.

**Key correction:** F-duplication-003 must not be “fixed” by choosing one predicate. Codex operates on raw server history and must retain interleaved function calls; the shared filter operates on normalized application items. Keep both semantics and add paired regression coverage before considering a parameterized helper.

**Reclassifications:**
- F-security-005 needs a fresh dependency audit; its cited `picomatch` production path is stale.
- C-null-2 fails closed on restart by clearing transient grants, so it is not a security defect.
- F-overbuild-002 is a compatibility/deprecation decision, not cleanup.
- F-duplication-005 (remote file I/O) is unrelated to dead SSH settings and needs its own semantics-preserving design.

# Historical remediation status — updated 2026-08-02

Scope of the prior round: everything **except** the security findings, which were then
explicitly deferred. Work was delegated to seven parallel subagents with disjoint file
ownership, then re-verified centrally. Changes are in the working tree, **not committed**.

Central verification (all run after integration, on the combined change set):

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test` | 403 files / 4981 tests passed, 1 skipped |
| `pnpm test:provider-black-box` | 18 files / 150 tests passed |
| `pnpm lint` | clean (eslint + prettier) |

Net diff: **−1029 / +335 lines** across 20 files.

## Findings addressed

| Finding | What was done |
|---|---|
| F-correctness-001 | Both dead catch blocks removed from `queue-controller.ts` (`#acceptPreflight`, `#dispatch`), plus the dead catch in `#resolveAction`. Each site now carries a comment pointing at the authoritative failure policy in the `failed` event handler, so the contradictory second policy cannot be re-introduced by accident. |
| F-duplication-007 | Same span as above — resolved by the same deletion, as the synthesis predicted. |
| F-correctness-003 | **Partial.** The unreachable `'locked'` variant was removed from `LoadConversationForProjectResult`. `isConversationLocked()` was **kept** — see Disproven below. |
| F-tests-001 | Dead `#pendingClearSink` field removed from `subagent-bridge.ts` along with the always-false branch it guarded; the 3 vacuous tests describing the removed deferral mechanism deleted. No new buffering tests added — see Disproven below. |
| F-tests-002 | `agent-client.dispose.test.ts` rebuilt from a 14-line placeholder to 8 real tests covering `AgentClient.dispose()`: idempotency, the abort→invalidate→dispose chain, `abort()` vs `dispose()` being distinct, post-disposal safety, and the no-bridge (transient client) path. |
| F-tests-003 | `logging-service.test.ts:65-79` given a real assertion (`expect(fs.existsSync(logDir)).toBe(false)`, matching the test's own stated intent). The other two deleted as unfixable/redundant: the "gracefully degrades on write errors" test injected no error, and the `settings-service.test.ts` case duplicated existing coverage at `:519`. |
| F-tests-005 | Bare `instanceof` test deleted from `codex-responses-model.test.ts`. |
| F-duplication-002 | Local `formatSubagentResult` deleted from `run-subagent.ts`; call sites now use the canonical `services/subagents/utils.ts` version. **Product behavior change:** the `run_subagent` tool now emits the `Validation:` and `Diff stat:` sections it was silently dropping, bringing it in line with the async path. |
| F-duplication-014 | 5 dead prompt files deleted (`simple.md`, `simple_prev.md`, `simple_v2.md`, `simple_v3.md`, `shell-sandbox.md`) — 455 lines that `post-build` was shipping into `dist/`. |
| F-duplication-001 | **Partial.** The ~31-line commented-out legacy factory removed from `openai-compatible-lazy.ts`. The main claim was disproven — see below. |
| F-dependencies-001 | `fast-glob` removed. |
| F-dependencies-002 | `@babel/cli`, `@babel/preset-react` removed. |
| F-dependencies-003 | `@types/jsdom`, `@types/mozilla-readability`, `@types/turndown` removed (no runtime counterparts installed). |
| F-dependencies-004 | `@types/marked` removed (`marked` v17 ships its own types). |
| F-dependencies-005 | `@types/ssh2` moved from `dependencies` to `devDependencies`. |
| F-dependencies-006 | Hand-rolled `deepEqual` in `structured-output.ts` replaced with the already-declared `fast-deep-equal`, after confirming semantic equivalence for JSON-schema enum values. |
| F-overbuild-004 | `subagent_async_progress` event kind and its interface removed from `conversation-events.ts`. |

## Findings disproven during remediation

These were verified as *stated* by the audit but turned out to be wrong when acted on.
Recorded here so they are not re-attempted.

1. **F-tests-001's "the current `#bufferedEvents`/`#flushBufferedEvents` mechanism has zero
   test references" is false.** It is covered by the sibling file
   `source/lib/subagent-bridge.background-sink.test.ts` (7 tests; `:142`, `:155`, `:182`
   directly exercise flush-after-buffer for both scopes). The lens grepped only
   `subagent-bridge.test.ts`. The dead-field half of the finding was still correct.
2. **F-correctness-003's "zero production callers outside its own file and test" is false
   for `isConversationLocked()`** — it is called from `cli.tsx`. Only the `'locked'` status
   variant was genuinely unreachable, because `loadConversationForProject()` never returns it.
3. **F-duplication-001's "dead ~90-line factory" is false.** `createStreamedModel` and
   `createRunner` in `openai-compatible.provider.ts:299-326` are exercised by
   `provider-contract.test.ts` (the provider black-box suite, which per AGENTS.md must
   reach models through the registry) and by `openai-compatible.provider.test.ts`. They are
   test-reachable, not dead. Only the commented-out block was removable.
4. **F-correctness-001 is not a live defect.** The live `failed`-event path drops the failed
   item and pauses with retained work, which is the *documented and intended* policy
   (`conversation-adapter.ts:432-438`). The dead catch blocks implemented a contradictory
   retry policy that never ran. Cleanup value, not bug-fix value.

## New finding from this round

- **`QueueTurnDriver.continueAfterAction` is an orphan interface member.** With its dead
  catch removed, the member is implemented by no production driver — only by test drivers.
  Either delete it (and the test drivers implementing it) or document why it is a
  deliberate extension point.

## Historical remaining order before the current re-triage (security excluded)

1. **F-duplication-003** — `codex-responses-model.ts:391-412` vs `chained-input-filter.ts:112-128`
   run a structurally identical scan with *different* predicates. Now the last finding where
   duplication has already produced a behavioral divergence. Decide which predicate is
   correct; do not merely unify the shape.
2. **`continueAfterAction` orphan member** (above).
3. **F-duplication-006** — byte-identical `#runAgentWithProvider` in `agent-chat-service.ts:32-63`
   and `agent-run-orchestrator.ts:502-533`; the doc comment already admits it.
4. **F-duplication-005** — the same `isRemote && sshService` branch hand-rolled in
   `create-file.ts`, `apply-patch.ts`, `search-replace.ts`. Pairs naturally with item 5.
5. **F-overbuild-001 (SSH settings)** — *needs an owner decision, not a refactor.* Five settings
   nothing reads; the real path is CLI flags. Deliberately left alone: deleting schema keys that
   may exist in users' `settings.json` carries a migration question, and RC-1's alternative
   reading (placeholder for unwired work) is live. Resolve the intent first.
6. **F-duplication-013** — `gpt-5-modern.md` and `gpt-5.4-mini.md` are near-identical. Product
   behavior; needs prompt-level judgement, not mechanical extraction.
7. **Lower value, unblocked:** F-architecture-001 (unused queue extension points),
   F-correctness-002 (`NULL_SESSION_CONTEXT_SERVICE` imported as a value in 4 providers),
   F-overbuild-002 (~19 legacy model-tier keys — note the migration table argues these are
   deliberate compatibility), F-overbuild-003 (unconstructed reasoning config),
   F-overbuild-005 / F-duplication-004/008/010/011/012/015/016 (remaining RC-4 duplication),
   F-dependencies-007/008/009 (version bumps; the "uninvestigated hang" rationale was already
   retracted in Contradictions §4), C-null-1, C-null-3, C-null-4.
8. **Not recommended yet:** F-architecture-002/003/004. Refactors of the turn/approval control
   flow for maintainability only. The suite is more trustworthy after this round, but that is
   not a high enough bar to restructure the retry/approval loop.

## Historical deferral, superseded by the current re-triage

The prior batch left F-security-001..005 and C-null-2 untouched. The current triage
re-enters F-security-001..003 as P0/P1 work and keeps only the explicitly accepted,
reclassified remainder behind the security re-entry gate above. Note that
**F-duplication-009** (the duplicated docker-approval check, despite the file's own
"single source of truth" comment) and **F-architecture-003/004** (ad-hoc approval-answer
branching; two unsynchronised approval mechanisms) sit inside root-cause group RC-3 and
should remain parked unless a concrete security behavior change requires them.
