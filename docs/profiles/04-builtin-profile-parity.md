# Built-in Profile parity

Milestone 1 reconstructs current production behavior. The code named below is
evidence for that migration, not the intended permanent layout.

## Shared current machinery

Current mode identity is represented by four settings normalized by
`normalizeAppModes()` and `SettingsService.normalizeExclusiveAppModes()`:

```text
app.orchestratorMode
app.liteMode
app.planMode
app.mentorMode
```

No true flag means Standard. The malformed-state precedence is Orchestrator,
Lite, Plan, then Mentor.

`buildPromptSpec()` currently keeps Plan, Mentor, and Orchestrator out of base
prompt selection. Their workflows arrive through notices created by
`runtimeModeNotice()` and `planModeNotice()`. This preserves a stable non-Lite
instruction prefix for provider prompt caching and chained Responses turns.

`getAgentDefinition()` currently owns most prompt and tool differences.
`ConversationConfigurationService.applyRuntimeSetting()` owns live mode effects.
`SavedAppMode` owns persisted legacy identity. UI components project labels from
the flags.

## `builtin:standard`

Standard is explicit in the new architecture, not an absence value.

Required parity:

- Select the model-family base prompt through the existing prompt-profile
  selection behavior.
- Include the normal non-Lite prompt fragments and configured dynamic guidance.
- Include ordinary local environment and project instructions when the current
  execution context permits them.
- Construct the normal non-Lite tool surface according to model, execution
  context, configured services, and global settings.
- Apply no additional Profile enforcement beyond global policy.
- Queue no activation workflow notice.
- Display and log the mode as Standard.

## `builtin:lite`

Lite is a structural prompt/context/tool variant rather than a notice-only
workflow.

Required parity:

- Use `lite.md` as the base prompt instead of a model-family base prompt.
- Omit the normal non-Lite approval-model, worktree-hygiene, mode-stub, and
  memory-instruction fragments selected by `buildPromptSpec()`.
- Use Lite environment rendering and skip project `AGENTS.md` ingestion in
  `getAgentDefinition()`.
- Preserve currently appended configured memory context, skill catalog, and
  session-browser behavior where `getAgentDefinition()` supplies them outside
  prompt-profile selection.
- Preserve common shell, web, memory, session, user-interaction, and local
  code-context construction when their current dependencies are available.
- Preserve Lite's separate file-tool branch, including current file-editing
  tools and outside-workspace read behavior.
- Do not register the non-Lite mentor and subagent branch.
- Queue no workflow notice merely because Lite is activated.
- Preserve current mid-session history protection for structurally incompatible
  switches.

Lite is not currently an enforced read-only mode. Milestone 1 MUST follow the
production tool construction rather than the README's older read-only wording.

## `builtin:plan`

Plan retains the Standard root prompt and tool surface, then adds workflow and
enforcement.

Required parity:

- Resolve Standard's non-Lite base prompt, context, and eligible tools.
- Queue `PLAN_MODE_ENTER_NOTICE` on activation and
  `PLAN_MODE_EXIT_NOTICE` on deactivation using the existing next-user-turn
  notice lane.
- Preserve the planning workflow currently sourced from `plan-mode-info.md`.
- Deny mutating shell commands through the policy currently checked by the shell
  tool.
- Deny file-writing tools and write-capable or unknown delegated roles through
  the policy currently installed by `installPlanModeInterceptor()`.
- Preserve Plan-specific handoff restrictions in `HandoffSession`.
- Permit read-only delegated roles currently accepted by the interceptor.
- Display, persist, resume, and log Plan identity.

The Profile enforcement contract, not a comparison against `builtin:plan`, must
eventually drive these denials. Milestone 1 may adapt existing guard
implementations behind the registered `plan-read-only` enforcement block, but
it must not weaken their current coverage or claim runtime enforcement for
stateful tool categories it does not currently intercept.

`installPlanModeInterceptor()` is an implementation mechanism of the
`plan-read-only` parity policy, not an additional block a Profile author must
remember to select.

## `builtin:mentor`

Mentor retains Standard composition and adds a prompt-guided collaboration
workflow plus specialized mentor integration behavior.

Required parity:

- Resolve Standard's non-Lite base prompt, context, and eligible tools.
- Queue the workflow currently sourced from `mentor-addon.md` on activation and
  the current Mentor exit notice on deactivation.
- Preserve `ask_mentor` exposure when a smart model or legacy mentor model and
  callback are configured.
- Preserve the secondary mentor runner's use of `subagents/mentor-mode.md` while
  the Mentor integration is active.
- Continue resolving the secondary model and provider through current global
  smart/mentor settings; the Profile does not select them.
- Remain selectable when no mentor model is configured. Current behavior simply
  lacks consultation capability; Milestone 1 must not introduce a new
  activation failure.
- Display the configured mentor model when the current UI does so.
- Display, persist, resume, and log Mentor identity.

## `builtin:orchestrator`

Orchestrator retains Standard's direct capabilities and adds a prompt-guided
delegation workflow with a strict runtime prerequisite.

Required parity:

- Resolve the same stable non-Lite instruction prefix as Standard.
- Queue the workflow currently sourced from `orchestrator.md` on activation and
  the current Orchestrator exit notice on deactivation.
- Preserve direct root tools; Orchestrator is not enforced by removing them.
- Require the complete asynchronous delegation surface currently checked by
  `getAgentDefinition()`: launch, result retrieval, status, steering, and
  cancellation.
- Preserve the single model-facing delegation tool and associated asynchronous
  controls when available.
- Fail agent construction rather than silently degrading when the required
  asynchronous delegation surface is incomplete.
- Display, persist, resume, and log Orchestrator identity.

## Built-in definitions

The logical definitions are:

```text
builtin:standard
  complete base composition

builtin:lite extends builtin:standard
  replace instructions/context/tool surface with Lite variants

builtin:plan extends builtin:standard
  replace workflow; accumulate plan-read-only enforcement

builtin:mentor extends builtin:standard
  replace workflow; add Mentor integration

builtin:orchestrator extends builtin:standard
  replace workflow; add required async-subagent integration
```

The built-in registry may use typed TypeScript definitions in Milestone 1, but
the definitions MUST be schema-validated and resolved through the general
Profile resolver. Consumers cannot receive handcrafted per-mode resolved
objects.

## Parity rule

If the implementation and this parity record disagree during Milestone 1, first
verify the live production path and its tests. Preserve confirmed current
behavior and update this record in the same change. Behavioral cleanup belongs
in a separately approved change after the migration is stable.
