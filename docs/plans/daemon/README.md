# Singleton daemon: one host, every UI a client

Status: in progress. Started 2026-11-27.

## Resume here

- **Current phase:** Steps 0–14d complete; Step 14e (`term2 serve`, web UI, control socket, Discord, ACP over daemon) is next.
- **State files:**
  - [Threat model, acceptance criteria & Step 6 comparison rubric](criteria-and-threat-model.md)
  - [Step 7 ownership comparison (Branch A vs Branch B)](step7-ownership-comparison.md)
  - [Step 8 scenario validation](step8-scenarios.md)
  - [Step 9 Client API inventory](step9-client-api-inventory.md)
  - [Client API v1.1 Core Spec (Frozen)](spec/client-api.md) · [Unix Binding (v1.1)](spec/transport-unix.md) · [HTTP+SSE Binding (v1.0)](spec/transport-http-sse.md) · [JSON Schema](spec/client-api.schema.json)
  - [Step 11 Host & Runtime Zoom-In](zoom/host-and-runtime.md) · [Web Client Zoom-In](zoom/web-client.md) · [TUI Zoom-In](zoom/tui.md)
  - [Decision log](decisions.md)
  - [Progress ledger](progress.md)
  - [Worth revisiting (owner review list)](worth-revisiting.md)
- **Next concrete actions:** Implement Step 14e Part 1 (`daemon.serve.start`/`stop` lease, `local_leases` capability, unified `term2 serve` + web UI over daemon), then Step 14e Part 2 (`session.control.bind`/`rebind`/`unbind`, `session.acp.set_mcp`, control socket / Discord / ACP over daemon), then Step 14f (default flip to daemon mode + `--in-process` escape hatch + full verification and smoke runs).


## Goal

A working term2, like it is today, where one long-lived daemon process owns every
session and every surface (TUI, web, headless, control socket, Discord) is a
client of it. The end state is not a prototype: it is term2 running in daemon
mode by default, with in-process mode kept as an escape hatch.

Later, and out of scope here: a cloud deployment where tools run in a VM or
microVM reached through a portal, so the agent loop and the tool execution
environment are two isolated environments.

## Why

The question that started this was the web sidebar's session status. The web
client already keeps state outside React (`createStore` in
`web-client/lib/term2/store.ts`, the `chats` resource in
`web-client/lib/term2/data/server-data.ts`), but nothing pushes changes for
sessions other than the open one, so the list is re-read only on triggers
(`createShellRuntime` in `web-client/lib/term2/shell/shell-runtime.ts`).

Fixing that properly exposed the larger problem. As of `8833212`:

- Every launch mode builds its own host: `createDirectApplication` in
  `src/app/application.ts` calls `createDirectInProcessHost`, so a TUI, a headless
  run and `term2 serve` are separate hosts.
- The session store takes a per-session writer lock (`acquireDirectWriterLock`,
  `src/session/writer-lock.ts`), so a session one process has open cannot be
  opened by another, and no process can see status changes in sessions another
  process runs.
- The server's session list (`listSessions` in `src/host/server.ts`) connects to
  every session and builds its snapshot per request, so "push a ping and refetch
  the list" is not cheap; a feed should push the changed row
  (`sessionListItem` in `src/host/server-projection.ts`).

What makes the move tractable: the TUI already depends only on `protocol/`, a
`DirectConnection` and an app-owned capability interface
(`src/clients/tui/integration.ts`, `src/clients/tui/use-client.ts`). Moving the
host out of process is mostly a transport change behind `DirectConnection`, not a
rewrite of the clients.

## Shape

Four parts joined by two contracts:

```
Clients ◄── Client API ──► Host (daemon) ◄──► Agent runtime ◄── Environment API ──► Execution environments
```

| Part | Owns |
| --- | --- |
| Clients | Rendering and input only: TUI, web, headless, control, Discord |
| Host (daemon) | Which sessions exist, who may see them, fanout to attached clients. The control plane. |
| Agent runtime | What happens inside a session: durable log, turn loop, providers, credentials |
| Execution environments | Where tools act: the host machine, an SSH box, later a VM. The data plane. |

The Client API is the long-term job of `@qduc/agent-wire`, which the owner wants
to become a public library for building agent interface layers.

## Steps

0. **Goals, non-goals and threat model.** The threat model is sized for term2: one
   user, their own machine or trusted network, using the auth that exists today
   (`src/host/server-auth.ts`, `server-pairing.ts`, `server-trusted-clients.ts`).
   Not multi-tenant, not internet-facing.

   "Works like now" is defined on the assumption that this program mostly moves
   code rather than changing it, to keep verification cheap:
   - The existing integration, e2e and provider black-box suites pass with their
     clients attached through the daemon instead of an in-process host.
   - New checks cover only the seams: attach and detach, reconnect after a dropped
     connection or daemon restart, two clients on one session, the session-list
     stream, daemon lifecycle (auto-start, version handshake).
   - A per-PR tripwire: a change that alters logic rather than relocating or
     rewiring it gets ordinary verification under the `verification` skill.
   - One hands-on smoke run per surface (TUI, web, headless) at the flip, not per
     commit.
1. **Shape:** the four parts and two contracts above.
2. **Start small:** the session-list stream is the first concrete piece. It fixes
   the web sidebar now and is the same contract the daemon and TUI use later.
3. **Each contract gets an RFC-style spec** that precedes and governs the
   implementation. In this program only the Client API (see Standing rules).
4. **Spec format follows the MCP/LSP protocol-spec style:** normative prose with
   RFC 2119/8174 keywords; one TypeScript schema in `@qduc/agent-wire` with JSON
   Schema generated from it; the core protocol separate from its transport
   bindings (unix socket, HTTP + SSE); whole-spec versioning negotiated at
   connect. OpenAPI or AsyncAPI only as optional generated views of the HTTP
   binding. Chosen because MCP's core/transport split and schema-plus-prose model
   match this API, and agent builders already recognise it.
5. **Design-then-review rounds before any freeze**, because a frozen API is
   expensive to change and every client and environment depends on it. The
   orchestrator freezes a contract when every review lens has passed with no open
   blocking finding from reviewers independent of the author, both sides of the
   contract have been zoomed (step 11), and the conformance suite passes.
6. **Fix the comparison criteria before step 7 runs**, so the pick is not swayed
   by whichever answer reads better: security, fit with the target architecture,
   small API surface, migration cost (a cost, not decisive alone), behaviour
   under failure (crash, disconnect, two UIs on one session).
7. **Ownership boundaries from two independent branches:** branch A decides who
   owns what without reading the current code; branch B derives it from the code.
   Compare row by row against step 6's criteria and pick the better answer per
   concern. Concerns without an obvious owner today include settings, approvals,
   MCP servers and background jobs.
8. **Test the chosen boundaries against scenarios:** send a message, approve a
   tool, reconnect after a drop, two UIs on one session, the execution environment
   disappearing mid-turn. A row that cannot explain a scenario is not settled.
9. **Inventory what the Client API carries:** names and directions only, drawn
   from steps 7–8. Anything with no scenario behind it is cut.
10. **Draft the spec and a conformance test suite** from the inventory, then run
    the review rounds (steps 3–5).
11. **Zoom into each part only to its sub-module seams.** Depth: Host full; Clients
    web only (TUI when the daemon exists); Agent runtime shallow (how it plugs into
    the Host); Execution environments deferred. Each sub-module's internals go to
    one subagent, which receives its contract and constraints (failure behaviour,
    repository rules, limits) and works the rest out alone. It reports contract
    problems into the review loop instead of working around them, and its output
    is accepted only by an independent check against the contract. One worktree
    per subagent, per `AGENTS.md`. Internal interfaces get a design note and one
    review round, not an RFC-style spec: changing them stays inside one part.
12. **Recheck the draft spec against what the zoom-ins found, then freeze** under
    step 5's rule.
13. **Prototype the session-list stream** against the draft spec and feed what it
    teaches back into review before anything freezes.
14. **Build out to the flip**, each piece through steps 11–12: the daemon (growing
    `term2 serve`), a remote `DirectConnection`, headless as its first client, the
    TUI, then control and Discord. Flip daemon mode to default when "works like
    now" passes in it.

## Standing rules

- **Main always works.** Every PR keeps `main` green and term2 usable; non-draft
  PRs auto-merge once checks pass, so there is no safe broken intermediate state.
  In-process mode keeps working beside the daemon until the flip and stays as an
  escape hatch after it.
- **State lives in the repository:** this plan, a decision log (each choice and
  why), a progress ledger and a "worth revisiting" list, under `docs/plans/daemon/`,
  so a fresh orchestrator session can resume.
- **Execution environments are deferred.** Only their ownership rule is recorded:
  the agent loop and credentials never live inside one. No Environment API spec,
  inventory or port in this program: a spec with no real consumer would freeze a
  guessed shape, and the port is a logic change across the roughly 21 files that
  branch on `isRemote()`/`getSSHService()` today, which breaks the "mostly
  moving code" assumption. Constraint for all work here: new code reaches
  execution through `ExecutionContext` (`src/tools/execution-context.ts`), adds no
  new `isRemote()` branch and exposes no credential to tool processes. When cloud
  becomes real, the Environment API enters this loop at step 6.
- **Autonomy.** The orchestrator runs to the end without the owner, with no budget
  cap. There are no stop conditions, because an agent offered an exit tends to
  take it. Hard cases have a default action instead, and each one is logged in
  "worth revisiting" for the owner to read at the end:
  - A frozen contract has to change: reopen it through design, review and freeze,
    and bump its version through connect-time negotiation.
  - A security question the threat model does not answer: keep term2's current
    posture, neither weaker nor stronger. If the case is new, take the simplest
    option that does not weaken it. New security machinery is proposed in "worth
    revisiting", not built.
  - A step keeps failing: change the approach (fresh agent, different breakdown,
    smaller step) rather than retrying the same thing.
