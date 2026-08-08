# Menu system redesign

Status: Phase 5 is in progress. All of Phase 4 is merged — graphs 1–2 at
`efa50cfa`, graph 3 at `3b4f67dd`, graph 4 at `32eabded` (implementation
commits `ed3a8a31`, `b9ac1938`, `c05117a2` + `683be8f1`). **Phase 5 (Step 3,
legacy deletion) is the only outstanding work.**

## Resume here

Read this section and `### Phase 4 rule-id collision` below before touching
`source/components/input/`, `InputBox.tsx`, `InputContext.tsx`, or the
completion hooks. The rule-id finding in particular contradicts the naive
reading of the Phase 4 step list.

### What is already done

- Phase 1 kernel: `21976b1d`, `8c230aea`.
- Phases 2–3 and Phase 4 graphs 1–2: `ed3a8a31`, merged as `efa50cfa`.
- The kernel already implements successors, `pop-to`, `BackPolicy` restore,
  return points, the intent host, and correlated `IntentResult` delivery.
  `menu-controller.test.ts` already carries a settings→settings_value contract
  test. **The remaining Phase 4 work is session and wiring work, not kernel
  work.**
- The trigger registry enables the controller-owned slash, path, skills,
  settings, settings-value-child, settings-model, command-model, and
  direct-setting-value rules in `InputBox.tsx`.
- `menu-registry.tsx` is now a total `MenuRegistry`; every frame kind has a
  mounted session.

### Phase 5 progress in this worktree

The legacy popup paths have been removed from production wiring: trigger
detection, mode handlers, popup prop/navigation adapters, and the completion
branches in `useEscapeKey` are gone. `InputBox` now routes menu input through
`MenuController`/`MenuStackHost`; the registry is total and trigger-registry
replacement reconciles the active stack. The unreferenced `PopupManager` has
also been removed. The missing queue/history declarations and split-chunk
Alt+Enter behavior were repaired while bringing the tree back to a typed,
tested state.

The remaining Phase 5 gate is the legacy `InputContext` migration. `mode` and
`triggerIndex` are still independently stored and exposed through
`setMode`/`setTriggerIndex`, and the completion hooks plus their direct-mode
test harnesses still call those setters. Migrate those callers to controller
state/transactions, then run the final full-suite, typecheck, lint, and diff
checks before recording the phase as complete.

### Worktree base — read before `git worktree add`

**Every worktree for this work must be based on local `HEAD`, never on
`origin/main`.**

Local `main` is substantially ahead of `origin/main`, and the unpushed range is
not just the most recent merge — it includes the Phase 1 kernel (`21976b1d`,
`8c230aea`) and this plan document itself (`845ddfdc`), alongside unrelated
compaction and subagent work. A worktree cut from `origin/main` would therefore
lose the *entire* redesign and silently present a tree in which none of this
plan's premises hold.

Deliberately no commit count is quoted here: it goes stale on every commit,
including the ones that record it. Run the check instead.

This is a live trap rather than a hypothetical: the `worktree.baseRef` setting
defaults to `fresh`, which branches from `origin/<default-branch>`. Any tooling
that honours that default must be overridden here. Verify before starting a
step:

```bash
git rev-list --count origin/main..main   # non-zero means: do not branch from origin/main
git merge-base --is-ancestor 21976b1d HEAD && echo "kernel present"
```

### Measured baseline at the time of the merge

- `pnpm run typecheck` — green.
- Focused suites (`InputBox.test.tsx`, `InputContext.test.tsx`,
  `source/components/input/`, `source/hooks/`) — 41 files, 387 tests, green
  except one known pre-existing failure described under **Verification
  commands**.

### Step order

Steps are strictly sequential. **Step 2 consumes the sessions built in Step 1,
so Steps 1 and 2 cannot run in parallel.** Step 3 requires both graphs to be
controller-owned. One step per worktree, merged back `--no-ff` before the next
begins.

#### Step 0 — land the uncommitted tree — DONE (`efa50cfa`)

Was: commit the ~978-line working-tree blob so later graphs have a reviewable
base. No longer outstanding.

#### Step 1 — Phase 4 graph 3 — DONE (`b9ac1938`, merged `3b4f67dd`)

Settings, reset, settings value, and settings-backed model are controller-owned.
The rules `settings`, `settings-value-child`, and `settings-model` are enabled
at `InputBox.tsx:173-183`; `command-model` and `direct-setting-value` are
defined but disabled, awaiting Step 2. The `reopenSettingsMenu` +
`settingsFilterRef` hack is gone.

Two outcomes worth carrying forward are recorded below under
`### Successor restore points` and `### ModelSettingConfig`.

**The return-point warning in this step's original scope is resolved, not
outstanding.** It said that if the hack still looked necessary after the
cutover, a missing return-point invariant was the cause. It did not: the design
resolved into the two restore-point cases below, both confirmed against
already-pinned tests. No invariant was missing.

Original scope, for the record:

- Split the colliding rules (see `### Phase 4 rule-id collision`) and enable
  `settings`, `settings-value-child`, and `settings-model`.
- Add `SettingsMenuSession`, `SettingsValueMenuSession`, and `ModelMenuSession`
  to `menu-registry.tsx`. `ModelMenuSession` is built here, not in Step 2,
  because the settings-backed model child needs it first.
- Route `/settings reset ` as a typed `reset-setting` intent. It must never
  push `settings_value` or rewrite the prefix to `/settings `.
- First production use of `apply-settings` carrying the model and provider
  changes in one intent, and of `IntentResult` field-error return.
- Delete the `reopenSettingsMenu` + `settingsFilterRef` hack at
  `InputBox.tsx:179-189`. It reconstructs `/settings <filter>` from a ref on
  reset; under this design the parent settings frame stays mounted, so
  category, filter, and selection survive without reconstruction. If the hack
  still looks necessary after the cutover, a return-point invariant is missing
  — find it rather than reinstating the ref.

Out of scope: the direct `/model ` trigger, `/effort`, `/auto-approve`, and
handoff. Those are Step 2.

#### Step 2 — Phase 4 graph 4 — DONE (`c05117a2` + `683be8f1`, merged `32eabded`)

The handoff conversion landed correctly: the structural gate prints nothing,
and the falsification experiment failed exactly the two "closed without
choosing" tests and nothing else.

A regression was caught in review and fixed in `683be8f1`. See
`### Enabling a rule makes dead branches live` for the general rule it taught.

In scope (as originally written):

- Enable `command-model` and `direct-setting-value`.
- Replace `use-handoff-flow.ts:108-110`
  (`setInputAndCursor` + `setMode('model_selection')` + `setTriggerIndex`) with
  a plain `replaceText('/model ', 7)`. The `command-model` rule then fires on
  its own; no explicit `open` is needed, and `open`'s `UnboundFrameSpec` does
  not accept a bound frame anyway.
- Convert `use-handoff-flow.ts:91-97` off the legacy `mode` projection **in
  this step, not in Step 3.** It currently detects menu close by watching
  `mode` return to `'text'`. That survives on the compatibility projection
  during migration and then breaks silently the moment Phase 5 deletes the
  projection. Have it observe an empty stack, or the model acceptance intent,
  instead.

Out of scope: deleting any legacy module. That is Step 3.

#### Step 3 — Phase 5: delete legacy paths (in progress)

In scope: `useTriggerDetection`, `useModeHandlers`, the `insertions.ts`
helpers, `toPopupProps`, `PopupManager`'s hand-mapped prop adapter, stored
`InputMode` and `triggerIndex` in `InputContext`, the completion branches in
`useEscapeKey`, and `dismissedCompletionRef` / `inputRevisionRef`.

Two cautions:

- **Keep `determine-active-menu.ts`.** The new trigger rules import it. It is
  not legacy.
- `useEscapeKey` also owns the escape hint and queue cancellation, and
  `PopupManager` is still reached from `BottomArea`. Strip the completion
  branches; do not delete either wholesale.

Close the step by making `MenuRegistry` total instead of
`Partial<MenuRegistry>` (`menu-registry.tsx:24`). That single change makes the
compiler prove every frame kind has been migrated, which is a stronger gate
than any search for stale callers.

### Successor restore points

A successor transition can be reached two ways, and they need **different**
restore points. Step 1 derived this empirically; Step 2 needs the same rule for
direct `/effort ` and `/auto-approve `, so it is written down here rather than
left as an inference from test fixtures.

| How the child was reached | Restore point |
| --- | --- |
| Explicit accept from a mounted parent list | the actual pre-transition editor snapshot, preserving whatever filter the user had typed |
| Passively typed (user typed the whole trigger) | the bare prefix, e.g. `/settings ` |

The reasoning: a passively-typed activation never had a mounted parent session
filtering a list, so there is no prior parent state to preserve, and Back must
not invent one by reconstructing "what the user had typed before this". This
reproduces the deleted `settingsFilterRef` default, which started at `''` and
was only ever populated by an explicit list selection — so the two cases are a
faithful decomposition of the old behavior, not a new policy.

Both cases are pinned. Find them with:

```bash
grep -n "Input:/settings " source/components/InputBox.test.tsx
```

Those assertions predate the migration; they are the reason the passive case is
known to restore to the bare prefix. Do not "fix" them to preserve a filter.

The implementation of each case is commented at its site: the passive case in
`triggers.ts` (`settingsListRestorePoint`), the explicit case in
`SettingsMenuSession.tsx` (`pushChildEffect`).

### Gate: the handoff conversion fails silently

The handoff conversion in Step 2 is the one change in this migration whose
failure mode is silence. Nothing throws, no existing test necessarily fails,
and a diffstat plus a green suite look identical whether it was done correctly
or not. It surfaces only in Step 3, when Phase 5 deletes the `mode` projection
and the handoff stops sending. Verify it directly rather than inferring it from
a passing report.

**Structural check** — must print nothing once Step 2 is done:

```bash
grep -nE "^\s*(mode|setMode|setTriggerIndex)\b" source/hooks/use-handoff-flow.ts
```

It targets the hook's declared options and destructured parameters, so it is
not confused by the unrelated `standard_mode_requested` action or the "Standard
mode" message text. Before Step 2 it prints 12 lines.

**Behavioral check — the part that is easy to get wrong.** The existing tests
in `use-handoff-flow.test.tsx` are coupled to the legacy projection: the
harness owns `mode` in its own `useState`, and assertions read
`getSnapshot().mode` and `getSnapshot().triggerIndex` directly. Step 2 must
rewrite them, and a rewrite can be made to pass by re-pinning whatever the new
implementation happens to do.

The replacement must pin the **observable behavior**, not the new mechanism:
that the captured handoff is sent after model selection closes the menu, and
that it is *not* sent when the picker closes without a choice. Both cases
already exist as tests and both must survive the rewrite with their meaning
intact. If the rewritten tests would still pass with the send-on-close signal
removed entirely, they are pinning the mechanism and the gate has not been met.

Outcome in Step 2: the gate was met. The structural grep prints nothing and
removing the send-on-close signal failed exactly the two "closed without
choosing" tests. The section below records what the gate did *not* cover.

### Enabling a rule makes dead branches live

Generalize the handoff gate above. It was scoped to one conversion; the hazard
is structural and applies to every graph.

**Enabling a trigger rule makes a previously unreachable session branch live in
production for the first time.** A step that builds a session while its rule is
disabled leaves that branch implemented, typechecked, and unexercised — Step 1
did exactly this with `ModelMenuSession`'s `target.type === 'command'` accept
path. The step that *enables* the rule inherits it.

This produced a real regression in Step 2, fixed in `683be8f1`. Accepting a
`/model gpt-4` selection posted the literal string to the model as a chat
message instead of executing the command. The accept path closes through a
`submit-prompt` intent whose only handler was `sendUserMessage`, bypassing the
`parseInput` → `resolveSlashCommand` → `command.action(...)` dispatch that
`handleSubmit` had always run.

The suite stayed green because the only test covering that behavior renders a
hand-built harness (`grep -n "ModelSelectionSubmitHarness"
source/components/InputBox.test.tsx`) that drives the pre-migration mechanism
and never touches the controller. It asserts only that *something* submitted,
so it passes whether or not the controller path works.

Two rules follow:

- When a step enables a rule, every accept path that rule makes reachable needs
  a test **through the controller**. Any pre-existing test of that behavior must
  be checked for whether it bypasses the controller — if it does, it is not
  coverage, and re-pinning it to the new mechanism does not make it coverage.
- **A test written after a fix and never observed failing is not evidence.**
  What resolved this was requiring the new test be seen red against the unfixed
  code first; it produced `waitForCondition timed out after 3000ms. Last value:
  0`. Demand the red observation, not the assertion that a test was added.

The fix extracted one dispatcher with two callers rather than duplicating the
parse: `grep -rn "tryExecuteSlashCommand" source/`. `resolveSlashCommand` now
appears only inside `source/utils/slash-command-dispatch.ts`, so `handleSubmit`
and the intent host cannot drift.

Known remaining gap, handed to Step 3: no test pins `app.tsx`'s own call to
`tryExecuteSlashCommand` — the covering test wires its own mirror intent host,
so deleting that line from `app.tsx` fails nothing.

### ModelSettingConfig

This plan referenced `ModelSettingConfig` in the `model` frame without ever
defining it, and the Phase 1 kernel filled that gap with a placeholder:
`{ settingKey; label?; requiresRestart? }` (`menu-types.ts:53-57` as of
`362755fb`). The placeholder was never consumed.

Step 1 replaced it with a mirror of the fields in `utils/ai/model-settings.ts`
that the settings-backed model frame actually needs — `modelKey`,
`providerKey`, `fallbackProviderKey?` — rather than introducing a translation
layer between the two shapes.

`providerKey` is the load-bearing field: without it the session cannot build
the single `apply-settings` intent carrying both the model and the provider
change, and would have to emit two intents, which this design forbids.

### Phase 4 rule-id collision

`determine-active-menu.ts` collapses graph 3 and graph 4 into shared rule ids:

| Rule id | Graph 3 case | Graph 4 case |
| --- | --- | --- |
| `model` | `/settings agent.model ` via `MODEL_SETTING_TRIGGERS` (line 28) | `/model ` via command completion (line 26) |
| `settings_value` | the `/settings <key> ` child (line 53) | `/effort `, `/auto-approve ` via `setting-value` completions (line 66) |

Enabling either id enables both graphs at once, which violates this plan's own
rule that a frame is never partly owned by the legacy detector and partly by
the controller.

**Split the rules; do not merge the graphs.** Use `settings-value-child` /
`direct-setting-value` and `settings-model` / `command-model`. Step 1 carried
this out under exactly those names; all four rules now exist in `triggers.ts`,
with the two graph-4 rules defined but not yet enabled. The frames
already differ, and the current single rules hardcode the graph-4 shapes, which
are wrong for the graph-3 child:

- `triggers.ts:66` hardcodes `target: {type:'command'}` with
  `back: {type:'close-clear-input'}`. The settings-backed model child needs a
  `{type:'setting'}` target and a `restore` back policy to its mounted parent.
- `triggers.ts:91` hardcodes `origin: {type:'direct-trigger'}` with
  `close-clear-input`. The `/settings <key> ` child needs
  `origin: {type:'settings-list', operation:'set', back: restore(...)}`.

Splitting makes origin and `BackPolicy` properties of the rule rather than a
runtime branch inside one session. These rules need the split regardless of how
the steps are sequenced.

## Outcome

Decouple menu lifecycle, input editing, and menu-specific workflows from
`InputBox` without replacing it with a new god object.

The redesign has three layers:

1. A transactional input/menu controller owns the editor snapshot, menu stack,
   text bindings, trigger reconciliation, and atomic transitions.
2. A hook-safe menu host mounts one component per frame. Each menu owns its
   domain-specific fetching, validation, selection, and rendering.
3. An application effect host executes typed domain intents only after the
   controller has committed the required input and stack transition.

`InputBox` becomes an adapter. It renders the controlled editor, forwards
editor events, disables `MultilineInput` while a menu owns input, and renders
the menu host. It no longer owns `mode`, `triggerIndex`, completion dismissal,
menu opening effects, insertion policy, or a per-mode key-handler table.

## Decisions

- The controller owns `{editor, stack, dismissedActivation}` as one atomic
  state. React state is a published snapshot, not a second authority.
- A text binding belongs to its frame. There is no global `triggerIndex` or
  global binding.
- Query ranges and replacement ranges are separate concepts.
- Trigger overlaps are legal when the grammar declares precedence or a
  successor relationship. There is no blanket prefix-free assertion.
- Parent frames remain mounted beneath pushed children, preserving menu-local
  selection and filter state without reconstructing it from the input buffer.
- Provider configuration remains a provider-owned state machine. The generic
  controller owns its frame, focus, transient text, and close transitions, but
  not its draft/validation policy.
- Menu components return typed effects. They never receive a generic
  `run(() => void)` escape hatch.
- A menu-input router connects the one Ink listener to the active mounted
  session. `InputBox` forwards normalized events; it does not regain a mode
  handler table.
- The cutover is by complete trigger graph. A frame is never partly owned by
  the legacy detector and partly by the new controller.

## Non-goals

- Do not rewrite menu presentation while changing ownership.
- Do not flatten all menu state into a common `{items, loading, error}` shape.
- Do not change settings, provider, rewind, or slash-command domain behavior.
- Do not persist or resume an open menu stack across process restarts.
- Do not introduce a runtime switch that can change engines while a menu is
  open.

## Ownership

| Concern | Owner |
| --- | --- |
| Text, cursor, revision | input/menu controller |
| Menu stack and active frame | input/menu controller |
| Trigger grammar and dismissal | input/menu controller |
| Query and replacement coordinates | active frame binding |
| Selection, loading, validation, rendering | mounted menu session |
| Provider wizard draft and phases | provider menu reducer |
| Settings/provider/rewind application effects | application effect host |
| Terminal/editor integration | `InputBox` adapter |

The controller earns its module boundary because deleting it would spread
atomic editor/stack/binding invariants back across `InputContext`, `InputBox`,
trigger effects, menu hooks, and application-level openers.

## Controller model

### Editor and binding

```ts
type EditorSnapshot = Readonly<{
  text: string;
  cursor: number;
  revision: number;
}>;

type TextRange = Readonly<{
  start: number;
  end: number;
}>;

type ReplacementEnd = 'cursor' | 'buffer-end' | number;

type TextBinding = Readonly<{
  trigger: {
    range: TextRange;
    text: string;
  };
  queryStart: number;
  queryEnd: 'cursor';
  query: string;
  replacement: {
    start: number;
    end: ReplacementEnd;
  };
  activationId: string;
  revision: number;
}>;
```

`query` is the controller-published value for the current snapshot. Menus read
it and never slice the editor buffer themselves. The controller updates it in
the same transaction as text and cursor changes.

`replacement` is independent of the query:

| Frame | Query range | Replacement range |
| --- | --- | --- |
| path | after `@` through cursor | `@` through cursor |
| slash | after `/` through cursor | `/` through cursor or command-defined range |
| settings | after `/settings ` through cursor | key start through buffer end |
| settings value | value start through cursor | value start through cursor |
| model | model argument start through cursor | model argument start through buffer end |
| skills | after `/skills ` through cursor | query start through cursor |

This preserves the existing distinctions: accepting a path consumes `@`,
path/skill/value completion can preserve a suffix, and model acceptance removes
a stale model/provider suffix.

### Frames

```ts
type FrameId = string;

type ReturnPoint = Readonly<{
  editor: EditorSnapshot;
}>;

type BackPolicy =
  | { type: 'restore'; point: ReturnPoint }
  | { type: 'close-preserve-input' }
  | { type: 'close-clear-input' };

type SettingsOrigin =
  | { type: 'settings-list'; operation: 'set'; back: BackPolicy }
  | { type: 'direct-trigger'; triggerId: string; back: BackPolicy };

type MenuFrame =
  | { id: FrameId; kind: 'slash'; binding: TextBinding }
  | { id: FrameId; kind: 'path'; binding: TextBinding }
  | {
      id: FrameId;
      kind: 'settings';
      binding: TextBinding;
      initialKey?: string;
      operation: 'set' | 'reset';
      prefix: '/settings ' | '/settings reset ';
    }
  | {
      id: FrameId;
      kind: 'settings_value';
      settingKey: string;
      binding: TextBinding;
      origin: SettingsOrigin;
    }
  | {
      id: FrameId;
      kind: 'model';
      target: { type: 'command' } | { type: 'setting'; config: ModelSettingConfig };
      binding: TextBinding;
      back: BackPolicy;
    }
  | { id: FrameId; kind: 'skills'; binding: TextBinding }
  | { id: FrameId; kind: 'rewind'; items: RewindItem[]; initialDisposition: RewindDisposition }
  | { id: FrameId; kind: 'providers'; returnPoint: ReturnPoint };

type MenuState = Readonly<{
  editor: EditorSnapshot;
  stack: readonly MenuFrame[];
  resolvedCandidateIdentity: string | null;
  activationEpoch: number;
  dismissedActivation: string | null;
}>;
```

Only text-triggered frames carry a binding. `rewind` and `providers` are
explicit application-opened surfaces.

`mode` is a compatibility projection only:

```ts
const mode = frameKindToLegacyMode(state.stack.at(-1)?.kind ?? 'text');
```

No production path may write that projection.

### Public surface

```ts
interface MenuController {
  getSnapshot(): MenuState;

  applyEditorEdit(edit: EditorEdit): void;
  replaceText(text: string, cursor?: number): void;
  clearText(): void;

  dispatch(effect: MenuEffect, expected: ExpectedFrame): void;
  dispatchActiveEvent(event: MenuEvent): void;
  escape(): void;

  open(frame: UnboundFrameSpec, options?: OpenOptions): void;
  replace(frame: FrameSpec, options?: OpenOptions): void;
  close(): void;
  closeAll(): void;
}
```

Supporting public types are explicit rather than inferred by implementers:

```ts
type ExpectedFrame = Readonly<{ frameId: FrameId; revision: number }>;

type FrameInput =
  | { kind: 'composer'; text: string; cursor: number }
  | { kind: 'transient'; text: string; cursor: number; sensitive: boolean }
  | { kind: 'none' };

type TextBindingSpec = Omit<TextBinding, 'query' | 'activationId' | 'revision'>;

type FrameSpecOf<F extends MenuFrame = MenuFrame> = F extends MenuFrame
  ? Omit<F, 'id' | 'binding'> & { binding?: TextBindingSpec }
  : never;

type FrameSpec = FrameSpecOf;

type UnboundFrameSpec =
  | Omit<Extract<MenuFrame, { kind: 'rewind' }>, 'id'>
  | Omit<Extract<MenuFrame, { kind: 'providers' }>, 'id' | 'returnPoint'>;

type OpenOptions = Readonly<{
  buffer?: BufferChange;
  preserveEditorAsReturnPoint?: boolean;
}>;
```

Every operation computes the full next state, writes an authoritative mutable
snapshot before scheduling React state, and publishes one update. Ink input
callbacks always read that committed snapshot. This preserves the synchronous
burst-input invariant: several callbacks in one render turn cannot each derive
from stale text.

`dispatch` carries the active frame id and editor revision observed by the menu.
The controller rejects a stale effect rather than applying its ranges to a
newer buffer.

### Controller invariants

- `0 <= editor.cursor <= editor.text.length` after every transaction.
- A bound top frame's trigger literal still occupies its declared trigger
  range.
- A binding's `query` equals the current editor slice from `queryStart` through
  the cursor, and every replacement coordinate is valid for the same revision.
- Only controller transactions change editor text, cursor, stack, binding, or
  dismissal state.
- A child frame and any buffer edit needed to enter it commit together.
- A stale frame id/revision cannot produce a buffer edit or domain intent.
- Explicitly opened frames do not participate in text-trigger reconciliation.
- Every nested Back behavior is represented by the stack and an explicit
  return point, never by reparsing or a follow-up effect.
- `resolvedCandidateIdentity` and `activationEpoch` advance deterministically;
  dismissal never depends on a render or effect having run.

## Atomic effects

```ts
type StackChange =
  | { type: 'keep' }
  | { type: 'close-top' }
  | { type: 'close-all' }
  | { type: 'push'; frame: FrameSpec }
  | { type: 'replace-top'; frame: FrameSpec }
  | { type: 'pop-to'; frameId: FrameId };

type BufferChange =
  | { type: 'keep' }
  | { type: 'clear' }
  | { type: 'replace'; text: string; cursor: number }
  | { type: 'splice'; range: TextRange; text: string; cursor: 'after-insert' };

type DomainIntent =
  | { type: 'submit-prompt'; text: string }
  | {
      type: 'apply-settings';
      changes: readonly { key: string; value: unknown; persistence: 'runtime' | 'restart' }[];
    }
  | { type: 'reset-setting'; key: string }
  | { type: 'rewind'; item: RewindItem; disposition: RewindDisposition }
  | { type: 'provider-save'; draft: CustomProviderDraft; originalId: string | null }
  | { type: 'provider-delete'; providerId: string }
  | { type: 'provider-reorder'; providerIds: string[] }
  | { type: 'slash-execute'; command: SlashCommand; args?: string };

type MenuEffect = Readonly<{
  buffer?: BufferChange;
  stack: StackChange;
  intent?: IntentRequest;
}>;

type IntentRequest = Readonly<{
  id: string;
  sourceFrameId: FrameId;
  intent: DomainIntent;
}>;

type IntentResult =
  | { id: string; sourceFrameId: FrameId; ok: true }
  | {
      id: string;
      sourceFrameId: FrameId;
      ok: false;
      message: string;
      fieldErrors?: Readonly<Record<string, string>>;
    };
```

The controller commits `buffer` and `stack` first. The application effect host
then handles `intent` exhaustively. A slash command may still use the existing
`SlashCommand.action`, but it runs only after the slash frame's declared close
and buffer policy has committed. Any menu it opens does so through the public
controller capability. Settings-backed model acceptance uses one
`apply-settings` intent containing both the model and provider changes.

The effect host returns an `IntentResult` to the menu-input router. The router
delivers it only when the correlated source frame is still mounted. Provider
save/delete/reorder failures therefore return field errors to the provider
reducer without reopening or reconstructing the frame. Results for frames that
have closed are logged and ignored.

There is no untyped callback that can mutate stack or editor state behind the
controller.

### Settings parent-to-child transition

Selecting `shell.timeout` from `/settings shel` in `operation: 'set'` is one
transaction:

1. Replace the active settings-key range with `shell.timeout `.
2. Move the cursor after the delimiter.
3. Materialize a `settings_value` binding against the post-edit snapshot.
4. Push the child frame with
   `origin: {type: 'settings-list', operation: 'set', back: restore(...)}`.

The controller does not wait for trigger detection to rediscover the child.
Escape pops the child and restores the declared return point. Because the
settings component remains mounted underneath it, category, filter, and
selection state also survive.

A manually typed `/settings shell.timeout ` uses the same declared successor
and must construct a required `BackPolicy`; child frames never have an
undefined Back result. Settings-backed model selection uses the same pattern
with a `model` child.

Reset is a different settings operation, not a value-menu prefix accident:

- Selecting a key in `/settings reset ` preserves that prefix and completes
  `/settings reset <key> `.
- The completed reset frame handles the next acceptance as a typed
  `reset-setting` intent with an explicit buffer/stack result.
- It never pushes `settings_value` or rewrites the prefix to `/settings `.

After a successful setting value application, `SettingsOrigin` determines the
exit atomically: a settings-list origin restores/pops to its mounted parent;
direct triggers such as `/effort` and `/auto-approve` close and clear. Reset,
Back, and successful application therefore each have a declared result.

## Trigger grammar

```ts
type TriggerCandidate = Readonly<{
  ruleId: string;
  identity: string;
  frame: FrameSpec;
}>;

type TriggerRule = Readonly<{
  id: string;
  priority: number;
  parse(editor: EditorSnapshot): TriggerCandidate | null;
  successors: readonly {
    ruleId: string;
    operation: 'push' | 'replace-top';
  }[];
}>;
```

The registry validates unique rule ids, deterministic priority ties, and that
all declared successors exist. It does not attempt to inspect opaque parser
functions or reject every textual prefix relationship.

`/settings reset ` is a declared higher-priority extension of `/settings `.
`settings -> settings_value` and `settings -> setting-backed model` are
declared successors. The generic slash rule owns only command text before its
argument separator.

### Reconciliation rules

On every editor transaction:

1. Normalize text and cursor and increment the revision.
2. Resolve the highest-priority trigger candidate.
3. Compare its stable `identity` with `resolvedCandidateIdentity`.
4. On `null -> candidate`, increment `activationEpoch` and materialize
   `activationId = identity + ':' + activationEpoch`.
5. On `candidate -> null`, store `resolvedCandidateIdentity = null`; the next
   match is necessarily a new activation.
6. If there is no text-bound frame, open only on `null -> candidate`.
7. If the active candidate has the same activation, update its binding/query
   and preserve the mounted menu session.
8. If the candidate is a declared successor, increment the epoch and perform
   its push/replace
   transition atomically.
9. On unrelated `candidate A -> candidate B`, store B's identity, increment the
   epoch, materialize B's activation, and close or replace A according to the
   winning rule. B never inherits A's dismissal.
10. If the trigger literal is removed or the cursor leaves the permitted
    region, close according to the rule.
11. Explicitly opened frames ignore text-trigger reconciliation until closed.

Escape closes the top frame and records its activation id. That activation
cannot reopen until matching first becomes `null`. Re-renders and async item
refreshes therefore cannot reopen a dismissed menu. Moving out of the trigger
and back creates a new activation and may open it again.

Typing more query text after Escape does not reopen the same activation. This
is an intentional normalization of today's inconsistent dismissal behavior.

## Hook-safe menu host

The registry stores components, not hook-returning functions:

```ts
type MenuComponentProps<F extends MenuFrame> = {
  frame: F;
  active: boolean;
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  services: MenuServices;
};

type MenuRegistry = {
  [K in MenuFrame['kind']]: React.ComponentType<
    MenuComponentProps<Extract<MenuFrame, { kind: K }>>
  >;
};
```

```tsx
function MenuStackHost({ stack, controller, interactions, services }: Props) {
  return stack.map((frame, index) => {
    const Menu = registry[frame.kind];
    return (
      <Menu
        key={frame.id}
        frame={frame}
        active={index === stack.length - 1}
        controller={controller}
        interactions={interactions}
        services={services}
      />
    );
  });
}
```

Each frame is a real component boundary, so changing the active menu does not
change hook order inside `MenuStackHost`. Non-top frames remain mounted but
render nothing and do not consume input.

Only common selection mechanics are extracted:

```ts
function useMenuSelection<T>(
  items: readonly T[],
  options?: {
    isDisabled?: (item: T) => boolean;
    visibleRows?: number;
  },
): SelectionModel<T>;
```

Fetching, categories, provider caches, warnings, typed values, validation, and
rendering remain with their menu session.

### Active-menu events

```ts
type MenuEvent =
  | { type: 'move'; direction: 'up' | 'down' | 'home' | 'end' | 'page-up' | 'page-down' }
  | {
      type: 'command';
      command: 'tab' | 'left' | 'right' | 'refresh' | 'reset' | 'delete' | 'reorder-up' | 'reorder-down';
    }
  | { type: 'accept'; input: FrameInput; selected: unknown | undefined }
  | { type: 'escape' };

type MenuInteraction = Readonly<{
  handle(event: MenuEvent | IntentResult): MenuEffect | 'fallthrough' | void;
}>;

interface MenuInteractionRegistry {
  register(frameId: FrameId, interaction: MenuInteraction): () => void;
  dispatch(
    frameId: FrameId,
    event: MenuEvent | IntentResult,
  ): ReturnType<MenuInteraction['handle']>;
}
```

Accept always carries the current controller-owned input and an optional
selection. This preserves typed custom model ids, typed numeric/free-form
setting values, provider wizard fields, and fallthrough when a completion list
has no selected item.

Each mounted session calls
`useActiveMenuInteraction(frame.id, active, interaction)`. Registration uses a
stable mutable registry and unregisters on unmount or deactivation. The one
unconditional Ink listener converts terminal input to `MenuEvent` and calls
`controller.dispatchActiveEvent(event)`. The controller reads the committed
top frame, routes to that frame's registered interaction, then applies any
returned effect with the current `ExpectedFrame`.

Thus only the top frame consumes input, inactive mounted parents retain state,
and neither `InputBox` nor the controller contains a per-kind handler table.

## Menu-specific sessions

| Session | Owned state and behavior |
| --- | --- |
| slash | filtering, selection, Tab completion, typed argument execution |
| path | workspace items/loading/error/warning, selection and refresh |
| settings | category, search-all mode, filter, selection and current values |
| settings value | suggestions, free-form/numeric parsing, persistence choice, reset |
| model | provider, per-provider cache/loading/error, refresh and typed model fallback |
| skills | skill filtering, selection and suffix-preserving insertion |
| rewind | selection, scroll and mutable edit/resend disposition |
| providers | provider workflow reducer described below |

### Provider session

```ts
type ProviderSessionState =
  | { phase: 'list'; items: ProviderSelectionItem[] }
  | {
      phase: 'wizard-name' | 'wizard-url' | 'wizard-key';
      draft: CustomProviderDraft;
      editingField: ProviderField | null;
      modified: boolean;
    }
  | { phase: 'wizard-type'; draft: CustomProviderDraft; editingField: ProviderField | null }
  | { phase: 'edit-fields'; draft: CustomProviderDraft; originalId: string }
  | { phase: 'confirm-discard'; resume: ProviderSessionState }
  | { phase: 'confirm-delete'; providerId: string }
  | { phase: 'reorder'; providerIds: string[] };
```

The provider component owns this reducer, field errors, and validation. Opening
the provider frame captures the composer's editor as its `returnPoint`. Wizard
text then uses the controller-owned editor as transient field input; closing
the provider frame restores the captured composer atomically, so field edits
never destroy a suspended draft. Escape is first offered to the provider
reducer:

- field with changes -> `confirm-discard`;
- field without changes -> previous provider phase;
- reorder/delete confirmation -> previous provider phase;
- provider list -> controller closes the frame.

Backspace/Delete and `[`/`]` remain phase-sensitive provider events rather than
being forced into generic list behavior.

## Integration flow

### Text-triggered completion

1. `InputBox` forwards the editor change to `applyEditorEdit`.
2. The controller commits text/cursor/revision and reconciles the grammar.
3. React renders the published snapshot and mounts/updates the relevant frame.
4. The active menu reads `frame.binding.query`.
5. The Ink listener routes acceptance through the active interaction; the
   session returns a `MenuEffect` with the observed frame id/revision.
6. The controller atomically commits its buffer and stack changes.
7. The application effect host executes any domain intent and returns a
   correlated result when the originating session needs one.

### External menu opening

`app.tsx`, handoff, rewind, and provider commands receive a typed menu
capability from the input composition root:

```ts
type MenuCapability = Pick<MenuController, 'open' | 'replace' | 'close' | 'closeAll'>;
```

This replaces `rewindMenuRef`, `providersMenuRef`, and direct
`setMode`/`setTriggerIndex` calls. It is a normal public boundary, not a ref into
an `InputBox` hook.

## Migration

### Phase 0 - characterize behavior

No production change.

- Build a parity matrix that asserts buffer text, cursor, visible menu,
  selection, submitted turn, and service side effects.
- Lock down current replacement ranges before deleting `insertions.ts`.
- Preserve the synchronous `/usage` burst regression.
- Inventory every text/cursor/mode writer and every menu opener.

Gate: focused InputBox, InputContext, trigger/escape, insertion, provider,
rewind, handoff, and command tests pass on the baseline.

### Phase 1 - pure controller kernel

- Add the reducer/controller, frame and effect types, trigger grammar, and
  focused contract tests.
- Do not mount it in `InputBox` yet.
- Use existing renderers in test fixtures where useful; do not redesign UI.

Gate: contract tests cover every trigger, legal extension, successor,
invalidation, dismissal, replacement range, stale effect, and Back result.
They also cover active-interaction routing and correlated intent success/failure
delivery. The legacy runtime remains the sole authority.

### Phase 2 - atomic editor cutover

- Back `InputContext` with the controller snapshot and transactions.
- Keep `InputContext` temporarily as a compatibility facade with no independent
  input/menu state.
- Route every production text and cursor mutation through the controller.
- Preserve a synchronous committed snapshot for Ink callbacks.
- Keep legacy menu rendering/detection only through adapters.

Gate: no production path writes separate input/cursor state. Legacy-shaped
setters only forward to controller transactions. The burst and focused input
suites pass repeatedly.

### Phase 3 - external frames

- Migrate rewind and providers to controller-opened mounted sessions.
- Replace `rewindMenuRef` and `providersMenuRef` at the application boundary.
- Preserve provider draft/discard/delete/reorder behavior and rewind
  disposition.

Gate: there are no imperative menu refs. External opening, Back, repeated open,
provider wizard, delete/reorder, and rewind edit/resend tests pass.

### Phase 4 - connected trigger graphs

Migrate each graph completely before starting the next:

1. slash command selection and typed execution;
2. path and skills completion;
3. settings, reset, settings value, and settings-backed model selection;
4. direct model/effort triggers and handoff model selection.

For each graph, replace its legacy detection, key mapping, acceptance helper,
and popup prop block together. Registry sessions may keep existing render
components.

Graphs 1–2 are merged. Before starting graph 3, read
`### Phase 4 rule-id collision` in **Resume here**: graphs 3 and 4 share rule
ids today and must be split first, or enabling either one silently hands both
graphs to the controller at once.

Gate per graph: exactly one engine owns it, no legacy handler/helper remains
reachable for it, and its parity cases pass.

### Phase 5 - delete legacy paths

Delete only after every graph is controller-owned:

- stored `InputMode` and `triggerIndex`;
- completion dismissal and input revision refs;
- `useTriggerDetection`;
- legacy completion branches in `useEscapeKey`;
- `useModeHandlers`;
- `PopupManager`'s hand-mapped prop adapter;
- imperative rewind/provider refs;
- obsolete insertion helpers.

Keep any cursor workaround still required by `ink-prompt` inside the editor
adapter. It must not remain menu state.

Gate: production search has zero callers of legacy setters, refs, and helpers;
the focused suites, full `pnpm test`, typecheck, lint, and `git diff --check`
pass.

## Writer and opener checklist

These paths must migrate before their legacy setters disappear:

- normal and popup editing in `InputBox`;
- autocomplete and command completion;
- trigger detection and Escape;
- app-level rewind/provider openers;
- settings/model/effort/skills command input replacement;
- handoff model selection;
- provider wizard field editing;
- rewind restore and resend;
- pending-turn guard restoration;
- shell mode, history, queue editing, and app shortcuts;
- test harnesses that currently write `mode` or `triggerIndex` directly.

During migration, engine ownership is static per trigger graph and frozen for
the lifetime of an open frame. Do not dual-write, mirror, or repair divergence
between legacy and controller state.

## Required parity matrix

| Contract | Required cases |
| --- | --- |
| grammar | slash, path, skills, model, direct setting value, settings, reset, settings-to-value successor |
| replacement | path consumes `@`; settings inserts key/delimiter; path/skill/value suffix behavior; model replace-to-end |
| stack and Back | Escape does not reopen; settings value/model return points; provider phase-aware Back |
| acceptance | Tab vs Enter; typed custom model; typed numeric/free-form setting; settings reset; submit/fallthrough |
| navigation | arrows, page/home/end, category/provider switching, refresh, reset, rewind disposition, provider delete/reorder |
| external opens | slash action, app command, handoff, rewind restore/resend |
| async rendering | model loading/error/refresh, path warning, settings categories, provider field errors |
| intent results | model+provider setting application; provider save/delete/reorder success and field-error return |
| atomic editing | insertion/backspace/delete away from end; synchronous slash burst; exact cursor per transaction |
| adjacent input behavior | queue selection/edit, history, image input, shell mode, Alt+Enter |

After each non-trivial defect found during migration, add the narrow regression
and ask which missing controller invariant or parity case allowed the defect
class. A one-off test without the structural follow-up is not sufficient.

## Expected file shape

Names may change during implementation, but ownership should converge on:

- `source/components/input/menu-controller.ts` - pure transactional kernel and
  trigger reconciliation;
- `source/components/input/menu-types.ts` - frames, bindings, effects, intents;
- `source/components/input/MenuStackHost.tsx` - hook-safe mounted frame host;
- `source/components/input/menu-registry.tsx` - frame-to-component mapping;
- existing menu hooks/components, incrementally converted into mounted
  sessions;
- `source/context/InputContext.tsx` - composition/provider and temporary
  compatibility facade;
- `source/components/InputBox.tsx` - terminal editor adapter;
- an application-level exhaustive intent handler near the input composition
  root.

Do not create separate manager/coordinator/driver layers around the controller.
The controller is already the deep module that owns the lifecycle invariant.

## Verification commands

Per step, before merging back:

```bash
FORCE_COLOR=0 pnpm vitest run \
  source/components/InputBox.test.tsx \
  source/context/InputContext.test.tsx \
  source/components/input/ \
  source/hooks/
pnpm run typecheck
```

Two measured caveats, both pre-existing and neither caused by `ed3a8a31`:

- **`FORCE_COLOR=0` is required.** Two queue tests in `InputBox.test.tsx`
  (`up enters the queued selector…`, `up past the top queued item…`) assert
  with `toContain` on raw strings that chalk splits with colour escapes. They
  pass at colour level 0 and fail at level 3. Without the variable you will
  chase two phantom failures.
- The split-chunk Alt+Enter case was repaired during this Phase 5 work. It
  must remain covered in the focused suite and must submit exactly once as a
  `follow_up`.

The final gate must include:

```bash
pnpm test
pnpm run typecheck
pnpm run lint
git diff --check
```

This is UI/input work, not a provider, bridge, run-loop, registry, or
non-interactive change; `pnpm test:provider-black-box` is not required unless
implementation crosses one of those boundaries.
