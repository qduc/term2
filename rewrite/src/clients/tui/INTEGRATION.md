# Direct TUI integration

The TUI consumes `DirectConnection` and direct wire types from contract commit
`53d0bc767adab83fe91fd78f6c9da463ad7cd1f8`; that commit and its M2 prerequisite
must be integrated before this subtree compiles. It does not import bridge wire,
Session or Engine. `projectSnapshot` and `projectEvent` translate the public
wire to client-only display state. `submitText`, `answerInteraction` and
`cancelForeground` send typed wire commands and surface rejected/unavailable
results. Acknowledgement is not completion. `/compact`, `/retry-turn`, and
`/retry-tool` use typed commands; optional capabilities can return unavailable.

The app must supply the connection, mount `Tui` with theme/skin providers,
handle exit and session replacement, and implement the `TuiIntegration.command`
local/host/config command seam. It must not expose a raw slash-command RPC or
access Session/Engine from the TUI. Unsupported commands must fail visibly. The
hook closes the connection on unmount/replacement without cancelling the session;
the app owns the host and must not share a connection with another consumer.

The local `/answer <interaction-number> <choice-number> [text]` control maps
approval allow/deny and question answer/stop to `WireDecision` with the actual
request ID. Stop uses `answer` plus `stopAfterApprovalResolution`, not approval
denial. It rejects a changed interaction index while an answer is being edited.
This is an interim UI, not parity with full product prompts. Ctrl+G also opens a
keyboard request picker. Foreground input remains available outside the picker.

## Remaining direct contract / app dependencies

- `submit` has no typed delivery selector for steer vs follow-up. Queue edit,
  retract/resume/discard, task controls, configure, rewind, reset/rollover and
  preview are declared, but their optional Session capabilities are not yet
  implemented. The app must supply UI commands, configuration/model catalogs,
  session switching, and global settings/credentials as host/config capabilities.
- The question `input`/`presentation` are generic JSON without typed question
  lists, choices, multi-select, validation or answer schema; the TUI displays
  JSON and accepts a string. It cannot faithfully implement the existing guided
  ask-user flow or typed multi-question answers until C4/Session specify that
  public contract. Scoped approval grants are not currently offered.
- The wire lacks a stable transcript ordering tying tool occurrences/reasoning to
  messages, and reasoning deltas carry neither message ID nor model step. The
  view cannot safely interleave these or prove correct draft/reasoning replacement
  across model steps. It displays tools separately, keys reasoning by turn, and
  requires the owner to supply an explicit ordering/identity/reset contract.
- Rewind/edit/resend parity needs a rewind result containing the original input
  (including attachments), or an app/Session-owned typed equivalent. The current
  `rewind` ack carries no original turn. Session-changing results need the app to
  connect the new session and replace the surface. The current retry capability
  and all optional operations must not claim success until installed.
- Full history fidelity (especially recalling images), terminal-native scrollback
  and complete keyboard/approval UI remain. Markdown uses the product renderer
  and skin gutter. Long activity and interaction panels can exceed terminal height.
- Snapshot seq can be null and replay is not available; do not reuse a cursor or
  replay pre-snapshot events. C4/host own atomic snapshot+live correctness.

No tests, reviews, builds or terminal checks have run; all are deferred until
post-M6. In particular, projection equivalence, background interactions, answer
semantics, editor/input ownership and terminal rendering need real direct-path
verification before M5 parity is claimed.

## Local parity work (unverified)

Ctrl+G opens the request-ID-based approval/question panel; Escape goes back
without discarding the underlying draft. It presents allow, deny, denial reason,
free-text answer and stop; structured multi-question and multi-select still need
the typed question/answer contract. Clipboard image paste uses ink-prompt and
sends direct `WireContent` image attachments. Paste errors and command rejection
are displayed, and attachments stay in the draft on rejection.

`/queue retract <number>`, `/queue edit <number> <text>`, `/queue resume`, and
`/queue discard` send typed queue mutations; unavailable is reported. `/steer`
reports the missing submit delivery selector rather than sending an ordinary
message. The transcript is rendered offscreen at terminal width and browsed by
rows with PgUp/PgDn and Ctrl+Up/Down. Long activity panels can still overflow;
color/terminal rendering and streaming performance require real-terminal checks.

Input history is now stored separately from old CLI history at
`envPaths('term2').data/tui-history-next.json`, using same-directory atomic
replacement. Malformed history is preserved and surfaced as an error. Only text
is persisted (not clipboard images or `/answer` text). Concurrent writers can
still overwrite each other's latest entries; app ownership/serialization is
needed if multiple direct TUIs must share that file without lost updates.
