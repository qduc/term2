# Lens report: overbuild
Codebase: /Users/qduc/src/term2  |  Scope: whole repo (source/)  |  Date: 2026-08-01

## Summary
`/Users/qduc/src/term2/audit/invariants.md` did not exist at the start or end of this
pass (confirmed by repeated directory listing), so this lens ran from direct code
investigation only — see Blocked. The overbuild in this codebase is not diffuse
speculative architecture; the provider registry and language-tool set genuinely need
their many implementations, and most single-value-looking settings (`transport`,
`readPolicy`, `displayMode`, `autoApproveMode`, `useRtkCompression`) turned out to be
real, exercised branches. The pointlessness that *is* well-integrated clusters in two
specific places: (1) a full SSH settings sub-schema that is validated, defaulted,
migrated, and offered through `/settings` autocomplete but is never read by the actual
SSH connection path (which is driven entirely by CLI flags), and (2) three-to-four
historical generations of "which model for task X" settings that coexist as equally
first-class, user-settable keys years after a migration table was written to
consolidate them. A few smaller dead branches (one unreachable event type, one
unreachable relative-model-policy field reading settings keys absent from the schema)
round out the picture. By line count the affected surface is small (roughly 500-700
of ~84k non-test source lines, well under 1%), so the ratio of shipped-functionality
code to hypothetical-future code is high; the issue is concentrated decision debt from
incomplete migrations, not broad speculative scaffolding.

## Findings

### F-overbuild-001: SSH settings schema is fully wired but never consulted by the real SSH connection path
- **Severity**: high
- **Confidence**: high
- **Location**:
  - `source/services/settings/settings-schema.ts:310-316` (`SSHSettingsSchema`: `enabled`, `host`, `port`, `username`, `remoteDir`)
  - `source/services/settings/settings-schema.ts:676-680` (`SETTING_KEYS.SSH_*`)
  - `source/services/settings/settings-sources.ts:84-88` (source-tracking mapping for all five keys)
  - `source/hooks/settings-completion-config.ts:131-135` (all five keys listed for `/settings` tab-completion)
  - `source/utils/value-suggestions.ts:116` (autocomplete suggestion for `ssh.port`)
  - `source/cli.tsx:432-534` (actual SSH connection logic, driven by `cli.flags.ssh` / `cli.flags.remoteDir` / `cli.flags.sshPort`, never touches `settingsService.get('ssh.*')`)
- **Claim**: A user can run `/settings ssh.host myserver.com`, `/settings ssh.enabled true`, `/settings ssh.port 2222`, etc., have them validated and persisted, and see them offered via autocomplete, yet none of the five values ever reaches the code that opens an SSH connection — that code only reads `cli.flags.ssh`, `cli.flags.remoteDir`, and `cli.flags.sshPort` set at process start via CLI arguments.
- **Evidence**: `grep -rn "ssh\.enabled\|ssh\.host\|SSH_ENABLED\|SSH_HOST"` across `source/` (excluding schema/sources/completion-config/tests) returns zero hits. `source/cli.tsx:440` gates the entire SSH connect block on `if (sshFlag)` where `sshFlag = cli.flags.ssh` (line 432), constructs `SSHConfig` from `resolvedHost`/`resolvedUser`/`resolvedPort` derived from the flag and `~/.ssh/config`, and never calls `settingsService.get('ssh.*')` anywhere in the file.
- **Verify by**: `grep -rn "settingsService.get('ssh\." source --include="*.ts" --include="*.tsx"` (excluding settings-schema.ts/settings-sources.ts/settings-service tests) — expect no results. Then set `ssh.host`/`ssh.enabled` via `/settings` in a running session and confirm no SSH connection is attempted without the `--ssh` CLI flag.
- **Invariant impact**: none (invariants.md absent).

### F-overbuild-002: Three-to-four coexisting generations of "which model for task X" settings, all equally first-class
- **Severity**: high
- **Confidence**: high
- **Location**:
  - `source/services/settings/settings-schema.ts:11-193` (`AgentSettingsSchema`: `efficientModel`/`capableModel` [gen 1]; `mentorModel`/`mentorProvider`/`mentorReasoningEffort`, `autoApproveModel`/`autoApproveProvider`, and `tools.editHealingModel`/`editHealingProvider` at line 298-303 [gen 2, single-purpose]; `subagentExplorerModel`/`Provider`/`ReasoningEffort`, `subagentWorkerModel`/`Provider`/`ReasoningEffort`, `subagentResearcherModel`/`Provider`/`ReasoningEffort`, `subagentLibrarianModel`/`Provider`/`ReasoningEffort` [gen 3, per-role]; `smartModel`/`Provider`/`ReasoningEffort`, `balancedModel`/`Provider`/`ReasoningEffort`, `cheapModel`/`Provider`/`ReasoningEffort`, `choreModel`/`Provider` [gen 4, consolidated tiers])
  - `source/services/settings/ancillary-settings-migration.ts:8-38` (explicit `MIGRATIONS` table mapping 12 gen-2/gen-3 legacy keys onto the 4 gen-4 target keys — proof the team already decided gen-4 supersedes the rest)
  - `source/utils/ai/model-settings.ts:12-91` (13 separate `/settings` trigger configs, one per generation/role, all presented without deprecation markers)
  - `source/hooks/settings-completion-config.ts:37-92` (user-facing descriptions for every generation's keys, none marked legacy/deprecated)
  - `source/services/agent-runtime/model-resolver.ts:80-112` (`resolveLegacyTierModel`/`legacyTierModelSettingKeys` — runtime fallback chain walking gen-1/gen-2/gen-3 keys when gen-4 is unset)
- **Claim**: The settings surface for choosing a model per task carries at least 25 distinct keys (`efficientModel`, `capableModel`, `mentorModel`+2, `autoApproveModel`+1, `editHealingModel`+1, 4×(subagentRole × {Model,Provider,ReasoningEffort}) = 12, 4×(tier × {Model,Provider,ReasoningEffort}, minus choreReasoningEffort) = 11) even though the code's own migration table treats only 4 of them (`smartModel`, `balancedModel`, `cheapModel`, `choreModel` + their Provider/ReasoningEffort siblings) as canonical; the other ~19 keys are legacy inputs the migration silently folds into the canonical ones on load, yet they remain fully validated, settable via `/settings`, autocompleted, and documented as if current.
- **Evidence**: `ancillary-settings-migration.ts` migrates `agent.capableModel`/`agent.mentorModel` → `agent.smartModel`; `agent.subagentWorkerModel`/`agent.subagentResearcherModel` → `agent.balancedModel`; `agent.efficientModel`/`agent.subagentExplorerModel`/`agent.subagentLibrarianModel` → `agent.cheapModel`; `agent.autoApproveModel`/`tools.editHealingModel` → `agent.choreModel` (and the matching Provider/ReasoningEffort pairs). None of the 12 legacy keys named there — nor `efficientModel`/`capableModel`, which the migration doesn't even reach — carry a "deprecated" note in `settings-completion-config.ts`'s user-facing descriptions (checked lines 37-92; only fallback wording like "falls back to agent.model" appears, not "superseded by agent.cheapModel").
- **Verify by**: Search `settings-completion-config.ts` and `model-settings.ts` for any "deprecated"/"legacy"/"superseded" marker on the pre-tier keys — none exists. Then check `RUNTIME_MODIFIABLE_SETTINGS` in `settings-schema.ts:693-768`, which lists all four generations as runtime-modifiable without distinction.
- **Verify (what breaks if deleted)**: Deleting the gen-1/gen-2/gen-3 keys and their trigger/completion entries would only break the migration's read side for very old `settings.json` files (a one-time cost, already anticipated by `ancillary-settings-migration.ts`); no current runtime behavior depends on gen-1/2/3 as a *forward* API, since `model-resolver.ts` treats them purely as read-only fallbacks.
- **Invariant impact**: none (invariants.md absent).

### F-overbuild-003: `RelativeModelPolicy.reasoning` is fully implemented and tested but never constructed by any production code path, and reads settings keys absent from the schema
- **Severity**: medium
- **Confidence**: high
- **Location**:
  - `source/services/agent-runtime/types.ts:9-13` (`RelativeModelPolicy.reasoning?: 'low' | 'medium' | 'high'`)
  - `source/services/agent-runtime/model-resolver.ts:47-78` (`resolveRelativePolicy` — the `policy.reasoning` branch at lines 59-68)
  - `source/services/agent-runtime/model-resolver.test.ts:286-310` (only place `reasoning` is ever set, via a mock settings object)
- **Claim**: `resolveRelativePolicy`'s `if (policy.reasoning)` branch, which reads `settings.getDynamic('agent.reasoning.${effort}')` and `settings.getDynamic('agent.reasoningModel')`, is unreachable in production: no code anywhere constructs a `{ tier: ..., reasoning: ... }` policy object outside `model-resolver.test.ts`, and neither `agent.reasoning.<effort>` nor `agent.reasoningModel` exists anywhere in `SettingsSchema`/`SETTING_KEYS`, so even if reached, `getDynamic` (which returns `undefined` for any unknown dotted path per `settings-service.ts:313-326`) would always fall through to the non-reasoning resolution below it.
- **Evidence**: `grep -rn "reasoning:\s*'low'\|'medium'\|'high'"` restricted to non-test files returns nothing; `grep -rn "agent.reasoningModel\|agent\\.reasoning\\."` across all of `source/` returns only `model-resolver.ts` itself and its own test file.
- **Verify by**: Run `pnpm typecheck` after deleting the `reasoning` field from `RelativeModelPolicy` and the corresponding branch in `resolveRelativePolicy` (lines 59-68) — the only compile break should be in `model-resolver.test.ts`, confirming no production caller depends on it.
- **Invariant impact**: none (invariants.md absent).

### F-overbuild-004: `SubagentAsyncProgressEvent` ('subagent_async_progress') is declared in the conversation event union but never emitted or consumed
- **Severity**: low
- **Confidence**: high
- **Location**: `source/services/conversation/conversation-events.ts:26` (union member), `:207-213` (interface definition)
- **Claim**: The `'subagent_async_progress'` event type exists only in its own declaration file; no code constructs an object with `type: 'subagent_async_progress'`, and no switch/if-chain anywhere pattern-matches on it, unlike its sibling `subagent_question`/`subagent_completed`/`subagent_started` events, all of which have real producers (`subagent-async-registry.ts`, orchestrator) and consumers (logging, UI).
- **Evidence**: `grep -rn "subagent_async_progress"` across all of `source/` returns exactly the two lines in `conversation-events.ts` and nothing else, in contrast to `subagent_question`, which returns hits in `subagent-async-registry.ts`, `subagent-notification-store.ts`, and `conversation-log-events.ts`/`conversation-logger.ts`.
- **Verify by**: Delete the `SubagentAsyncProgressEvent` interface and its union entry, run `pnpm typecheck` — expect zero errors outside `conversation-events.ts`.
- **Invariant impact**: none (invariants.md absent). Note for synthesis: this event type may be a genuinely intended-but-unshipped piece of the async-subagent progress feature (`subagent_question`/`subagent_async_progress` look like siblings for the same feature area) rather than pure cruft — worth checking `docs/plans/subagent-oversight-*.md` before deleting.

### F-overbuild-005: The same 4-line "try structuredClone, catch → JSON round-trip" clone helper is reimplemented independently six times with no shared utility
- **Severity**: low
- **Confidence**: medium
- **Location**:
  - `source/services/tool-execution-ledger.ts:52-58`
  - `source/services/conversation/conversation-state-projector.ts:28-32`
  - `source/services/conversation/run-item-normalizer.ts:10-14`
  - `source/services/conversation/journal-to-ledger.ts:11-15`
  - `source/services/conversation/conversation-replay.ts:68-72` (plus two more local wrappers in the same file at lines 55, 63)
  - `source/services/conversation/conversation-turn-items.ts:10-14`
- **Claim**: Six files each define a byte-for-byte identical private `clone`/`deepClone<T>(value: T): T` function (`try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)) as T; }`) instead of importing one shared helper; the `catch` branch's necessity is unverified — nothing in these call sites documents a concrete case where `structuredClone` throws for the conversation/tool-ledger data being cloned (which is asserted to already be plain JSON-shaped `unknown`/`Item` data), so this may be defensive code against a state (non-cloneable data reaching these call sites) the type contracts already exclude.
- **Evidence**: identical `try/catch` bodies confirmed via direct read of all six files; no `export function deepClone`/`export const deepClone` exists anywhere in `source/` (`grep -rln "export function deepClone\|export const deepClone" source` returns nothing), so there was no existing shared utility being bypassed — each was written independently.
- **Verify by**: Extract one shared `deepClone` into a small utils module and confirm all six call sites can import it without behavior change (this is a refactor-safety check, not a functionality check); separately, add a temporary counter/log in the `catch` branch across a normal session to see whether it is ever hit — if never hit, the fallback is dead defensive code, not just duplicated code.
- **Invariant impact**: none (invariants.md absent).

## Non-findings
Checked and found to be real, exercised functionality (not overbuild):
- `agent.transport` (`websocket`/`http`): both values are read and branch on in `codex.provider.ts`, `openai.provider.ts`, and exercised by transport-fallback/retry logic (`retry-event-presenter.ts`), not a single-value flag.
- `sandbox.readPolicy` (`standard`/`strict`): both branch in `sandbox-policy.ts`/`sandbox-env.ts`/`sandbox-failure-classifier.ts` with distinct deny-list behavior.
- `ui.displayMode` (`standard`/`concise`): both drive real rendering differences in `MessageList.tsx`, `CommandMessage.tsx`, `SubagentActivityMessage.tsx`.
- `shell.autoApproveMode` (`off`/`advisory`/`auto`): all three read and branched on in `shell-auto-approval-evaluator.ts`/`StatusBar.tsx`.
- `shell.useRtkCompression`: gates a real code path in `shell.ts:436` calling into `services/rtk-service.ts`.
- `sandbox.dockerHostControlProjects`/`allowNetworking`/`allowReadExtra`: all read at sandbox-policy construction time; the apparent duplication between `docker-host-control-grants.ts` and `session-access-state.ts` is architecturally intentional (session-scoped vs. subagent-nested grant tracking via `nested-tool-compatibility-state.ts`), both wired into production `shell.ts`.
- `debug.debugBashTool`, `tools.enableEditHealing`: both single-purpose booleans with real, reachable branches (`command-logger.ts`, `search-replace.ts`).
- `enable_agent_workflow` + `agentWorkflow.*` limits: a real opt-in feature (default off), but functionally complete and reachable — registers `run_agent_workflow` tool and reads its own worker-thread sandbox (`workflow-sandbox.ts`); not dead, just off by default. Not flagged.
- DI seam interfaces (`ILoggingService`, `ISessionContextService`, `ISettingsService`, `ISSHService`, `IProviderTraffic` in `service-interfaces.ts`) each have exactly one production implementation plus test fixtures — this looks like a "one implementation behind an interface" candidate per the lens brief, but the reason for existing (test-double substitution at real module boundaries) is concrete and load-bearing, not speculative; not flagged.
- `source/tools/languages/` (9 language-specific files) and the provider registry: excluded per lens scope, and independently confirmed to have real per-language logic (not stub implementations).

## Blocked
- `/Users/qduc/src/term2/audit/invariants.md` does not exist. Checked at the start of the session and again after a 5-second wait; the file was never created. All findings above are therefore derived from direct code investigation (grep/read) rather than cross-checked against a pre-verified invariants ledger, and "Invariant impact" is marked "none" throughout for lack of a document to reference. The synthesis pass should treat this report as unverified against whatever ground truth invariants.md was meant to encode, and should re-run the "verify by" steps above independently.
- Did not evaluate `source/services/agent-runtime/` end-to-end for whether the whole `AgentConfig`/`resolveAgent`/`ModelPolicy` public-agent subsystem is reachable from any shipped user-facing entry point beyond `enable_agent_workflow`-gated workflows and subagents — this is a large subsystem (25+ files) that could hide further single-path abstractions; a full pass was out of scope given time.
- Did not run any test suite or `pnpm typecheck` to confirm the "verify by" deletions compile clean — these are proposed checks for the synthesis/repair pass, not completed verifications.