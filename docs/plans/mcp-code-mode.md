# MCP servers as `run_code` functions

## Resume here

Status: **Milestones 0 and 1 complete**; **Milestone 2 half complete**. Merged to `main`:
the `McpToolSource` contract (`360f7a36`), the script surface (`d0288cce`), config + connection
manager (`f3bb6916`), app wiring (`1077e20d`), and the OAuth core — credential store, provider
adapter, shared loopback helper, offline fixtures (`48053aaa`). Full unit suite green at
`1077e20d` (626 files / 8689 tests).

**Resume here:** the rest of Milestone 2 (login trigger, catalog `needs-auth` state, connection-
manager OAuth integration, gateway/non-interactive behavior) is blocked on four user decisions
recorded in `.coord/mcp-code-mode/PARKED-DECISIONS.md` (D1 login trigger, D2 project HTTP + OAuth,
D3 redirect ports, D4 DCR fallback). Do not implement those without an answer. Milestone 3 stays
evidence-gated. Known gaps carried forward: no auto-reconnect after a server fails; HTTP/SSE session
drop is not detected; the gateway composes no manager yet; no provider-driven end-to-end CLI test
(script → real stdio server is covered).

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
4. **Project stdio servers are opt-in** (revised 2026-09-17 after the M0 sandbox spike;
   follows from 3):
   - Servers from **user** config start normally.
   - A stdio server from a **project** `.mcp.json` never starts unless the **user** config
     enables it: `"projectServers": { "<name>": { "enabled": true } }`. A `projectServers`
     key inside a project `.mcp.json` is ignored.
   - Until enabled, the server appears in the catalog as failed, with an error naming the
     exact user-config line to add.
   - Project HTTP/SSE servers connect without opt-in (no local process), but their config
     values are taken literally: `${VAR}` expansion is user-config only, so a repository
     cannot send the user's secrets to a URL it chooses.
   - On a user/project name clash the **user** entry wins.

   Rationale: with no trust prompt, auto-starting a project stdio server would let a cloned
   repo run arbitrary commands at startup, before per-call approval can intervene.

   Superseded original (2026-09-17): run project stdio servers **inside the shell sandbox**,
   with a user-config override to unsandbox. Rejected after
   [the M0 sandbox spike](../research/mcp-m0-sandboxed-stdio.md) showed a sandboxed server is
   rarely usable and costly to support: this host lacks `socat` so the sandbox is unavailable
   at all; network needs the process-global `sandbox.allowNetworking`; node `fetch` ignores
   the proxy; `npx -y` fails on read-only `~/.npm`; `*_TOKEN` env is stripped; the runtime's
   single process-wide config means an unrelated shell `wrap` resets it and silently severs a
   live server's network; holding `acquire()` deadlocks the shell tool; and bwrap mount-point
   dotfiles persist in the workspace for the whole session. Nearly every real server would have
   needed the user override anyway, so opt-in gives the same safety without a sandbox launcher.
   Also rejected: all-unsandboxed (open hole given decision 3); ignoring project config
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
- **Dotted names** (resolved: flat `<server>__<tool>`, see M1). `tools.<name>` is flat today; `tools.github.create_issue` needs a
  namespace object or a flattened identifier scheme. Server/tool names may contain
  characters invalid in JS identifiers.
- **JSON Schema, not Zod.** `renderCompactSignature` already reads JSON Schema
  (`canonicalParameters ?? parameters`), but execution-time validation and
  `scriptedReturnSchema` assume Zod.
- **Prompt cache churn.** The `run_code` description is a getter read per request. Servers
  finishing connection or sending `tools/list_changed` mid-session change it, which
  invalidates provider prompt caches. Catalog changes should be batched to turn boundaries.

## Milestones

### Milestone 0 — spikes (no production code) — complete

Results (spike code stays on branches `mcp-m0-sdk`, `mcp-m0-sandbox`, `mcp-m0-servers`):

- [SDK compatibility](../research/mcp-m0-sdk-compat.md): `@modelcontextprotocol/client@2.0.0`
  connected to and called tools on v1 stdio, v1 Streamable HTTP, v1 legacy HTTP+SSE, and v2
  Streamable HTTP fixtures. Decision: v2 client only in production. Pagination, `list_changed`,
  abort/timeout and crash behavior were not exercised by the spike.
- [Test servers and catalog cost](../research/mcp-m0-test-servers.md): `github-mcp-server`
  v1.12.2 lists 90 tools without a token; compact signatures for all 90 are ~14.6k chars vs
  ~2.3k for names only (raw JSON ~257k). Decision: MCP header is names-only, details via
  `tools.describe`. No tested server paginates.
- [Sandboxed stdio](../research/mcp-m0-sandboxed-stdio.md): mechanically feasible but not
  practical; led to the Decision 4 revision above.

Original questions:

1. **SDK line.** `@modelcontextprotocol/client` v2 implements `2026-07-28`. Does it connect to
   handshake-era (`2025-11-25` and earlier) servers, and to legacy HTTP+SSE? If not, what
   does v1 (`@modelcontextprotocol/sdk` 1.x) cover, and can both coexist?
2. **Sandboxed stdio.** Can a stdio server be spawned through the existing sandbox runner
   (`shell-sandbox-runner.ts`) with a live stdin/stdout pipe, not a one-shot command?
3. **Test servers.** Pick at least: one small stdio server, one large one
   (`github/github-mcp-server` with all toolsets), one Streamable HTTP server, one
   OAuth-protected remote server. Record tool counts and rendered catalog size.

### Milestone 1 — connect, catalog, call (all transports, non-OAuth auth) — complete (`1077e20d`)

- Config loading (user + project), provenance tracking, per-mode opt-in.
- Connection manager: stdio, Streamable HTTP, legacy SSE; static header/token auth;
  timeouts; crash/unreachable surfaced as structured script errors; `tools/list`
  pagination; `list_changed` refresh batched to turn boundaries.
- Project stdio opt-in (decision 4) with actionable failure text.
- Script-only registry entries. Naming: flat members `<server>__<tool>`, every character
  outside `[A-Za-z0-9_$]` replaced by `_`, a leading digit prefixed with `_`; colliding MCP
  members (with each other or a built-in) are exposed as neither and listed in the catalog.
  Rationale: nested `tools.<server>.<tool>` would need changes to the sandboxed code host's
  flat namespace bindings (`CapabilityKind` in `host-types.ts`) and its realm-isolation rules.
- Catalog scaling from day one: per-server one-line summary plus tool names in the header;
  full signatures via `tools.describe`. Reopens `run_code` Milestone 4 with this concrete
  consumer — record header size before and after.
- JSON Schema argument validation; `structuredContent` returned to scripts when present,
  text content otherwise; `isError` surfaced as a script-visible failure.
- Approval on every call; non-interactive allowlist.

Exit: every Milestone 0 test server except the OAuth one is callable from a script, with
approval, in interactive and non-interactive modes; provider black-box coverage for the
new `run_code` description shape.

### Milestone 2 — OAuth remote servers — core merged (`48053aaa`), rest blocked on D1–D4

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
