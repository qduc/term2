# Exclusive menu input ownership

Status: implemented.

## Resume here

This is a follow-on to `docs/plans/menu-system-redesign.md`. The menu kernel,
controller-owned frames, total menu registry, intent-result delivery, and
legacy completion-path removal are already complete. This plan addresses the
remaining ownership leak: `InputBox` still participates in menu composition
and keyboard routing.

Implementation is complete. `ApplicationInputSurface` now owns the exclusive
menu/editor cutover; `MenuSurface` owns normalized terminal input while a menu
stack is present, and `InputBox` is editor-only. The focused suites (162 tests),
typecheck, and changed-file formatting checks pass. The full suite reached 442
passing test files with 16 known baseline CLI/dist and conversation-hook
failures; the full lint command also remains blocked by pre-existing warnings
and four unrelated formatting violations.

## Objective

Make menu visibility transfer exclusive terminal input ownership from
`InputBox` to the menu system.

When `MenuController.stack` is non-empty:

- render the menu at the application/input composition layer, outside
  `InputBox`;
- keep `InputBox` unmounted, including no `useInput` subscription;
- let the active menu layer exclusively handle navigation, filtering,
  selection, acceptance, editing, and escape;
- route menu results through `MenuController` and the application intent host;
- restore `InputBox` as the sole keyboard owner when the stack becomes empty.

Target structure:

```text
Application input surface
├── MenuSurface       when menu stack is non-empty
└── InputBox          when menu stack is empty
```

## Implementation plan

### Phase 1 — Characterize the ownership boundary

Add tests that establish the required behavior before moving ownership:

- `InputBox` is not mounted while a menu is visible;
- menu keyboard events are handled without `InputBox`;
- keyboard-driven coverage exists for every frame kind, rather than calling
  `dispatchActiveEvent` directly as the only test path;
- settings selection and value editing produce the correct typed intents;
- closing a menu restores editor text, attachments, queue-edit state, and
  cursor position exactly.

Record the current mount, unmount, and restoration behavior, including the
existing two-commit cursor-synchronization workaround if it is still needed.

### Phase 2 — Establish a session-owned menu surface

Move `MenuStackHost` and menu-session dependencies out of `InputBox` and into
the application/input composition layer that currently renders `InputBox`.

Introduce `MenuSurface` as the stable rendering and input boundary. It should
normalize Ink input and dispatch it to the active menu interaction, but it
must not contain a `switch (frame.kind)` or recreate `InputBox`'s old
mode-handler table.

The active menu session owns interpretation:

- slash sessions resolve the selected command;
- bound completion sessions edit the controller-owned composer binding;
- settings/model sessions decide whether left/right means navigation or cursor
  movement;
- provider sessions decide whether delete edits transient text or requests
  provider deletion;
- acceptance derives selected items and transient input from session/controller
  state rather than having the router inspect menu-specific hooks.

Keep domain mutations expressed as typed `MenuEffect`/`IntentRequest` values.
Menu components must not call application settings behavior directly.

### Phase 3 — Make input ownership explicit

Extend the input-owner model with a menu owner and compute ownership from the
same state used to render the bottom input surface:

```text
handoff/confirmation/approval/etc.
    > menu stack non-empty
    > editor
```

Use one authoritative owner/snapshot consistently for:

- `BottomArea` rendering;
- menu-router activation;
- application-shortcut suppression;
- background-task keyboard activation.

Do not derive ownership independently in `App` and `BottomArea`.

When a higher-priority modal preempts an open menu, retain the menu stack and
mounted session state, deactivate the menu router, and reactivate it when the
modal closes.

Gate: a menu and the non-emergency application-shortcut handler can never both
consume Escape, Shift-Tab, or ordinary typed input.

### Phase 4 — Perform the exclusive render cutover

Change `ApplicationInputSurface` to select exactly one child:

```tsx
return stack.length > 0 ? <MenuSurface {...menuProps} /> : <InputBox {...editorProps} />;
```

While a menu is visible, `InputBox` must be absent. Consequently its
`useInput`, raw-stdin Alt+Enter listener, history navigation, queue editing,
paste handling, and `MultilineInput` cannot observe menu keys.

When the final menu frame closes, remount `InputBox` from the authoritative
controller editor snapshot. Restore the cursor only after `MultilineInput` has
synchronized its value, preserving the existing workaround if required.

Gate: instrumented composition tests prove mount/unmount exclusivity and exact
text/cursor restoration.

### Phase 5 — Remove compatibility leakage

After the cutover is green, remove from `InputBox`:

- `MenuStackHost`;
- menu hooks and service construction;
- trigger-registry installation;
- menu-specific `useInput` branches;
- menu prompt-label control flow;
- menu-related refs and mode checks.

Migrate remaining consumers before deleting legacy `InputContext` projections:

- replace `App`'s `mode === 'text'` checks with stack/owner state;
- replace remaining `triggerIndex` reads with frame-owned bindings;
- retain semantic controller observers such as handoff close detection unless
  their behavior is deliberately relocated.

Deletion gate: repository search finds no production consumer of removed mode
projections or menu-routing helpers.

### Phase 6 — Verify

Run the focused menu/input suites:

```bash
FORCE_COLOR=0 pnpm vitest run \
  source/components/InputBox.test.tsx \
  source/components/layout/BottomArea.test.tsx \
  source/components/input/ \
  source/context/InputContext.test.tsx \
  source/lib/input-owner.test.ts \
  source/hooks/use-app-keyboard-shortcuts.test.tsx \
  source/hooks/use-handoff-flow.test.tsx

pnpm run typecheck
pnpm test
pnpm run lint
git diff --check
```

Classify full-suite failures against an untouched baseline before calling them
regressions. The provider black-box suite is not required for a UI-only
composition change; run `pnpm test:provider-black-box` if implementation
crosses provider, bridge, run-loop, registry, or non-interactive wiring.

## Completion condition

The work is complete when:

- a higher-priority modal suppresses both menu and editor input;
- otherwise, a non-empty menu stack mounts one menu router and no `InputBox`;
- an empty stack mounts `InputBox` and no menu router;
- ordinary keys cannot fan out across those surfaces;
- editor text, cursor, attachments, queue-edit state, menu session state, and
  intent-result behavior survive every ownership transition exactly.
