# MCP M1 wiring report

## Built

- Added the `mcp` built-in capability and made the plan enforcement profile deny
  MCP, keeping MCP out of read-only/plan agents.
- Propagated an optional `McpToolSource` through `AgentClient`,
  `AgentConfiguration`, and `AgentFactoryDeps`; `getAgentDefinition` only
  supplies it when both `shell` and `mcp` are enabled. Subagent definitions do
  not receive the root source.
- Composed `loadMcpConfig` and `McpConnectionManager` in the CLI root. Startup
  is non-blocking, configuration/catalog failures are logged once, and manager
  shutdown follows conversation shutdown.
- Added user-config-only `nonInteractiveAllow` matching for MCP approval
  members (`server/tool` and `server/*`). Project configuration cannot provide
  this allowlist.
- Added `TurnStableMcpToolSource`. The agent configuration calls `beginTurn()`
  from `getAgent`, which is the existing provider-request/turn boundary; the
  live source is still used for every call.

## Tests

- `source/services/mcp/turn-stable-mcp-tool-source.test.ts`: catalog remains
  frozen after `list_changed` and refreshes at the next boundary.
- Existing MCP connection/config tests and profile/agent/non-interactive tests
  cover the production paths; the plan denial expectation was updated.

## Gates

- Verify command: `NODE_ENV=test pnpm exec vitest run source/services/mcp source/tools/system/run-code source/services/profiles && pnpm typecheck` — passed (MCP/profile/run_code focused suite: 175 tests; typecheck passed).
- `pnpm test:related` for changed source files — passed (83 files, 1573 tests, 1 expected fail, 1 skipped).
- `pnpm typecheck` — passed.
- `pnpm lint` — ESLint passed with existing warnings; repository Prettier check failed on pre-existing unrelated files plus `source/agent.ts` and the new turn-stable file before formatting. Changed files were formatted individually; the repository-wide check still reports unrelated existing formatting drift.

## Known gaps / risks

- Gateway runtime composition and a provider-driven end-to-end CLI fixture were
  not added in this slice; gateway sessions therefore need an explicit source
  injection in a follow-up.
- The CLI's non-interactive path reuses the process manager and closes it on
  normal CLI shutdown; abrupt `process.exit` paths retain the existing process
  exit behavior.
