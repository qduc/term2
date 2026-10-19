# Bounded agent assembly delivery

Not an acceptance of the broader codex/agent-assembly-migration branch. That branch stays unmerged. This change is only the web-tool and skill-activation factories from the bounded plan.

## What landed

`createWebToolDefinitions` is the only production construction of `web_search` and `web_fetch`. `createSelectedActivateSkillTool` is the only production construction of `activate_skill`, and it still returns nothing for an empty catalog. `FeatureSelection` records the caller's existing decision. It does not grant a capability, and child network wrappers stay in `SubagentToolPolicy`.

No container, catalog, blueprint, internal hook, or new dependency was added. `ApplicationRunLoop` and `ToolCallExecution` were not edited.

## Evidence

Command: `pnpm exec tsx tmp-bounded-features.mts` (removed after the run). `pnpm typecheck` passed.

Root order stays shell, then `web_search`, then `web_fetch`. Descriptions match the shared factory. `activate_skill` stays after the web tools when a non-empty catalog is present. `tools.web.enabled: false` omits web tools. `tools.skills.enabled: false` omits `activate_skill`. An empty catalog does not build the skill tool.

An explorer with `networkScope: ['example.com']` still gets the finite-host fetch denial and the wildcard search denial. A worker, an explorer with `canSearchWeb: false`, and a mentor do not gain web tools. A script-generic explorer does not keep `activate_skill`.

## Not shown

No interactive or non-interactive product session. The run loop and provider path were not modified, and the provider black-box suite was not rerun.
