# MCP servers as `run_code` functions

## Resume here

Status: **proposed, not started** (drafted 2026-09-17; no implementation merged).
Next step: Milestone 0 spikes. Nothing below has been validated against a running MCP
server yet.

Before touching this area, also read:

- [`run_code` lifecycle and contracts](run-code-codemode-improvements.md) — especially
  Milestone 4, whose "no concrete MCP consumer" disposition this plan reopens.
- [Inline approval for nested `run_code` calls](run-code-nested-approval.md).
- [One sandboxed code host](sandboxed-code-host.md).
- [MCP code-mode survey](../research/mcp-code-mode-survey.md) — read its verification
  header first; several of its recommendations are rejected here.

## Goal

term2 can use tools from any kind of MCP server — local stdio, Streamable HTTP, legacy
HTTP+SSE, and OAuth-protected remote servers — and those tools are reachable **only as
functions inside `run_code` scripts**, never as direct model tools.

## Decisions (user, 2026-09-17)

1. **Code mode only.** MCP tools are never registered as direct tools. The model sees a
   compact catalog in the `run_code` description and calls `tools.<server>.<tool>(args)`.
   Rationale: full MCP tool definitions never enter the prompt, which is the main token win
   reported by prior art. Accepted cost: models/modes without `run_code` cannot reach MCP.
2. **Tools first.** Resources are a later milestone. Sampling and roots are out — both are
   deprecated in the `2026-07-28` spec. Elicitation is out unless a concrete server needs it
   (it is not deprecated; it needs the server to call back into term2 mid-call).
3. **No trust prompt** for project-scoped `.mcp.json`.
4. **Sandbox by config provenance** (follows from 3):
   - Servers from **user** config run unsandboxed.
   - Stdio servers from a **project** `.mcp.json` run inside the shell sandbox
     (`createSandboxRuntimeConfig` in `source/utils/shell/sandbox/sandbox-policy.ts`).
   - A project server may be unsandboxed only by a per-server override in **user** config.
     Nothing in a repository's own `.mcp.json` can opt out.
   - A sandbox-caused server failure names the exact user-config override to add.
   - Remote HTTP servers have no local process; provenance does not change their handling.

   Rationale: with no trust prompt, an unsandboxed project server would let a cloned repo
   run arbitrary commands at server start — before per-call approval can intervene.
   Rejected: all-unsandboxed (open hole given decision 3); all-sandboxed-with-grants
   (the sandbox strips `*_TOKEN`/`*_API_KEY` env and denies network, so nearly every real
   server would need grants, including ones the user wrote); ignoring project config
   (breaks team-shared configs).

Defaults accepted without override:

- Per-mode/profile opt-in to MCP tools (subagents included).
- Read the de-facto `mcpServers` JSON format from project `.mcp.json` and from a user-level
  file next to term2's `settings.json`. File-only config at first; no `/settings` UI.
- Servers start in the background at launch; an unready server appears in the catalog as
  connecting rather than blocking startup.
- Every MCP call requires approval. Tool annotations (`readOnlyHint` etc.) are hints the
  spec says must not be trusted for security, so they do not bypass approval.
- Non-interactive runs: calls allowed by a config allowlist run; everything else is denied.
- MCP results go through the same bounding as other scripted tool results
  (`RUN_CODE_LIMITS.maxResultChars`, `bound-tool-result.ts`).

## Known constraints in the current code

- **No script-only tool concept.** `createRunCodeToolDefinition` in
  `source/tools/system/run-code/run-code.ts` exposes the wrapped direct-tool registry minus
  `RUN_CODE_PROHIBITED_TOOLS`. Decision 1 needs a registry entry that is script-visible
  but absent from the provider tool list — and still routed through
  `ToolApprovalPolicyRegistry` and `NestedApprovalOwner` like any nested call.
- **Header renders every tool.** `renderToolsHeader` in `tools-header.ts` prints a
  signature for every non-essential tool. Catalog size is unbounded with MCP.
- **Dotted names.** `tools.<name>` is flat today; `tools.github.create_issue` needs a
  namespace object or a flattened identifier scheme. Server/tool names may contain
  characters invalid in JS identifiers.
- **JSON Schema, not Zod.** `renderCompactSignature` already reads JSON Schema
  (`canonicalParameters ?? parameters`), but execution-time validation and
  `scriptedReturnSchema` assume Zod.
- **Prompt cache churn.** The `run_code` description is a getter read per request. Servers
  finishing connection or sending `tools/list_changed` mid-session change it, which
  invalidates provider prompt caches. Catalog changes should be batched to turn boundaries.

## Milestones

### Milestone 0 — spikes (no production code)

Answer, with evidence recorded here:

1. **SDK line.** `@modelcontextprotocol/client` v2 implements `2026-07-28`. Does it connect to
   handshake-era (`2025-11-25` and earlier) servers, and to legacy HTTP+SSE? If not, what
   does v1 (`@modelcontextprotocol/sdk` 1.x) cover, and can both coexist?
2. **Sandboxed stdio.** Can a stdio server be spawned through the existing sandbox runner
   (`shell-sandbox-runner.ts`) with a live stdin/stdout pipe, not a one-shot command?
3. **Test servers.** Pick at least: one small stdio server, one large one
   (`github/github-mcp-server` with all toolsets), one Streamable HTTP server, one
   OAuth-protected remote server. Record tool counts and rendered catalog size.

### Milestone 1 — connect, catalog, call (all transports, non-OAuth auth)

- Config loading (user + project), provenance tracking, per-mode opt-in.
- Connection manager: stdio, Streamable HTTP, legacy SSE; static header/token auth;
  timeouts; crash/unreachable surfaced as structured script errors; `tools/list`
  pagination; `list_changed` refresh batched to turn boundaries.
- Sandbox-by-provenance for stdio (decision 4) with actionable failure text.
- Script-only registry entries; `tools.<server>.<tool>` namespacing with a documented
  mangling rule for invalid identifiers.
- Catalog scaling from day one: per-server one-line summary plus tool names in the header;
  full signatures via `tools.describe`. Reopens `run_code` Milestone 4 with this concrete
  consumer — record header size before and after.
- JSON Schema argument validation; `structuredContent` returned to scripts when present,
  text content otherwise; `isError` surfaced as a script-visible failure.
- Approval on every call; non-interactive allowlist.

Exit: every Milestone 0 test server except the OAuth one is callable from a script, with
approval, in interactive and non-interactive modes; provider black-box coverage for the
new `run_code` description shape.

### Milestone 2 — OAuth remote servers

- OAuth 2.1 + PKCE via the SDK's auth provider interface, token storage and refresh.
- Client ID Metadata Documents first; Dynamic Client Registration only as a fallback
  (DCR is deprecated in `2026-07-28`).
- Evaluate reuse of provider OAuth plumbing — see
  [provider OAuth independence](provider-oauth-independence.md).

Exit: the OAuth test server works end to end, including token refresh.

### Milestone 3 — gated follow-ups

Each only on evidence (telemetry or a concrete server that needs it):

- Approval allowlists per server/tool.
- `tools.search` if `tools.describe` usage or unknown-tool failures show discovery cost.
- Resources (`mcp.read(uri)`-style access).
- Elicitation.

## Open questions

- Exact user-config file name/location and the override key shape for decision 4.
- Whether per-mode opt-in lists servers, tools, or both.
- Tool-description prompt injection: descriptions are server-authored text rendered into
  the prompt. The survey's keyword stripping is unproven; decide on a mitigation (e.g.
  length caps, omitting descriptions from the header) with evidence.
