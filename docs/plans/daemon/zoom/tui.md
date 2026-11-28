# Step 14d TUI zoom-in

Baseline is the merged Step 14b–14c implementation (`7a2c636c0`). An independent
design review traced the interactive launch path through `launch-tui.tsx`, the
TUI integration, commands, settings, menus, restart and control adapter, and
compared it to the Unix client and Client API v1.0.

## Submodule boundaries

| Submodule | Contract |
| --- | --- |
| Terminal and Ink client | Keep existing input ownership, rendering, presentation hooks, slash-command flow, usage output, and native restart instructions. Keep clipboard, terminal probes, and local `!` on the client per D005. |
| App-layer TUI backend | Supply session creation, attachment and selection; presentation preferences; product operations; and client lifecycle. The existing in-process backend keeps its live services. A daemon backend gets state and results from the host and exposes the same intent to the UI. |
| Client attachment | Maintain a snapshot at a known accepted batch boundary. Detach only the client view. On transport failure, reconnect to the same logical session, replace transient state, and settle uncertain commands by receipt where supported. Explicit session close and workspace revocation are terminal. |
| Daemon workspace and session catalog | Accept local CWD under owner authority. Resolve stable opaque workspace IDs from the same scope used by session listing. Resolve file and skill reads against the selected session or known workspace. Preserve the TUI launch workspace boundary for resume and fork. |
| Daemon runtime and configuration | Own settings writes, credentials, providers, hooks, MCP, session configuration, goal changes, and background notifications. Carry launch overrides into the session without changing global defaults. Send UI-safe live state and receipts. |

## Review findings and migration order

1. Finish the attachment and workspace seams against v1.0. The baseline remote
   cut pairs an old snapshot with a new ordinal, and a detached transport cannot
   recover on its own. The session index emits workspace aliases that create
   cannot resolve. File and skill reads need to address the selected workspace.
2. Draft the smallest Client API revision needed for parity. Named-model
   handoff must install the target during successor creation. The resume menu
   needs the signal it uses to exclude empty conversations. The TUI needs
   effective per-session settings and accepted revisions in addition to the
   redacted global web settings projection. Define exact launch configuration
   semantics, review the proposed changes independently, then freeze and
   negotiate the new revision before depending on it.
3. Implement frozen v1.0 operations absent from the baseline, including
   server-resolved skills and goal/approval configuration. Use the existing
   session authority and mutation paths. Route MCP and hooks through the host,
   with workspace ownership and process lifetime defined at composition.
4. Wire the TUI launcher through the daemon backend. Let it own reconnect and
   client-only restart. Disable client-driven background draining in daemon
   mode. Keep control and Discord ownership work visible in Step 14e.

## Acceptance evidence

- Run the built CLI in a PTY with an isolated daemon and assert the attached
  session from another client, so an in-process fallback fails the check.
- Attach two clients, detach one mid-turn, recover after connection loss, and
  check the accepted transcript and the provider's submission count. Replay
  must not repeat terminal notifications. Race approval answers and verify one
  settlement.
- Compare launch overrides, resume picker, file/skill scope, provider/settings
  edits, MCP, cancellation, background notifications, and restart against the
  in-process entry point. Use separate daemon startup and workspace CWDs.
- Run the existing TUI end-to-end cases in both modes. Record any parity
  differences before the default flip.
