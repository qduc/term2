# Soak brief: two terminals, 30 minutes

Part of the real-terminal check (issue #140, flip gate item 5). A context-free agent uses legacy term2 and
term2-next side by side for 30 minutes of normal work and lists every difference it notices. Every difference
fails the gate unless it is on the accepted-differences list; the report marks each one **unexplained** for the
owner's team to triage. The soak does not fix anything.

## Operator notes (not given to the agent)

1. Build both CLIs and have a store (`run.mjs` does both, or `generate-store.mjs --out <store>`).
2. Start the terminals and leave the server running:

   ```sh
   node rewrite/parity/real-terminal/soak.mjs serve --state /tmp/soak --store <store>
   ```

   Which CLI is A and which is B is random and written to `/tmp/soak/mapping.json`. Do not give that file
   to the agent.

3. The server writes the agent's only command, `/tmp/soak/t` (`t type both "hi{enter}"`, `t screen A`, ...).
4. Start a fresh agent with no repository context, no tools beyond a shell and an image viewer, and the brief
   below as its whole prompt (replace `<T>` with `/tmp/soak/t`). It must not read the repository.
5. When it finishes, map A/B back with `mapping.json`, save the list as a JSON array of strings and add it to
   a finished run with `run.mjs --out <run dir> --report-only --soak <file>`. Stop the server with `<T> stop`.

The fake model behind both terminals is the harness's scripted model (`lib/session.mjs`, `scriptedModel`): it
answers deterministically, so both terminals get the same replies to the same prompts.

---

## Brief (give the agent everything below this line)

You are testing two builds of the same terminal AI assistant. They are running right now in two real
terminal emulators, labelled **A** and **B**. They are supposed to be indistinguishable to a user: the same
screens, the same wording, the same colours and layout, the same keys, and the same speed. Your job is to use
both, side by side, for **30 minutes of normal work**, and to list **every difference you notice**, however
small.

You have no other context, and you need none. Do not read any files except the screenshots this tool gives
you, and do not look for the programs' source code. Judge only what a user would see and feel.

### Your controls

Everything goes through one command, `<T>`:

| Command | What it does |
| --- | --- |
| `<T> type both "text{enter}"` | Types into both terminals at once, like a person (one key at a time). Use this most of the time, so both get identical input. |
| `<T> type A "..."` / `<T> type B "..."` | Types into one terminal. |
| `<T> screen A` / `<T> screen B` | Prints the visible screen as text. |
| `<T> shot both` | Saves screenshots of both screens and prints their paths. Open them to compare colours, highlighting and layout. |
| `<T> resize 80 24` | Resizes both terminals. |
| `<T> restart both` | Starts the program again (for example after you exit it). |

Keys inside the text: `{enter}` `{esc}` `{tab}` `{shift+tab}` `{backspace}` `{up}` `{down}` `{left}` `{right}`
`{pgup}` `{pgdn}` `{ctrl+c}` `{ctrl+o}` `{ctrl+t}` `{ctrl+g}` `{alt+enter}`, and `{wait:500}` to pause 500 ms.
After typing, wait a moment and look at both screens before you judge.

### The assistant

It is a chat assistant for programming work in a project folder. The model behind both terminals is a
deterministic stand-in, so the same prompt gets the same reply in both. It understands a few requests:

- anything containing **stream** gets a long streamed reply (about 25 seconds), useful for trying keys while a
  reply is arriving;
- **list the files** makes it run a shell command;
- **create a file** makes it run a command that asks for your approval first;
- **markdown** gets a formatted reply with a heading, a list and a code block;
- anything else gets a short plain answer.

The program has commands that start with `/` (type `/` to see them), file mentions that start with `@`, a
shell mode with `!`, a model picker, settings, a list of past conversations (`/resume`), keyboard shortcuts
shown in its footer, and approval prompts. The past-conversation list holds over a thousand old sessions.

### What to do

Work like a user would for 30 minutes (check the time with `date` at the start and keep going until 30 minutes
have passed). Cover at least: the start screen; several ordinary turns; a tool call; an approval (approve once,
deny once); every `/` command that opens a menu or view; moving around inside menus; `/resume` and opening an
old conversation; the footer shortcuts; typing, editing and deleting text in the input; pressing keys while a
reply streams (typing, Enter, Escape, the shortcuts); cancelling a reply; a resize to 80x24 and back to 100x34;
and exiting with Ctrl+C. Repeat anything that felt slow in one terminal to see if it is consistent.

For every difference, note it right away, before you forget, with: what you did, what A showed or did, what
B showed or did, and whether it is about **content** (text, wording, missing or extra information),
**appearance** (colour, spacing, alignment, highlighting), **behaviour** (a key does something different), or
**speed** (one reacts noticeably slower, freezes, or flickers).

### Report

When the 30 minutes are up, reply with:

1. The start and end time.
2. A numbered list of every difference, one per line, in the form
   `[content|appearance|behaviour|speed] <what you did>: A <...>; B <...>`.
3. Anything you could not try, and why.

Do not guess which terminal is the "right" one, and do not try to explain the differences. Just report them.
