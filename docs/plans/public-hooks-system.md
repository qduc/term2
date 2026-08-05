Status: plan. Waiting on implementation; no hook loading or public lifecycle contract exists yet.

# Public hooks system implementation plan

## Goal

Add a small, versioned, user-facing hook system for Term2. Version 1 exposes 11 semantic lifecycle events, supports executable TypeScript hook files in user and project directories, and keeps the public contract independent from provider frames, UI events, durable logs, and internal runtime refactors.

The first concrete consumer is Herdr status synchronization. The same surface should also support notifications, audit logging, telemetry, narrow pre-tool policy, and approval policy without turning Term2 into a general plugin platform.

## Scope

### Version 1 events

```ts
type Term2HookEventName =
  | "session.start"
  | "session.end"
  | "status.change"
  | "turn.start"
  | "turn.end"
  | "turn.error"
  | "tool.before"
  | "tool.after"
  | "tool.error"
  | "approval.requested"
  | "approval.resolved";
```

Version 1 deliberately excludes compaction hooks. Term2 does not currently have one stable application-owned compaction lifecycle that would justify a public contract. Add `compact.before` and `compact.after` later only when that lifecycle has a clear owner.

### Non-goals

- No plugin SDK, custom tool registration, UI extension API, provider-frame access, or arbitrary internal event subscription.
- No automatic promotion of `ConversationEvent`, log events, queue events, or provider events into public hooks.
- No tool-argument mutation or tool-result replacement in version 1.
- No remote hook discovery from an SSH target in version 1. Hooks execute locally in the Term2 process and describe the local Term2 session, even when tools execute through an SSH execution context.
- No hot reload. Hook files are discovered and loaded once during startup.
- No delivery guarantee across process crashes. Hooks are live lifecycle callbacks, not a durable queue.

## Contract decisions

### Installation and precedence

Discover files in this order:

1. User hooks: `~/.term2/hooks/*.{js,mjs,ts}`.
2. Project hooks: `<session cwd>/.term2/hooks/*.{js,mjs,ts}`.

Sort paths lexicographically within each scope and register callbacks in load order. Project hooks run after user hooks. Files do not override one another by basename; every discovered file is loaded. Symlinks are rejected so discovery cannot silently escape the reviewed hook directory.

`~/.term2/hooks` matches the existing user-authored skill convention at `~/.term2/skills`; it does not change the existing `SettingsService` location. Put path construction in a hook discovery module rather than reusing skill discovery, because executable code has different trust and validation requirements.

### Module shape

Each file must default-export a registration function:

```ts
export default function register(term2: Term2Hooks): void | Promise<void> {
  term2.on("status.change", async event => {
    // Translate Term2 status for an external status consumer.
  });
}
```

`Term2Hooks.on()` returns an unsubscribe function. Registration is only valid while the module's default export is running; retaining the registrar and adding callbacks later is rejected. This makes startup deterministic and avoids partially registered modules.

Use a small production TypeScript loader dependency such as `jiti` behind a `HookModuleLoader` interface. Do not depend on the repository's development-only `tsx` runner or expose the loader as part of the public API. JavaScript and TypeScript files use the same contract. Publish generated declarations through an `@qduc/term2/hooks` package export and generate a small `term2-hooks.d.ts` shim plus `tsconfig.json` path mapping in each hook root so editor/type resolution works even when Term2 is installed globally. Runtime loading must erase type-only imports and must not depend on bare-package resolution from the hook directory.

### Trust model

Hook files are trusted, in-process code with the same OS permissions as Term2; they are not sandboxed by tool approval or the shell sandbox. State this in startup diagnostics and documentation.

- User hooks are trusted by virtue of residing in the user's own config directory.
- Project hooks are disabled by default.
- Add a persisted settings entry containing trusted canonical project roots, and a CLI/settings control to trust or revoke a root. Trust is granted to the canonical root, not to individual filenames or content hashes.
- Treat every discovered user or project hook directory as a protected write target in the file-tool approval policy. `create_file`, `apply_patch`, and any other Term2 write tool must require explicit approval for writes that create, update, rename, or remove hook files even when the directory is physically inside the workspace. Add the check at the shared path-policy boundary so future write tools inherit it. Root trust permits loading; it never grants silent model writes.
- Non-interactive mode must fail closed for an untrusted project: skip project hooks, emit a diagnostic, and continue with user hooks. It must never prompt on stdin unexpectedly.
- Interactive startup may offer one explicit trust prompt listing the canonical project path and discovered files. Declining skips all project hooks for that run and does not persist trust.
- Loading errors are isolated per file. A malformed or throwing file is reported with its path and skipped; it does not prevent other files or Term2 itself from starting.

Persisting trust by project root avoids repeated prompts for ordinary hook edits while making the security boundary explicit. This is equivalent to trusting a repository's executable development configuration, not approving one immutable artifact.

User hooks remain implicitly trusted in version 1, including non-interactive/CI runs, because they are host configuration rather than repository content. Document that CI images and shared homes must disable user hooks with a setting or use an isolated home. Provide `hooks.user.enabled` and `hooks.project.enabled` switches, both honored before discovery; project hooks still additionally require root trust.

### Event envelope and correlation

Every event carries:

```ts
interface HookEventBase<Name extends Term2HookEventName> {
  type: Name;
  schemaVersion: 1;
  eventId: string;
  sessionId: string;
  timestamp: number;
  scope: "root" | { subagent: { agentId: string; role: string } };
  turnId?: string;
  toolCallId?: string;
}
```

Use application-generated opaque IDs. A `turnId` identifies one logical admitted user turn across provider retries and approval continuations. A `toolCallId` correlates the tool and approval lifecycle. Do not expose `TurnLease`, generation counters, provider response IDs, or queue position as public identity.

Payloads:

- `session.start`: cwd, interactive/non-interactive mode, provider name, model name.
- `session.end`: reason (`normal`, `fatal_error`) and session duration. It represents actual root runtime shutdown only; reset, undo, and provider/model changes do not end the session.
- `status.change`: previous/current public status and a stable reason enum.
- `turn.start`: normalized turn origin (`user`, `queued`, `approval_continuation`) and optional user text. Make user text opt-in through a hook setting because it can contain secrets.
- `turn.end`: terminal kind (`response`, `approval_required`, `stale`, `failed`) and duration. An approval pause emits `turn.end` with `approval_required`; its continuation reuses the same `turnId` and does not emit a second `turn.start`.
- `turn.error`: normalized error category, safe message, and recoverability. Do not expose stack traces unless debug logging is enabled.
- `tool.before`: tool name, normalized arguments, attempt number, and ownership (`root` or subagent metadata).
- `tool.after`: tool name, duration, and normalized result summary. Full tool output is opt-in because it can contain secrets or be very large.
- `tool.error`: tool name, duration, normalized error category/message, and whether the failure was converted into a model-visible result.
- `approval.requested`: tool name, normalized arguments, approval kind, and current proposed decision.
- `approval.resolved`: resolution (`approved`, `rejected`, `aborted`, `auto_approved`), source (`user`, `policy`, `system`), and whether execution followed.

Public status is intentionally coarser than `TurnStatusMachine.SessionStatus`:

```ts
type Term2Status =
  | "idle"
  | "working"
  | "waiting_for_user"
  | "waiting_for_approval";
```

Map both `streaming` and `continuing` to `working`. `waiting_for_user` covers an active `ask_user` interaction, not an empty input prompt. Because `TurnStatusMachine` cannot distinguish `ask_user` from ordinary approval, compose public status in a root lifecycle observer that sees both the internal status and pending tool metadata. `TurnStatusMachine` reports internal transitions to that observer but is not the sole public emitter. Suppress duplicate transitions when two internal states map to the same public status. Turn failures are represented by `turn.error` followed by ordinary transition to `idle`, not by a synthetic status.

### Version 1 hooks are observational

Every version 1 callback has the return type `void | Promise<void>`. `tool.before` runs immediately before actual execution, after arguments are normalized and approval has been resolved; it cannot deny or mutate the call. `approval.requested` observes only requests that will be presented to a user. Auto-approval produces `approval.resolved` with source `policy` and no preceding `approval.requested`; this asymmetry is explicit so consumers do not maintain an invalid one-to-one pairing assumption.

Decision-capable tool and approval hooks are deferred until there is a concrete consumer and a separately reviewed safety contract. Reserving observation-only callbacks now avoids putting timeout, precedence, cancellation, and hard-safety override semantics on every tool call.

### Failure, timing, and recursion policy

- Await callbacks so lifecycle order is deterministic.
- Catch and log every callback failure with hook file, event type, and callback index. Passive hook failures fail open.
- Apply a configurable per-callback timeout with a conservative default (5 seconds). A timeout stops waiting but cannot cancel arbitrary in-process code; log that limitation. Since version 1 is observational, timeout and failure both fail open.
- Hook callbacks may use normal Node APIs, but hook activity does not recursively emit Term2 tool events because it does not execute through the Term2 tool registry.
- Delivery is at-most-once within a process for a given `eventId`. Approval replay and continuation must consult the existing call/approval ledgers so they do not duplicate request or resolution events.

## Architecture

### New hook module

Create a cohesive `source/services/hooks/` module:

- `hook-contracts.ts`: exported names, payload union, status/reason enums, type guards, and schema version.
- `hook-registry.ts`: registration, unsubscribe, ordered passive dispatch, timeout/error isolation, and source metadata.
- `hook-discovery.ts`: canonical user/project paths, deterministic scanning, extension filtering, symlink rejection, and trust filtering.
- `hook-module-loader.ts`: `jiti`-backed external module loading and default-export validation.
- `hook-service.ts`: startup orchestration and the narrow runtime port (`emit`, `shutdown`). It owns loaded module cleanup and diagnostics.

This module earns a separate boundary because it hides executable-code discovery, trust, ordering, timeout, and failure-isolation policy. Lifecycle owners receive only the narrow port and must not know how files are loaded.

### Composition and lifecycle ownership

- In `source/cli.tsx`, construct and initialize `HookService` after settings/session context are available and before creating the session runtime. The same instance is used by interactive and non-interactive composition.
- Extend `CreateConversationSessionOptions`/`CreateSessionRuntimeInternalsOptions` in `source/services/session/session-composition.ts` with a hook lifecycle port. Keep a no-op implementation for tests and callers that do not configure hooks.
- Expose runtime registration only if needed for first-party embedding; file hooks should be loaded at the CLI boundary. Do not put hook loading in `ConversationAdapter`.
- Add an internal-transition observer to `source/services/session/turn-status-machine.ts`; it remains the sole owner of internal status mutation. A root lifecycle observer combines those transitions with pending tool metadata to emit public status, including `waiting_for_user` for `ask_user`.
- Have `source/services/session/turn-coordinator.ts` own normal `turn.start`, `turn.end`, and `turn.error` emission. Route the direct turn termination paths in `SessionLifecycle.resetSession()`, `afterProviderChanged()`, `afterUndo()`, and `afterToolRetry()` through a coordinator-visible termination method so each admitted turn closes exactly once even if its generator is no longer drained.
- Reserve `session.end` for actual root runtime shutdown. Add an awaited `SessionRuntime.shutdown(): Promise<void>` (or make `dispose` async consistently), update all callers, and have `runNonInteractive` await shutdown before `cli.tsx` calls `process.exit`. Startup composition emits `session.start` only after hook registration succeeds and the runtime is ready.
- Install the full lifecycle port only on the root runtime. Subagent-created `SessionRuntime`s do not emit independent session/status/turn lifecycles in version 1, preventing Herdr status flapping. Root-observed nested tool events carry `scope.subagent` so they do not imply a phantom nested `session.start`.
- Do not derive these events from `ConversationLogger`, `ConversationEvent`, or `TerminalResultCollector`; those protocols have different persistence and UI semantics.

### Tool and approval ownership

The application-owned execution seam is `source/services/agent-runtime/application-run-loop.ts#invokeTool`; it calls the definitions wrapped by `source/lib/agent-factory.ts`, so those are nested layers, not independent execution paths. Avoid instrumenting both and avoid the stream processor, because a streamed tool proposal is not an actual execution.

1. Introduce one narrow observational `ToolExecutionLifecyclePort` in `source/tools/types.ts` (or a neighboring contracts file) with before/after/error methods.
2. Inject it into `ApplicationRunLoopDeps` through the existing composition root; do not inject it into `AgentFactoryDeps`.
3. Instrument `application-run-loop.ts#invokeTool`, including the resumed-approval invocation currently performed while applying an approval decision. Preserve the distinction between propagated cancellation/invariant failures, wrapper interceptor rejections returned as synthetic failure results, and exceptions converted to model-visible results. Classify interceptor rejection at the run-loop boundary; do not add a second emitter inside `agent-factory.ts`.
4. Instrument approval lifecycle at `source/services/approval/tool-approval-batch-coordinator.ts`. In `stageBatch`, emit `approval.requested` immediately before the `decision === "prompt"` presentation branch. Emit `approval.resolved` where the decision is committed, and carry an explicit source (`user` or `policy`) instead of inferring it from the normalized `"y"`/`"n"` continuation answer. Auto-approved calls emit only `approval.resolved`.
5. Keep `ApprovalFlowCoordinator` responsible for consuming committed continuation answers; do not treat it as the prompt-vs-policy decision owner.
6. Include ownership metadata from `ToolOwnershipRegistry` so root and nested calls share one contract without exposing separate event names.

## Implementation sequence

1. **Pin the contract with tests.** Add compile-time and runtime contract tests for all 11 payload variants, root/subagent scope, correlation requirements, callback ordering, timeout behavior, and failure policy.
2. **Add discovery, trust settings, and write protection.** Extend the settings schema/defaults/persistence with user/project enablement, trusted project roots, payload privacy flags, and timeout. Add canonicalization and path tests for macOS/Linux semantics, missing directories, symlinks, duplicates, and project trust. Extend the shared file-write approval policy so all hook-directory writes require user approval.
3. **Add external module loading.** Add `jiti` as a production dependency, validate default exports, attach source metadata to registrations, and test `.js`, `.mjs`, and `.ts` fixtures plus syntax/registration failures.
4. **Wire startup.** Initialize `HookService` in `cli.tsx`, add interactive trust resolution, define non-interactive skip behavior, and ensure partial startup failures are diagnostic rather than fatal.
5. **Add root session and status events.** Instrument `TurnStatusMachine`, `TurnCoordinator`, `SessionLifecycle`, and awaited runtime shutdown. Introduce one logical `turnId` at admission, preserve it through retries and approval continuation, and route all lifecycle abort paths through exactly-once turn termination. Keep nested runtimes out of root session/status/turn emission.
6. **Add tool lifecycle events.** Instrument `ApplicationRunLoop#invokeTool` once. Ensure unknown tools, interceptor rejections, thrown tools, converted errors, cancellations, repeated failures, post-execute policies, and nested tools each have specified terminal behavior.
7. **Add observational approval events.** Instrument `ToolApprovalBatchCoordinator.stageBatch` at prompt presentation and decision commit, carry decision source explicitly, and test auto-approval's resolution-only behavior.
8. **Add the Herdr example.** Add a documented sample hook translating `status.change` to Herdr without adding Herdr-specific code to the runtime.
9. **Document and export.** Add `package.json` `exports` and `types` metadata for an `@qduc/term2/hooks` declarations-only subpath, generate hook-directory editor shims/path mappings, and export only hook author types and registration interfaces. Document trust, write protection, CI user-hook disablement, ordering, privacy defaults, observational-only semantics, local-vs-SSH behavior, and versioning.
10. **Run broad validation.** Because this changes the run loop, provider bridge behavior, approvals, and non-interactive startup, run focused hook/session/approval tests, the full unit suite, typecheck, lint, build, and the provider black-box suite.

## Test plan

### Unit tests

- `source/services/hooks/hook-registry.test.ts`: registration order, unsubscribe, duplicate callbacks, failure isolation, timeout, and event IDs.
- `source/services/hooks/hook-discovery.test.ts`: path order, lexical file order, extension filtering, missing directories, canonical roots, symlink rejection, user/project scope, and untrusted projects.
- `source/services/hooks/hook-module-loader.test.ts`: valid JS/TS modules, async registration, missing/default-export errors, syntax errors, and partial registration rollback.
- Extend `turn-status-machine.test.ts`: all internal-to-public mappings, duplicate suppression, error-to-idle sequence, approval wait, continuation, abort, and stale lease behavior.
- Extend `turn-coordinator.test.ts`: one logical turn ID through retries/continuation, exact start/end/error cardinality, approval-required terminal, abort, and stale outcome.
- Extend `application-run-loop.test.ts`: before/after/error ordering, interceptor rejection, thrown and converted errors, cancellation, post-execute behavior, resumed approval execution, exactly-once invocation events, and result privacy. Keep `agent-factory.test.ts` as a regression check that wrapper behavior is unchanged and does not emit hooks independently.
- Extend `tool-approval-batch-coordinator.test.ts`: requested-at-prompt timing, explicit user/policy resolution source, auto-approval without a request event, rejection, multiple pending calls, and call-ID correlation. Extend `approval-flow-coordinator.test.ts` only for downstream continuation compatibility.

### Integration and end-to-end tests

- Interactive startup with user hooks, trusted project hooks, declined trust, broken hooks, and deterministic combined ordering.
- Non-interactive startup skips untrusted project hooks without reading stdin and still loads user hooks.
- A fixture hook records the applicable lifecycle events for a successful turn, failed turn, approved tool, rejected tool, and nested tool; it does not assume all 11 fire in one run or that every resolution has a request.
- Queue a turn and verify `turn.start` occurs when execution begins, not when queued.
- Run through SSH mode and verify hooks execute locally with the intended local session cwd metadata.
- Build/install the packaged CLI and load a `.ts` hook to prove the loader is a production dependency rather than a development-only accident.
- Provider black-box scenarios must retain existing tool and approval wire behavior; hooks observe but do not alter provider protocol shapes.

## Data flow

1. CLI resolves the canonical cwd and settings.
2. Discovery finds user hooks and, only for a trusted root, project hooks.
3. The module loader evaluates each file and registers typed callbacks in deterministic order.
4. `HookService` is injected into the session and tool execution composition roots through narrow ports.
5. Lifecycle owners create schema-versioned events with session/turn/call correlation IDs.
6. The registry awaits callbacks and isolates failures; version 1 does not accept behavior-changing responses.
7. Existing status, approval, and tool owners continue committing their own decisions through current state machines and ledgers.
8. Hook diagnostics go through `LoggingService`; hook events themselves are not automatically written to the conversation log.

## Edge cases and failure modes

- **Retries:** reuse `turnId`; increment `attempt` on tool payloads; do not emit another `turn.start` for an internal provider retry.
- **Approval continuation:** reuse both `turnId` and `toolCallId`; emit exactly one requested and one resolved event per approval generation.
- **Multiple pending approvals:** correlate exclusively by `toolCallId`; never infer identity from array order.
- **Unknown tool:** no `tool.before`, because no physical invocation occurs. Do not emit `tool.error`; the existing model-visible unknown-tool result remains outside physical execution lifecycle.
- **Nested/background agents:** root session/status/turn hooks are not installed into nested runtimes. Root-observed nested tool events include `scope.subagent`. Background tool activity may occur after foreground `turn.end` but before `session.end`; hooks remain active until awaited root shutdown.
- **Session reset/provider change:** do not emit `session.end`; the existing session ID remains live. Status/turn events continue under it, with reset/provider-change reasons where applicable.
- **Turn termination outside normal draining:** reset, provider change, undo, and tool retry notify the coordinator-visible termination owner synchronously before invalidating the lease, guaranteeing one `turn.end` with a real `TurnOutcome` terminal kind.
- **Process signals/fatal crashes:** make best effort to emit `session.end`; do not claim delivery if Node cannot drain callbacks.
- **Sensitive payloads:** user text, full arguments, and full outputs are redacted or summarized by default. Hook settings must opt into each full-content class explicitly.
- **Slow hooks:** timeout and continue; log duration and source without including sensitive payloads. The timed-out callback may still run because in-process promises cannot be forcibly cancelled.
- **Hook changes during a run:** ignored until next startup.

## Acceptance criteria

- A TypeScript file in the user hook directory can observe `status.change` in both interactive and non-interactive Term2.
- A project hook never executes before its canonical project root is explicitly trusted.
- All 11 events have exported discriminated payload types with `schemaVersion: 1`, stable session correlation, and documented timing.
- Every actual tool invocation emits exactly one `tool.before` and exactly one of `tool.after`/`tool.error`; approval pauses and replay do not duplicate them.
- Version 1 hooks cannot alter tools or approval decisions. Existing safety and approval behavior is unchanged.
- Any Term2 file-tool write into a user or project hook directory requires explicit user approval, including writes inside the active workspace.
- Hook exceptions, invalid modules, and timeouts cannot crash the session; their fail-open/fail-closed behavior matches this plan.
- User/project ordering is deterministic and verified against the packaged CLI.
- Existing conversation events, durable history, approval behavior, provider wire contracts, and non-interactive output remain backward compatible when no hooks are installed.
- Focused tests, full tests, typecheck, lint, build, and `pnpm test:provider-black-box` pass.

## Assumptions and risks

- Executing TypeScript in process is accepted as trusted-code execution. A real security sandbox would be a separate project and would materially change the API and implementation.
- Adding a production TypeScript loader increases startup and dependency surface; packaged-CLI tests are mandatory.
- The current dual tool execution paths create the largest exactly-once risk. Instrumenting shared low-level invocation seams is preferable to inferring completion from stream events.
- Public status loses some internal detail by design. Consumers needing queue, provider, token, or stream details should use separate machine-readable runtime protocols rather than expanding this hook contract.
- The exact interactive trust UI should follow existing prompt and settings patterns discovered during implementation; the security semantics above are fixed even if presentation changes.

## Deferred extensions

- `compact.before` / `compact.after` once compaction has a stable application owner.
- Decision-capable `tool.before` and `approval.requested` hooks, after a separately reviewed precedence, timeout, cancellation, and hard-safety contract has a concrete consumer.
- Content-hash trust, signed hook packages, or an isolated worker-process sandbox.
- Hot reload and hook management commands.
- Tool argument mutation, result replacement, environment injection, custom tools, and UI extensions.
- A richer machine-readable event stream separate from the small public hook contract.

