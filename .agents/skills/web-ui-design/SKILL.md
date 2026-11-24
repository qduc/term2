---
name: web-ui-design
description: The repository owner's design intent for the term2 web UI (`web-client/`) — visual hierarchy, how many controls a surface may show, behaviour rules that keep the user informed, and how to propose and check UI changes with them. Use before designing, restyling or reviewing any web-client screen, settings row, menu, chip or dialog, before proposing UI options to the user, and when the user says a screen feels busy, unfocused, weird or "not like other apps".
---

# Web UI design intent

Learned from a long design session on the web UI (Nov 2026, PRs #370–#391). Each
principle names the decision it came from, so you can check whether a new case is
really the same case. The code shows what was built; this records why, and what
the owner rejected.

The web client uses shadcn/ui on Radix with its **default theme**, Tailwind v4 and
lucide icons. The owner chose shadcn's defaults over matching the old custom look:
prefer an existing shadcn component and its default styling over a hand-rolled one.

## 1. Familiar beats clever

The owner judges layouts against mainstream apps (ChatGPT, Claude, Linear, VS Code
settings). "I never see an app put them there" and "I never see a settings screen
like this" are real objections, not taste.

- Global actions (settings, help, theme) live in the **header**, not a sidebar footer.
- Settings is a **full page with search**, sections on the left. Searching matches
  everyday words ("dark", "cost", "internet"), not only setting names.
- Providers use a **two-pane list → detail** layout.
- "New chat" is present but **quiet**; it shouldn't be the loudest thing in the sidebar.

## 2. One place for the eye to land

The owner reviews screens from a distance: "if I look at this page from far away,
where should my eye focus?" Every screen needs a clear answer.

- **The content the user came for is the loudest thing**: the chosen model, the
  message, the folder. Controls that edit it are quieter than the content itself.
- **Avoid a field of equal-weight outlined shapes.** Twenty chips, outlined buttons and
  selects at one weight read as grey texture (the Models page before #391).
- **Don't repeat a label on every row.** A "Modified" tag and a "Reset to default" on every
  row told the user nothing, because every row was modified. Show state only where it
  differs, and put per-row actions inside the row's editor.
- **Summary first, edit on demand.** For lists of settings, show one line per item
  (label, value in bold, extras in grey, a secondary value on the right); clicking opens
  the editor in place, one at a time (`ModelsSummary.tsx`). The owner preferred this over
  "same rows, quieter controls".
- **Say a group's explanation once**, under the group heading, not under every row.

## 3. Fewer controls, grouped by what they change

- **Merge related controls.** Effort lives inside the model picker. A helper tier's models
  and effort are one row with one Reset. Composer extras go behind a **+ menu**.
- **Remove what isn't needed**, rather than hiding it under "Advanced". The owner removed
  the whole old Models tab (Lite mode, temperature, default model, default effort) when
  asked "is any of this needed?". Before keeping a control, be ready to say who changes it
  and why.
- **Short option lists.** The effort list became Off / Low / Medium / High / Extra high;
  Auto, Min and Max were cut as noise.
- **Compact over truncated.** When a chip ran out of room, the fix was a readable name
  (provider shown, vendor prefix dropped) plus a small effort glyph (three bars), not a
  longer chip with an ellipsis.

## 4. Nothing moves or jumps

- Dialogs and panels keep a **stable size** across tabs; switching tabs must not resize
  the frame.
- Failures don't auto-expand a tool row and push the transcript around. The web app follows
  the TUI's **Concise / Standard** display modes for tool output.
- Tool output is cut by **size only**, never by what it contains.

## 5. Tell the user; never act silently

- **No silent fallbacks.** If the chosen model is unavailable, say so and keep the choice;
  don't swap in another model "even if it's down".
- **Show what's in effect.** The model chip shows its provider. Settings that only reach new
  or reopened chats say so.
- **Ask before loosening safety**, including a "Reset to default" that loosens (sandbox
  network, read policy). Tightening saves without asking.
- **Don't keep a restriction that only looks like security.** The owner removed the
  workspace-root limit on the folder picker because the agent already acts with the user's
  own permissions; the limit only blocked real folders. A check has to protect something
  the user can name.

## 6. Actions land where the user expects

- **After creating or choosing something, show it.** Adding a folder opens a new chat in it;
  the previous chat doesn't stay on screen.
- **Don't create things the user didn't commit to.** "New chat" opens a draft; the gateway
  session is created on the first send, so clicking around leaves no empty chats.
- **Per-context choices stay per-context.** A model picked in a blank chat becomes the
  default for blank chats. An existing chat keeps its model until the user changes it **and**
  sends a message. Nothing changes a chat the user is only looking at.
- **Put direct actions where the eye already is**: Edit under the user's message, Retry under
  each reply (asking first when it would remove later turns).

## How to work with the owner on UI

- **Show, don't describe.** "Seeing it is easier to decide than reading." For a layout
  question, render 2–3 options as mockups (with the user's real data where you have it)
  and give a recommendation. "Show me" means a visual, not more prose.
- **Diagnose before proposing.** When the owner says a screen feels wrong, name the concrete
  causes first (equal weights, repeated labels, ragged column), then offer options.
- **Expect refinement rounds.** The owner picks a direction ("A is much better") and then
  refines it; carry forward what they liked and say what changed.
- **Cheap to change? Build it.** When a change is easy to revert, build it and let the owner
  look instead of asking. Ask first only for one-way doors.
- **Verify in the real app.** Run `pnpm dev:web` in the browser pane, screenshot the result,
  and revert any test values you set in the owner's real settings or folders.
- **Push back once, with a reason**, when a request removes something that protects the
  user; then follow the owner's call.

For general restraint and polish checks (spacing, contrast, calm), the `restrained-ui`
plugin skill complements this one; where they conflict, this file's owner-specific
decisions win.
