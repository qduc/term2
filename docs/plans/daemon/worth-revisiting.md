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

10. **Web access to local (unbound) sessions** *(D007, D011)*:
    - The web sidebar now lists a terminal's sessions live under a covering grant,
      but opening one answers 404, because in-process serve never held local
      sessions and widening web authority is the owner's call. A proposed design:
      admit an unbound session to a web caller only under a `read_write` grant
      whose root equals the session root, and on revoke or narrow end the web
      caller's attachments to unbound sessions in that root (they are not closed,
      since a terminal may own them). Without the second half, an attached web
      stream would outlive its grant.

11. **`--issuer` / `--audience` on the serve lease** *(D011)*:
    - The frozen v1.1 `daemon.serve.start` params have no issuer or audience, so
      daemon mode refuses non-default values and points at `TERM2_IN_PROCESS=1`.
      Add them in the next Client API minor revision.

12. **One serve lease per daemon** *(D011)*:
    - Two leases would mean two grant sets authorizing one application. If several
      listeners are wanted (say a socket for the BFF and TLS for a LAN), they should
      share one grant set rather than each carry their own.
    - Related: a daemon store's web sessions are pinned to the first serve state
      directory (`<daemon state dir>/serve-state-dir`). Recording the issuing state
      directory in each session's binding would let one store serve several.

13. **Web sessions without a lease** *(D011)*:
    - With no lease active, the daemon cannot resolve web-bound sessions (their
      grants live in the serve state directory), so they drop out of local listings
      and cannot be opened from the terminal. The TUI resume picker can still list
      one under its root and then fail to open it. Decide whether the owner should
      be able to open web sessions locally without a running serve.

