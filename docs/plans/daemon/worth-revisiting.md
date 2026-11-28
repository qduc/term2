# Worth Revisiting (Owner Review List)

Decisions, trade-offs, security questions, and deferred items logged during autonomous execution of the singleton daemon program for the owner to review after the flip.

---

1. **Graduate `src/protocol/client-api/` into `@qduc/agent-wire` (`qduc/agent-runtime`)** *(D006)*:
   - Because `qduc/agent-runtime` is a separate repository outside this run's mounted workspace, the Client API TypeScript schema + Zod-generated JSON Schema are staged in a self-contained module under `src/protocol/client-api/` (zero Term2-internal imports) with generated JSON Schema in `docs/plans/daemon/spec/client-api.schema.json`.
   - When ready to publish `@qduc/agent-wire` publicly, move `src/protocol/client-api/` into `qduc/agent-runtime/packages/wire` and switch Term2/web-client imports to `@qduc/agent-wire`.

2. **Migration of legacy `<data>/gateway-next/conversations` sessions** *(D007)*:
   - Previously `term2 serve` used `<stateDir>/conversations` (`<data>/gateway-next/conversations`) while CLI/TUI used `<data>/conversations-next`.
   - The unified daemon uses `<data>/conversations-next` by default (respecting explicit `--state-dir` / `TERM2_CONVERSATIONS_DIR` overrides). Existing users who have historical sessions in `<data>/gateway-next/conversations` may want a one-time import/merge utility or explicit `--state-dir` note.

3. **TUI `!` bang-shell stays client-local** *(D005)*:
   - Kept local to the TUI process (disabled on SSH) to preserve user shell env and avoid adding an unapproved shell-execution RPC on the Client API. Revisit if remote/web surfaces ever want an explicit user-invoked shell escape.

4. **Omitted v1 Client API verbs cut by Step 9** *(no current scenario)*:
   - `session.delete`, `session.archive`, `session.rename` (titles remain derived from first user message).
   - `queue.reorder` (only `edit`, `retract`, `resume`, `discard` exist).
   - `client.reportPresence` (cross-surface notification suppression when viewing a session on another UI).
   - Dedicated `memory.*` CRUD and `jobs.subscribeOutput` firehose streams.

5. **Background job survival across daemon restart** *(Step 7 Row 11)*:
   - Background tasks survive client disconnect and auto-drain notifications in the daemon, but still terminate on daemon restart (reopening as `interrupted`). True cross-restart survival requires an external process supervisor and belongs with the deferred Execution Environments program.

6. **Per-client `SSH_AUTH_SOCK` forwarding for SSH sessions** *(Step 7 Row 8)*:
   - The daemon inherits its own startup `SSH_AUTH_SOCK`. If a user opens a new terminal with a forwarded SSH agent (`ssh -A`) after the daemon already started, passing a client-local `SSH_AUTH_SOCK` hint (local Unix-socket clients only) may be desirable.

7. **Cross-process lock on `settings.json` when `--in-process` coexists with a live daemon** *(Step 7 Row 16)*:
   - Per-session SQLite writer locks already prevent concurrent writes to the same conversation log between `--in-process` and a live daemon, but `settings.json` remains unprotected against simultaneous writes from an `--in-process` escape-hatch process and a running daemon (matching today's TUI + `serve` posture).

8. **Process-global `AnthropicShellSandboxRunner` (`@anthropic-ai/sandbox-runtime`)** *(Step 7 Row 9)*:
   - `@anthropic-ai/sandbox-runtime`'s `SandboxManager` is process-global and mutates `process.env.CLAUDE_CODE_TMPDIR`. In the daemon, concurrent multi-workspace sandboxed shell calls serialize safely around it; long-term isolation across concurrent workspaces belongs with the deferred Execution Environments / per-workspace sandbox worker.

9. **Daemon startup environment and per-launch overrides** *(Step 14d)*:
   - A later client can start from another shell with different environment
     overrides. Keep the distinction between durable defaults, CLI launch
     choices, and provider credentials explicit in the TUI API review. Review
     the chosen client-visible environment behavior with the SSH agent case in
     item 6.

10. **Custom `--issuer` / `--audience` on `term2 serve`** *(Step 14e Part 1)*:
    - Frozen Client API v1.1 `daemon.serve.start` binds the standard `chatforge-bff` / `term2-gateway` issuer and audience (used by `term2-web` and default `term2 serve`). Deployments overriding `--issuer` or `--audience` fall back cleanly to in-process `term2 serve`. Consider adding optional `issuer` / `audience` fields in a future Client API minor bump if custom BFF deployments need daemon sharing.

11. **ACP version over the daemon** *(D011)*:
    - `clientMode` is only `'acp'`, so the daemon gives every ACP session v2's
      shell behaviour. For v1 that is stricter in Ask, and in Assisted or
      Unattended it would be weaker (a mutating sandboxed command ran unreviewed),
      so the daemon refuses those two modes and points to `TERM2_IN_PROCESS=1`.
      Fixing it needs a Client API change, for example `clientMode: 'acp_v1'` or a
      `shellEscapeApproval` launch flag.

12. **Session lifetime after the last client leaves** *(D011)*:
    - Daemon sessions outlive their client: an ACP session's running turn keeps
      running and a pending permission waits for the next client, where in-process
      exit interrupts them. A TUI session stays live after the TUI exits, so ACP
      cannot resume it until it is closed. Decide whether idle sessions should
      close when their last client detaches.

13. **Session titles from the daemon index** *(D011)*:
    - Daemon clients see the session index's title (first line, up to 120
      characters) rather than the store's normalized 60-character title. Affects
      every daemon client; a `shortTitle` field or index change would fix it.

14. **Control socket runtime directory** *(D011)*:
    - The socket lands in the daemon's `XDG_RUNTIME_DIR`. The frozen bind params
      carry no runtime directory, so a TUI started with a different value does not
      find its socket where its own `term2 control` looks (`/bridge status` shows
      the real path). A future schema revision could add the field.

15. **Control socket handoff exposure** *(D011)*:
    - For up to 30 s after `/restart`, the paused socket still answers read-only
      `status`/`get` with no TUI behind it; in-process the socket vanishes during
      the exec. The handoff lease id works as a bearer token for any same-user
      daemon connection that can read the replacement's environment. Same user
      only, who can already reach both sockets.

16. **Two TUIs on one session** *(D011)*:
    - In-process, the writer lock meant at most one control socket per session.
      Over the daemon two TUIs can each bind one; Discord send then uses the
      first opted-in live socket bound to that session. Confirm that rule.

17. **Daemon-wide pending launch values** *(found verifying D011; code from Part 1)*:
    - `DaemonLaunchPolicies` (formerly inline in `daemon.ts`) keeps one pending
      approval policy and one pending flag set for the whole daemon. Launches are
      serialized, but a plain `session.attach` that opens a dormant session during
      a launch can adopt that launch's values. For ACP this only makes a session
      stricter or causes a spurious `busy`, but a concurrent headless launch's
      `approvalPolicy { autoApprove }` could reach the attached session. Keying per
      launch needs the new session id before `createSession` returns it. Fix before
      the Step 14f flip.
    - **Status: fixed** (`claude/daemon-launch-policy-race`). Each create or launch
      now runs its session start inside `DaemonLaunchPolicies.withLaunch`, an
      `AsyncLocalStorage` frame holding its own values. Only a session built inside
      that call adopts them: the session a resume or fork names, else the first one
      built, and nothing once the call returns. A concurrent attach runs in its own
      async context and sees no launch values. Reproduced and covered by the
      dormant-attach case in `tests/host/daemon-unix-conformance.integration.test.ts`.

