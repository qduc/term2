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
- Review round 1 fixed MCP signature leakage from the general header, preserved
  MCP failure envelopes while recording failed call outcomes, built the catalog
  once per description read, and added coverage for collisions, sanitization,
  server states, non-text output, abort propagation, and provider-registry
  isolation.

## Design choices

- Names are flat and deterministic: `<server>__<tool>`, with non-identifier
  characters replaced by `_` and leading digits prefixed by `_`.
- Built-in and MCP name collisions are omitted from the MCP catalog and listed
  as collisions. MCP tools are appended only to the runtime's script registry;
  the provider-facing registry remains the existing direct-only filtered list.
- Catalog snapshots are read when the description/registry is built. The source
  change subscription is intentionally unused in this slice; turn-boundary
  freshness is deferred as specified.
- Headers contain server state, tool count, and member names only. The general
  `renderToolsHeader` receives only non-MCP tools, so MCP signatures and
  descriptions cannot leak into the provider-facing header. Full MCP
  descriptions and original names are available through `tools.describe`, with
  server text capped at 2,000 characters and explicitly labeled. The describe
  result also includes the compact rendered signature.
- Script-visible MCP failures use the runtime's standard rejected-call path;
  `isError` text is not double-prefixed, and `McpCallError` includes its code.
  Every server/config/tool string rendered in the catalog is collapsed to one
  line and bounded; server error text is explicitly labeled.
- JSON Schema validation uses the permitted minimal validator: object root,
  `required`, and top-level primitive types. Deeper validation remains the
  server's responsibility; no dependency was added.
- Every MCP call registers and evaluates an approval policy through the same
  `ToolApprovalPolicyRegistry` and runtime `NestedApprovalOwner` path. The
  `readOnlyHint` annotation only controls the stall-detection `effect` hint;
  it never affects approval. Without an approval owner, prompting calls remain
  unavailable from the script.
- Results prefer `structuredContent`; otherwise text blocks are joined and
  non-text blocks become `[<type> content omitted]`. `isError` and
  `McpCallError` reject the script call with the standard
  `tools.<member> failed: ...` message while the runtime ledger records an
  `error` outcome. Existing runtime
  serialization/bounding and abort-signal propagation are retained.

## Tests

`source/tools/system/run-code/mcp-script-surface.test.ts` proves:

1. compact MCP catalog rendering and script-only exposure;
2. structured-content calls through the real runtime and approval registry;
3. pre-approval required/primitive argument validation;
4. server `isError` and transport failures reject at the script boundary with
   the standard failure message and no success result envelope;
5. denial when approval is required without a nested owner;
6. original-name description output and 2,000-character server-text capping;
7. collision omission, built-in collision, identifier sanitization, connecting
   and failed states, non-text content, abort propagation, and provider-registry
   isolation;
8. `isError` and `McpCallError` both produce failure ledger outcomes.

## Gates

Required verify command, passed:

```text
NODE_ENV=test pnpm exec vitest run source/tools/system/run-code && pnpm typecheck
```

Observed: 8 test files passed, 228 tests passed; `pnpm typecheck` passed.

Review round 2 focused regression gate:

```text
NODE_ENV=test pnpm exec vitest run source/tools/system/run-code/mcp-script-surface.test.ts
```

Observed: 1 test file passed, 11 tests passed.

Related-test gate passed:

```text
pnpm test:related ./source/tools/system/run-code/mcp-script-surface.ts ./source/tools/system/run-code/run-code.ts ./source/tools/system/run-code/run-code-runtime.ts
```

Observed: 53 test files, 1,102 passing tests and 1 expected fail.

Changed-file ESLint and Prettier checks passed:

```text
pnpm exec eslint source/tools/system/run-code/mcp-script-surface.ts source/tools/system/run-code/mcp-script-surface.test.ts source/tools/system/run-code/run-code.ts source/tools/system/run-code/run-code-runtime.ts
pnpm exec prettier --check source/tools/system/run-code/mcp-script-surface.ts source/tools/system/run-code/mcp-script-surface.test.ts source/tools/system/run-code/run-code.ts source/tools/system/run-code/run-code-runtime.ts
```

The repository-wide `pnpm lint` command did not pass because the baseline has
62 warnings and Prettier reports 33 pre-existing unrelated files. It reported
zero errors in the changed files; the changed-file checks above passed.

## Review round 2 disposition

All five cross-review findings were addressed:

1. MCP failures now fall through the runtime's standard `failed(message)` path,
   with exactly one transport-code prefix.
2. Catalog server names, member names, errors, and collision lines are one-line
   bounded strings, with server error text labeled.
3. Required/property validation uses own-property checks.
4. MCP describe output includes `renderCompactSignature`.
5. Regression assertions verify script rejection, rendered collision output,
   and the bounded error text.

## Review round 1 disposition

All four coordinator findings were addressed in the follow-up commit:

1. MCP tools are excluded from `renderToolsHeader`; only the dedicated compact
   MCP catalog lists members.
2. MCP server/protocol failures throw through the existing runtime catch, which
   records `error` while returning the nested `{ ok: false, error }` envelope.
3. Tests cover all requested naming, collision, state, content, abort, and
   registry-isolation decisions.
4. A single `McpCatalog` value is reused for each description read.

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
