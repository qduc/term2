# OSC 7501 program status

**Status:** implemented 2026-11-15.

Term2 reports its status to terminals that speak the OSC 7501 program-status
protocol ([spec](https://www.superlogical.com/rex/docs/build/program-status);
implemented by Ghostty/libghostty, Rex and hc). Terminals and multiplexers can
then show whether term2 is working or waiting for a person, without reading
the screen. Claude Code speaks the same protocol.

**Detection.** Status is written only when the terminal answered the
`ESC ] 7501 ; ?` query. `src/clients/terminal-probe.ts` sends it at startup in
the same round trip as the OSC 11 colour query, followed by DA1, so a terminal
that ignores it costs nothing extra (see the theme doc's detection section).
Interactive runs always probe; headless runs probe only when both stdin and
stdout are terminals (for example `hc run term2 "..."`), so piped or redirected
runs never see escape bytes. tmux does not answer, so term2 stays silent there.
Nested term2 runs started by tools have no terminal stdin, so they do not
probe or report over their parent.

**What is reported** (`src/app/application-hooks.ts`, from the root session's
public hook lifecycle; every report carries `app=term2`):

| Term2 | OSC 7501 |
|---|---|
| start | `idle` |
| `idle` / `working` | same |
| `waiting_for_user` | `blocked`, `kind=question` |
| `waiting_for_approval` | `blocked`, `kind=permission` |
| interactive quit | `clear` |
| headless run ends | `done` |
| fatal error | `error` |

**Why exit differs by mode.** The spec makes terminals keep `done` and `error`
after the program exits ("the user has not seen it yet"). A headless result
and a crash are unseen, so they stay. Quitting an interactive session leaves
nothing unseen; reporting `done` there left a stale status on the shell term2
ran in until something cleared it (observed in hc, 2026-11-15), so an
interactive quit removes the record instead, as Claude Code does.

The OSC sequence format and the write queue live in
`src/shared/utils/output/program-status.ts`. Writes are synchronous so the
final report reaches the terminal before the process exits.
