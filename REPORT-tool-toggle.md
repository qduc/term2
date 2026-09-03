# Report: tool-toggle Phase 1 (main-agent capability booleans)

Branch `tool-toggle`, worktree `.worktrees/tool-toggle`, based on `ce7a8e32`
(merge of memory-index-redesign). Implemented per
`docs/plans/tool-toggle-setting-design.md` (Phase 1/M1 scope, v2). **Not merged
to main**, per instructions.

## What was built

One boolean setting per capability group — `tools.<group>.enabled`, default
`true` — that masks that group's capabilities from the resolved Profile's tool
capabilities **for the main agent only**. Masking happens after profile
resolution, so every downstream check (including the three raw
`capabilities.has(...)` reads at the former `agent.ts:548,554,571` — ask_mentor
and run_subagent/async controls) consults one effective set. Toggles are
runtime-modifiable: the live-effect router rebuilds the agent, so changes land
next model request. Subagents are explicitly NOT covered (deferred M3; the
`SubagentToolFactory` role booleans are untouched).

Mode-conflict warnings: disabling a toggle that a built-in profile's guidance
references (Lite → shell/web/fileRead/fileWrite; Standard/Plan →
fileWrite/subagents; Orchestrator → subagents; Mentor → mentor) queues one
composed warning notice through `queueModeNotice`. `queueModeNotice` now
**composes** (`existing\n\nnew`) instead of overwriting, so a profile
transition plus toggle warnings all reach the next turn.

`tools.fileRead.enabled` folds both read capabilities; there is no
`filesystem-read-external` toggle. Lite's outside-workspace read authority
remains `liteMode`-keyed — documented in the schema `.describe()`, the module
comment, the test, and the design doc, not silently hidden.

## Files changed

Production (8):
- `source/services/tool-toggles.ts` (new) — group↔key mapping,
  `resolveDisabledCapabilities`, `buildToggleConflictNotice`, `isToolToggleKey`.
- `source/agent.ts` — effective capability set + `hasCapability` rewrite; the
  three raw reads converted; debug log of the applied mask.
- `source/services/runtime-setting-router.ts` — `isToolToggleKey` branch in
  `applyRuntimeSettingChange` (rebuild); pre-transaction previous-value capture
  + `#queueToolToggleConflictNotice` after profile commit in `apply()`.
- `source/services/session/session-manager.ts` — `queueModeNotice` composes.
- `source/services/settings/settings-schema.ts` — 12 nested toggles
  (schema + `.describe()`), `DEFAULT_SETTINGS`, `SettingsWithSources`,
  `SETTING_KEYS`, `RUNTIME_MODIFIABLE_SETTINGS`.
- `source/services/settings/settings-sources.ts` — source-keys mirror.
- `source/hooks/settings-completion-config.ts` — descriptions + `tools` category.
- `source/utils/settings-command.ts` — 12 `formatSettingsSummary` entries.

Tests (9):
- `source/services/tool-toggles.test.ts` (new) — mapping, union, key
  recognition, warning matrix (all 6 built-in rows, non-builtin generic,
  no-conflict null cases, single composed notice per batch).
- `source/agent.test.ts` — **the required table-driven test** (`tools.<group>.enabled
  toggles remove exactly their own tools and prompt fragments`): all 12 toggles,
  each asserting exact tool-list equality against the baseline (removal + no
  collateral), capability-gated prompt markers dropped, prompt byte-identical
  for fragment-less groups, and every tool present in the baseline precondition
  — this is what proves the raw-check paths (`ask_mentor`, `run_subagent`
  family) actually go dark when disabled. Plus `tool capability toggles default
  to enabled…` (no regression to defaults) and the Lite `fileRead` test
  (documented limitation asserted, not silently broken).
- `source/services/runtime-setting-router.test.ts` — rebuild branch,
  restart-persistence does not rebuild, single warning, batch composition,
  no-warn cases, workflow-profile-switch + toggle both queue.
- `source/services/session/session-manager.test.ts` — compose + set-when-empty.
- `source/services/settings/settings-schema.test.ts` — defaults/round-trip/
  runtime-modifiable; Contract-04 counts 134→146.
- `source/services/settings/test-helpers/settings-consumer-inventory.ts` — 12
  keys classified under "live-effect router or next request".
- `source/hooks/settings-completion-logic.test.ts` — category + description coverage.
- `source/utils/settings-command.test.ts` — fixture + summary assertions.
- `source/lib/agent-factory.test.ts`, `source/lib/agent-client.application-continuity.test.ts`,
  `source/lib/openai-agent-client.chat.test.ts` — their partial settings mocks
  lacked `getDynamic`, now read unconditionally; mocks updated, production
  contract kept strict (no optional-chaining tolerance).

Docs:
- `docs/plans/tool-toggle-setting-design.md` — status header (Phase 1
  implemented), two implementation-verified corrections recorded (grep/glob
  write-branch coupling → new Acknowledged gap #5; `run_subagent_async` never
  registered by the composition root), M1 bullets trued up.
- `AGENTS.md` — Profile M1 status line fixed (stale "not implemented"), the
  docs-pass item the design doc promised.

## Test commands run (exact)

| Command | Result |
| --- | --- |
| `NODE_ENV=test pnpm vitest run` (tool-toggles, router, session-manager, settings-schema, completion-logic, settings-command, agent) | **158 passed / 0 failed** (7 files) after fixes; red-first TDD was observed at each step before implementation |
| `NODE_ENV=test pnpm vitest run source/lib/agent-factory.test.ts` | 37 passed |
| `NODE_ENV=test pnpm vitest run source/lib/openai-agent-client.chat.test.ts source/lib/agent-client.application-continuity.test.ts` | 5 passed |
| `pnpm typecheck` | exit 0 (`tsc --noEmit` clean) — baseline also verified before edits |
| `pnpm test:lane` | My delta is clean; remaining failures are **pre-existing at the branch point** (verified by stashing all changes and re-running at clean `ce7a8e32`): `create-file`/`search-replace` needsApproval outside-workspace tests, `conversation-session.provider`/`.isolation`, 1 unhandled error. Two agent-construction test files failed only via the partial-mock `getDynamic` crashes (fixed). |
| `pnpm test:provider-black-box` | 28 passed / 1 failed / 36 skipped — the failure (`openai-http.early-close does not become empty success`, `result.timedOut` true) **reproduces identically at the clean branch point** (verified via stash), so it is pre-existing/environmental, not caused by this branch |
| `pnpm test` (full isolated suite) | **7596 passed / 6 failed / 3 expected-fail** (586 files). All 6 failures are the pre-existing file-tool `needsApproval` outside-workspace family (`apply-patch` ×2, `create-file` ×2, `search-replace` ×2) — **reproduced with all branch changes stashed at clean `ce7a8e32`** (6 failed / 108 passed in the three files isolated), so they are environmental and pre-date this branch. No regression introduced. |

## Table-driven capability test

Exists and passes: `source/agent.test.ts` →
`tools.<group>.enabled toggles remove exactly their own tools and prompt fragments`
(12 rows; precondition + exact-equality + prompt-marker assertions per row; runs
in the isolated suite since `agent.test.ts` is deliberately excluded from the
lane manifest per the 2026-08-29 leak-union note).

## Judgment calls made alone

1. **Key names**: `tools.shell.enabled`, `tools.web.enabled`,
   `tools.fileRead.enabled`, `tools.fileWrite.enabled`, `tools.memory.enabled`,
   `tools.sessions.enabled`, `tools.skills.enabled`, `tools.mentor.enabled`,
   `tools.subagents.enabled`, `tools.backgroundTasks.enabled`,
   `tools.userInteraction.enabled`, `tools.codeContext.enabled` — camelCase
   groups match existing `SettingsData` style; all 12 runtime-modifiable.
2. **Warning wording**: one composed notice per apply batch, e.g.
   `Tool warning: tools.shell.enabled disabled while the Lite profile's guidance still references these tools; the model may attempt unavailable tools.`
   Non-builtin profile ids get a generic variant naming the id. Only true→false
   flips warn; only `persistence: 'runtime'` changes warn; enabling never warns.
   Composition separator is `\n\n`.
3. **Rebuild mechanism**: the router branch reuses the transport-branch shape
   (`setModel(get('agent.model'))`) so the toggle rides the existing
   next-request rebuild path without a new lifecycle.
4. **grep/glob coupling** (fileWrite off also removes the search pair for
   standard non-gpt5 models): recorded in the test with a comment and as
   Acknowledged gap #5 + follow-up, not silently "fixed" — per the design
   doc's deviations rule.
5. **`run_subagent_async`** is never registered by the composition root
   (`createRunSubagentAsyncToolDefinition` has no production caller); async
   launches ride on `run_subagent`. The table row and design doc were corrected
   to the real registered family.
6. **`configure_task_check_in`** survives `subagents`-off in this fixture
   because its OR-condition's background-tasks branch still holds; it is
   attributed to the backgroundTasks row, with the semantics documented in the
   test comment.
7. **Fixture fixes over defensive code**: kept
   `resolveDisabledCapabilities` strict (getDynamic required) and updated three
   incomplete test mocks, matching how the repo's older agent-construction
   tests already implement `getDynamic`.
8. **Docs scope**: no settings docs exist to update; CHANGELOG is maintained
   by release chores only (checked `git log -- CHANGELOG.md`), so no entry —
   matches the profile-M1 precedent. AGENTS.md's stale Profile M1 line was
   fixed as the design doc's docs-pass item.
9. **Known limitation surfaced by the warnings map**: warnings fire in the
   conversation `apply()` batch path; programmatic `setDynamic`/`reset()`
   changes take effect on next rebuild without a warning (matches how other
   notices behave; noted here so it is a decision, not an accident).

## Pre-existing failures at the branch point (not mine — flagging per policy)

- Lane: `create-file` / `search-replace` `needsApproval` outside-workspace
  tests, `conversation-session.provider` / `.isolation` (the latter two did not
  reproduce in the isolated full-suite run — load-sensitive), 1 unhandled error.
- PBB: `openai-http.early-close does not become empty success` (timeout).
- Full suite: the 6 file-tool `needsApproval` failures listed above.
All sets reproduce at clean `ce7a8e32` with all my changes stashed. Worth a
separate diagnosis: the outside-workspace approval detection appears broken in
this environment (plausibly home/workspace path resolution), and the PBB
early-close scenario times out instead of failing fast.

## Review findings resolution (Option 1: Scope Acceptance)

Following independent review in `REVIEW-tool-toggle-implementation.md`, Option 1
was chosen and implemented:
1. **Formal Scope Acceptance**: Phase 1 is accepted as governing the main-agent
   surface only. Subagent tool capability inheritance is explicitly scheduled
   for Milestone 3, and individual tool controls (e.g. `web_search` vs
   `web_fetch`) for Milestone 2.
2. **Warning Map Expansion**: `PROFILE_TOGGLE_CONFLICTS` in
   `source/services/tool-toggles.ts` now accounts for base model instructions
   (shell and file-write) across `builtin:standard`, `builtin:plan`,
   `builtin:orchestrator`, and `builtin:mentor`. Tests in
   `source/services/tool-toggles.test.ts` updated and verified.
3. **Transaction Ordering Verification**: Added test in
   `source/services/runtime-setting-router.test.ts` proving reverse application
   order (`toggle` then `profile`) correctly queues both mode transition and
   toggle conflict notices without loss.
4. **Memory Context Documentation**: Corrected
   `docs/plans/tool-toggle-setting-design.md:368-371` to distinguish `tools.memory.enabled`
   (disabling memory tools and active guidance) from passive injected memory
   context (governed by the profile context source).

