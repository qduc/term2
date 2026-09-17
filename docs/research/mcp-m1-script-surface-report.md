# M1 script surface delivery report

## Built

- Added `source/tools/system/run-code/mcp-script-surface.ts`, a script-only MCP
  catalog adapter.
- Added the `mcpToolSource?: McpToolSource` seam to
  `CreateRunCodeToolOptions`; no MCP tools are added to the provider registry.
- Integrated catalog construction into `createRunCodeToolDefinition` and MCP
  calls into the existing `createRunCodeRuntime` prepare/approval/invoke path.
- Added `source/tools/system/run-code/mcp-script-surface.test.ts` with six
  production-path tests.

## Design choices

- Names are flat and deterministic: `<server>__<tool>`, with non-identifier
  characters replaced by `_` and leading digits prefixed by `_`.
- Built-in and MCP name collisions are omitted from the MCP catalog and listed
  as collisions. MCP tools are appended only to the runtime's script registry;
  the provider-facing registry remains the existing direct-only filtered list.
- Catalog snapshots are read when the description/registry is built. The source
  change subscription is intentionally unused in this slice; turn-boundary
  freshness is deferred as specified.
- Headers contain server state, tool count, and member names only. Full MCP
  descriptions and original names are available through `tools.describe`, with
  server text capped at 2,000 characters and explicitly labeled.
- JSON Schema validation uses the permitted minimal validator: object root,
  `required`, and top-level primitive types. Deeper validation remains the
  server's responsibility; no dependency was added.
- Every MCP call registers and evaluates an approval policy through the same
  `ToolApprovalPolicyRegistry` and runtime `NestedApprovalOwner` path. The
  `readOnlyHint` annotation only controls the stall-detection `effect` hint;
  it never affects approval. Without an approval owner, prompting calls remain
  unavailable from the script.
- Results prefer `structuredContent`; otherwise text blocks are joined and
  non-text blocks become `[<type> content omitted]`. `isError` is returned as
  `{ ok: false, error }`; `McpCallError` includes its code. Existing runtime
  serialization/bounding and abort-signal propagation are retained.

## Tests

`source/tools/system/run-code/mcp-script-surface.test.ts` proves:

1. compact MCP catalog rendering and script-only exposure;
2. structured-content calls through the real runtime and approval registry;
3. pre-approval required/primitive argument validation;
4. server `isError` script-visible envelopes;
5. denial when approval is required without a nested owner;
6. original-name description output and 2,000-character server-text capping.

## Gates

Required verify command, passed:

```text
NODE_ENV=test pnpm exec vitest run source/tools/system/run-code && pnpm typecheck
```

Observed: 8 test files passed, 223 tests passed; `pnpm typecheck` passed.

Related-test gate passed:

```text
pnpm test:related ./source/tools/system/run-code/mcp-script-surface.ts ./source/tools/system/run-code/run-code.ts ./source/tools/system/run-code/run-code-runtime.ts
```

Observed: 53 test files, 1,097 passing tests and 1 expected fail.

Changed-file ESLint and Prettier checks passed:

```text
pnpm exec eslint source/tools/system/run-code/mcp-script-surface.ts source/tools/system/run-code/mcp-script-surface.test.ts source/tools/system/run-code/run-code.ts source/tools/system/run-code/run-code-runtime.ts
pnpm exec prettier --check source/tools/system/run-code/mcp-script-surface.ts source/tools/system/run-code/mcp-script-surface.test.ts source/tools/system/run-code/run-code.ts source/tools/system/run-code/run-code-runtime.ts
```

The repository-wide `pnpm lint` command did not pass because the baseline has
62 warnings and Prettier reports 33 pre-existing unrelated files. It reported
zero errors in the changed files; the changed-file checks above passed.

## Known gaps / risks

- No connection, configuration, app wiring, OAuth, or catalog-change subscription
  was added; these are outside this assignment.
- The fake source tests the boundary contract, not an MCP transport.
- The minimal validator intentionally does not validate nested properties,
  enums, arrays, `additionalProperties`, or combinators.
- Approval policy registrations are cached by member name for the lifetime of a
  run-code definition. If a future source snapshot replaces a descriptor under
  the same member name, the registration should be refreshed at the same
  turn-boundary batching seam.
