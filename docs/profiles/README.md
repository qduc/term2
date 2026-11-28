# Profile architecture and compatibility

Bare is the default experience for fresh terminal, headless, and server
sessions and the only entry in `builtinProfiles`. The CLI help, onboarding,
slash completion, and settings menus omit profile selection. Choose the model
and reasoning effort independently with `/model` and `/effort`.

## Legacy inputs and saved sessions

| Entry point | Behavior |
| --- | --- |
| Hidden `--profile bare/standard/full/lite`, `--lite`, and `-l` | Select `builtin:bare` for the launch. |
| Exact `/profile [name]`, `/bare`, and `/lite` | Acknowledge Bare for the supported aliases without changing the session or clearing history. |
| Explicit Plan, Pair, Mentor, or Orchestrator selection | Fails as an unknown profile. |
| Saved settings or sessions naming a dropped workflow | Run Bare while preserving the saved configuration and historical conversation facts. |
| Saved Standard or Lite profile IDs, or old records without a profile or enabled legacy mode | Resolve to Bare. The legacy adapter projects Bare to `liteMode: true` for older readers. |

See `chooseProfile` in [cli.ts](../../src/app/cli.ts), `acknowledgeProfile` in
[launch-tui-settings.ts](../../src/app/launch-tui-settings.ts),
`createSessionSettings` in [settings.ts](../../src/app/settings.ts), and the
[legacy adapter](../../src/config/profiles/legacy-adapter.ts). On resume, an
explicit launch choice takes precedence. Otherwise, the last recorded profile
configuration takes precedence over the session header.

`getProfileMetadata` produces the canonical ID, definition version, and digest.
CLI conversation headers and machine-readable output retain profile metadata for
compatibility and composition comparisons. The digest fingerprints the resolved
profile composition. Settings, injected project instructions, and runtime
availability can differ between sessions with the same digest.

## What Bare supplies

The [definition](../../src/config/profiles/registry.ts) loads
[bare.md](../../src/session/prompts/bare.md) as the main prompt. `buildPromptSpec`
and the [main agent factory](../../src/app/agent.ts) use the effective capabilities
to render tool guidance, then assemble the enabled project instructions, skills
catalog, and short environment line. Local project and global `AGENTS.md`
instructions are loaded on the host. Remote project instructions come from the
remote workspace. Skills are loaded through shell or through `read_file` when the
read-only surface withholds shell. A project can separately opt into
[personal memory context](../reference/personal-memory-context.md).

- When enabled, the native `read_file`, `create_file` and `search_replace` or
  `apply_patch` tools are available directly and through `run_code`. Both routes
  share the validation and approval path. The effective file and shell settings,
  workspace access, and provider editing surface determine which tools are offered.
- `run_code` exposes the configured web, memory, session, MCP, and background
  capabilities as script members. Bare lists the nonessential members by name.
  Use `tools.describe(name)` for the schema. Configured delegation uses the
  existing subagent runtime.
- Shell searches are used when `app.searchViaShell` is enabled and shell is
  available. Bare exposes shell `background` and `monitor` only when there is a
  background job registry for the current surface. An interactive root can also
  expose direct `session_rollover`, which is unavailable inside scripts.
- A root request gains `goal_check` once the session has had a goal. The actual
  completion conditions come from the [durable goal contract](../plans/agent-runtime/durable-goal.md).
  Ordinary requests without an active goal follow the ordinary stop path.

## Composition and authority

`app.activeProfileId` is the internal selection key. The
[profile schema](../../src/config/profiles/schema.ts) validates declarations.
`resolveProfile` in [resolver.ts](../../src/config/profiles/resolver.ts)
canonicalizes the ID, resolves parent and registered-block references, and merges
each block by its own rules. The result carries instructions, context, tool
capabilities, enforcement, integrations, presentation, requirements, and identity.
The resolver can take an explicit registry. The shipped launch path uses the
built-in registry.

Capability groups determine which tools the application may offer. The tools
still pass through the session's authority, sandbox, and approval checks.
Registered enforcement adds restrictions. Profile data has no authority to
weaken those checks or execute integration code.

## History

- The Profile model first replaced built-in modes in `b1ddd32a`. The
  [historical design](https://github.com/qduc/term2/tree/c455d16c56dfa1d46664c0b3183873100942bf65/docs/profiles)
  records the original parity requirements, block design, and migration plan.
- [The Lite merge](lite-bare-merge.md) records the rationale for the compact
  script surface and the request-size measurements for Bare 2.0.0. Bare 3.0.0
  restored native file tools alongside it in `317873590`. The
  [token-efficiency study](../research/bare-token-efficiency-20261024.md)
  records its tested tasks and scope.
- The [retirement decision](https://github.com/qduc/term2/issues/149) dropped
  Plan, Pair, Mentor, and Orchestrator from the direct executable. Their old
  workflow notices are skipped on retry when the saved profile differs from
  Bare. The main prompt now comes from one definition, with subagents retaining
  their own role prompts.
