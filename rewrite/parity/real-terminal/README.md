# Real-terminal check

Flip gate item 5 of #65 (issue #140): run legacy term2 (`dist/cli.js`, the spec) and term2-next
(`rewrite/dist/rewrite/src/app/cli.js`) side by side in a real terminal emulator and show whether a user could
tell them apart, by what they see or by how fast they react. The pyte/pty captures and headless goldens in
`rewrite/parity/` compare text; this check compares the rendered terminal and the time to paint.

This is a tool you run by hand or as a queued job. It is not a CI test (a full run takes about an hour), it
adds no unit tests, and it does not change product code. It uses only the loopback fake provider.

## One command

```sh
node rewrite/parity/real-terminal/run.mjs --out <dir> [--store <dir>]
```

On a fresh checkout it installs dependencies and builds whichever CLI is missing, generates a synthetic store
into `<out>/store` when `--store` is omitted, and writes `<out>/report.html` (side-by-side screenshots, diffs,
latency tables, gate verdicts) and `<out>/results.json` (every sample).

| Option | Meaning |
| --- | --- |
| `--store <dir>` | Conversation store. Legacy reads `<dir>/conversations`, term2-next reads `<dir>/conversations-next`, the same names both CLIs use under their data directory, so a team member can pass their own term2 data dir (on Linux `~/.local/share/term2-nodejs`). Every CLI run works on a private copy; the given store is never written. |
| `--workspace <dir>` | The CLIs' working directory. Default `<store>/workspace` when present (generated stores put most sessions there), otherwise a scratch project. With a real store, pass the project your sessions belong to. |
| `--sizes 100x34,80x24` | Terminal sizes. |
| `--quick` | A quarter of the samples. A smoke run, not gate evidence. |
| `--only latency\|walk` | One half of the run. |
| `--soak <file>` | JSON array of soak differences to list in the report. |
| `--store-mb <n>` | Size of a generated store, per format (default 420). |

Check the load average the report prints; rerun any measurement taken above load 9.

## What it does

**Terminal** (`lib/terminal.mjs`, `lib/page.html`). Each CLI runs in a pty (node-pty; this environment has no
sshd, so the ssh-to-localhost path is not used). Its bytes stream over SSE into xterm.js (DOM renderer) in
headless Chromium. Everything the harness judges is read back from xterm.js: buffer text, rendered pixels.
`calibrate()` measures the harness floor with `cat` (raw echo) through the same path; it is about 3 ms.

**Isolation** (`lib/env.mjs`, `lib/session.mjs`). Each CLI gets its own scratch `HOME`, `XDG_*` dirs, settings
pointing at its own fake provider, and a copy of the store. Both CLIs get the same scripted model
(`scriptedModel`), so the same prompt gets the same reply. Keys are typed one per write, as a person types:
both CLIs treat a multi-character write ending in CR as a paste, and legacy then inserts a newline instead of
submitting.

**Store** (`generate-store.mjs`, `lib/record-templates.mjs`). The generator first drives each CLI in a pty
against the fake provider to record a template conversation (a small and a large shell output, a 40-delta
streamed reply, a plain turn and a manual `/compact`). It then clones those blocks with fresh ids, timestamps
and `seq` numbers, so every line has exactly the shape that CLI writes, including how each caps a large tool
output and term2-next's `refs` that point at earlier `seq`s by offset. Both formats are written in lockstep from
one seeded plan (the same sessions, projects, times and turns), and generation stops when both reach the size
floor. A generated store holds about 1,400 sessions and one long session with large tool outputs, a compaction
every 40 blocks and one reply of 200,000 deltas. Nothing comes from a real conversation. term2-next refuses a
conversations directory with foreign entries, which is why the two formats live in separate directories.

**Latency** (`lib/latency.mjs`). For each class (typed character, backspace, Enter on the composer, an arrow in
the model menu and in the resume list, Ctrl+O, Shift+Tab, opening `/model` and `/settings`, paging the resume
list), idle and while a reply streams: the page timestamps the key, posts it to the pty, and stops at the first
xterm.js render whose screen satisfies the class predicate. Typing classes look at the composer row; the others
look at the rows below the streamed text (status row and elapsed-time rows excluded), with the baseline taken on
the page at the instant of injection. CPU per key is the CLI process tree's utime+stime and bytes per key is pty
output, both over injection to paint + 100 ms. Every sample starts from the empty composer with no menu open. A
key whose expected change never paints within 5 s is a miss, and the screen at the timeout is kept for the
report. Separately, **store timings** record startup and the first and second `/resume` until the list paints.

**One timeout: 5 s** (`PAINT_TIMEOUT_MS`). Every expected screen (a key's paint, the resume list, a walk step)
either appears within 5 s or fails; the harness never waits longer to find out how slow it was. A failure must
not leak into later samples, so when a CLI no longer gets back to the empty composer (a frozen UI that may still
paint later), the harness replaces it with a fresh CLI on the same home and store copy and goes on. A resume list
that does not paint fails all of that phase's resume-list keys without sending them. Startup alone may take a
minute: it is reported, not gated.

**Walk** (`lib/walk.mjs`). The same 30 steps for both CLIs: startup, a markdown turn, a tool call, an approval
prompt and approval, the slash and path menus, `/model`, `/settings`, Ctrl+O, Shift+Tab, `/help`, `/resume`
with a preview, a resize and back, the Ctrl+C confirmation, and exit. Before each screenshot, cells matching the
masks are painted grey: version, ids, paths, ports, durations (including wall-clock times and relative ages)
and spinner frames. Nothing else is masked.

**Report** (`lib/report.mjs`). Pixel diff of each pair in Chromium (canvas, exact RGB compare), the differing
text rows, and the gate:

- latency per class within 1.2x legacy or 5 ms of it, at p50 and p95, and no key over 200 ms;
- screenshots identical apart from the masks;
- every soak difference fails unless it is on the accepted-differences list (there is none yet), and is
  listed as unexplained.

**Soak** (`soak.mjs`, `SOAK-BRIEF.md`). Two live terminals, A and B (randomly assigned, mapping kept from the
agent), and a small command for a context-free agent to type, read screens, take screenshots and resize.

## Debugging traps found while building it

- A whole string in one pty write is a paste. Legacy turns a trailing CR in a paste into a newline.
- Escape while a reply streams arms "Press Esc again to interrupt"; a second Escape cancels the reply. The
  harness never sends Escape when the composer is already home.
- Legacy lists queued steers between the separator and the input row; the composer is the last `❯` row below
  the separator, not the row right after it.
- Manual `/compact` needs `agent.contextCompaction.compactThresholdTokens` and `agent.maxRequestInputTokens`
  for an uncatalogued model, and term2-next's local compaction request is recognised by `# Historical
  transcript chunk`, not the `[Host context-compaction request]` marker.
- A rewrite that changes the length of text inside a term2-next tool output breaks its `refs` (offsets into
  that text); the generator keeps every rewrite inside referenced text length-preserving.
- Regexes inside predicate source built from template literals need doubled backslashes.
- While a reply streams, a menu outlives the reply. Restarting the reply must not type into the open menu (its
  filter takes the text, and legacy then picks a "model" named after the prompt): the harness closes the menu,
  starts another reply and reopens the menu.
- term2-next truncates resume rows at 80 columns before their message count, so "N msgs" alone never matches
  there; the list predicate also accepts its Preview pane. A first full run waited 30 minutes on this.
- term2-next builds its catalogue on the first `/resume` of a fresh store copy and does not answer keys meanwhile
  (153 s on the 420 MB store at 100x34 in the first full run). Under the 5 s rule that is a failure plus a CLI
  restart; the restarted CLI may rebuild, so later resume-list keys can fail too.
- A single screen read can catch a redraw half done (legacy erases and repaints while a reply streams). "Not at
  the composer" counts only after it lasts 300 ms (before sending Escape) or 2 s (before restarting a CLI); an
  instant check restarted legacy four times in the second full run.
- Legacy refuses `/resume` while a reply streams ("cannot run while the agent is working"); term2-next opens it.
