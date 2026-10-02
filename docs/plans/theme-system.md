# Theme system

## Resume here

Read this before touching `source/theme/`, `source/components/theme.ts`, or adding a
colour to any component.

**What exists.** Colours are not constants any more; a component asks for a
*meaning* and the user's `ui.theme` setting decides what it looks like.

- `source/theme/palettes.ts` — `ThemeTokens` (the semantic token set), the
  `THEMES` registry (`dark`, `light`, `high-contrast`, `mono`), and `ColorRole`.
- `source/theme/ThemeContext.tsx` — `useTheme()`, `ThemeProvider`, and
  `SettingsThemeProvider`, which resolves `ui.theme` and re-renders when it changes.
- `source/theme/resolve-theme.ts` — `resolveThemeName()` plus the pure parsers
  (`parseColorFgBg`, `parseOsc11Response`, `backgroundModeFromRgb`) and
  `shouldDetectBackground()`.
- `source/theme/detect-terminal-background.ts` — the startup OSC 11 query.
- `source/components/theme.ts` — what components import: `useTheme`, the glyph
  constants, and the types. Glyphs stay here because they do not vary by palette.

**Using a colour in a component.**

```tsx
const theme = useTheme();
<Text color={theme.danger}>…</Text>
```

For module-level data (hint lists, label maps) store a `ColorRole` and resolve it
where the theme is in scope: `{ label: 'CREATE', tone: 'success' }` then
`theme[op.tone]`. Examples: `operationLabels` in `ApprovalPrompt.tsx`, `MenuHint`
in `MenuContainer.tsx`, `FormattedSettingValue.tone` in `settings-value-formatter.ts`.

**Adding a palette.** Add it to `THEMES` and `THEME_NAMES` in `palettes.ts`, give it
`supportedBackgrounds`, and add the name to the `ui.theme` suggestions in
`value-suggestions.ts`. `palettes.test.ts` then holds it to the contrast policy.

**Enforced by tests, not convention.**

- `palettes.test.ts` — body colours reach 4.5:1 and hint colours 3:1 on every
  background a palette declares; user text on the user band reaches 4.5:1.
- `no-raw-colors.guard.test.ts` — no hex literal, no removed `COLOR_*` constant
  anywhere in production source; no named terminal colour (`'green'`, `'gray'`)
  in UI code (`components/`, `hooks/`, `app.tsx`, `cli.tsx`).

## Why it is built this way

**React context, not a mutable module global.** The first idea was to keep the
`COLOR_*` exports and reassign them (ES live bindings make this work for reads at
render time). Rejected: `React.memo` components such as `ChatMessage` would not
re-render when a global changes, so a live theme switch would leave stale colours
in memoised subtrees, and forcing a remount with `key` would drop component state.
Context re-renders every consumer, memoised or not. It is also the shape a layout
skin needs, so this is not throwaway work.

**Default context value is the dark palette.** Components rendered with no
provider (the many existing unit tests, one-off Ink roots) look exactly as they
did before. `useTheme()` can never return nothing.

**User text colour is explicit.** User messages draw a background band. The band
colour was hard-coded but the text colour was left to the terminal default, so on a
light terminal the default dark text sat on a dark band at about 1.5:1. `userText`
exists so the band and its text are chosen together, and the contrast test pins the
pair.

**An explicit `ui.theme` beats `NO_COLOR`.** `NO_COLOR` is a default for software
without user configuration (no-color.org); only `auto` honours it.

**Detection: OSC 11, then `COLORFGBG`, then dark.** `COLORFGBG` is static and set by
only some terminals, so it is the fallback, not the source. At startup
`detectTerminalBackground` sends the OSC 11 colour query followed by a Device
Attributes query (`ESC [ c`). Terminals answer in order and all answer DA1, so
receiving the DA1 reply means any colour reply has already arrived: a terminal that
ignores OSC 11 costs one round trip instead of the full 150 ms timeout, and its DA1
reply is consumed instead of landing in the prompt later. It must run before Ink
takes over stdin because the replies arrive as input; `cli.tsx` calls it only when
`shouldDetectBackground()` says the answer can matter.

**`SettingsThemeProvider` recolours new output only.** Lines already committed to
the terminal's scrollback keep the colours they were printed with. Ink's `<Static>`
history is likewise written once.

## Known limits (not yet addressed)

- OSC 11 was exercised only against fake streams in unit tests, never against a
  real terminal emulator, and not through tmux or SSH, which can swallow or delay
  the reply. Treat "works in terminal X" as unverified until someone runs it there.
- Detection runs once at startup. A terminal or OS appearance change mid-session is
  not noticed; DEC mode 2031 (colour-scheme change notifications) would cover that
  and is not implemented.
- `runModelPickerHost` mounts `SettingsThemeProvider` without the startup detection
  result, so `auto` there falls back to `COLORFGBG`, then dark.
- `services/profiles/registry.ts` carries `presentation.color` values such as
  `'white'`. No component renders them today, which is why the named-colour rule
  excludes that directory; if a component starts to, it must map them to roles.
- The context-usage gauge in `StatusBar.tsx` is still a single muted colour at any
  fill level.

## Phase 2: layout skins (not started)

A theme today changes colour only. The structural designs discussed for this work
(a quiet rail layout, bordered cards, a dense ledger, a conversation-first layout)
differ in how a tool call, a user message, the status bar and the approval prompt
are *drawn*. The intended shape is a `chrome` section on the theme selecting a
renderer variant per surface, with `ThemeTokens` growing alongside rather than
the variants branching on theme names. Nothing in the repository implements this
yet; the mock-ups were scratch renders and were not committed.

## Verifying a change here

```bash
NODE_ENV=test node_modules/.bin/vitest run source/theme source/components/message/ChatMessage.test.tsx
node_modules/.bin/tsc --noEmit
```
