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
    - **Status: fixed** (`d60623817`). Each create or launch
      now runs its session start inside `DaemonLaunchPolicies.withLaunch`, an
      `AsyncLocalStorage` frame holding its own values. Only a session built inside
      that call adopts them: the session a resume or fork names, else the first one
      built, and nothing once the call returns. A concurrent attach runs in its own
      async context and sees no launch values. Reproduced and covered by the
      dormant-attach case in `tests/host/daemon-unix-conformance.integration.test.ts`.

18. **Resume of a live session kept its earlier launch posture** *(found verifying item 17)*:
    - Launch records were cleared only when a session closed, and a live session
      keeps the surface it was built with. So `term2 --auto-approve "…"` followed by
      `term2 --resume last "…"` without the flag ran the resume with auto-approve.
      Conversely an interactive session resumed headless kept asking for a person
      the headless client never answers, and a terminal resume of a live headless
      session kept its headless (or auto-approve) surface.
    - The comparison must cover the session-only settings a launch applies too:
      after `--approval-mode always` (or `sandboxEnabled: false`), a resume without
      the flag kept them. And the TUI's in-session `/resume` attached without any
      launch, so it bypassed the check entirely.
    - **Status: fixed** (`claude/daemon-headless-resume-posture`). The independent
      verifier rejected the first attempt (`70ada1588`): it gated only the launch,
      so a second launch could reopen the session before the first client attached
      (the first client then ran with a posture it never asked for), it compared only
      the surface flags, and it left `/resume` ungated. Now
      `src/app/daemon/launches/launch-gate.ts`:
      - compares surface flags and the saved approval mode, sandbox and unattended
        escape review against what a fresh session for the launch would get;
      - reopens a differing live session only when nothing uses it, checked and
        closed without yielding (`DirectHost.closeSessionIfUnused`), and refuses
        the launch with `busy` when the session stays wider than asked;
      - leaves a reservation per launching connection: its next attach opens the
        session with the launch's values and is refused if the session runs wider.
        Until then no other launch reopens the session;
      - is used by the daemon TUI's `/resume`, which now launches a resume first.
      A second review found three more gaps, now closed: a launch could loosen
      a session another client had open with its own `approvalMode` or
      `sandboxEnabled` (now `busy`; equal or tighter values still apply); a TUI
      reattaching after a dropped connection attached as a plain viewer (it now
      launches a resume first, with the approval mode and sandbox it last saw);
      and a failed attach left its reservation behind (it is now released).
      A third review found that applying a launch's approval mode compared it with
      the session's accepted configuration while the gate compared the live value,
      which an in-session `/auto-approve` changes alone. So a re-admission mid-turn
      sent a needless configure and the reconnect failed, and an explicit tighter
      mode on an unused session was a no-op whose attach was then refused. The
      apply step now compares the live value too: equal is a true no-op, and a
      different mode lands on the live settings even when the configure has
      nothing to change. A refusal now ends the TUI's reconnect on every path.
      A fourth review found that once a configure has rebuilt a session, its tools
      enforce the copy of its settings that rebuild took: a later live-only
      `settings.update` of the approval mode or sandbox does not reach them before
      the next rebuild, so a resume read a live `off` while `always` was in force.
      Now a session-scoped write of `shell.autoApproveMode`, `sandbox.enabled` or
      `shell.unattendedEscapeReview` on a rebuilt session rebuilds it at once
      (`launchGate.syncEnforced`, the same configure the TUI's own `/auto-approve`
      sends on a rebuilt session), or is refused with `busy` and rolled back while
      it cannot take a configure. A launch's applied settings are synced the same
      way, and the gate compares the values in force
      (`DirectApplication.enforcedSettings`). A rebuilt session's in-session mode
      change therefore needs it idle, as the TUI's rebuild already did. A launch
      the session refuses that way leaves its settings as they were: the values
      it wrote before its configure are restored.
      Rebuilding a live surface in place was not chosen: the runtime captures its
      surface options once, at open. Covered by
      `tests/host/remote-direct-host.integration.test.ts` (built CLI),
      `tests/host/daemon-unix-conformance.integration.test.ts` (live resume,
      launch-then-attach race, session-only settings) and
      `tests/cli/daemon-tui.e2e.test.ts` (`/resume` of a live auto-approve session),
      plus the loosening, re-admit, mid-turn reattach, explicit-mode and
      rebuilt-session cases in the two host suites.
    - Still open:
      - A plain attach with no launch before it (another viewer) sees the session
        as it is.
      - A TUI's re-admission asks for the approval mode it last saw, so it
        tightens a mode another client loosened in the session meanwhile (and is
        refused if it would loosen one tightened meanwhile while that client is
        still there).
      - A launch that sets a different approval mode on a live session it shares
        changes the live value for the other client, and leaves the session's
        accepted configuration (what `/restart` carries) as the configure left it.
      - A launch that leaves its session shared at a narrower posture than asked
        is admitted. If that leaves a headless client with an interactive surface
        and nobody at the other end, its approval waits for a person who is not
        there.
      - A reservation lasts until its connection attaches or disconnects, with no
        timeout.
      - Session settings outside the comparison survive a resume of a live
        session: `sandbox.allowNetworking`, `readPolicy`, `allowReadExtra`,
        `dockerHostControlProjects`, `hooks.*`, `tools.*`. The TUI does not write
        them per session, but a raw v1.1 `settings.update { sessionId,
        persist: false }` does.
      - Serve's web `configuration` and ACP admission read
        `sessionConfiguration().approvalMode`, which for a session never rebuilt
        is the snapshot taken when it opened, not the live mode. The web UI can
        show a stale mode; for ACP admission it is harmless.
      - A `persist: true` session-scoped write refused mid-turn (it needed a
        rebuild) still saves the global preference, and publishes no
        `settings.changed` for it.
      - `/resume` changes: the daemon TUI refuses a target another client is
        using when its posture is looser (or, when the TUI was started with
        `--approval-mode`, one that is mid-turn or has background work, since the
        mode is applied as a configure), and a target in another workspace. These
        match what an in-process TUI refuses (writer lock, `canRun`), but they are
        new for daemon users.

19. **TUI settings projection keeps a stale `rebuilt` flag** *(found verifying item 18)*:
    - After another client's configure rebuilds a session (for example a launch
      with `model` and `reasoning`), the `settings.subscribe` stream a TUI holds
      sends no update, so its projection keeps `rebuilt: false`; a fresh
      `settings.get` reads `true`. The TUI's `/auto-approve` and `/sandbox` then
      skip the rebuild they send on a rebuilt session. Present on `d60623817`.
      Item 18's fix makes the daemon rebuild on such a write itself, so the
      posture holds, but the projection and anything else that reads the flag
      stay wrong until the TUI refreshes it.
