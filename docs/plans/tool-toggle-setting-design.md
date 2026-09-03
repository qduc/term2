# Design: user-facing tool disable setting — Phase 1 (main-agent capability booleans)

**Status: Phase 1 (M1) implemented** on branch `tool-toggle`
(worktree `.worktrees/tool-toggle`), pending merge to main; gate results are
recorded in `REPORT-tool-toggle.md` at the worktree root. Revised 2026-09-03
against main `c975002e` after an independent review
([tool-toggle-setting-design-review.md](./tool-toggle-setting-design-review.md)).
Every finding in that review was re-verified against the tree before this
revision; the citations below reflect the verified state. The original v1
design (single array denylist, claimed subagent inheritance) is superseded.

Two design claims were corrected during implementation, per the rule that
deviations observed while implementing are recorded, not silently fixed:

1. `grep`/`glob` register **inside** the file-write branch for standard
   non-gpt5 models (`agent.ts` standard else-branch), so disabling
   `tools.fileWrite.enabled` also removes the search pair. Recorded as a
   follow-up in Acknowledged gaps #5; decoupling is not Phase 1 scope.
2. `run_subagent_async` is never registered by the composition root —
   `createRunSubagentAsyncToolDefinition` has no production caller. Async
   launches ride on `run_subagent`'s `execution` parameter, so the registered
   subagent family is `run_subagent` + `get_subagent_result` +
   `get_subagent_status` + `send_message` + `cancel_run` (+
   `configure_task_check_in`, which its OR-condition keeps alive when either
   feeding capability is still enabled).

## Problem statement

Users cannot turn off an individual tool or tool family. The main agent's tool
surface is decided entirely by the active Profile's capability groups
intersected with runtime availability (model, remote, service wiring). A user
who wants the model to stop using shell, or to run without file-edit tools,
has no lever: the closest equivalents (`app.searchViaShell`, Plan mode's
read-only enforcement, Lite mode) change much more than the tool they care
about.

**Phase 1 delivers group-level disable for the main agent only.** It
deliberately does not cover subagents and cannot split tools that share one
capability group. Both limits are explicit, acknowledged scope boundaries (see
"Acknowledged gaps"), not oversights: subagent enforcement is milestone M3, and
splitting bundled groups into per-tool toggles is milestone M2 — the next
deliverable after Phase 1.

## Current architecture (verified)

**Profile M1 is implemented and merged.** AGENTS.md line 51 still says
"Milestone 1 not implemented"; that is stale (`docs/profiles/README.md:3-7`
future tense is stale too). `getAgentDefinition` resolves and consumes a
`ResolvedProfile` today.

### Main-agent tool construction

- `source/agent.ts:301-322` — `resolveActiveProfile(settingsService, …)` runs
  at every agent build; a `ProfileResolutionError` for the missing
  async-subagent integration is remapped to the orchestrator prerequisite
  message.
- `source/agent.ts:324-325` — `profile.tools.capabilities` is read into
  `hasCapability`. This closure drives most registrations and all prompt
  flags, **but it is not the only reader**: three raw `capabilities.has(…)`
  reads bypass it — `mentor` at `agent.ts:548`, `subagents` at `agent.ts:554`
  and `agent.ts:571`. Any enforcement design must route those through the
  same effective set or disabled `mentor`/`subagents` would drop prompt
  guidance while leaving the tools registered.
- `source/agent.ts:339-354` — the closure's flags gate prompt construction via
  `buildPromptSpec` (`runSubagentEnabled`, `memoryEnabled`,
  `sessionBrowserEnabled`, `backgroundShellEnabled`, …). Tools and their
  explanatory prompt fragments move together — but only for checks that go
  through the closure.
- `source/agent.ts:406-591` — registration sites: shell (:407), web (:408-419,
  registering `web_search` **and** `web_fetch` under the single `web`
  capability), task check-in (:421-427), background shell (:429-437),
  worktree (:441-450), memory/sessions/rollover/skills (:452-459), ask_user
  (:461-467), code-context (:469-474), lite/full file tools (:476-544),
  mentor (:547-550), foreground + async subagent tools (:554-581), workflow
  (:583-591). Model- and context-conditional decisions live here too:
  `searchViaShell` suppresses grep/glob (:280-282, :378), `isGpt5` swaps
  `apply_patch` for `create_file`+`search_replace` (:499-543), remote kills
  code-context (:285) and worktree (:441).
- Capability vocabulary: 13 fixed groups in
  `source/services/profiles/registry.ts:30-44`. Lite excludes `mentor` and
  `subagents` (`registry.ts:71-75`).
- The resolver flattens a ToolsBlock's `include`/`exclude`
  (`source/services/profiles/types.ts:54-59`) into the capability set
  (`source/services/profiles/resolver.ts:330-341`); unknown capability strings
  are **fatal** diagnostics (`resolver.ts:334-338`, fatal filter
  `resolver.ts:717-722`). `ResolvedToolSurface` exposes only `capabilities`
  (`types.ts:181-183`). In production source, the only non-resolver reader of
  `ResolvedProfile.tools.capabilities` is `agent.ts:324` (grep-verified);
  transition, notice, and enforcement consumers read other blocks.
- `filesystem-read-external` has **no independent construction effect**: its
  only consumer is the OR at `agent.ts:326`
  (`filesystemReadEnabled = …workspace… || …external…`). Lite's
  outside-workspace read authority is keyed to the `liteMode` branch, which
  passes `allowOutsideWorkspace: true` regardless of that capability
  (`agent.ts:476-498`); the standard branch never grants outside-workspace
  access from capabilities at all (:513-544). A standalone external-read
  toggle would be a no-op control.
- Every tool definition carries a stable runtime `name`
  (`source/tools/types.ts:98-103,160-163`), but only a subset is centralized
  (`source/tools/tool-names.ts`) and there is no name→definition registry; the
  group→tool mapping is intentionally variable by model/context
  (`docs/profiles/02-block-contracts.md:130-133`).
- Plan mode enforcement is a separate invocation-time layer (denials handled
  by `source/services/plan-mode-interceptor.ts:31-52`), not part of tool
  registration.
- Existing precedent for settings that gate individual tools:
  `enable_agent_workflow` directly gates the `run_agent_workflow` tool
  (`settings-schema.ts:778`, `agent.ts:583-590`), and `app.searchViaShell`
  removes grep/glob from the surface (`agent.ts:280-282,375-378`). There is no
  *general* user-facing tool/capability allowlist or denylist (grep verified).

### Subagent tool construction (the part the main-agent path does not reach)

- Subagents are built by a separate `SubagentToolFactory`
  (`source/services/subagents/runtime.ts:63-106`), not by
  `getAgentDefinition`/`buildAgent`. Execution runs build tools from it at
  `source/services/subagents/execution-runner.ts:178-203`; nested runs at
  `source/services/subagents/nested-runner.ts:238-262`.
- Tool selection gates on role booleans — `definition.canRead`,
  `definition.canSearchWeb`, `definition.canRunShell`, filesystem/network
  scopes — in `source/services/subagents/tool-policy.ts:805-945`. Nothing in
  this path reads `profile.tools.capabilities`. **A capability masked for the
  main agent remains fully usable inside any subagent.**
- Settings already reach the factory (it holds `deps.settings`, and
  `resolveSubagentSearchViaShell(this.#settings, …)` is consulted per role,
  `execution-runner.ts:176`, `nested-runner.ts:249`), and the rebuild path
  clears the subagent caches (`source/lib/agent-client.ts:639-645`,
  `onConfigChanged` → `subagentBridge.clearCache()`), so a later enforcement
  milestone has both the data and the invalidation hook it needs.

### Settings and runtime plumbing

- Section schema `ToolsSettingsSchema`
  (`source/services/settings/settings-schema.ts:409-418`), `SETTING_KEYS`
  (:777-912), `RUNTIME_MODIFIABLE_SETTINGS` (:915-1026), `SettingsWithSources`
  (:734-739). Nested-boolean precedent: `agent.backgroundCheckIn.enabled`,
  `agent.sessionRollover.enabled` (:648-656).
- Runtime writes validate the full candidate settings object
  (`settings-service.ts:585-610,757-784`). Failure handling is layered:
  a syntactically corrupt file is quarantined (`settings-service.ts:214-238`),
  but a syntactically valid file with a Zod-invalid value keeps its valid
  sections while invalid sections fall back to defaults via `mergeSettings`,
  and the file is left unchanged for the user to fix
  (`settings-persistence.ts:215-237`). So a too-strict enum on a tools key
  would not quarantine the file — it would silently revert the whole `tools`
  section to defaults on load.
- `/settings` Enter routes through `ConversationConfigurationService.apply`
  (`source/services/runtime-setting-router.ts:39-81`) →
  `applyRuntimeSettingChange` (:95-166). Keys with a branch rebuild or
  reconfigure live (e.g. `agent.transport`, :132-135). Keys without a branch
  persist but change nothing until the next agent build. A rebuild is
  `buildAgent` → `getAgentDefinition` (`source/lib/agent-factory.ts:391-450`)
  via `AgentConfiguration.rebuildAgent`
  (`source/lib/agent-configuration.ts:263-276`), reachable through
  `ConversationService.setModel` (`conversation-service.ts:317`); the rebuilt
  agent serves the next model request. A running agent is never mutated
  (`agent-configuration.ts:199-210`).
- Profile switches mid-session are classified noop / structural /
  notice-only / agent-rebuild
  (`source/services/profiles/profile-transition.ts:50-68`) and commit notices
  + rebuilds (:135-157).
- **Mode notices are a single overwrite slot, not a queue**:
  `queueModeNotice(text)` assigns one string
  (`source/services/session/session-manager.ts:166-168`), consumed and cleared
  at next-request preparation
  (`source/services/session/initial-input-preparer.ts:36-42,76-79`). Profile
  transitions write the same slot (`profile-transition.ts:156`). Two
  notifications before the next request overwrite each other.
- Settings UI is a key→value flow: key list
  (`source/components/menu/SettingsSelectionMenu.tsx`), Enter opens the value
  menu (`SettingsValueMenuSession.tsx:30-41,94-112`), which picks `runtime`
  vs `restart` persistence via `isRuntimeModifiable` and replaces the whole
  setting with the single selected/typed value. Boolean settings already have
  a complete editing pattern: the value menu suggests `true`/`false` from the
  Zod schema (`source/utils/value-suggestions.ts:237-239,264-267`), typed or
  selected text parses to a boolean (`source/utils/settings-command.ts:54-55`),
  and the intent applies it. Scalar replace semantics are harmless for
  booleans and hazardous for arrays (a suggestion would overwrite the entire
  array — the defect that killed the v1 array design).
- No deferred/ToolSearch tool loading exists in the main agent;
  `tool_search_call` appears only as provider wire-protocol item types
  (`providers/luna-responses-lite-wire-protocol.ts:25`,
  `providers/codex-responses-model.ts:650`). The tool array is fully
  materialized per build, so a masked capability makes the tool genuinely
  absent from the wire request.
- Spec context: `Profile-visible ∩ runtime-available ∩ effective authority`
  (`docs/profiles/02-block-contracts.md:145-153`); M1 slice 4 kept
  "model, execution-context, service-availability, and global-setting
  decisions" at tool construction (`docs/profiles/06-milestone-1.md:68-75`).

## Design decisions

### 1. Granularity: per-capability boolean settings (12 keys)

**Recommendation:** one boolean per capability group, nested under `tools`:

| Setting key | Masks capability group(s) |
| --- | --- |
| `tools.shell.enabled` | `shell` |
| `tools.web.enabled` | `web` |
| `tools.fileRead.enabled` | `filesystem-read-workspace` **and** `filesystem-read-external` (combined — see below) |
| `tools.fileWrite.enabled` | `filesystem-write` |
| `tools.memory.enabled` | `memory` |
| `tools.sessions.enabled` | `sessions` |
| `tools.skills.enabled` | `skills` |
| `tools.mentor.enabled` | `mentor` |
| `tools.subagents.enabled` | `subagents` |
| `tools.backgroundTasks.enabled` | `background-tasks` |
| `tools.userInteraction.enabled` | `user-interaction` |
| `tools.codeContext.enabled` | `code-context` |

All default `true` (denylist semantics: default = exactly the
Profile-determined surface). The nested shape follows
`agent.backgroundCheckIn.enabled`; it leaves room for M2 to add finer keys
under the same groups without a schema migration.

Why booleans:

- The settings menu's boolean editing pattern is complete and safe today —
  `true`/`false` suggestions derived from the schema, scalar replace, full
  runtime persistence routing (citations above). Each key is independent, so
  toggling one group can never re-enable another. This eliminates the v1
  array design's silent-overwrite defect by construction.
- The value vocabulary becomes compile-time constants instead of user-typed
  strings. The v1 warn-and-drop normalization concern disappears: there is no
  free-text capability name to mistype, and the fatal unknown-capability path
  in the resolver is unreachable from settings. Unknown keys written by a
  newer binary are simply ignored by the older schema on load.
- Per-key wiring cost is real but bounded and precedented:
  `enable_agent_workflow` and `app.searchViaShell` already gate individual
  tool families through the same touchpoint set.

Why `filesystem-read-external` is **not** independently toggleable: it has no
construction effect of its own today. Its only consumer ORs it into
`filesystemReadEnabled` (`agent.ts:326`), and Lite's outside-workspace
authority comes from the `liteMode` branch, not from any capability
(`agent.ts:476-498`). An advertised standalone toggle would be a silent no-op
in Lite. Phase 1 therefore folds both read capabilities behind
`tools.fileRead.enabled` (masking either string disables all file-read tools
in both standard and lite). The limitation this leaves — no way to express
"workspace reads only" — is documented under Acknowledged gaps, and
re-deriving outside-workspace eligibility from the effective external-read
capability is the prerequisite for ever splitting this key.

Rejected — one `tools.disabledCapabilities: string[]` denylist (v1): the
generic value menu replaces the whole setting with one selected/typed value
(`SettingsValueMenuSession.tsx:30-41,94-112`), so a suggestion pick would
overwrite the entire array, silently re-enabling every previously disabled
group; safe editing would require a read-modify-write editor in M1, which is
the UI work this scope explicitly avoids.

Rejected — 13 booleans including a standalone
`filesystem-read-external.enabled`: ships a control that cannot do what its
name promises (no-op in Lite).

Rejected — allowlist semantics (`tools.*.enabled` reversed as "groups to
keep"): the `enabled` key with default `true` already gives per-group opt-out;
an allowlist interpretation of the same keys would fight Profile inheritance
and make "forgetting" a group silently remove tools.

### 2. Enforcement: one effective capability set in the main agent — a Phase 1 correctness requirement

**Recommendation:** `getAgentDefinition` computes a single post-resolution
effective set and *every* downstream check reads it:

```ts
const disabled = resolveDisabledCapabilities(settingsService); // settings → masked group strings
const effectiveCapabilities = new Set([...capabilities].filter((c) => !disabled.has(c)));
const hasCapability = (c: string): boolean => effectiveCapabilities.has(c);
```

and the three raw reads are converted to the closure: `agent.ts:548`
(`capabilities.has('mentor')` → `hasCapability('mentor')`), `agent.ts:554` and
`agent.ts:571` (`capabilities.has('subagents')` → `hasCapability(...)`). After
that conversion, every tool registration and every prompt flag derives from
the same set, so a masked group is both unregistered *and* undescribed — the
prompt/tool coherence noted in the architecture section holds for all 13
groups. `resolveDisabledCapabilities` is a small pure module (settings read →
masked-string set) so M3 can import the identical mapping for subagents.

This is not polish; it is what makes Phase 1 true. With the raw reads left in
place, disabling `mentor` or `subagents` drops the explanatory prompt
fragments (they go through the closure) while leaving the tools registered
(they do not) — the model keeps a tool it was told was removed, which is the
exact failure class this setting exists to prevent. The M1 test pass must
include a table-driven case over all 13 capabilities asserting: masking each
group removes every tool whose registration consults it, flips its
`buildPromptSpec` flags (fragment co-removal), and leaves every other group's
tools intact. Log the effective mask at debug level at build time.

The mask stays post-resolution, in agent construction — the boundary the
review confirmed as sound. The spec fixes the intersection order
`Profile-visible ∩ runtime-available ∩ effective authority`
(`02-block-contracts.md:145-153`), M1 slice 4 deliberately kept global-setting
decisions at construction (`06-milestone-1.md:68-75`), and
`agent.ts:324` is the only non-resolver reader of the capability set, so one
local fold reaches everything.

Rejected — resolver injection (v1 rationale, unchanged and review-endorsed):
divergent resolved profiles across consumers (transition planning, notices,
enforcement cache in `source/services/profiles/active-profile.ts:18-36`);
`availableCapabilities` filtering runs before requirement evaluation
(`resolver.ts:563-577`) so a user preference could turn into a fatal
`ProfileResolutionError` at agent build (:589-594, :717-722); user toggles
would churn `identity.digest` (`resolver.ts:90-106`). Tradeoff: two places to
look when debugging "why is this tool missing" (profile capabilities, then the
mask) — accepted, mitigated by the debug log and by keeping the mapping in one
importable function.

Because booleans carry no free-text vocabulary, the v1 warn-and-drop
normalization section is dropped. Corrected persistence facts for the
implementer: a schema-invalid `tools` section does not quarantine the file —
valid sections survive, the invalid section reverts to defaults, and the file
is left untouched (`settings-persistence.ts:215-237`); quarantine is reserved
for recovered syntactic corruption (`settings-service.ts:214-238`). Tests
should encode the first behavior, not the second.

### 3. Mode interaction: allow, then warn — with a complete dependency map and composed delivery

The mask is post-resolution, so it cannot break resolution: the orchestrator's
required integration (`builtin:integration/async-subagents`,
`registry.ts:167-175`) is checked against callback availability
(`agent.ts:288-320`), not capabilities, and `classifyProfileTransition` never
sees the mask. But mode workflow text is profile-owned and not capability-
gated, so disabling a group a mode's text references orphans those mentions.

**Recommendation:** accept the change; queue a warning notice at apply time
naming the active profile and the degraded groups. The dependency map must be
complete over the built-ins:

| Active profile | Load-bearing groups | Evidence |
| --- | --- | --- |
| `builtin:orchestrator` | `subagents` | `orchestrator.md:23` instructs `run_subagent` delegation |
| `builtin:mentor` | `mentor` | mentor workflow addon; `ask_mentor` gated at `agent.ts:547-550` |
| `builtin:lite` | `shell`, `filesystem-read-workspace`, `filesystem-write`, `web` | `lite.md:11-19` names `Shell`, `read_file`, `apply_patch`, `create_file`, `search_replace`, `web_search`, `web_fetch` |
| `builtin:standard` (and plan, which inherits its identity) | `filesystem-write`, `subagents` | model-family base prompts name `apply_patch` (e.g. `gpt-5.6.md:26`) and `run_subagent` (e.g. `gpt-5.6.md:34`, `kimi.md:11`) |
| non-builtin ids | any disabling change | conservative until custom Profiles carry dependency metadata (open question) |

Delivery must compose, not overwrite. `queueModeNotice` is a single-string
assignment (`session-manager.ts:166-168`) shared with profile transitions
(`profile-transition.ts:156`), and a pending notice is consumed and cleared at
the next request preparation (`initial-input-preparer.ts:76-79`). A profile
switch immediately followed by a capability toggle — or several toggles —
before the next model request would silently drop all but the last warning.
Phase 1 therefore includes a minimal composing change: make the notice writer
append to any pending notice (e.g. `pendingModeNotice = existing ?
`${existing}\n\n${text}` : text` inside `session-manager`, or an accumulating
`string[]` consumed as a joined block — either is small; the v1 single-write
contract is the thing that must not survive). Tests must cover: capability
toggle after a profile switch before the next turn (composed), reverse order,
and two toggles in one apply batch.

Rejected — reject the setting when a mode depends on the group: needs a
maintained enforcement-grade dependency table and would block the primary use
case ("temporarily remove shell under plan-like discipline").
Rejected — silent override: the setting would lie about the effective surface
and orphaned-prompt failures would be undiagnosable.

No prompt-level "these tools are disabled" acknowledgement: absent tools are
not advertised, and enumerating removed tools spends context to re-invite
them. The setting description and the warning notice carry the caveat.

Non-conflicts, recorded so implementers don't "fix" them: Plan-mode
enforcement is an invocation-time denial layer (`plan-mode-interceptor.ts:31-52`)
and composes with a masked surface; disabling `shell` does not remove
background-shell control tools (gated by `background-tasks` + registry,
`agent.ts:429-437`) — correct, since jobs launched before the toggle still
need get/cancel; masking `memory` also drops memory context and guidance
because `agent.ts:350` derives `memoryEnabled` from the closure;
`run-agent-workflow`'s `parentTools` snapshot (`agent.ts:587`) automatically
reflects the mask.

### 4. Mid-session behavior: runtime-modifiable, effective next request

Add all twelve keys to `RUNTIME_MODIFIABLE_SETTINGS`
(`settings-schema.ts:915`) and add one `applyRuntimeSettingChange` branch that
rebuilds the agent — the pattern `agent.transport` already uses
(`runtime-setting-router.ts:132-135`):
`deps.setModel(deps.settingsService.get('agent.model'))`. The rebuild reruns
`getAgentDefinition`, which re-reads the booleans; the rebuilt agent serves
the next model request. No restart. A turn in flight finishes with the tool
array it started with (no live mutation of a built agent,
`agent-configuration.ts:199-210`).

Cost note: the tool array is part of the request prefix, so the next request
after a toggle pays at least one prompt-cache invalidation. Do not promise
"exactly one miss" as a cross-provider invariant; the app already accepts this
class of discontinuity for mode switches and model changes, and the toggle is
user-initiated.

Rejected — startup-only: "disable shell for this session" is a primary use
case, and runtime per-tool controls (`app.searchViaShell`,
`enable_agent_workflow`) are already the norm.

### 5. UI shape: the existing boolean value-menu pattern, unchanged

Each key is a plain boolean and uses exactly the flow every other boolean
setting uses today: Enter on the key opens the value menu with schema-derived
`true`/`false` suggestions (`value-suggestions.ts:237-239,264-267`), selection
or typed `true`/`false` parses to a boolean (`settings-command.ts:54-55`), and
the apply intent routes runtime persistence via `isRuntimeModifiable`
(`SettingsValueMenuSession.tsx:94-112`). No new menu component, no array
editing, no suggestions table entries needed (the schema supplies the
suggestions). Descriptions come from the Zod `.describe()` text via the
existing completion config. Phase 1 ships no custom editor; if a per-group
ON/OFF overview menu is ever wanted, it is additive polish after M2, not a
dependency.

### 6. Scope boundary: main agent only in Phase 1

Phase 1 enforcement covers the tool array and prompt flags built by
`getAgentDefinition`. It does not touch `SubagentToolFactory`, the Plan-mode
interceptor (composes fine; separate layer), or the enforcement cache (reads
the enforcement block, not tools). The setting description must say plainly:
"applies to the main agent; subagents are not restricted until a later
milestone." See Acknowledged gaps.

## Acknowledged gaps (Phase 1 is not feature-complete)

1. **Subagents bypass the mask.** Subagent tools are selected by role
   booleans in `SubagentToolFactory` (`tool-policy.ts:805-945`), which never
   consults capabilities. Until M3 lands, a capability disabled for the main
   agent remains fully usable by any subagent the model delegates to — the
   model can route around the toggle. This is the accepted cost of the narrow
   Phase 1; M2 and M3 may be swapped if that interim risk is judged
   unacceptable.
2. **Bundled groups cannot be split.** The motivating example — disable
   `web_search`, keep `web_fetch` — is not expressible: both register under
   the single `web` capability (`agent.ts:408-419`). The same bundling applies
   to `sessions` (browser tools + rollover, `agent.ts:453-455`), `memory`
   (six-plus tools via `MemoryCapabilityBuilder`, `agent.ts:452`), and the
   subagent family (`run_subagent` + four async controls + workflow,
   `agent.ts:554-591`). Splitting these into individually toggleable tools is
   M2, the next deliverable.
3. **File reads are one combined toggle, and Lite cannot express
   workspace-only reads.** `tools.fileRead.enabled` masks both read
   capabilities because `filesystem-read-external` has no independent
   construction effect (`agent.ts:326`) and Lite's outside-workspace access is
   keyed to `liteMode`, not a capability (`agent.ts:476-498`). With
   `tools.fileRead.enabled = true`, Lite still reads outside the workspace and
   no setting can prevent that in Phase 1. Fixing this requires re-deriving
   outside-workspace eligibility from the effective external-read capability —
   a construction change, not a settings change, and deliberately out of
   Phase 1.
4. **`app.searchViaShell` and `enable_agent_workflow` remain separate
   levers.** They already control tool availability by other means and are not
   unified with the capability booleans in Phase 1.
5. **`grep`/`glob` registration is coupled to the write branch (found during
   implementation).** For standard non-gpt5 models the search pair registers
   inside `if (filesystemWriteEnabled)` in `agent.ts`, so
   `tools.fileWrite.enabled = false` removes `create_file`/`search_replace`
   *and* `grep`/`glob`; conversely `tools.fileRead.enabled = false` removes
   them via the nested read condition. The enforced behavior is pinned by the
   table-driven test with an explanatory comment. Follow-up: move search
   registration out of the write branch so search depends only on the read
   toggle; that is a registration-shape change, deliberately not Phase 1.

## Milestones

**M1 (Phase 1) — main-agent capability booleans, enforced everywhere in the
main agent.** One reviewable unit:

- Schema: twelve `tools.<group>.enabled` booleans (default `true`) with
  `.describe()` copy that states the main-agent scope and next-request
  semantics; full setting-wiring (`SETTING_KEYS`, `DEFAULT_SETTINGS`,
  `SettingsWithSources`, `SETTING_DESCRIPTIONS`, `CATEGORY_KEYS.tools`,
  `RUNTIME_MODIFIABLE_SETTINGS`, `formatSettingsSummary`).
- Enforcement: `resolveDisabledCapabilities` mapping + effective set in
  `getAgentDefinition`; convert the three raw `capabilities.has` reads
  (`agent.ts:548,554,571`); debug-log the effective mask.
- Runtime: one `applyRuntimeSettingChange` branch triggering an agent rebuild.
- Warnings: built-in dependency map (orchestrator/mentor/lite/standard rows
  above) + notice-composition change so warnings append rather than overwrite.
- Tests: table-driven over all 12 toggles (tools removed, prompt markers
  flipped, others untouched — 13 capability strings, since `tools.fileRead`
  masks both read capabilities); router rebuild branch; schema round-trip;
  settings-completion visibility; warning composition (batch, single-toggle,
  no-op cases, and workflow-profile switch + toggle); Lite cases (`fileRead`
  off removes lite file tools; lite still reads outside workspace with
  `fileRead` on — documented behavior, asserted so it cannot regress
  silently). Two expectations were corrected during implementation (see the
  status header).
- Gates: focused settings tests, full suite, and the provider black-box suite
  (agent construction feeds the run loop and non-interactive mode —
  `provider-testing` skill).
- Docs: AGENTS.md WIP line fix (stale "M1 not implemented" — done) and this
  doc's status header (done). No settings docs exist to update; CHANGELOG is
  maintained by release chores only (`git log -- CHANGELOG.md`), so no entry
  was added, matching the profile-M1 precedent.

**M2 (Phase 2) — split bundled capabilities into individually toggleable
tools.** The stated next deliverable. Scope: a term2-owned registry mapping
stable tool names to groups (handling the model-conditional substitutions,
`agent.ts:499-543`); per-tool enable keys under the existing sections (e.g.
`tools.web.search.enabled`, `tools.web.fetch.enabled`), AND-composed with the
group master so `tools.web.enabled = false` still removes both; prompt
fragment updates where tools are named (`lite.md:14-19`, model-family
prompts); the same table-driven test pattern per tool. Deserves its own short
design pass for the registry's ownership before implementation.

**M3 — subagent enforcement (deferred, sketched).** Intersect the masked set
with role permissions inside `SubagentToolFactory.buildToolDefinitions`: the
factory already holds `deps.settings` (`runtime.ts:63-74`), so it can call the
same `resolveDisabledCapabilities` and filter `definition.canRead` /
`canSearchWeb` / `canRunShell` / write-scope selections (decide the rule —
recommended: a masked group removes the role's eligibility for that group's
tools, e.g. `canSearchWeb && !masked.has('web')`). Invalidation is already
wired: the rebuild path clears subagent caches via
`agent-client.ts:639-645`. Test matrix: each role × each masked group, plus
the mentor runner path and worktree-pinned nested runs
(`nested-runner.ts:238-262`). Ordering note: M3 is placed after M2 per the
agreed Phase 2 priority; the swap is cheap if the interim delegation risk
(gap 1) is judged unacceptable.

## Open questions

1. **M2 key composition.** When a group splits, do `tools.<group>.enabled`
   masters persist as AND-ed switches, or are they migrated to per-tool keys?
   Recommendation: persist as masters (no migration; denylist semantics
   preserved); decide at M2 design.
2. **Workspace-only reads.** Re-deriving outside-workspace eligibility from
   the effective `filesystem-read-external` capability would make Lite's
   outside-workspace access capability-controlled for the first time — a
   behavior change to Lite that needs its own parity characterization before
   any split of `tools.fileRead.enabled`.
3. **Custom Profiles.** The M1 warning map covers built-ins. When user
   Profile discovery lands, Profiles should declare which capability groups
   their workflow text depends on so the warning is data-driven. Non-builtin
   ids keep the conservative warn-on-any-disable until then.
4. **Per-project scoping.** Settings are global (XDG `settings.json`); "disable
   shell only in this repo" is not expressible and needs a settings-layer
   feature, not this setting.
5. **Resumed sessions.** A conversation saved with tool calls for a now-masked
   tool replays those items as history. Confirm during M1 that replay tolerates
   historical tool items whose tools are absent from the current request
   (OpenAI-style transports generally do; Codex Responses unverified) with one
   replay test.
6. **Docs hygiene.** `docs/profiles/README.md:3-7` still describes M1 in
   future tense; fix alongside the AGENTS.md line in the M1 docs pass.
