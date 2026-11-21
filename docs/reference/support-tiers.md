# Support tiers

Term2 has more features than one maintainer can hold to the same standard. This
document lists the user-visible ones and assigns each a tier, so that the
verification effort, the release gate and the deprecation rules have something
to refer to. A feature without a row has no promise attached to it.

The list was swept from the code at commit `b275968`. Item names were checked
against the registries named under [Keeping this current](#keeping-this-current).
The Reason column is a tiering judgement; where it states behaviour (for example
"off unless a setting is changed"), that came from the sweep and was not
re-verified row by row, so the implementation wins on any disagreement.

## What each tier promises

| Tier | Promise | Consequence |
| --- | --- | --- |
| Core | Works in every release. | A known break blocks the release. Every core item has at least one automated check. Removal or a behaviour change goes through deprecation. |
| Supported | Meant to work; fixed when found broken. | Does not block a release. Removal goes through deprecation. |
| Experimental | May break or change without notice. | No check required. May be removed in any release. Never on by default. |
| Compatibility | Kept only so older saved data or callers keep working. | No new behaviour. Each has a stated condition for removal. |

Why four and not two: the gap between "must never break" and "may break" is
where most of the feature list sits, and treating all of it as core is what made
the list unmanageable. Compatibility is separate from Experimental because its
items are stable and depended on by old conversation logs; they are not unfinished.

## Surfaces and launch modes

| Item | Reached by | Tier | Reason |
| --- | --- | --- | --- |
| Interactive TUI | `term2` | Core | The primary surface. |
| Headless run | `term2 "<prompt>"`, `--json`, `-q`, `--show-reasoning` | Core | Scripts and the release smoke check depend on it. |
| Help and version | `-h`, `-v` | Core | First thing a broken install is asked. |
| Model, provider and effort flags | `-m`, `-p`, `-r` | Core | Needed to start any session on a chosen model. |
| Approval flags | `--auto-approve`, `--approval-mode`, `--show-review` | Core | They change what runs without a person. |
| Resume and fork | `-R`/`--resume [id\|last\|ls]`, `--fork` | Core (resume), Supported (fork) | Losing access to a saved conversation is the worst non-safety failure. |
| Goal flags | `--goal`, `--goal-criteria` | Supported | |
| Model listing | `--list-models`, `--refresh` | Supported | |
| Provider login | `--codex-login`, `--grok-login` | Same tier as its provider | A provider without its login is unusable. |
| Sandbox network grants | `term2 sandbox-network allow\|revoke`, `listen allow\|revoke` | Supported | |
| ACP agent, protocol v1 | `term2 acp` | Supported | |
| ACP agent, protocol v2 | `term2 acp` (negotiated) | Experimental | `src/clients/acp/README.md` calls it experimental. |
| Remote SSH session | `--ssh`, `--remote-dir`, `--ssh-port`, `ssh.*` | Supported | Has its own contract, `docs/contracts/06-ssh-transport-lifecycle.md`. |
| Control socket and control CLI | `--control-socket`, `term2 control ...`, `/bridge` | Experimental | |
| Discord bridge | `term2 discord`, `--discord-input`, tool `discord_send` | Experimental | Depends on a third-party service and a bot token. |
| Gateway server | `term2 serve` with socket, TLS, pairing and assertion auth | Experimental | Its only client in this repository is the prototype web client. |
| Web client | `web-client/` | Experimental | `web-client/SOURCE.md` calls it a prototype. |
| Coordinator deployment files | `deployment/coord-startup/` | Experimental | Its README says it installs nothing. |

## TUI commands and input

| Item | Reached by | Tier | Reason |
| --- | --- | --- | --- |
| Interrupt and exit | Ctrl+C, Esc | Core | The only way to stop a turn that is going wrong. |
| Queue and steer while a turn runs | submit during a turn, Meta+Enter | Core | Submitted text must not be lost. |
| Model and effort pickers | `/model` (Ctrl+O), `/effort` (Ctrl+T) | Core | |
| Settings editor | `/settings`, `/settings reset` | Core | |
| Approval mode switch | `/auto-approve` | Core | |
| New conversation, resume picker | `/clear`, `/resume` | Core | |
| Help and quit | `/help`, `/quit` | Core | |
| Slash menu, `@` path completion, `!` shell | `/`, `@`, `!` | Supported | |
| Provider manager | `/providers` | Supported | |
| Rewind and retry | `/rewind`, `/undo`, `/retry [turn\|tool]`, `/retry-turn`, `/retry-tool` | Supported | |
| Compact, copy, usage | `/compact`, `/copy`, `/usage` | Supported | |
| Goal | `/goal` | Supported | |
| Skills | `/skills` | Supported | |
| Handoff to another model | `/handoff` | Supported | |
| Restart | `/restart [stop]` | Supported | |
| Task manager and budget panel | Ctrl+G, Ctrl+B | Supported | |
| Picker keys | Tab, arrows, Ctrl+F, Ctrl+N, Ctrl+R, Ctrl+D | Supported | |
| Themes | `ui.theme` | Core (`auto`, `dark`, `light`), Supported (`high-contrast`, `mono`) | An unreadable default is a broken TUI. |
| Skins | `ui.skin` | Core (`classic`), Supported (`rail`, `cards`, `ledger`, `zen`) | `classic` is the default. |
| Desktop notifications | `app.notifications*` | Supported | Depends on terminal support. |
| First-run setup, home-directory guard | automatic | Supported | |
| Typed-only commands | `/sandbox`, `/mcp`, `/mcp-login`, `/profile`, `/bare`, `/lite` | Supported (`/mcp`, `/mcp-login`, `/sandbox`), Compatibility (`/profile`, `/bare`, `/lite`) | Absent from `/help`. One built-in profile remains, so the profile commands select nothing new. |

## Models and providers

Every built-in provider and every custom provider type is Core, by the
maintainer's decision. The release gate therefore spans every wire protocol in
this table, not a chosen subset. A preset in `provider-presets.json` is only a
name and a URL for one of the custom types, so it takes that type's tier; what
needs a check is each protocol, not each of the 25 presets.

| Item | Reached by | Tier | Reason |
| --- | --- | --- | --- |
| Codex | provider `codex` | Core | |
| OpenRouter | provider `openrouter` | Core | Also the source of the vendored catalogue. |
| OpenAI | provider `openai` | Core | |
| Grok | provider `grok` | Core | Its upstream proxy rejects outdated client versions, so it can break without a Term2 change. |
| Custom type `openai-compatible` | `providers[]` | Core | Covers most presets. |
| Custom type `openai` | `providers[]` | Core | |
| Custom type `anthropic` | `providers[]`, presets `anthropic`, `minimax` | Core | |
| Custom type `google` | `providers[]`, preset `gemini` | Core | |
| Custom type `opencode` | `providers[]` | Core | Picks a wire protocol from the model id, so one type covers several protocols. |
| Custom type `llama.cpp` and local presets | `providers[]`, presets `llama-cpp`, `ollama`, `lm-studio`, `vllm` | Core | Behaviour depends on a locally installed server version, which a recorded fixture cannot track. |
| Other presets | the remaining preset ids | Core, as the custom type they use | |
| HTTP transport for OpenAI and Codex | `agent.transport` = `http` | Supported | A transport option, not a provider. |
| Grok chat-completions lane | env `TERM2_GROK_API=chat` | Experimental | An emergency switch. |
| Model selection syntax | `provider/id:effort` | Core | |
| Reasoning effort | `-r`, `/effort`, `agent.reasoningEffort` | Core | |
| Retries and stream timeouts | `agent.retryAttempts`, `agent.maxModelStreamIdleMs`, `agent.codex.websocket*TimeoutMs` | Core | A hung or looping request blocks every other feature. |
| Prompt caching | automatic | Supported | A break costs money, not correctness. |
| Image input | attachments | Supported | |
| Helper model tiers | `agent.smartModel`, `agent.balancedModel`, `agent.cheapModel`, `agent.choreModel` | Supported | |
| Account store and switching | `/providers` | Supported | |
| Credential import from vendor CLIs | `CODEX_HOME`, `GROK_HOME` | Supported | |
| Usage and cost report, quota windows | `/usage`, footer | Supported | |
| Cache-preserving effort changes | `agent.cachePreservingEffort` | Experimental | |
| Flex service tier | `agent.useFlexServiceTier` | Experimental | |

Recorded wire fixtures under `scripts/provider-black-box/fixtures/` exist for
`openai`, `openrouter`, `google` and `opencode`. There is none for `codex`,
`grok` or `anthropic`, so the Core tier for those three is a promise the fixture
set does not yet back.

## Tools, approvals and delegation

| Item | Reached by | Tier | Reason |
| --- | --- | --- | --- |
| Shell | tool `shell` | Core | |
| File reading and search | `read_file`, `grep`, `glob` | Core | |
| File editing | `apply_patch`, `create_file`, `search_replace` | Core | |
| Approval mode `off` | `shell.autoApproveMode` | Core | The default. |
| Hard gates | `ApprovalHardGate` in `approval-route.ts` | Core | Only a person may grant them, in every mode. A break here is a safety failure. |
| Shell sandbox, filesystem and network policy | `sandbox.*`, prompt `sandbox_network_access` | Core | |
| Unsandboxed escape approval | `sandbox: "unsandboxed"` on `shell` | Core | |
| Shell and generation limits | `shell.timeout`, `shell.backgroundTimeout`, `agent.maxStreamOutputChars` | Core | |
| Approval modes `auto`, `unattended`, `always` | `shell.autoApproveMode` | Supported | The modes are Supported; the hard gates they must respect are Core. |
| Background shell jobs | `get_shell_job`, `cancel_shell_job`, `monitor_shell_job`, `cancel_shell_monitor`, `configure_task_check_in` | Supported | |
| Code context | `read_code_outline`, `code_context_search` | Supported | |
| Web | `web_fetch`, `web_search` with Tavily, Exa, Firecrawl or SearXNG | Supported | |
| Memory | `memory_list`, `memory_get`, `memory_search`, `memory_retrieve`, `memory_create`, `memory_update`, `memory_delete` | Supported | |
| Session browsing and rollover tools | `session_list`, `session_search`, `session_read`, `session_rollover` | Supported | |
| Worktrees | `enter_worktree`, `exit_worktree` | Supported | |
| Skills | `activate_skill` | Supported | |
| Goals and questions | `propose_goal`, `goal_check`, `ask_user` | Supported | |
| Subagents | `run_subagent` with roles `explorer`, `worker`, `librarian`, `reviewer`, `mentor`; `ask_mentor`; `list_models`; subagent-only `run_explorer`, `ask_orchestrator` | Supported | |
| Scripted tool calls | `run_code` | Supported | |
| Completion verifier | `agent.completionVerification`, `verifier.model` | Supported | |
| MCP | `mcp.json`, `.mcp.json`, `/mcp`, `/mcp-login`, `nonInteractiveAllow` | Supported | |
| Hooks | `~/.term2/hooks`, `.term2/hooks`, `hooks.*`, package export `./hooks` | Supported | The event names are a published interface. |
| Tool toggles | `tools.*.enabled` | Supported | |
| Async subagent controls | `get_subagent_result`, `get_subagent_status`, `send_message`, `cancel_run` | Experimental | Offered only with the `builtin:integration/async-subagents` integration. |
| Docker host control | `sandbox.dockerHostControlProjects` | Experimental | |
| Agent workflow tool | `run_agent_workflow`, `enable_agent_workflow`, `agentWorkflow.*` | Experimental | Not reachable at `b275968`: `agent.ts` registers it only when an agent runtime is supplied, and the one supplier, `getAgentRuntime` in `tool-surface.ts`, returns `null`. |

## Conversations, context and configuration

| Item | Reached by | Tier | Reason |
| --- | --- | --- | --- |
| Conversation log | automatic | Core | Every other conversation feature is replayed from it. |
| Context compaction | `agent.contextCompaction.*`, automatic | Core | Runs without being asked in any long session. |
| Session rollover | `agent.sessionRollover.*`, automatic | Core | Same reason. |
| Settings load, save and environment overrides | `settings.json`, `SETTING_ENV_VARIABLES` | Core | |
| AGENTS.md instructions | `~/.agents/AGENTS.md`, `<cwd>/AGENTS.md` | Core | |
| Local workspace admission | launch directory | Core | Decides what may be written. |
| Run budget | `agent.runBudget.*` | Supported | |
| Per-request input ceiling | `agent.maxRequestInputTokens` | Supported | |
| Durable goal and goal stop policy | `/goal`, automatic | Supported | |
| Background check-ins and headless wait limit | `agent.backgroundCheckIn.*`, `agent.backgroundWaitTimeoutMs` | Supported | |
| Memory store and prompt index | `memory.*` | Supported | |
| Personal context | `personal-context.json` | Supported | |
| Input history | `ui.historySize` | Supported | |
| Storage location overrides | `TERM2_CONVERSATIONS_DIR`, `TERM2_CONFIG_DIR`, `TERM2_CACHE_DIR`, `TERM2_SESSION_INDEX_PATH` | Supported | The test suite depends on them. |
| Raw provider traffic capture | `TERM2_RAW_TRAFFIC` | Supported | A debugging aid. |
| Unattended profile | `TERM2_SUPERVISED=1` | Experimental | |
| Automatic memory canary | `TERM2_AUTOMATIC_MEMORY_CANARY=1` | Experimental | |
| Gateway workspace grants | `term2 serve --allow-write`, `--workspace-root` | Experimental | Tier of the gateway. |

## Persisted formats

A format's tier is the tier of the upgrade promise: for Core, a file written by
an earlier release must still load, or be migrated, after an upgrade.

| What | Version marker | Tier | Reason |
| --- | --- | --- | --- |
| Conversation log (`<id>.jsonl`) | `LOG_FORMAT_VERSION`; the reader rejects other versions | Core | |
| Settings (`settings.json`) | none in the file; `persisted-selection-migration.ts` rewrites old values | Core | No version field means an incompatible change cannot be detected on load. |
| Provider credentials (`codex-auth.json`, `grok-auth.json`) | none found | Core | Tier of the provider. Losing them forces a new login. |
| Memory store (`index.json`, `items/`) | `version: 1`, validated on read | Supported | |
| Input history (`tui-history-next.json`) | none found | Supported | |
| MCP configuration and OAuth tokens (`mcp.json`, `direct-mcp-oauth.json`) | not checked | Supported | |
| Session index, native catalogue, model catalogue cache | version checked; rebuilt or refetched on mismatch | Rebuildable | Derived data. A break costs time, not content. |
| Application log, audit log, provider traffic | none | Rebuildable | Diagnostic output; nothing reads it back to run. |
| Gateway state (`direct-workspace-grants.json`, `replay.sqlite`) | `version: 1` on grants | Experimental | Tier of the gateway. |

## Compatibility-only names

| Name | Kept because | Remove when |
| --- | --- | --- |
| Tool name `run_subagent_async` | `createRunSubagentAsyncToolDefinition` is marked deprecated and unregistered; the TUI still renders rows recorded under this name. | No supported conversation log can contain it. |
| Tool names `bash`, `find_files` | Approval and rendering code still accepts them; neither is registered as a tool. | Same condition. |
| Profile ids `plan`, `pair`, `mentor`, `orchestrator` | `DROPPED` in `dropped-profiles.ts` maps saved ids to Bare. | Saved settings and logs that name them are no longer supported. |
| Settings `app.mentorMode`, `app.liteMode`, `app.planMode`, `app.orchestratorMode` | Read by `legacy-adapter.ts` to translate old profile flags. | With the profile ids. |
| Legacy conversation store (`conversations/`, `last.json`) | Still read by the resume list and session browser. | The offline v3 migration is no longer offered. |
| Gateway route `POST /` | Alias kept in `matchPrivateRoute`. | Tier of the gateway; it can go at any time. |

## Keeping this current

These symbols enumerate their area exhaustively. A new entry in one of them
needs a row here, and a row whose name no longer appears in its registry is stale.

| Area | Registry |
| --- | --- |
| CLI flags and subcommands | `FLAGS`, `SUBCOMMANDS`, `CONTROL_COMMANDS` in `src/app/cli-args.ts` |
| `term2 serve` flags | `VALUE_FLAGS`, `BOOLEAN_FLAGS` in `src/host/gateway/serve-args.ts` |
| Slash commands | `COMMAND_SECTIONS` in `legacy-commands.ts`, `OTHER_COMMANDS` in `typed-command.ts` |
| Gateway routes | `matchPrivateRoute` in `src/host/server-routes.ts` |
| Built-in providers | the imports in `src/model/providers/index.ts` |
| Custom provider types | `KNOWN_CUSTOM_PROVIDER_TYPES` in `settings-schema.ts` |
| Provider presets | `src/model/providers/provider-presets.json` |
| Root tool list | `getAgentDefinition` in `src/app/agent.ts` |
| Approval modes and hard gates | `APPROVAL_POLICIES`, `ApprovalHardGate` in `approval-route.ts` |
| Subagent roles | `SUBAGENT_ROLES` in `src/tools/subagents/types.ts` |
| Hook events | `Term2HookEventName` in `hook-contracts.ts` |
| Settings keys and environment overrides | `SETTING_KEYS` in `settings-schema.ts`, `SETTING_ENV_VARIABLES` in `settings-env.ts` |
| Skins and themes | `SKIN_NAMES`, `THEME_NAMES` |
| Log fact types | `Fact` in `src/session/facts.ts` |

Not swept: `bench/`, `eval/`, `parity/`, `vendor/`, `scripts/`, `website/`, and
the internals of `@qduc/agent-core`, which lives in another repository. The
exact-pinned version of that package is itself an external dependency of every
Core item above.
