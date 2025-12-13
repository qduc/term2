# Next.js Frontend + Node Backend Refactor Plan (Backend-first)

Date: 2025-12-13

Goal: prepare the current terminal app (Ink UI + local tools) so the *same backend core* can later be hosted behind a Node server and consumed by a Next.js frontend.

Constraint (critical): **after each phase, the current CLI must still work** and tests must pass. No phase should require “finish everything” to regain a working system.

Non-goals (for this document):
- No Next.js UI implementation.
- No production hosting/security hardening beyond minimal scaffolding.

---

## Guiding architecture

Target shape (incremental):

- **UI adapters**
  - Terminal UI (Ink): already exists.
  - Web UI (Next.js): later.

- **Transport adapters**
  - Local in-process calls (CLI → services): current.
  - HTTP/SSE or WebSocket (Next.js → Node server): later.

- **Core “conversation runtime”** (backend)
  - Session-scoped conversation orchestration
  - Provider selection / runner creation
  - Event stream (text delta, reasoning delta, tool approval required, command output, final)
  - No Ink/React imports

- **Runtime services** (injected)
  - Settings (per session, or per process with session overrides)
  - Logging (per request/session correlation)
  - Persistence (history, settings file)
  - Local machine tools (shell/fs) OR server tools

This repo is already close: `ConversationService` and `OpenAIAgentClient` are the right core-ish units, but they currently depend on global singletons (`settingsService`, `loggingService`) and UI-level message modeling is duplicated.

---

## Phase 0 — Baseline & safety rails (no behavior change)

**Intent**: Make it easy to refactor safely. No architecture changes yet.

### Work items
- Add/confirm a “backend refactor” test run script (optional): e.g. `npm test` already.
- Document the current public backend API used by UI:
  - `ConversationService.sendMessage(...)`
  - `ConversationService.handleApprovalDecision(...)`
  - `ConversationService.abort()`
  - `ConversationService.setModel/ setReasoningEffort/ setProvider`

### Acceptance
- CLI works exactly as before.
- `npm test` passes.

---

## Phase 1 — Create a shared conversation event contract (small, high leverage) ✅ DONE

**Intent**: Stop duplicating message/event shapes between UI and services. This will be the backbone for an HTTP streaming API later.

### Work items
1. Introduce a shared type module, e.g.:
   - `source/services/conversation-events.ts` (or `source/core/conversation-events.ts` if you create `core/` later)
2. Define a stable event union, *transport-friendly* (JSON-serializable):
   - `text_delta` (delta + accumulated optional)
   - `reasoning_delta`
   - `approval_required` (toolName, argumentsText, callId if available)
   - `command_message` (command, output, success, failureReason)
   - `final` (finalText, reasoningSummary?, usage?, etc.)
   - `error` (message, kind)
3. Add a tiny adapter inside `use-conversation.ts` that maps these events to the existing UI `Message[]` list.
4. Keep `ConversationService` public API **unchanged** in this phase; only use the event types internally and/or in tests.

### Notes
- Don’t try to redesign the whole stream yet.
- Keep backward compatibility: `ConversationResult` can remain, but start deriving it from events to avoid drift.

### Acceptance
- CLI behavior unchanged.
- Tests updated/added to ensure event types are emitted in expected order for:
  - normal response
  - approval_required flow
  - abort during approval

---

## Phase 2 — Dependency injection: remove singleton imports from core paths ✅ DONE

**Intent**: Make core session-safe and server-friendly.

### Work items
1. Define minimal interfaces (not concrete singletons):
   - `LoggingService` interface (info/warn/error/debug + correlation id methods)
   - `SettingsService` interface (get/set + “sources” optional)
2. Update constructors to accept deps explicitly:
   - `new OpenAIAgentClient({ model, reasoningEffort, maxTurns, retryAttempts, deps: { settings, logger, editor } })`
   - `new ConversationService({ agentClient, deps: { logger } })`
3. Keep existing singleton exports (`settingsService`, `loggingService`) but move them into a thin composition root:
   - CLI composition already in `source/cli.tsx` — wire deps there.
4. Ensure default behavior still uses the same settings/logging by passing the singletons from the composition root.

### Why this is incremental
- You’re not changing the conversation logic. You’re just replacing imports with constructor-injected dependencies.

### Acceptance
- CLI works.
- Tests pass.
- Add at least one test that constructs `ConversationService` with a fake logger/settings (proves decoupling).

### Implementation notes (what landed)
- `OpenAIAgentClient` accepts injected deps (`deps: { logger, settings }`) instead of importing singletons.
- `ConversationService` accepts injected deps (`deps: { logger }`).
- `source/cli.tsx` wires `SettingsService` + `loggingService` into the composition root.

---

## Phase 3 — Session-scoped runtime wrapper (introduce “ConversationSession”) ✅ DONE

**Intent**: prepare for a server where multiple users have parallel conversations.

### Work items
1. Introduce a new class that owns state currently inside `ConversationService`:
   - `ConversationSession` (or rename existing `ConversationService` if you prefer, but do it carefully)
   - Session owns: `previousResponseId`, `ConversationStore`, pending approval context, abort controller lifecycle
2. Keep a thin `ConversationService` facade for backward compatibility:
   - `ConversationService` can become a factory or manager that creates a single default session for CLI.
3. Add an explicit `sessionId` concept (string) inside the session object (even if CLI uses one session).

### Acceptance
- CLI still uses one session transparently.
- Tests validate two sessions can run without sharing:
  - history
  - previousResponseId
  - pending approval

### Implementation notes (what landed)
- Introduced `ConversationSession` (`source/services/conversation-session.ts`) which owns per-session state.
- Refactored `ConversationService` into a backward-compatible facade that delegates to a single default session (CLI remains unchanged).
- Added isolation tests to ensure two sessions do not share `previousResponseId` or pending approval state.

---

## Phase 4 — Move streaming to an async iterator / event emitter (still in-process) ✅ DONE

**Intent**: make it trivial to bridge to SSE/WebSockets without UI callbacks.

### Work items
1. Add a new API in session:
   - `run(input): AsyncIterable<ConversationEvent>`
   - `continue(approvalDecision): AsyncIterable<ConversationEvent>`
2. Keep the old callback-style API working by implementing it as an adapter over the new event stream.
   - i.e. callbacks subscribe to events.
3. Update `use-conversation.ts` to optionally consume the async iterator directly (or keep callbacks for now).

### Acceptance
- CLI still works.
- Tests cover both APIs (old and new) to avoid regressions.

### Implementation notes (what landed)
- `ConversationSession.run()` and `ConversationSession.continue(...)` stream `ConversationEvent` via `AsyncIterable`.
- The legacy callback-style APIs (`sendMessage`, `handleApprovalDecision`) now adapt over the event stream, keeping the CLI/UI unchanged.
- Added tests that validate event ordering for both normal runs and approval continuations.

---

## Phase 5 — Tooling boundary: separate “local tools” from “server tools”

**Intent**: for a Node server, you may still allow shell/fs tools, but you’ll likely want policy control and safer defaults.

### Work items
1. Introduce a tool registry concept with profiles:
   - `local` (current behavior)
   - `server` (restricted; maybe no raw shell by default)
2. Keep existing tool implementations; just route selection through a factory.
3. Add settings-controlled allowlist/denylist for tools at runtime (session settings override process default).

### Acceptance
- CLI continues using the `local` profile.
- Tests ensure tool registry can build both profiles.

---

## Phase 6 — Introduce a Node server package (API only, CLI still primary)

**Intent**: add backend hosting without touching Next.js yet.

### Work items
1. Add `source/server/` (or `server/`) with a minimal HTTP server:
   - Express/Fastify (pick one; Fastify is nice for perf; Express is ubiquitous)
2. Implement endpoints that wrap sessions:
   - `POST /sessions` → create session
   - `POST /sessions/:id/messages` → start run
   - `POST /sessions/:id/approval` → approve/reject
   - `POST /sessions/:id/abort`
   - `GET /sessions/:id/stream` (SSE) **or** upgrade to WebSocket
3. Reuse the same `ConversationSession` core.
4. CLI remains unchanged (still uses in-process session).

### Acceptance
- CLI still works.
- A simple curl-based smoke test can:
  - create a session
  - send a message
  - receive streamed events

---

## Phase 7 — Stabilize, document, and prepare for Next.js

**Intent**: make the API contract stable enough for a Next.js client.

### Work items
- Write `docs/api.md` describing the event stream and endpoints.
- Add a “golden transcript” test fixture for server streaming ordering.
- Add auth story (even if it’s just a placeholder middleware) and CORS configuration plan.

### Acceptance
- CLI + server both work.
- Contract documented.

---

## Suggested file layout after Phase 4+

This is the *direction*, not a requirement for early phases:

- `source/core/`
  - conversation session runtime
  - conversation events types
  - provider abstractions
- `source/adapters/`
  - local tools
  - editor impl
  - persistence
- `source/ui-terminal/` (optional rename)
  - Ink components/hooks
- `source/server/`
  - HTTP/SSE transport

Do NOT move files early unless it helps; moving too soon creates churn.

---

## Execution checklist (repeat each phase)

For each phase:
1. Implement smallest set of changes.
2. Run `npm test`.
3. Smoke test CLI:
   - send a normal message
   - trigger a tool approval
   - abort and continue
4. Only then start the next phase.

---

## Risk register (things to watch)

- **Global singletons**: break multi-session isolation on a server.
- **Hosted tools** (e.g. `webSearchTool`) may not be interceptable the same way as function tools.
- **Approval flow**: currently depends on injecting tool interceptor results; ensure callId/toolName matching stays consistent across providers.
- **OpenRouter vs OpenAI**: conversation chaining differs; keep that divergence contained in the session layer.
