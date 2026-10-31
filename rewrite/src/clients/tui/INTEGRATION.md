# Direct TUI integration boundary

`Tui` is a client surface, not an executable. The app owner must create a direct
host connection, provide a stable `TuiIntegration`, mount `Tui` under the desired
skin/theme providers, handle exit/session replacement, and add CLI wiring. The
hook closes its connection on unmount or replacement, not the session; cancellation
is an explicit action. Do not mount one connection in multiple TUI instances.

C4 must implement the adapter against its **final direct** wire types. The
checked-in protocol is the older bridge projection; it lacks the typed events,
occurrence identities, multiple interactions and command vocabulary needed here.
No bridge implementation is supplied. `submitText` and `cancelForeground` provide
helpers for the shared command shapes present today; C4 must reconcile their result
handling with the final direct types. In particular:

* Snapshot must initialize transcript, status/model, every pending interaction,
  tools, queue, tasks, notices, usage and retry availability. Event updates must
  cover the same state and preserve ordering. Identify drafts by turn and model
  step, and associate a completed message with the matching draft. If the wire
  cannot make that association C4 must supply it; do not guess from text or time.
* Interaction choices must be those the protocol actually supports. Preserve the
  interaction/request identity, owner and decision semantics; resolve questions,
  nested and background approvals through the same typed answer operation. Do not
  translate stop-after-resolution into denial or invent scoped grants.
* Submit, cancel, answer and each existing slash command must use the C4-assigned
  typed operation, or app-owned host/config capabilities as appropriate. Rejected,
  unsupported and stale results must throw an informative error. The adapter must
  not report success before admission/acceptance, implement policy, invoke private
  runtime APIs, or send raw slash text as a generic wire RPC. Session changes
  require the app to attach a fresh connection and replace the component.
* `/answer <interaction number> <choice number> [text]` and `/cancel` are local UI
  affordances; other slash commands are delegated untouched. The input remains
  available for foreground messages when a background interaction is pending.

This is an early, deliberately incomplete surface: no adapter is supplied, so it
cannot claim M5 parity or be launched yet. Full product slash command and modal
behavior, editor history/images, markdown, transcript scrollback/windowing,
keyboard accessibility and terminal resize behavior remain integration work.
Tests, reviews, builds and real terminal checks are deferred until after M6 by
user direction. The existing source input component is coupled to old settings,
logging, history, interaction and runtime services and is not reused; skin and
theme view leaves are reused instead. The C4 projection must determine correct
snapshot/live equivalence and replay ordering; the TUI cannot repair a non-atomic
host attach.
