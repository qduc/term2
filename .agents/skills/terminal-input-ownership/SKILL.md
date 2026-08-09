---
name: terminal-input-ownership
description: Diagnose and design keyboard input ownership in React Ink terminal user interfaces. Use when Escape or double-Escape behaves incorrectly, text remains after a menu closes, keys are dropped or handled twice during view transitions, modal and editor input conflict, cursor state is lost across remounts, or an interactive terminal boundary misbehaves. For writing or fixing Ink component tests generally, use react-ink-testing instead; this skill covers only the ownership model and the boundary cases that model creates.
---

# Terminal input ownership

Model terminal keyboard behavior as an event-routing problem coupled to explicit state transitions. Do not infer ownership from whichever view is currently visible; rendering and input subscription timing can differ.

This skill assumes React Ink (`useInput`, `useStdin`, and Ink's key-metadata decoding). The principles transfer to other terminal frameworks, but the timing hazards and the encoding notes below are Ink-specific.

## Establish one ownership model

Define a priority order for interactive surfaces. At any instant, exactly one eligible surface should interpret a physical keypress:

| State | Owner | Expected result |
| --- | --- | --- |
| Signal keys (Ctrl-C, Ctrl-D) | The application root, always | No surface may capture or suppress these |
| A higher-priority modal, prompt, or approval is active | That surface | Lower-priority surfaces do not react |
| A menu, picker, or dialog is open | That surface | Editor shortcuts are suspended |
| No overlay is open | The editor or command line | Normal editing and cancellation apply |
| A surface transition is underway | A stable handoff boundary | Boundary-sensitive keys use authoritative state |

Signal keys sit outside the ownership stack by design: exit and interrupt must work even when an overlay is mid-transition or wedged. Assign them once at the root and never let a child claim them.

Keep ownership state separate from presentation state. A view can be mounted before its listener is active, or remain subscribed briefly after it is no longer the owner.

## Keep authoritative state authoritative

Store editor text, cursor position, overlay stack, and relevant revisions in one authoritative state owner or controller. Treat rendered components as projections of that state. On every input event:

1. Read the current authoritative snapshot.
2. Determine the current owner and the semantic transition.
3. Apply one state transition.
4. Render the resulting projection.

Do not let a stale component-local value overwrite newer controller state during a remount. Preserve cursor and text deliberately when an overlay returns control to the editor.

## Make handoffs robust

React effects, subscription setup, and terminal delivery are independently timed. A key can arrive after the authoritative overlay stack changes but before the replacement view has installed its listener. When that window matters, keep a stable boundary subscribed across the transition.

**Implement the boundary outside the component tree.** Subscribe once at the controller or store level — a raw stdin subscription or store middleware owned by the same module that owns the authoritative state. Do not implement it as a parent React component holding `useInput`: a parent component is only stable until that parent itself remounts, which is precisely the race being defended against. If the boundary must live in the tree for other reasons, mount it above every surface that can trigger a remount and document why.

The boundary should:

- inspect the current snapshot rather than a render-time closure;
- handle only the keys it truly owns during the handoff;
- delegate the state transition to the authoritative owner;
- stop handling once the ownership condition no longer holds.

Use one stable bridge for a handoff-sensitive key. Do not add parent and child handlers that both perform the same semantic action.

## Make each key single-consumer

Separate physical delivery from semantic handling. One terminal byte sequence may reach multiple listeners, but it should produce at most one logical transition. For each key, document whether it is:

- consumed by the active overlay;
- delegated to the editor;
- ignored by the current surface; or
- interpreted as a multi-key gesture.

Give every handler an explicit consumed result and route all handlers for one key through a single dispatch that stops at the first consumer. If a stable boundary handles Escape, the equivalent child behavior must either be removed or report consumption through that same dispatch. Otherwise one Escape can close a child and then close its parent, clear input unexpectedly, or restore the wrong cursor.

## Encode close semantics explicitly

"Close the top surface" is not a complete state transition. Different frame types may require different buffer effects:

- closing a root command-trigger surface may remove the trigger text;
- closing a nested picker may restore the parent's text and cursor;
- cancelling an editor gesture may preserve or clear text according to editor policy;
- closing a modal may leave the underlying editor untouched.

Represent stack changes and buffer changes together, or use a typed close policy. Do not scatter buffer cleanup across view-unmount callbacks; unmount timing is too late and too indirect for ownership-sensitive behavior.

Provide a safe controller-level fallback for the short period when a view-specific interaction is not registered. The fallback is subject to the same single-consumer dispatch as everything else: **it runs only when no view-specific handler reported the event consumed.** Idempotency is not a sufficient guard — an idempotent close still pops twice when two frames are on the stack. Keep the fallback narrow and keyed to the current top-frame type.

## Account for terminal encoding

Do not assume every Escape byte arrives as a separate ordinary callback. Ink can decode a rapid `ESC ESC` sequence as metadata plus Escape, or otherwise combine bytes. Test and handle both Ink's normal `useInput` representation and the raw stdin chunk representation.

For a double-Escape gesture:

- distinguish it from a single Escape followed by an unrelated key;
- inspect key metadata as well as the input string;
- pick, document, and centrally define the gesture window as one constant;
- keep short-lived timing state in a mutable ref or equivalent event-time storage;
- avoid relying only on a React state closure that may be stale in the second callback;
- ensure the gesture has one consumer and one clear transition.

Keep single Escape and double Escape semantics independent: a single Escape should not accidentally perform the clear action merely because a hint or timer was rendered.

**Bracketed paste.** Pasted content can contain ESC bytes and will arrive as one large chunk. Detect paste mode (or treat any chunk above a small length threshold as paste) and route it to the editor as literal text, bypassing gesture detection entirely. Otherwise pasting text that contains an escape sequence fires the double-Escape gesture, or a paste beginning with ESC closes an overlay.

## Test the boundary, not just the final screen

Write regression tests around both stable states and transition windows. Assert the authoritative state as well as visible output: active owner, overlay stack, editor text, cursor position, and whether the event was consumed.

Use `ink-testing-library`'s `stdin.write` for ordinary behavior. Emit directly on the underlying stdin stream only when the test specifically targets byte chunking, subscription timing, or a remount race, and explain that reason in the test. For test mechanics beyond this — mocking hooks, structuring the suite, asserting on frames — use the `react-ink-testing` skill.

The applicable regression matrix includes:

- Escape from a root overlay applies its complete close policy;
- Escape from a nested overlay closes only that overlay;
- parent text and cursor are restored exactly after a nested close;
- Escape delivered during an editor-to-overlay handoff is handled;
- Escape delivered during an overlay-to-editor handoff is handled;
- two Escape bytes in one terminal chunk trigger the intended gesture;
- a single Escape is not consumed twice;
- pasted text containing ESC is inserted literally and triggers no gesture;
- Ctrl-C exits while an overlay is open and mid-transition;
- an inactive surface does not mutate state;
- reopening an overlay does not resurrect stale command text.

## Debugging workflow

1. Reproduce the symptom with the smallest input sequence and record the expected owner at each step.
   - **If the symptom is intermittent**, stop hunting a deterministic sequence — it may not exist. Instrument the ownership decision point instead: log the snapshot, chosen owner, transition, and consumed result on every event, then diff logs across a passing and a failing run. The first divergence is the race.
2. Trace physical input, decoding, listener delivery, ownership selection, state transition, and rendering separately.
3. Find the first point where actual ownership or state diverges from the model.
4. Add a failing test at that boundary, including the transition timing if relevant.
5. Fix the ownership or state-transition contract rather than adding another view-local special case.
6. Test sibling overlay types, nested frames, remounts, and editor restoration.
7. Run focused tests, static checks, formatting, and the project's broader suite as appropriate; classify pre-existing failures separately.

## Recognize common signatures

- "The first Escape after opening does nothing": listener installation is effect-timed or the wrong snapshot is being read.
- "The command remains after closing": root close has no explicit buffer transition.
- "One Escape closes two things": multiple surfaces are semantic consumers, or a fallback ran alongside a view handler.
- "Double Escape works when typed manually but not in a test": the test is not modeling terminal chunking or metadata decoding.
- "The gesture fires when I paste": paste chunks are being fed through gesture detection.
- "Text reappears after close": stale local controlled state is echoing over authoritative state.
- "Cursor jumps after returning from a menu": cursor restoration is implicit in remounting instead of part of the transition.
- "Ctrl-C stops working when a modal is open": a surface captured a signal key.

The goal is a small, explicit input-ownership protocol: one authoritative state, one owner per event, stable handoffs where timing requires them, and tests that exercise the boundaries where those guarantees can fail.