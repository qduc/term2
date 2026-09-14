/**
 * Data-only binding descriptors for menu frames.
 *
 * Each table is the single source of truth for a frame's advertised keys:
 * the MenuFooter renders from it (via bindingHints), and the interaction's
 * handle() switch in the owning session session file is the behavior it
 * describes. Hints cannot drift from behavior because both sides are tested
 * against the same table (see menu-bindings.test.ts).
 *
 * Entries are deliberately data-only: key/action labels plus the command ids
 * they map to. State-dependent availability (e.g. the inline nickname editor
 * suspending Tab and list navigation in the model frame) is expressed by the
 * owner selecting a different table, never by predicates inside entries.
 *
 * Tab policy (conditional rule, 2026-09-14): Tab advances the frame's
 * secondary dimension — it switches tabs/sections where such a dimension
 * exists, and completes the highlighted entry where it does not. Each Tab
 * binding must carry a rationale recording the decision that gives it its
 * meaning, so a future "consistency" pass has to consciously delete the
 * recorded decision rather than silently reverting it.
 */

/** Every event/command id a menu interaction may advertise a key for. */
export const MENU_COMMAND_VOCABULARY = [
  'move',
  'accept',
  'escape',
  'input',
  'tab',
  'left',
  'right',
  'backspace',
  'refresh',
  'favorite',
  'nickname',
] as const;

export type MenuCommandId =
  | 'move'
  | 'accept'
  | 'escape'
  | 'input'
  | 'tab'
  | 'left'
  | 'right'
  | 'backspace'
  | 'refresh'
  | 'favorite'
  | 'nickname';

export type MenuBinding = Readonly<{
  /** Footer key label, e.g. '↑↓' or 'Tab/←→'. */
  key: string;
  /** Footer action label, e.g. 'navigate'. */
  action: string;
  /** Event/command ids the owning interaction dispatches for this key. */
  commands?: readonly MenuCommandId[];
  /**
   * The recorded decision this binding implements. Required for Tab
   * bindings; optional elsewhere.
   */
  rationale?: string;
}>;

export type MenuBindingTable = readonly MenuBinding[];

/** Derive the [key, action] hint rows MenuFooter renders from a table. */
export const bindingHints = (bindings: MenuBindingTable): [string, string][] =>
  bindings.map(({ key, action }) => [key, action]);

/** Slash-command picker. Owned by createSlashMenuInteraction (SlashMenuSession). */
export const SLASH_MENU_BINDINGS: MenuBindingTable = [
  { key: '↑↓', action: 'navigate', commands: ['move'] },
  { key: '⏎', action: 'run', commands: ['accept'] },
  {
    key: 'Tab',
    action: 'complete',
    commands: ['tab'],
    rationale:
      'The slash frame has no tab/section dimension, so under the conditional Tab rule Tab inserts the highlighted command into the composer ("complete") without executing it.',
  },
  { key: 'esc', action: 'cancel', commands: ['escape'] },
];

/**
 * Model picker list-footer segments, in advertised order. Owned by
 * ModelMenuSession's interaction while no nickname draft is open;
 * MODEL_MENU_BINDINGS is the unified (Favorites/All) composition.
 */
const MODEL_MENU_CORE_BINDINGS: MenuBindingTable = [
  { key: '↑↓', action: 'navigate', commands: ['move'] },
  { key: '⏎', action: 'select', commands: ['accept'] },
];

const MODEL_MENU_TAB_BINDINGS: MenuBindingTable = [
  {
    key: 'Tab/←→',
    action: 'tab',
    commands: ['tab', 'left', 'right'],
    rationale:
      'User decision f106ddd1 (2026-09-11): Tab switches the Favorites/All tab and never completes the highlighted model id into the composer; Enter is the only selection key.',
  },
];

const MODEL_MENU_NICKNAME_BINDINGS: MenuBindingTable = [{ key: 'ctrl+n', action: 'nickname', commands: ['nickname'] }];

const MODEL_MENU_TAIL_BINDINGS: MenuBindingTable = [
  { key: 'ctrl+f', action: 'favorite', commands: ['favorite'] },
  { key: 'ctrl+r', action: 'refresh model list', commands: ['refresh'] },
  { key: 'esc', action: 'cancel', commands: ['escape'] },
];

export const MODEL_MENU_BINDINGS: MenuBindingTable = [
  ...MODEL_MENU_CORE_BINDINGS,
  ...MODEL_MENU_TAB_BINDINGS,
  ...MODEL_MENU_NICKNAME_BINDINGS,
  ...MODEL_MENU_TAIL_BINDINGS,
];

/** Model picker, legacy per-provider tab mode (←→ switches provider tabs). */
export const MODEL_MENU_PROVIDER_TAB_BINDINGS: MenuBindingTable = [
  { key: '←→', action: 'provider', commands: ['left', 'right'] },
];

/**
 * Model picker while the inline nickname editor owns the input row: Tab and
 * list navigation are deliberately suspended (the editor is bound to one
 * highlighted row, so navigating away would orphan it), and only the draft
 * bindings are advertised.
 */
export const MODEL_MENU_NICKNAME_DRAFT_BINDINGS: MenuBindingTable = [
  { key: '⏎', action: 'save nickname', commands: ['accept'] },
  { key: 'esc', action: 'cancel nickname', commands: ['escape'] },
];

/** Model picker error/empty fallback under a legacy per-provider tab. */
export const MODEL_MENU_PROVIDER_FALLBACK_BINDINGS: MenuBindingTable = [
  { key: '←→', action: 'switch provider', commands: ['left', 'right'] },
  { key: 'esc', action: 'cancel', commands: ['escape'] },
];

/**
 * Select the bindings advertised in the model picker's list footer. Pure
 * selection over the tables above — state lives in the caller's props, never
 * in predicates here. While a nickname draft is open the component advertises
 * MODEL_MENU_NICKNAME_DRAFT_BINDINGS instead and does not call this.
 */
export const modelMenuFooterBindings = (dims: {
  /** The frame renders the Favorites/All tab switcher (unified mode). */
  tabDimension: boolean;
  /** The frame renders a legacy per-provider tab bar. */
  providerDimension: boolean;
  /** The highlighted row can be nicknamed (Favorites or unified view). */
  nicknameAvailable: boolean;
}): MenuBindingTable => [
  ...MODEL_MENU_CORE_BINDINGS,
  ...(dims.tabDimension ? MODEL_MENU_TAB_BINDINGS : dims.providerDimension ? MODEL_MENU_PROVIDER_TAB_BINDINGS : []),
  ...(dims.nicknameAvailable ? MODEL_MENU_NICKNAME_BINDINGS : []),
  ...MODEL_MENU_TAIL_BINDINGS,
];
