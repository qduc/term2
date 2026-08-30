# Contract 04 — Settings consumption

Status: **owner-reviewed 2026-08-14; focused command green.** Owners: settings schema
and source resolution (`settings-schema.ts`, `settings-service.ts`,
`settings-merger.ts`, `settings-env.ts`, `settings-persistence.ts`,
`settings-sources.ts`), plus the runtime owner consuming each setting
(`ConversationConfigurationService` + `runtime-setting-router` for runtime
changes, `/settings` command for user entry).

## 1. Contract

| # | Invariant | User-visible harm it prevents |
| --- | --- | --- |
| C4.1 | Every user-facing setting has a runtime consumer or is explicitly marked presentation-only or restart-only. | A setting the user edits has no effect (silent no-op), or a runtime edit is silently lost at the next save. |
| C4.2 | Schema default, runtime fallback, persisted value, environment override, role override, and per-invocation override have one documented precedence order. | The effective value differs depending on which code path reads it; the user cannot predict what applies. |
| C4.3 | A runtime-modifiable setting takes effect at its promised boundary. | The user is told a change "applies" and it does not, or it applies mid-turn with a different guarantee than promised. |
| C4.4 | The effective value — not merely schema presence or UI mutation — is tested. | Schema/UI changes pass review while the runtime consumer ignores the setting. |

## 2. Owners

- **Enforcement:** `SettingsService` (effective value, source tracking,
  runtime-modifiable gate); `settings-schema.ts` (bounds, defaults,
  `RUNTIME_MODIFIABLE_SETTINGS`, `SENSITIVE_SETTING_KEYS`); `settings-merger.ts`
  (precedence); `settings-env.ts` (environment mapping); the runtime consumer of
  each setting (run loop, shell tool, approvals, subagents, compactor, UI,
  non-interactive).
- **Recovery:** `ConversationConfigurationService.apply()` routes runtime
  changes through one `setDynamicTransaction` before effects
  (`runtime-setting-router.ts:37-49`); a rejected transaction invokes no
  effects (test `runtime-setting-router.test.ts:40-49`); `/settings` reports
  `Set <key> to <value>` only after success (`settings-command.ts:375-388`).

## 3. Execution paths that share the contract

- Root interactive session (prompt construction, run loop, shell, approvals,
  compactor).
- Nested subagent, mentor, background, and workflow paths (inherited/attenuated
  settings).
- Non-interactive mode (`source/non-interactive.ts`).
- Runtime `/settings` mutation and reset; startup load (file/env/CLI).

## 4. Identities and state crossing the boundary

- Effective leaf values with sources: `SettingSource` =
  `'cli' | 'env' | 'config' | 'default'` (`settings-schema.ts:566`);
  `SettingsWithSources` for per-key source reporting (`:573-726`).
- Precedence (service level): defaults < config file < env < CLI
  (`settings-merger.ts:54-79`, documented "cli > env > config > defaults",
  `:55-57`). On save reconciliation the order is defaults -> committed file ->
  startup env -> startup CLI, then recorded runtime overrides are applied last
  (`settings-service.ts:873-891`). Role and per-invocation layers sit on top
  and are consumer-specific (see §5).
- `RUNTIME_MODIFIABLE_SETTINGS` is the explicit runtime/restart classification
  (`settings-schema.ts:861-966`); settings outside it reject `setDynamic` with
  "Requires restart" (`settings-service.ts:518-527`). There is no
  "presentation-only" marker; `/settings` summary selects a display subset by
  hand (`utils/settings-command.ts:32-242`).

## 5. Precedence details per layer

- **Service:** `mergeSettings(DEFAULT_SETTINGS, fileConfig, env, cli)`
  (`settings-service.ts:157-180`); test `mergeSettings: cli > env > config >
  defaults precedence` (`settings-merger.test.ts:11-20`).
- **Environment:** only the fields in `buildEnvOverrides()` are env-backed
  (OpenRouter/OpenAI keys, `OPENROUTER_MODEL`, `LOG_LEVEL`,
  `DISABLE_LOGGING`, `DEBUG_LOGGING`, `NODE_ENV`, `SHELL/COMSPEC`,
  `LOG_FILE_OPERATIONS`, `DEBUG_BASH_TOOL`, Tavily/Exa/web-search)
  (`settings-env.ts:15-67`).
- **Role override:** frontmatter explicit > inherited per-tier
  `agent.<tier>*` > legacy role-specific > tier resolver; reasoning falls back
  to `agent.reasoningEffort` then `'default'`
  (`subagents/role-loader.ts:103-140`).
- **Per-invocation:** mentor consultation values override role/definition
  (`mentor-runner.ts:244-250`, `:283-290`); shell tool `timeout_ms` and
  `max_output_length` override settings (`source/tools/system/shell.ts:843-858`);
  `config.providerOverride`/`config.temperature` override settings
  (`lib/agent-configuration.ts:109-125`); model resolver: model argument >
  `agent.model` > `'gpt-4o'` fallback (`model-resolver.ts:43-44`).

## 6. Settlement semantics

- **Success:** a valid runtime change is validated, applied, source-tracked,
  persisted when enabled, and notifies listeners by `SettingsService`.
  Conversation configuration validates the entire runtime change set before
  applying any member, then applies the corresponding live effects
  (`settings-service.ts:604-645`, `runtime-setting-router.ts:37-48`). A
  restart-only change is validated and persisted for a later process, rather
  than applied to the current runtime.
- **Failure:** a sensitive, restart-only-at-runtime, or schema-invalid dynamic
  change throws before that dynamic change is applied. A failed
  `setDynamicTransaction` applies no runtime members and therefore invokes no
  live effects (`settings-service.ts:604-641`). Effects run only after a
  successful settings transaction; there is no compensating rollback if a
  subsequent consumer effect throws, so this contract does not claim an
  end-to-end settings-plus-effects transaction.
- **Cancellation:** **N/A.** Settings mutations and their router calls are
  synchronous and take no `AbortSignal`; there is no pending setting mutation
  that can be cancelled or later settled as cancelled.
- **Retry:** **N/A.** The settings service and runtime-setting router perform
  no automatic retry or replay of a failed mutation/effect. A user or caller
  must issue a new change after resolving the error.
- **Ambiguous outcome:** **N/A.** These APIs return or throw in-process and
  expose no provider-style ambiguous/unknown settlement state. Persistence or
  consumer failures are not reclassified as an acknowledged-but-unknown
  setting outcome.

## 7. Observability

- `/settings <key>` prints `${key}: ${value} (${source})`
  (`settings-command.ts:272-279`); the summary lists per-key sources
  (`formatSettingsSummary`, `:32-242`).
- Startup logs count CLI/env/config override leaves without values
  (`settings-service.ts:243-249`).
- Shell execution logs the resolved `timeout` and `maxOutputLength`
  (`source/tools/system/shell.ts:860-868`).
- Diagnosis: a setting that appears in the summary with an unexpected source is
  resolved through a precedence layer other than the one intended (C4.2).

## 8. Public boundary under test

- `SettingsService.get/getSource/setDynamic/setPersistentDynamic/reset` —
  `settings-service.test.ts`.
- Schema bounds/defaults/markers — `settings-schema.test.ts`.
- Merger precedence — `settings-merger.test.ts`.
- Environment mapping — `settings-env.test.ts`.
- Persistence/sensitive stripping — `settings-persistence.test.ts`.
- Source tracking — `settings-sources.test.ts`.
- Runtime effects routing — `runtime-setting-router.test.ts`.
- `/settings` command behavior (incl. "next request" boundary wording) —
  `utils/settings-command.test.ts`.

### 8.1 C4.1 consumer and classification inventory

This is the current exhaustive inventory of the **126 values** exported by
`SETTING_KEYS` (not a second runtime registry). The canonical structured
consumer inventory is settings-owned, imported by `settings-schema.test.ts`,
and rejects missing, duplicate, or unknown keys against the runtime export.
"Live-effect router" means `ConversationConfigurationService` and
`runtime-setting-router.ts` apply an immediate in-process effect; "next
request" means the effective setting is read while creating the next model,
tool, or child run; "restart-only" means `SettingsService` persists it but
does not promise a live replacement of its already-created owner.

The canonical exhaustive inventory is
[`settings-consumer-inventory.ts`](../../source/services/settings/test-helpers/settings-consumer-inventory.ts).
Its 20 owner/classification groups distinguish the live-effect router, next
request/tool/child-run consumers, security-sensitive credentials,
presentation-only settings, and restart-only owners. The runtime owners include
workflow admission; model/request construction and run containment; provider,
mentor, compaction, shell, sandbox, non-interactive, subagent, application,
file-tool, SSH, search, memory, and hook services; plus terminal/catalog
presentation. `settings-schema.test.ts` imports and validates that module
against the runtime `SETTING_KEYS` export.

The inventory intentionally records the four different categories that a UI
listing alone cannot express: provider credentials are security-sensitive,
terminal/catalog settings are presentation-only, restart-only settings alter a
newly constructed owner, and runtime-modifiable settings apply through the
live router or at their documented next-request boundary.

## 9. Deterministic contract matrix

| ROADMAP minimum-matrix cell | Evidence (file:title) | Status |
| --- | --- | --- |
| Schema-to-consumer classification | `settings-consumer-inventory.ts`, imported by `settings-schema.test.ts` "keeps the structured Contract 04 consumer inventory complete and duplicate-free", classifies every runtime `SETTING_KEYS` export (126 values) and rejects missing, duplicate, or unknown keys | covered |
| Default value | `settings-service.test.ts:69-92` "initializes with defaults"; targeted `settings-schema.test.ts` cases for context compaction, run-budget policy, sandbox settings, workflow limits, and background timeout | covered |
| Customized value | `settings-service.test.ts:570-592` "set() modifies runtime-modifiable settings"; `:272-300` "config file overrides defaults" | covered |
| Minimum bound | `settings-schema.test.ts` cases "context compaction defaults...", "includes agent.maxParallelToolCalls...", "shell.backgroundTimeout defaults...", and "memory settings default..." exercise exact minima and reject below-minimum values | covered |
| Maximum bound | `settings-schema.test.ts` "accepts the exact maximum mentor samples and mentor pool size" accepts 8 and rejects 9; "context compaction defaults..." covers ratio endpoints | covered |
| Invalid value rejection | `settings-schema.test.ts` request-deadline, Codex-timeout, compaction, run-budget, parallel-tool, and background-timeout cases; `settings-service.test.ts:620-631` (invalid persistent setting), `:805-852` (startup rejects invalid config) | covered |
| Migrated value | `settings-service.test.ts:94-106` "migrates the former persisted request-deadline default to disabled"; `:344-498` (custom-provider migrations); `ancillary-settings-migration.ts:8-83` | covered |
| Root consumer | `agent-client.application-run-loop.test.ts:276+` "applies a changed maxParallelToolCalls setting to the next request" | covered |
| Nested (subagent) consumer | `nested-runner.test.ts` "passes the settings-backed policy to direct nested runs and activates critical tool-free wrap-up" | covered |
| Mentor consumer | `mentor-runner.test.ts` "samples the mentor N times without letting samples see each other" and "lets the pool override mentorSamples" | covered |
| Background consumer | `shell.test.ts` "background launches use shell.backgroundTimeout and truncate overflow when timeout_ms is absent" | covered |
| Workflow consumer | `agent.test.ts` "uses configured workflow limits without exposing them in tool arguments" | covered |
| Non-interactive consumer | `non-interactive.test.ts` "runNonInteractive exposes configured provider and model through its session lifecycle" | covered |
| Runtime change at request boundary | `settings-command.test.ts:176-194` "setting agent.maxParallelToolCalls reports that the new limit applies on the next request" (+ reset equivalent); root execution test `agent-client.application-run-loop.test.ts:276+` | covered |

## 10. Verification commands

Focused (recorded 2026-08-14, all green):

```sh
NODE_ENV=test pnpm test \
  source/services/settings/settings-service.test.ts \
  source/services/settings/settings-schema.test.ts \
  source/services/settings/settings-merger.test.ts \
  source/services/settings/settings-env.test.ts \
  source/services/settings/settings-persistence.test.ts \
  source/services/settings/settings-sources.test.ts \
  source/services/runtime-setting-router.test.ts \
  source/utils/settings-command.test.ts \
  source/lib/agent-client.application-run-loop.test.ts \
  source/services/subagents/nested-runner.test.ts \
  source/services/subagents/mentor-runner.test.ts \
  source/tools/system/shell.test.ts \
  source/agent.test.ts \
  source/non-interactive.test.ts
```

Result: **14 files / 303 tests passed.** This command corrects the Phase 0
baseline Seam 4 command: two of its three paths do not exist
(`settings-manager.test.ts`, `settings-store.test.ts` — the implementation is
`SettingsService`), so Vitest silently ran only 1 of 3 files. Classification:
**test defect in the baseline record, not a product defect.**

Broader gates: `NODE_ENV=test pnpm test`, `pnpm typecheck`. Setting changes
should also run the affected consumer's focused tests (e.g. run-budget tests
for `agent.runBudget.*`, shell tests for `shell.*`).

## 11. Known gaps and classification

There is no demonstrated product defect, remaining execution-path gap, or
unenforced inventory-completeness gap in this contract matrix.
