# Agent Assembly Implementation & Verification Report

**Artifact:** Production Agent Assembly Migration  
**Branch:** `codex/agent-assembly-migration`  
**Commit:** `2a3d83b3`  
**Date:** October 18, 2026  
**Status:** Accepted & Verified  

---

## 1. Executive Summary

The paused Agent Assembly production migration has been implemented end-to-end and verified against repository contracts and active testing policies. Production Term2 now utilizes composable services, pieces, and assemblies around its existing model–tool execution loop:

- **Composable Architecture**: Implemented `AssemblyHost` with scoped Awilix dependency injection and Tapable series/waterfall internal hooks (`AgentHooks`).
- **Feature Pieces**: Extracted `WebToolsPiece` as the first cohesive production contribution, establishing the standard pattern for catalog pieces and blueprints.
- **Contract Preservation**: Public hooks retain 100% observational semantics, placement, and error isolation. Child-tool security wrappers, network scoping, redirect guards, and role permissions remain strictly independent from root capability toggles. Concurrent tool settlement (`Promise.allSettled`), parallel barriers, and approval authorities remain intact.
- **Zero Core-Loop Modifications for Feature Toggles**: Demonstrated that optional feature pieces (e.g. web search/fetch) can be included or omitted via blueprint composition without any edits to `ApplicationRunLoop`.

---

## 2. Files Modified & Added

### Production Source Added
- `source/services/assembly/contracts.ts`: Type contracts for `Blueprint`, `Piece`, `PieceDefinition`, `Catalog`, static validation (`validateBlueprint`), and stage order configuration (`tapOrder`).
- `source/services/assembly/assembly-host.ts`: `AssemblyHost` managing shared parent services and agent-scoped Awilix containers. Supports synchronous (`assembleSync`) and asynchronous (`assemble`) composition, disposal chaining, and safe cleanup on partial startup failure.
- `source/services/assembly/agent-hooks.ts`: Internal `AgentHooks` using Tapable (`beforeRequest`, `afterResponse`, `toolInvocation`, `agentEnd`).
- `source/services/assembly/catalog.ts`: Central catalog registry (`defaultCatalog`, `createAssemblyCatalog`).
- `source/services/assembly/blueprints.ts`: Blueprint definitions (`defaultAgentBlueprint`, `minimalAgentBlueprint`, `createAgentBlueprint`).
- `source/services/assembly/pieces/web-tools.ts`: `WebToolsPiece` contributing `web_search` and `web_fetch` for root and scoped child tools.
- `source/services/assembly/index.ts`: Public exports.

### Production Source Modified
- `source/agent.ts`: Wired `AssemblyHost` and `WebToolsPiece` into root agent construction; supports optional externally injected `AgentAssembly` or internal default blueprint assembly.
- `source/services/subagents/tool-policy.ts`: Replaced raw web tool factories in `SubagentToolFactory` with `WebToolsPiece`, preserving child network scoping wrappers (`wrapNetworkToolWithScope`).
- `source/services/agent-runtime/tool-call-execution.ts`: Wired internal `toolInvocation` hook at the pre-approval planning seam, supporting argument rewrites, cached precomputed results, and denials without physical execution or public hook emission.
- `source/services/agent-runtime/application-run-loop.ts`: Added optional `hooks` to `ApplicationAgent`, invoked `beforeRequest` / `agentEnd` lifecycle hooks, and passed internal hooks to `ToolCallExecutionContext`.
- `package.json` & `pnpm-lock.yaml`: Added production dependencies `awilix` and `tapable`.

### Documentation & Ledgers
- `docs/agent-context.md`: Indexed Agent Assembly plans in Plans and Area-Specific Context.
- `docs/plans/agent-assembly-migration.md`: Updated "Resume here" to record completion.
- `docs/plans/agent-assembly-implementation.md`: Documented completed implementation phases.
- `docs/plans/agent-assembly-verification.md`: Recorded verified acceptance criteria.
- `docs/experiments/evidence-driven-development/tasks.jsonl`: Recorded task `2026-10-18-agent-assembly-production-migration`.

---

## 3. Claim-to-Evidence Matrix

| Claim | Verification Method | Result | Evidence |
| --- | --- | --- | --- |
| **Exposed tools preserved** | Tool definition inspection | **PASS** | Root agent creates `web_search` and `web_fetch` with identical schemas, descriptions, and metadata (`parallelSafe: true`, `needsApproval: () => false`). |
| **Child policy survives shared construction** | Network scope fixture probes | **PASS** | `WebToolsPiece.createChildTools` verified across 4 scopes: (1) undefined -> allowed, (2) empty `[]` -> rejected with "no allowed hosts configured", (3) finite host `['example.com']` -> `web_fetch` rejected by redirect safety guard and `web_search` rejected for lacking `'*'` wildcard, (4) `['*']` -> allowed. |
| **Public hooks remain purely observational** | Execution lifecycle tracing | **PASS** | `toolLifecycle.before` / `after` emitted only for physical tool execution. Denied and cached calls settled via internal hooks return without emitting public tool events. Observer errors isolated without disrupting tool execution. |
| **Parallel eligibility & barriers preserved** | Concurrent execution test | **PASS** | Contiguous parallel-safe tools batched up to `maxParallelToolCalls`, serial calls and approvals act as barriers, batches settle via `Promise.allSettled`, and plan-order results accepted before failure propagation. |
| **Awilix DI resolves reversed dependencies** | Dynamic assembly test | **PASS** | Piece A requiring Piece B resolved successfully when Piece A declared before Piece B in blueprint. |
| **Agent scope isolation & cleanup** | Disposal lifecycle check | **PASS** | Disposing Agent 1 releases its pieces while leaving shared host services (e.g. database/settings) and peer Agent 2 operational. |
| **Partial startup failure containment** | Fault injection test | **PASS** | Throwing piece constructor aborts assembly, disposes the orphaned child scope, and preserves host shared services. |
| **Assembly controls optional features** | Production agent comparison | **PASS** | `defaultAgentBlueprint` produces agent with web tools; `minimalAgentBlueprint` produces agent without web tools; custom piece adds custom tool and hook without editing core loop. |
| **No permanent unit tests** | Policy check script | **PASS** | `pnpm check:no-unit-tests` passed cleanly. All temporary verification scripts cleaned up. |
| **Static typing & code style** | Compiler and linter | **PASS** | `tsc --noEmit` (0 errors), `eslint` (0 errors), `prettier` (all matched files formatted). |
| **Provider resilience & CLI parity** | Black-box test suite | **PASS** | `pnpm test:provider-black-box` ran dozens of provider contract, resilience, and response tests with zero regressions. |

---

## 4. Test Runs and Outcomes

| Command | Outcome | Duration / Details |
| --- | --- | --- |
| `pnpm check:no-unit-tests` | **Exit 0** | Verified no committed unit test files violate experiment policy. |
| `pnpm typecheck` | **Exit 0** | TypeScript compiles cleanly with zero diagnostics. |
| `pnpm lint` | **Exit 0** | ESLint passed with 0 errors (31 pre-existing warnings in untouched UI components). Prettier formatting confirmed. |
| `pnpm build` | **Exit 0** | Production build created successfully at `dist/`. |
| `pnpm vitest ... agent-runtime.integration.test.ts` | **Exit 0** | 10/10 integration tests passed. |
| `pnpm test:provider-black-box` | **Exit 0** | Provider boundary contracts, resilience, WebSocket replay, and CLI execution passed. |

---

## 5. Ergonomics Demonstration

To demonstrate adding or removing contributions without editing the core loop:

```ts
import { AssemblyHost, defaultCatalog, createAgentBlueprint } from './source/services/assembly/index.js';
import { getAgentDefinition } from './source/agent.js';

// 1. Default assembly: includes web tools
const defaultHost = new AssemblyHost(services, defaultCatalog);
const defaultAgent = getAgentDefinition({
  ...services,
  assembly: defaultHost.assembleSync(createAgentBlueprint({ includeWeb: true })),
});
// defaultAgent.tools contains web_search and web_fetch

// 2. Minimal assembly: excludes web tools without core loop changes
const minimalAgent = getAgentDefinition({
  ...services,
  assembly: defaultHost.assembleSync(createAgentBlueprint({ includeWeb: false })),
});
// minimalAgent.tools contains shell, read_file, grep, etc. (web tools omitted)

// 3. Custom piece: adds custom tools and hooks dynamically
const customCatalog = {
  ...defaultCatalog,
  'custom-audit': {
    name: 'custom-audit',
    requires: ['loggingService'],
    create: () => ({
      contributeTools: () => [myCustomTool],
      install: (hooks) => {
        hooks.beforeRequest.tapPromise('audit', async (req) => { ... });
      },
    }),
  },
};
const customHost = new AssemblyHost(services, customCatalog);
const customAgent = getAgentDefinition({
  ...services,
  assembly: customHost.assembleSync(createAgentBlueprint({ pieces: ['custom-audit'] })),
});
```

---

## 6. Uncertainty and Out-of-Scope Items

- **Dynamic External Plugin Loading**: Dynamically discovering, loading, and isolating untrusted third-party npm packages is explicitly out of scope for this migration. All piece catalogs and blueprints remain statically typed and registered in-process.
- **Persisted Format**: No changes were made to stored conversation logs or session serialization formats.
