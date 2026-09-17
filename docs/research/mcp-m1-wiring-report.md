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
  shutdown follows conversation shutdown, including bounded close calls from
  SIGINT/SIGTERM handlers.
- Added user-config-only `nonInteractiveAllow` matching for MCP approval
  members (`server/tool` and `server/*`). Project configuration cannot provide
  this allowlist.
- Added `TurnStableMcpToolSource`. The agent configuration calls `beginTurn()`
  from the actual `startStream` turn boundary; incidental `getAgent` reads do not
  advance it. The
  live source is still used for every call.

## Tests

- `source/services/mcp/turn-stable-mcp-tool-source.test.ts`: catalog remains
  frozen after `list_changed` and refreshes at the next boundary.
- Existing MCP connection/config tests and profile/agent/non-interactive tests
  cover the production paths; the plan denial expectation was updated.
- `source/services/approval/non-interactive-approval-policy.mcp.test.ts`:
  allowlist wildcard/exact/malformed/empty behavior and explicit non-MCP
  membership behavior through `runWithSession`.
- `source/agent.test.ts`: capability-enabled/disabled/plan/subagent surfaces
  and provider-facing exclusion.
- `source/tools/system/run-code/mcp-script-surface.test.ts`: real
  `McpConnectionManager` plus the stdio fixture, calling `echo` from a script.
- `source/services/mcp/mcp-connection-manager.test.ts`: empty configuration
  lifecycle.

## Gates

- Verify command: `NODE_ENV=test pnpm exec vitest run source/services/mcp source/tools/system/run-code source/services/profiles && pnpm typecheck` — passed (MCP/profile/run_code focused suite: 175 tests; typecheck passed).
- `pnpm test:related` for changed source files — passed (83 files, 1573 tests, 1 expected fail, 1 skipped).
- `pnpm typecheck` — passed.
- Review-round focused/related reruns — passed: 305 focused tests and 1047
  related tests (the latter includes 1 pre-existing expected failure).
- New-test focused command:
  `NODE_ENV=test pnpm exec vitest run source/agent.test.ts source/tools/system/run-code/mcp-script-surface.test.ts source/services/approval/non-interactive-approval-policy.mcp.test.ts source/services/mcp/mcp-connection-manager.test.ts` — passed (109 tests).
- `pnpm lint` — ESLint passed with existing warnings; repository Prettier check failed on pre-existing unrelated files plus `source/agent.ts` and the new turn-stable file before formatting. Changed files were formatted individually; the repository-wide check still reports unrelated existing formatting drift.

## Known gaps / risks

- Gateway runtime composition remains a follow-up. The real stdio fixture
  end-to-end script path is covered by the command above; a fake-provider
  `runNonInteractive` harness remains outside this branch because the CLI
  composition owns config loading and process startup.
