# Pinned coordinator startup candidate

Inactive deployment sources, retained with the accepted Discord runtime. No files
here install or enable a service. Original candidate and independent acceptance:
`/home/qduc/coord/term2/tasks/discord-durability/startup/`, `startup-recheck.md`.
Those originals remain untouched. This copy changes only `stop_bridge` grace:
8 seconds to 12 seconds, inside the unchanged unit's 15-second outer stop timeout.

## Contract and limits

`startup.py` selects the configured anchor's unique committed rollover lineage via
`lineage.mjs`, then adopts its matching live coordinator or creates a fresh isolated
Herdr pane. The pane execs an explicit passive resume with Discord opt-in. The
launcher checks the kernel peer, exact process binding/current log and real local
`bridge_result` admission before starting its bridge child; no startup prompt is
submitted. Readiness loss stops the child but does not kill the coordinator.
The boot UUID scopes the pair's runtime; ambiguity and corrupt nonempty history
records fail closed for manual reconciliation. `/clear` and unrelated session
switches require stopping ingress and explicitly repinning the new persisted log.
This recovers coord only, not desk, and never replays old admitted work.

The 12-second wait permits the tested single outstanding 10-second GET or POST
deadline and final cleanup. It is not a total tick-duration guarantee: serial
requests, storage stalls and the outer systemd deadline may still force crash
recovery. Preserve the durable journal; interrupted `sending` effects become
uncertain on restart, not permission to re-POST. No new setting, cancellation,
retry, transcript repair or persistence format is introduced.

## Installation remains a separate action

Keep the entire built checkout and its own dependencies; do not rebuild it while
in use. A future private config must select the reviewed absolute `dist/cli.js`
for both entries, actual current persisted anchor, correct private bridge config
and state, and the installed Node/Herdr paths. `config.example.json` is deliberately
inactive and still has placeholders; never run it as production configuration.

Install both helpers as regular files together under the unit's stable
`/home/qduc/.local/lib/term2-coord-startup/`, not links into task artifacts. See the
original candidate README plus `activation-plan.md` for backup, staged copy,
boot-only enablement, shared-Herdr maintenance and rollback constraints. Do not
start a second Herdr over the shared server or install/enable anything as part of
integration verification. A real user-manager/cgroup exercise, no-login reboot,
physical power loss and separately authorized live Discord journey remain distinct
from isolated process evidence.

## Verification provenance

The assembled probe uses real passive Ink TUI, real isolated Herdr, real built CLI
and durable journal, with only Discord HTTP and provider endpoints synthetic.
Evidence and executable probes are retained under
`/home/qduc/coord/term2/tasks/discord-durability/integration-evidence/`.
`grace-red.log` records the original premature kill; `assembled.log` records the
same contract after adjustment. Existing startup process tests run against this
copy and the accepted built CLI, not the old primary build. No permanent unit
suite is introduced here. Independent review of this copied candidate/grace
adjustment is separate from earlier startup and application acceptance.
