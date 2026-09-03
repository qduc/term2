# Review: user-facing tool disable setting

**Verdict:** Needs revision before implementation. The post-resolution boundary and warn-and-drop validation choice are sound, and Profile Milestone 1 is live, but M1 has enforcement bypasses that would leave disabled capabilities executable. It also does not deliver the individual-tool control used to motivate the setting.

## Findings

### High - The proposed mask does not apply to subagent tool surfaces

- **Claim:** Does not hold. The design says the mask applies to subagents because they use the same factory and Profile (`tool-toggle-setting-design.md:329-338`).
- **Actual code checked:** The main agent is built through `buildAgent()` -> `getAgentDefinition()` at `source/lib/agent-factory.ts:391-450`. Subagents use a separate `SubagentToolFactory` created at `source/services/subagents/runtime.ts:64-106`. Execution runs build tools from it at `source/services/subagents/execution-runner.ts:178-203`; nested runs do the same at `source/services/subagents/nested-runner.ts:238-257`. Their tools are selected from role booleans such as `canRead`, `canSearchWeb`, `canRunShell`, and `canWrite` at `source/services/subagents/tool-policy.ts:813-940`. None of these paths calls `getAgentDefinition()` or reads `profile.tools.capabilities`.
- **Why it matters:** Disabling `web`, `shell`, or `filesystem-write` would affect only the parent. A subsequently launched subagent could still use the disabled surface. That contradicts the promise that nothing in the session tree may web-search and creates false confidence around a safety/control setting.
- **Smallest correction:** Intersect the shared disabled set with role permissions in `SubagentToolFactory`, or filter its completed tool list through one shared effective-tool policy. The rebuild path clears the nested role cache at `source/lib/agent-client.ts:639-645`, so newly built subagents can pick up the setting. Otherwise explicitly scope M1 to the parent and delete the inheritance claim.

### High - Changing `hasCapability` is not a complete main-agent enforcement point

- **Claim:** Does not hold as written. The design calls the local closure the enforcement point and proposes changing only it (`tool-toggle-setting-design.md:28-30,116-119,163-165`).
- **Actual code checked:** `hasCapability` is declared at `source/agent.ts:324-325` and drives prompt flags at `source/agent.ts:339-354`. Most registrations use it, but `ask_mentor` checks raw `capabilities.has("mentor")` at `source/agent.ts:546-550`. `run_subagent` and async controls check raw `capabilities.has("subagents")` at `source/agent.ts:552-581`.
- **Why it matters:** Disabling `mentor` or `subagents` would remove prompt guidance while leaving the tools registered. The saved setting would appear to work but would not prevent invocation.
- **Smallest correction:** Build one effective post-resolution capability set and require every downstream check to use it. Remove raw set reads from tool construction and add a table-driven test over all 13 capabilities. This preserves the sound post-resolution boundary without injecting the preference into the resolver.

### High - `filesystem-read-external` is not independently enforceable today

- **Claim:** The 13-value denylist overstates the granularity the current construction seam can enforce.
- **Actual code checked:** The vocabulary distinguishes workspace and external read at `source/services/profiles/registry.ts:30-44`, and the contract says external read makes outside-workspace tools eligible at `docs/profiles/02-block-contracts.md:109-137`. Agent construction collapses both into one OR-ed flag at `source/agent.ts:324-327`. In Lite, read, grep, and find get outside-workspace access based on `liteMode`, not the external-read capability, at `source/agent.ts:476-497`.
- **Why it matters:** In Lite, disabling only `filesystem-read-external` leaves outside-workspace reads available. One advertised toggle is therefore a no-op for the authority distinction its name expresses.
- **Smallest correction:** Derive outside-workspace eligibility from the effective external-read capability, or omit that value from M1 and state that M1 can disable only all file reads together. Test Lite with external disabled and workspace read enabled.

### Medium - Capability-only granularity does not satisfy the motivating individual-tool use case

- **Claim:** Capability-level control is architecturally coherent, but treating individual-tool control as a later refinement is a real scope reduction.
- **Actual code checked:** Every definition has a stable runtime `name` at `source/tools/types.ts:98-103,160-163`, although only a subset is centralized at `source/tools/tool-names.ts:1-13`. The single `web` capability registers both `web_search` and `web_fetch` at `source/agent.ts:408-419`. The setting cannot express the design example of stopping search while retaining fetch. Similar bundling exists for sessions, memory, and subagent execution/control.
- **Why it matters:** The proposal says it addresses an individual tool or family and specifically names stopping `web_search`. The proposed setting cannot perform that use case.
- **Smallest correction:** Decide the product boundary before implementation. Capability-only M1 is acceptable only if requirements, UI copy, and tests are explicitly narrowed to tool-group disabling. If individual tools remain required, add a stable tool-name denylist/registry overlay in M1 or split capabilities such as search and fetch.

### Medium - M1 suggestions cannot correctly edit a multi-value denylist

- **Claim:** Does not hold. Thirteen curated scalar suggestions do not make a `string[]` setting safely editable through the generic menu.
- **Actual code checked:** Accepting a value chooses one suggestion, parses its one string, and submits it as the entire setting at `source/components/input/SettingsValueMenuSession.tsx:30-41,94-110`. `parseSettingValue()` returns a string unless the text is a complete JSON array/object at `source/utils/settings-command.ts:51-71`. Suggestions are a flat scalar list at `source/utils/value-suggestions.ts:4-7,309-317`. Arrays are merely displayed as JSON at `source/hooks/use-settings-completion.ts:24-35`.
- **Why it matters:** A bare `web` suggestion fails `z.array(z.string())`. A singleton JSON suggestion such as `["web"]` validates but replaces the whole denylist, re-enabling every previously disabled group. Users still must type the complete JSON array, so M1 does not provide the claimed typo-resistant toggle UX.
- **Smallest correction:** Put a read-modify-write ON/OFF editor in M1. If UI work must be deferred, remove the misleading suggestions, describe M1 as manual JSON configuration, and do not call the interactive toggle complete until M2.

### Medium - The warning design has a stale map and a lossy delivery channel

- **Claim:** Allow-with-warning is reasonable for current built-ins, but the proposed implementation cannot reliably deliver all needed warnings.
- **Actual code checked:** Lite names `Shell` plus file and web tools at `source/prompts/lite.md:11-19`, while the proposed Lite dependency map omits `shell`. A pending notice is one string assignment, not a queue, at `source/services/session/session-manager.ts:160-168`; it is consumed at `source/services/session/initial-input-preparer.ts:36-40,76-79`. Profile transitions use the same slot at `source/services/profiles/profile-transition.ts:135-156`.
- **Why it matters:** Disabling shell in Lite leaves prompt/tool inconsistency without warning. Multiple profile/settings changes before the next request can overwrite rather than compose warnings.
- **Smallest correction:** Add at least Lite -> `shell`, and aggregate capability conflicts with any pending mode notice or use an accumulating notice API. Test a profile switch plus a capability change before the next turn.

### Low - No per-tool toggle exists is too absolute

- **Claim:** Only the narrower claim that no general allowlist/denylist exists holds.
- **Actual code checked:** `enable_agent_workflow` is a setting key at `source/services/settings/settings-schema.ts:777-779` and directly gates the single `run_agent_workflow` tool at `source/agent.ts:583-590`. `app.searchViaShell` also changes individual search-tool availability at `source/agent.ts:280-282,375-378`.
- **Why it matters:** Existing tool-specific settings are relevant precedent for runtime rebuild behavior and weaken the argument that capability groups are the only viable user vocabulary.
- **Smallest correction:** Say that no general user-facing tool/capability denylist exists, while a few feature settings incidentally control particular tools.

### Low - The strict-validation failure description is inaccurate

- **Claim:** Warn-and-drop is still sound, but schema-invalid values do not all trigger whole-file quarantine.
- **Actual code checked:** Runtime writes validate the full candidate at `source/services/settings/settings-service.ts:585-610,757-784`. Recoverable syntax corruption is quarantined at `source/services/settings/settings-service.ts:214-238`. A syntactically valid file with a Zod-invalid value instead retains valid top-level sections and defaults the invalid section without quarantine at `source/services/settings/settings-persistence.ts:215-237`.
- **Why it matters:** The proposed string-array plus read-time intersection remains better for version skew, but tests would otherwise encode the wrong recovery behavior.
- **Smallest correction:** Say a strict enum can invalidate the `tools` section and make it fall back to defaults; reserve quarantine for recovered syntactic corruption.

## Claims that hold

- **Profile Milestone 1 is merged and live.** `resolveActiveProfile()` delegates to the typed resolver at `source/services/profiles/active-profile.ts:9-16`; `getAgentDefinition()` resolves it at `source/agent.ts:301-325`; and the production factory consumes it at `source/lib/agent-factory.ts:391-450`. Resolved capabilities are materialized at `source/services/profiles/resolver.ts:554-638`, with fatal diagnostics handled at `source/services/profiles/resolver.ts:717-723`. `AGENTS.md:51` is stale. The future-tense wording at `docs/profiles/README.md:3-7` is stale too.
- **There are exactly 13 built-in capability groups.** They are listed at `source/services/profiles/registry.ts:30-44`. Unknown Profile capability strings are diagnosed at `source/services/profiles/resolver.ts:330-341` and become fatal at `source/services/profiles/resolver.ts:717-722`.
- **Post-resolution masking is the safer architecture boundary.** The contract places runtime availability after Profile resolution at `docs/profiles/02-block-contracts.md:145-153`. In production source, the only non-resolver reader of `ResolvedProfile.tools.capabilities` is `source/agent.ts:324`; transition, notice, and enforcement consumers use other blocks. Keeping this preference out of Profile identity/digest is sound. The correction is to centralize and propagate the effective set, not to inject the preference into the resolver.
- **The Orchestrator hard failure is not triggered by this post-resolution mask.** It checks availability of all async callbacks at `source/agent.ts:288-320`, corresponding to the required integration at `source/services/profiles/registry.ts:167-175`. The mask does not alter that map. Plan enforcement is a separate invocation-time layer at `source/services/plan-mode-interceptor.ts:31-52`. For current built-ins, accepting an explicit disable with a reliable warning is preferable to silent override or hard rejection.
- **Next-request runtime application is viable.** The router already rebuilds for live definition changes at `source/services/runtime-setting-router.ts:132-151`, and `AgentConfiguration.rebuildAgent()` replaces the built agent at `source/lib/agent-configuration.ts:263-276`. The in-flight agent is not mutated (`source/lib/agent-configuration.ts:199-210`). A user-triggered cache discontinuity is proportionate, but the design should not promise exactly one cache miss as a cross-provider invariant.

## Milestone assessment

M1 is under-scoped, not overbuilt. Schema, normalization, rebuild, main-agent masking, subagent enforcement, warning composition, and a usable read-modify-write UI form one contract: when a capability is shown as OFF, it is absent everywhere in the promised scope. Deferring the dedicated editor while calling the scalar suggestion flow a toggle splits that contract at the wrong boundary. M2 is proportionate only for polish after a functional multi-value editor exists; it should not contain the first UI that can safely compose more than one disabled capability.
