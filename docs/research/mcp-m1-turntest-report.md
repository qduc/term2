# M1-wiring-turntest report — W-p5

## What was built

One integration test that proves MCP catalog turn stability through the real boundary.

### File modified
- `source/services/mcp/turn-stable-mcp-tool-source.test.ts` — added one new `it()` block inside the existing describe.

### Test added

**"MCP catalog turn stability through the real boundary"**

Proves the prompt-cache guarantee end-to-end through three components wired together:
1. `TurnStableMcpToolSource` (wraps a live `McpToolSource`, freezes its snapshot)
2. `AgentConfiguration` (owns the turn-stable wrapper, exposes `beginTurn()`)
3. `createRunCodeToolDefinition` (its `description` getter reads `mcpToolSource.snapshot()`)

The test exercises this exact flow:
- Creates a fake live `McpToolSource` with mutable snapshots and fireable `onCatalogChanged` listeners.
- Passes it to `AgentConfiguration` which wraps it in `TurnStableMcpToolSource`.
- Creates a `run_code` tool definition with the wrapped source (same instance).
- **Phase 1**: Reads `runCode.description` — confirms initial catalog text.
- **Phase 2**: Mutates the live source (adds a new server with a tool), fires `onCatalogChanged`. Reads the description again — asserts it is **identical** (prompt-cache guarantee). Also calls `config.getAgent()` and `config.getApplicationAgent()` between reads to prove incidental reads do **not** advance the turn.
- **Phase 3**: Calls `config.beginTurn()` (the real turn boundary via `AgentConfiguration.beginTurn()`). Reads the description again — asserts it now contains the new server and tool.

## Design choices

- **Asserted on rendered description text, not internal flags**: The test checks the actual `String(runCode.description)` output, which is what the model sees. This catches regressions in the description rendering path, not just the snapshot-swapping logic.
- **Uses the real `AgentConfiguration.beginTurn()` path**: Not calling `TurnStableMcpToolSource.beginTurn()` directly. This proves the wiring from `AgentConfiguration` through to the turn-stable source is correct.
- **Tested through `createRunCodeToolDefinition`**: The `run_code` tool's description getter is the actual prompt-cache boundary. The test uses the real tool definition, not a mock.

## Gate outputs

### `pnpm test:related`
```
Test Files  1 passed (1)
     Tests  2 passed (2)
```

### `pnpm typecheck`
```
$ tsc --noEmit
(exit 0)
```

### Verify command
```
NODE_ENV=test pnpm exec vitest run source/lib source/services/mcp source/tools/system/run-code
  Test Files  34 passed (34)
       Tests  707 passed (707)

pnpm typecheck
(exit 0)
```

## Known gaps / risks

- None. The test exercises the complete wiring path without substituting any production component.
