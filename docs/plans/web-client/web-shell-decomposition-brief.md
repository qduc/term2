# Brief: decompose the web chat shell

Status: brief for a design. Written 2026-11-26 against `main` at `d6467f44` (after qduc/term2#430 and #431). The
design goes in `web-shell-decomposition.md` next to this file; the build follows the design.

## Problem

`web-client/components/term2/Term2SessionShell.tsx` is **2,560 lines**, one function component. Phase 3 of the
transcript plan (`web-transcript-single-source.md`) moved its *policy* into `web-client/lib/term2/shell-machine.ts`
and removed every effect that copied or reset state, but the file itself still does every job on the page:

- **Logic, lines ~187-1460 (~1,270 lines):** 26 `useState`, 8 `useRef`, 16 `useEffect`, 17 `useCallback`,
  10 `useMemo`; the machine's command runner; send, rewind, retry, config apply, staged picks, attachments, file
  mentions, slash palette, prompt history, notifications, title badge, animation heartbeat, keyboard shortcuts,
  scroll pinning, settings-page URL state.
- **Server data held by hand** in the shell: `settings`, `models`, `skills`, `sessionFiles`, `workspaceMetadata`,
  with `loadingWorkspaces`, `loadingSessions`, `loadingModels`, `modelsChecked`, `loadingSkills`, `loadingFiles`,
  `filesLoadedFor`, `configBusy`, `loadError` and request-id refs. Lists of workspaces and sessions, the open
  chat's store and its request functions are in `web-client/hooks/useTerm2Session.ts` (453 lines).
- **Markup, lines ~1461-2560 (~1,100 lines):** sidebar (`<aside>`, ~70 lines), settings page switch, header,
  status banner, welcome/onboarding checklist (~150), goal banner, model-blocked card, empty-chat card, the turn
  loop with message actions and retry (~180), live status, interaction panel, diagnostics, the bottom dock (scroll
  button, queue bar, notice banner) and the **composer (~340 lines:** textarea, `@` file popover, slash palette,
  skills popover, attachments, model/effort/approval/usage chips, send/steer/queue buttons), the running-tasks
  panel, and four dialogs (provider, folder, help, rewind).

Consequences:

- Every feature and fix lands in this one file; every agent that touches the web UI reads 2,560 lines first.
- The whole tree re-renders on every keystroke: the composer's text is machine state held at the shell's top.
- No guard stops it growing: the repository's 500-line file-size gate (`scripts/check-complexity.mjs`,
  `scripts/complexity-budget.json`) walks only `src/`, so `web-client/` has no size check. Other large web files:
  `Term2FolderSelector.tsx` 816, `Term2ToolContent.tsx` 771, `Term2ModelPicker.tsx` 509.
- After phases 0-3, this is the one known door left open for the web bug classes the plan targeted: nothing stops a
  new syncing effect or a new hand-rolled fetch state from landing in the shell.

## Goal

1. **The shell becomes composition.** `Term2SessionShell.tsx` arranges regions and provides context; target a few
   hundred lines. Each region (sidebar, header, welcome, transcript, composer, dock, tasks panel, dialogs, settings
   switch) is its own component that reads what it needs and dispatches what it does.
2. **Components read state by selector.** The machine state and dispatch reach components through a provider and a
   selector hook, not prop drilling; a component re-renders only when its slice changes (typing re-renders the
   composer, not the transcript).
3. **Server data has one home.** Settings, models, skills, files, folder metadata, the chat and folder lists: one
   data layer with uniform loading/error/refresh, instead of a dozen hand-written flags. The design decides between
   a library (TanStack Query, SWR) and a small in-house hook, and recommends one.
4. **It does not grow back.** A guard, sized as a reminder, not a lock (the owner's standing preference): the
   file-size gate covers `web-client/` with recorded ceilings that only go down, and a rule against state copied or
   reset in an effect in the shell's components. Use the existing gate pattern: a static check under
   `scripts/check-rules.mjs` / `scripts/check-complexity.mjs` whose failure text in `scripts/gates/rules.mjs` says
   why and what to do.
5. **No behaviour change.** The page looks and works the same. All 18 browser flows (`tests/web-client/browser/`)
   and every generated property (`pnpm verify:generated`, including `shell.machine-rules` and `web.present-reuse`)
   pass unchanged.

**Built in one go.** The owner's decision: an agent can do the whole decomposition in one change with a proper
plan, not the human-paced strangler-fig sequence. The design should make that safe: a complete target structure,
a state-ownership table that leaves nothing unassigned, and a build order inside the one change that keeps the page
compiling and the checks runnable at each step, so a failure points at one step.

## Constraints

- **Settled architecture (do not change):**
  - `shell-machine.ts` stays a pure `step(state, action) → { state, commands }` with no React. Commands run in one
    place.
  - The address bar alone changes the open chat (`URL_CHANGED`).
  - Command results carry `{ sessionId, generation }` and stale ones are dropped.
  - Only `session-store.ts` imports the fold bundle, and `present.ts` imports its types only. No browser-side
    reducer or accumulator (rules in `scripts/gates/architecture-rules.mjs`; spec section 8 of
    `web-transcript-single-source-spec.md`).
  - Keep `@qduc/agent-wire` as the thing clients depend on. It is meant to become a public library for agent UIs;
    the in-repo web client is its first consumer.
- **Testing policy** (`AGENTS.md`, the `testing` and `verification` skills): no permanent unit tests. Browser flows,
  integration tests and bounded generated properties are allowed; temporary tests are fine. A high-risk change
  needs an independent verifier. Never edit or weaken a flow or property to get green; deleting or emptying one
  asks for the owner's `architecture-change` label.
- **Dependencies:** a new runtime dependency (TanStack Query, Zustand, XState, ...) is the owner's call. The design
  states the trade-off and a recommendation; the build waits for the owner's answer if it recommends one.
- **Stack:** Next 16.2, React 19.2, no React Compiler configured, Tailwind, shadcn-style `components/ui/`,
  existing `contexts/` (Auth, Theme). pnpm pinned at 11.7.0.
- **Design intent:** the `web-ui-design` skill holds the owner's UI rules. This work changes no pixels, wording or
  controls.
- **Docs:** `web-client/SOURCE.md` is the web client's public-interface document and must describe the new modules.
  Plans follow the `writing-docs` skill (status header, claims scoped to what they are true of).
- **CI:** the `web-browser` lane has a 120 s code-time budget (`scripts/ci-budget.json`); it runs about 35 s today.
  The `quality` lane runs the static gates and generated properties.

## What the design should contain

- The target module tree: each new file, its one job, and its public interface (props, hooks, context value).
- A state-ownership table: every `useState`, `useRef`, `useMemo`, `useCallback` and `useEffect` in the shell and
  `useTerm2Session.ts` today, and where it lives after (machine, data layer, a region component, derived at render,
  or deleted). Nothing left unassigned.
- How components reach the machine: the provider, the selector hook and how commands still run in one place.
- The data-layer decision, with its trade-off.
- The guards: what they check, where they live, their failure text, and the ceilings recorded.
- The one-go build order and the evidence that proves "no behaviour change" (which checks, and anything new, such
  as a render-count probe for the keystroke claim).
- Scope calls on the other large web files (`Term2FolderSelector.tsx`, `Term2ToolContent.tsx`): in or out, and why.
- Risks and a "do not" list.
