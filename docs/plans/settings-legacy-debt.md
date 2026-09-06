# Settings legacy debt: drift guards, dead scaffolding, and surface consolidation

## Resume here

**Status: completed (2026-09-06). Milestones M0 through M4 implemented and merged.**

Planning baseline: `2fb39cb60177a829c673eb278801d2fb6cbb456d`, inspected 2026-09-06.

Survey context: this document records the verified legacy surface of the settings
subsystem and a staged, decision-gated removal program. It is the follow-on the
menu-system-redesign plan's non-goal reserved ("do not change settings domain
behavior" / "do not rewrite menu presentation while changing ownership" - both
owners are settled now). The string/free-form value-entry UX pain is deliberately
NOT in scope; it is owned by a separate plan (`docs/plans/settings-field-editor.md`
not yet written).

Two claims in the 2026-09-06 survey conversation were corrected while writing this
document and are recorded correctly here: the legacy role-keyed model settings and
the four `app.*Mode` flags are excluded from the interactive menu via
`HIDDEN_SETTINGS` (they are not visible toggles), and the menu's models category
already shows only the tier generation. The legacy vocabulary survives in the
schema, the typed-trigger routing, the runtime fallback chains, and the text
`/settings` summary - not in the menu.

Ordering: M0 and M1 are small, mechanical, and independent of product decisions;
M2 is gated on a consumer inventory (M2a) and four decisions (D1-D4); M3 and M4
depend on M0's guards. Each milestone lands in its own worktree per AGENTS.md
parallel-work isolation and records merge SHAs and measured baselines here as it
lands.

## Evidence (survey, 2026-09-06)

### E1 - The registry is a set of hand-maintained cross-references of one schema

`settings-schema.ts` is the single source of truth (Zod), but the UI surfaces
duplicate its knowledge by hand:

- The `setting-wiring` skill documents **six mandatory touchpoints** per new
  setting: `SETTING_KEYS`, `DEFAULT_SETTINGS`, `SettingsWithSources`,
  `SETTING_DESCRIPTIONS`, `CATEGORY_KEYS`, `RUNTIME_MODIFIABLE_SETTINGS` - plus up
  to four optional ones (`HIDDEN_SETTINGS`, `COMMON_SETTINGS`, the
  `formatSettingsSummary` entries list, a `runtime-setting-router` branch). The
  skill names "forgetting one of the six" as the most common mistake.
- Registry litter is already observable: several keys appear in both
  `CATEGORY_KEYS` and `HIDDEN_SETTINGS` (e.g. `AGENT_MENTOR_MODEL` is in the
  models category set and in `HIDDEN_SETTINGS`; `SANDBOX_ALLOW_READ_EXTRA` is in
  the safety set and in `HIDDEN_SETTINGS`). `buildSettingsList` in
  `settings-completion-logic.ts` filters `HIDDEN_SETTINGS` before category lookup,
  so the category entries are dead; their presence is drift, not behavior.
- Description copy exists twice: on the Zod fields (`.describe(...)`) and again by
  hand in `SETTING_DESCRIPTIONS`. The two have already diverged in wording (see
  the `favoriteModels` / `modelNicknames` entries on each side).

### E2 - Two generations of model-key vocabulary coexist; the menu migrated, the rest did not

Verified split at baseline:

- The interactive menu already shows the tier generation only. Tier *providers*
  (`agent.smartProvider` / `balanced` / `cheap` / `chore`) and the entire legacy
  role-keyed generation (`agent.efficientModel`, `agent.capableModel`,
  `agent.mentorModel` + `mentorProvider` + `mentorReasoningEffort`,
  `agent.autoApproveModel` + `autoApproveProvider`, the three `subagent*` triples,
  `tools.editHealingModel` + `editHealingProvider`) are in `HIDDEN_SETTINGS`.
- The legacy generation is still first-class everywhere below the menu: schema
  fields, `SETTING_KEYS`, `SettingsWithSources`, `MODEL_SETTING_CONFIGS`
  (`model-settings.ts` - its own comment: "Legacy triggers remain recognized for
  settings files and commands created before tier consolidation"), and runtime
  read paths as tier-first fallbacks, e.g. `get('agent.smartModel') ??
  get('agent.mentorModel')` in `source/agent.ts`, `get('agent.choreModel') ??
  get('agent.autoApproveModel')` in `shell-auto-approval-evaluator.ts` and
  `non-interactive-approval-policy.ts`, `get('agent.choreModel') ??
  get('tools.editHealingModel')` in `search-replace.ts` / `apply-patch.ts`.
- `migrateLegacyAncillarySettings` in `ancillary-settings-migration.ts` merges
  legacy role keys into tier keys at **startup only** (capable+mentor to smart,
  worker to balanced, efficient+explorer+librarian to cheap, autoApprove+
  editHealing to chore), without overwriting tier values already present.
- The text `/settings` summary surface (`formatSettingsSummary` in
  `settings-command.ts`) prints the **legacy** generation (`AGENT_EFFICIENT_MODEL`,
  `AGENT_CAPABLE_MODEL`, `AGENT_MENTOR_MODEL` / `MENTOR_PROVIDER` /
  `MENTOR_REASONING_EFFORT` / `MENTOR_SAMPLES`, ...) and omits every tier key.
  The two user surfaces disagree on the primary vocabulary.
- `subagentResearcherModel/Provider/ReasoningEffort` are a third, parse-only
  generation: deprecated in the schema ("folded into explorer... Retained so
  persisted configs still parse"), absent from `SETTING_KEYS` and the UI config.

### E3 - The `app.*Mode` flags are compatibility-only fields with a write adapter

- `app.mentorMode/liteMode/planMode/orchestratorMode` remain in the schema as
  "Legacy compatibility fields accepted at boundaries; `activeProfileId` is the
  canonical profile selection", and in `HIDDEN_SETTINGS` (not user-visible).
- Every write to them is remapped to `app.activeProfileId` by
  `profileIdFromLegacyModeSetting` (`legacy-adapter.ts`) through
  `canonicalProfileSetting` (`settings-command.ts`) and
  `ConversationConfigurationService.apply` (`runtime-setting-router.ts`), which
  additionally runs profile-transition planning on the resulting profile change.
- Ownership: the profile-architecture workstream (`docs/profiles/README.md`, M1
  merged) is the natural owner of flag retirement. This plan should not touch the
  flags except to note them; see D2.

### E4 - Dead scaffolding shipped in production

- `package.json` pins `zod ^4.1.13`, yet `value-suggestions.ts` `suggestFromEnum`
  still carries the Zod v3 shape branch (`def.values` vs `def.entries`) and
  `isSettingType` / `autoSuggestFromSchema` poke `(schema as any)._def`.
  `use-settings-value-completion.ts` and `setting-schema-utils.ts` share the
  untyped-reflection pattern.
- `triggers.ts` still registers `command-model` and `direct-setting-value` rules
  gated behind the `enabledRuleIds` allowlist with comments "Disabled until Step 2
  enables...". Per `menu-system-redesign.md`, Step 2 never ran.
- `use-settings-value-completion.ts` carries a legacy `open()` initializer, a
  `settingKey` local state, a `triggerIndex` "compatibility projection for legacy
  callers", and a `mode === 'settings_value_completion'` branch - paths for the
  pre-controller completion graphs, kept after Phase 5 removed the legacy popup
  wiring.

### E5 - Curated provider pick-lists are pasted, duplicated, and stale

- `VALUE_SUGGESTIONS_BY_KEY` in `value-suggestions.ts` contains the same six-entry
  provider list (openai, openrouter, openai-compatible, anthropic, google, codex)
  under at least seven keys (`agent.mentorProvider`, the three `subagent*Provider`
  keys, `agent.autoApproveProvider`, `tools.editHealingProvider`, `agent.provider`).
- The provider registry has since grown first-class `grok` (`grok.provider.ts`,
  `OAUTH_ACCOUNT_PROVIDERS = ['codex', 'grok']` in `oauth-accounts.ts`) and the
  deepseek/openai-compatible routes - none of which appear in the suggestion
  lists. A hand-pasted list that must track the registry rots by construction.

### E6 - Behavioral costs (owned by other plans)

- Free-form string entry friction and the completion-DNA chrome ("Filter:", empty
  picker states) - owned by the future `settings-field-editor` plan.
- `parseSettingValue` coercion of numeric/boolean-looking strings before schema
  validation - same plan.
- `isSecretSetting` key-name regex `/(^|\.)apiKey$/` instead of schema metadata -
  folded into M3 here.

## Goals

1. Stop the drift class: registry/schema cross-checks as tests (M0).
2. Delete dead scaffolding that carries migration history (M1).
3. Finish the vocabulary migration the menu already did, for the surfaces that
   still speak legacy: typed triggers, text summary, fallback chains, schema
   fields - under an explicit deprecation decision (M2).
4. Collapse the per-key hand registries onto schema-derived metadata (M3).
5. Derive provider suggestions from the provider registry (M4).

## Non-goals

- No change to value-entry UX (field editor plan).
- No change to the settings.json file format beyond additive, already-shipped
  migration mechanics (M2's removal window may add a one-way cleanup).
- No provider-architecture change (M4 only reads the registry).
- No profile-architecture work (D2).
- No runtime-setting-router redesign; M3 only replaces hand metadata, not the
  side-effect chain's semantics.

## Decisions needed before M2 implementation (D1-D4)

- **D1 - legacy role-key end state.** Options: (a) remove after a deprecation
  window once no runtime fallback reads them (recommended - the fallback chains in
  E2 become removable one expression at a time); (b) keep parse-only forever; (c)
  keep as documented fallbacks indefinitely. Recommendation (a) with the window
  sized by the migration table in `ancillary-settings-migration.ts`.
- **D2 - `app.*Mode` flags.** Leave to the profile workstream (recommended - this
  plan only records them; removing the fields early would break persisted
  settings files and the adapter round-trip).
- **D3 - metadata derivation shape.** A companion typed module built from the
  schema (`type`, enum values, `.describe()` text, secret annotation, runtime-
  modifiable) validated by M0's tests (recommended), vs. code generation of
  `SETTING_KEYS` (rejected: adds a build step; the validation-test approach
  catches drift without one).
- **D4 - text summary vocabulary.** Switch `formatSettingsSummary` entries to the
  tier-primary keys the menu shows (recommended), or to the tier key plus its
  legacy fallback for display.

## Milestones

### M0 - Registry/schema consistency guards (small, first)

New test module under `source/services/settings/` (name proposal:
`registry-consistency.test.ts`) asserting, at baseline HEAD and thereafter:

- every `SETTING_KEYS` value resolves to a schema path (and the reverse: every
  schema path that `SettingsWithSources` declares has a key);
- every key in `SETTING_DESCRIPTIONS`, `CATEGORY_KEYS`, `COMMON_SETTINGS`,
  `HIDDEN_SETTINGS`, `RUNTIME_MODIFIABLE_SETTINGS` is a `SETTING_KEYS` member;
- no key appears in both `CATEGORY_KEYS` and `HIDDEN_SETTINGS` (E1 litter) - or
  the test carries an explicit, commented tolerance list of keys whose dual
  membership is intentional, which must shrink, not grow;
- every `MODEL_SETTING_CONFIGS` model/provider key and every
  `formatSettingsSummary` entry key is a `SETTING_KEYS` member.

Acceptance: green on main; each assertion demonstrated red against a seeded
defect first (the repo's testing skill requires the red observation). No behavior
change. This is the safety net M3's collapse and M2's removal build on, so it
lands before both.

### M1 - Remove dead scaffolding

Gated on a consumer grep proving each deletion is safe; delete code, not intent:

- (a) Zod v3 branches and `as any` `_def` reflection in `value-suggestions.ts`,
  `setting-schema-utils.ts`, `use-settings-value-completion.ts`; replace with the
  v4-only path and typed access where cheap. `suggestFromEnum` behavior is pinned
  by existing suggestion tests.
- (b) The `command-model` and `direct-setting-value` trigger rules in
  `triggers.ts` and any now-unused `enabledRuleIds` plumbing, if grep shows no
  production caller enables them.
- (c) The legacy hook projections in `use-settings-value-completion.ts` (`open()`,
  `settingKey` state, `triggerIndex` projection, the `mode ===
  'settings_value_completion'` branch) only if grep shows no caller outside the
  hook; record before/after test counts (repo norm for removal milestones).

Acceptance: typecheck green; focused suites green; removed-code coverage
disappears with the code; no pinned test regressed.

### M2 - Finish the vocabulary migration (decision-gated)

#### M2a - Consumer inventory and decision record (no behavior change)

Extend the existing `test-helpers/settings-consumer-inventory.ts` to enumerate,
per legacy and tier key, every production read site (the E2 list is partial).
Record which fallback chains exist, whether any consumer still reads a legacy key
as primary, and the migration table's overwrite semantics. Answer D1 and D4 in a
decision record appended to this document before any code changes.

#### M2b - Repoint or strip, one chain at a time

For each legacy key still read at runtime: either promote its tier key to sole
reader (if the legacy value can only arrive via pre-tier settings files, the
startup migration in E2 already copied it) or keep the fallback and schedule its
removal. Each expression is one commit-sized unit with its own test.

#### M2c - Remove the legacy generation from non-menu surfaces

- `MODEL_SETTING_CONFIGS`: drop legacy entries (typed `/settings agent.mentorModel`
  etc. then resolve through the tier key or fail with a pointer to the tier key).
- `formatSettingsSummary` (D4): print tier-primary keys.
- `SETTING_KEYS` / `SettingsWithSources` / schema: per D1's window. Schema fields
  removed last, after `ancillary-settings-migration.ts` and the deprecated-field
  parser notes are updated.
- `CATEGORY_KEYS` / `HIDDEN_SETTINGS` / `SETTING_DESCRIPTIONS`: delete entries for
  keys removed from `SETTING_KEYS` so M0's guards pass.

#### M2d - Deprecated-field cleanup

`subagentResearcherModel/Provider/ReasoningEffort`: fold removal into the same
window as the researcher-role retirement note in the schema, keeping one release
of parse-only warning before dropping.

### M3 - Schema-derived per-key metadata

Add a typed companion (proposal: `settings-ui-metadata.ts` under
`services/settings/`) that derives from the schema: value type, enum members,
`.describe()` text, secret annotation (replacing the `apiKey$` regex, E6),
runtime-modifiable flag (from `RUNTIME_MODIFIABLE_SETTINGS` until that set itself
is replaced by schema annotation). Consumers migrate one at a time:
`settings-completion-config.ts` (descriptions), `value-suggestions.ts` (schema
types/enums), `use-settings-value-completion.ts` (`isStringSetting` etc.),
`settings-command.ts` (parse decisions). M0's guards run throughout. Measure and
record the before/after touchpoint count for adding one setting (the skill's
checklist is the baseline).

### M4 - Provider suggestions from the registry

Replace the seven pasted provider lists in `VALUE_SUGGESTIONS_BY_KEY` with a list
derived from the provider registry (built-ins plus `OAUTH_ACCOUNT_PROVIDERS`);
keep a small optional description map for curated entries. Add a test asserting
the suggestion set contains the current registry providers (fails when the
registry gains a provider the suggestions omit).

## Worktree and sequencing

Per AGENTS.md: each milestone in its own worktree under `.worktrees/` (never a
sibling), branched from local HEAD - local `main` is ahead of `origin/main`, and
`worktree.baseRef` defaults to `fresh`, so branch from the local checkout state.
M0 and M1 are independent and may run in parallel worktrees; M2 needs M0 merged;
M3 and M4 need M0 merged (M3 additionally benefits from M1's reflection cleanup).
M2a is read-only and may run before D1-D4 are answered.

## Verification

- Focused (per milestone): `pnpm test` on the settings schema/registry tests,
  `settings-completion-logic.test.ts`, `SettingsSelectionMenu.test.tsx`,
  `SettingsValueMenuSession.test.tsx`, `value-suggestions` tests,
  `settings-command.test.ts`, `model-settings.test.ts`.
- `pnpm typecheck` after every milestone.
- Removal milestones (M1, M2c, M2d) additionally record before/after test counts
  and any full-suite gate per the AGENTS.md test-execution policy: full-suite runs
  need explicit finite shell timeouts and are recorded with elapsed time and
  terminal result separately; a narrowed rerun does not close a full-suite gate.
- Every documented command above is run before it is recorded; nothing in this
  document claims a run that did not happen.

## Related plans

- `docs/plans/menu-system-redesign.md` - the ownership work this plan builds on.
- `docs/plans/exclusive-menu-input.md` - input-ownership boundary (unchanged).
- `docs/profiles/README.md` - owns `app.*Mode` retirement (D2).
- `docs/plans/settings-field-editor.md` - not yet written; owns value-entry UX.

## Decision Record (M2a - 2026-09-06)

### D1 - Legacy role-key end state
**Decision: Option (a) — Remove runtime fallback chains, migrate non-menu surfaces, and schedule schema field retirement.**
- **Rationale**: `migrateLegacyAncillarySettings` already runs at startup to copy legacy role settings (`agent.capableModel`, `agent.mentorModel`, `agent.subagentWorkerModel`, `agent.subagentExplorerModel`, `agent.subagentLibrarianModel`, `agent.autoApproveModel`, `tools.editHealingModel`, etc.) into tier keys without overwriting tier values already present.
- Consumers at runtime do not need secondary `?? settings.get('legacyKey')` fallback expressions once startup migration has completed.
- Removing secondary read expressions allows promoting tier keys as sole readers, reducing divergence between the interactive menu and underlying runtime.
- Deprecation window: Schema definitions and parser acceptance remain active for one deprecation window so pre-tier persisted settings files continue to parse and migrate seamlessly.

### D4 - Text summary vocabulary
**Decision: Switch `formatSettingsSummary` entries to tier-primary keys.**
- **Rationale**: The interactive menu migrated to display tier models (`agent.smartModel`, `agent.balancedModel`, `agent.cheapModel`, `agent.choreModel`). The `/settings` text slash-command summary previously still printed legacy keys (`AGENT_EFFICIENT_MODEL`, `AGENT_CAPABLE_MODEL`, `AGENT_MENTOR_MODEL`) while omitting every tier key.
- Aligning `formatSettingsSummary` with tier-primary keys establishes consistent vocabulary across all user-facing surfaces.

## Implementation Record: Milestone 3 (2026-09-06)

### Schema-derived UI metadata & Touchpoint Count
- Added `source/services/settings/settings-ui-metadata.ts` companion module deriving value type, enum options, `.describe()` text, secret status (`.meta({ secret: true })`), and runtime-modifiability.
- Migrated consumers:
  - `source/hooks/settings-completion-config.ts`: replaced manual 170-line `SETTING_DESCRIPTIONS` dictionary with `getAllSettingDescriptions()`.
  - `source/utils/value-suggestions.ts`: replaced hand Zod reflection in `autoSuggestFromSchema`, `isSettingType` with `settings-ui-metadata.ts`.
  - `source/hooks/use-settings-value-completion.ts`: uses `isNumberSetting`, `isSecretSetting`, `isStringSetting` from `settings-ui-metadata.ts`.
  - `source/utils/settings-command.ts`: uses `isArraySetting` from `settings-ui-metadata.ts` for array parse decisions.
- **Touchpoint count for adding a setting**:
  - **Before M3**: 6 mandatory touchpoints (`SETTING_KEYS`, `DEFAULT_SETTINGS`, `SettingsWithSources`, `SETTING_DESCRIPTIONS`, `CATEGORY_KEYS`, `RUNTIME_MODIFIABLE_SETTINGS`).
  - **After M3**: 5 mandatory touchpoints (`SETTING_DESCRIPTIONS` eliminated as a manual touchpoint — descriptions are now defined directly on the Zod schema field via `.describe(...)` in `settings-schema.ts`).

## Implementation Record: Milestone 4 (2026-09-06)

### Dynamic Provider Suggestions & Registry Synchronization
- Replaced 7 duplicated/pasted provider suggestion arrays in `VALUE_SUGGESTIONS_BY_KEY` (`agent.mentorProvider`, `agent.subagentExplorerProvider`, `agent.subagentWorkerProvider`, `agent.subagentLibrarianProvider`, `agent.autoApproveProvider`, `tools.editHealingProvider`, `agent.provider`) with `buildProviderSuggestions()`.
- Provider suggestions are dynamically assembled from:
  - Registered providers in `getProviderIds()` (and their labels via `getProvider()`)
  - Active OAuth account providers in `OAUTH_ACCOUNT_PROVIDERS` (ensuring `grok`, which was omitted in the legacy lists, is included)
  - Custom provider types in `KNOWN_CUSTOM_PROVIDER_TYPES`
  - Curated human-friendly descriptions for standard providers
- Generalized provider setting detection via `isProviderSettingKey(key)` covering `agent.provider` and any `*Provider` key.
- Added tests in `source/utils/value-suggestions.test.ts` verifying:
  - All registered provider IDs appear in `buildSettingValueSuggestions('agent.provider')`.
  - All OAuth provider IDs appear in suggestions.
  - Dynamically registered providers (`upsertProvider`) immediately appear in suggestions without code modifications.

## Review record (2026-09-06, after agy completion)

Reviewed by coordinator against the plan and the D1/D4 decision record after agy
reported completion (watcher-settled at `452fe71b`, all milestones merged:
M0 `c1e4e745`, M1 `0fe06310`, M2 `f55e1bf6`, M3 `a4f39f45`, M4 `40085863`).

**Gate compliance**: M2 appended the D1/D4 decision record to this document in the
same commit as the code changes (ahead-of-code record not separately visible, but
the record exists and matches option (a)/D4 recommendations). Worktree isolation,
per-milestone merges, and worktree/branch cleanup were all followed.

**Validation actually run** (2026-09-06): `pnpm exec cross-env NODE_ENV=test
vitest run` over 16 settings/input/approval test files: 285 passed, 1 skipped,
0 failed (registry-consistency, settings-ui-metadata, settings-schema,
settings-completion-logic, use-settings-completion, settings-command,
value-suggestions, model-settings, non-interactive-approval-policy,
shell-auto-approval-evaluator, openai-agent-client.public-methods,
SettingsValueMenuSession, SettingsMenuSession, ModelMenuSession, SlashMenuSession).
`pnpm exec tsc --noEmit`: zero errors in settings-touched files; the only 15
errors are pre-existing dirty-file noise from other lanes
(`source/tools/system/run-code/run-code.test.ts`,
`source/services/conversation/conversation-service.test.ts`). Full suite not run.

**Findings** (no blockers; follow-ups recommended):

1. **M2 removed chore-tier and mentor-gate fallbacks but left the smart/cheap
   legacy chains live** — `model-resolver.ts` `resolveAncillaryModelTier` /
   `resolveRelativePolicy` still read `agent.capableModel` → `agent.mentorModel`
   (smart) and `agent.efficientModel` → `agent.subagentExplorerModel` (cheap)
   via `resolveLegacyTierModel` after the tier key. This contradicts the M2a D1
   record ("promoting tier keys as sole readers"); combined with the still-live
   legacy write paths (`runtime-setting-router.ts` mentor branches,
   `agent-configuration.ts` legacy whitelist, schema/SETTING_KEYS acceptance),
   a runtime write to a legacy key still steers smart/cheap ancillary resolution
   while the mentor tool gate ignores it — the divergence class M2 targeted.
   Follow-up: delete `resolveLegacyTierModel`/`legacyTierModelSettingKeys` for
   smart/cheap or repoint to tier-only reads once the deprecation window closes.
2. **`tools.editHealingProvider` override reads remain** in `edit-healing.ts`,
   `patch-healing.ts`, and `search-replace.ts` (deps.providerId ??
   editHealingProvider ?? agent.provider ?? 'openai') even though the apply-patch /
   search-replace call sites were cleaned in M2. Resolve consistently with D1.
3. **M3 single-sourced descriptions only partially** — `.describe()`-first is
   real, but `FALLBACK_SETTING_DESCRIPTIONS` in `settings-ui-metadata.ts` is the
   old SETTING_DESCRIPTIONS dictionary relocated, not eliminated; two description
   sources still disagree on drift. The "6→5 touchpoints" claim overstates: adding
   a setting still requires describe-or-fallback text. Also a visible copy
   regression: for keys with schema `.describe` (e.g. `agent.favoriteModels`,
   `agent.modelNicknames`) the richer old UI copy is shadowed and the "(edit via
   ctrl+f / ctrl+n in the model picker…)" affordance hints no longer display.
4. **M0 was not test-only**: `84996f98` also completed and exported
   `SETTINGS_SOURCE_KEYS` in `settings-sources.ts` (+47) to satisfy the new
   reverse guard. Legitimate drift repair, but a silent production change under a
   `test()` commit — worth a code comment noting intent.
5. **Plan premise corrected**: this document's M1 premise that the
   `command-model` / `direct-setting-value` trigger rules are disabled was
   wrong — `ApplicationInputSurface.tsx` enables both in its allowlist. agy
   correctly kept them (comment-only correction); the plan's "remove disabled
   rules" gate did not fire. AGENTS.md completed-bullet wording ("removal of ...
   disabled trigger rules") should be corrected to match.
6. Minor: `formatSettingsSummary` now omits `agent.mentorSamples` /
   `agent.mentorPool` (mentorSamples remains a visible menu setting); and
   unrelated commits `efda45f5`/`3303a149` (background-move wording) rode main
   inside the review window — not part of this plan, no action.

Verdict: plan goals substantially met and green on the focused gates; findings 1–2
are the D1 follow-up (remove the remaining smart/cheap and healing-provider legacy
reads) and should be tracked as the deprecation-window closure work.



