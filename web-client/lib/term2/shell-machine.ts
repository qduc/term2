/**
 * The chat shell's selection and draft policy as one pure function: `step(state, action) → { state, commands }`.
 * No React, no I/O. Term2SessionShell holds the state with useReducer and runs the returned commands in one
 * place (docs/plans/web-client/web-transcript-single-source-spec.md, section 5).
 *
 * The address bar owns which chat is open: `URL_CHANGED` is the only action that changes it. Every change of
 * what the page shows (another chat, a new or discarded draft) bumps `generation`. A command carries the `{ sessionId, generation }` it was issued under and its result
 * action echoes that tag; a result whose tag is no longer current is dropped. That single rule is what stops a
 * late response from one chat landing on another.
 */
import type { SessionConfigRecord, SessionConfigUpdate } from './types';

export type DraftConfig = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'approvalMode'>;
export type StagedConfig = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort'>;
export type Delivery = 'auto' | 'steer' | 'follow_up';
export type Tag = { readonly sessionId: string | null; readonly generation: number };

export type ShellState = {
  /** The chat the address bar names, as last reported by URL_CHANGED. */
  readonly openChat: string | null;
  readonly generation: number;
  /**
   * An unsent new chat: its folder and the picks to apply before its first message. `createdSessionId` is the
   * chat its first send already created, so a retry after a failure reuses it instead of creating another.
   */
  readonly draft: { readonly workspaceId: string; readonly config: DraftConfig; readonly createdSessionId?: string } | null;
  /** A draft's first send is in progress (creating the chat, applying its picks). */
  readonly starting: boolean;
  /** What the first send asked for, kept while its chat is being created. */
  readonly sendIntent: { readonly delivery?: Delivery; readonly overrideText?: string } | null;
  readonly startError: string | null;
  /** The first message waits for its new chat to be open, configured and live. */
  readonly pendingFirstSend: { readonly sessionId: string; readonly delivery?: Delivery; readonly overrideText?: string } | null;
  /** The open chat's configuration, only ever for `openChat`. */
  readonly config: SessionConfigRecord | null;
  /** Model or effort picked in the open chat, applied before its next message. */
  readonly staged: StagedConfig | null;
};

export type ShellAction =
  | { readonly type: 'URL_CHANGED'; readonly sessionId: string | null }
  | { readonly type: 'NEW_DRAFT'; readonly workspaceId: string }
  /** Back to the welcome screen: no draft and no chat. */
  | { readonly type: 'DRAFT_DISCARDED' }
  | { readonly type: 'DRAFT_CONFIG_PICKED'; readonly selection: DraftConfig }
  | { readonly type: 'DRAFT_SEND_REQUESTED'; readonly delivery?: Delivery; readonly overrideText?: string }
  | { readonly type: 'SESSION_CREATED'; readonly tag: Tag; readonly sessionId: string }
  | { readonly type: 'DRAFT_CONFIG_APPLIED'; readonly tag: Tag; readonly sessionId: string }
  | { readonly type: 'DRAFT_START_FAILED'; readonly tag: Tag; readonly message: string }
  | { readonly type: 'CONFIG_LOADED'; readonly tag: Tag; readonly config: SessionConfigRecord }
  | { readonly type: 'STAGED_CHANGED'; readonly staged: StagedConfig | null }
  /** Fed from the page: the open chat's config is loaded, sending is not blocked and its stream is live. */
  | { readonly type: 'READY_TO_SEND'; readonly sessionId: string };

export type ShellCommand =
  | { readonly type: 'createSession'; readonly tag: Tag; readonly workspaceId: string }
  | { readonly type: 'applyDraftConfig'; readonly tag: Tag; readonly sessionId: string; readonly config: DraftConfig }
  | { readonly type: 'navigate'; readonly sessionId: string | null }
  | { readonly type: 'loadConfig'; readonly tag: Tag }
  | { readonly type: 'submitFirst'; readonly sessionId: string; readonly delivery?: Delivery; readonly overrideText?: string };

export const initialShellState = (openChat: string | null): ShellState => ({
  openChat,
  generation: 0,
  draft: null,
  starting: false,
  sendIntent: null,
  startError: null,
  pendingFirstSend: null,
  config: null,
  staged: null,
});

/** The tag a command issued now carries. */
export const currentTag = (state: ShellState): Tag => ({ sessionId: state.openChat, generation: state.generation });
/** Whether a result issued under `tag` still belongs to what the page shows. */
export const isCurrentTag = (state: ShellState, tag: Tag) =>
  tag.generation === state.generation && tag.sessionId === state.openChat;
const isCurrent = isCurrentTag;
const result = (state: ShellState, commands: readonly ShellCommand[] = []) => ({ state, commands });

/** The commands a just-opened chat needs. */
const opened = (state: ShellState): readonly ShellCommand[] =>
  state.openChat ? [{ type: 'loadConfig', tag: currentTag(state) }] : [];

export function step(state: ShellState, action: ShellAction): { state: ShellState; commands: readonly ShellCommand[] } {
  switch (action.type) {
    case 'URL_CHANGED': {
      if (action.sessionId === state.openChat) return result(state);
      // A draft handing off to the chat it just created keeps its first send; any other change drops it.
      const handoff = state.pendingFirstSend?.sessionId === action.sessionId ? state.pendingFirstSend : null;
      const next: ShellState = {
        ...state,
        openChat: action.sessionId,
        generation: state.generation + 1,
        // Opening a real chat ends the draft; leaving one (no chat named) keeps a draft just opened.
        draft: action.sessionId ? null : state.draft,
        starting: action.sessionId ? false : state.starting,
        sendIntent: action.sessionId ? null : state.sendIntent,
        startError: null,
        pendingFirstSend: handoff,
        config: null,
        staged: null,
      };
      return result(next, opened(next));
    }
    case 'NEW_DRAFT': {
      // Not while a first send is creating its chat (the page disables New chat then too).
      if (state.starting) return result(state);
      // A chat a failed first send already created in this folder is reused by the new draft, not left behind.
      const created =
        state.draft?.workspaceId === action.workspaceId ? state.draft.createdSessionId : undefined;
      return result(
        {
          ...state,
          // A new draft is a new thing on screen: results for an earlier draft no longer apply.
          generation: state.generation + 1,
          draft: { workspaceId: action.workspaceId, config: {}, ...(created ? { createdSessionId: created } : {}) },
          startError: null,
          staged: null,
        },
        state.openChat ? [{ type: 'navigate', sessionId: null }] : [],
      );
    }
    case 'DRAFT_DISCARDED':
      return result(
        { ...state, generation: state.generation + 1, draft: null, starting: false, sendIntent: null, startError: null },
        state.openChat ? [{ type: 'navigate', sessionId: null }] : [],
      );
    case 'DRAFT_CONFIG_PICKED':
      return state.draft
        ? result({ ...state, draft: { ...state.draft, config: { ...state.draft.config, ...action.selection } } })
        : result(state);
    case 'DRAFT_SEND_REQUESTED': {
      if (!state.draft || state.starting || state.openChat) return result(state);
      const tag = currentTag(state);
      const next: ShellState = {
        ...state,
        starting: true,
        startError: null,
        pendingFirstSend: null,
        sendIntent: {
          ...(action.delivery ? { delivery: action.delivery } : {}),
          ...(action.overrideText !== undefined ? { overrideText: action.overrideText } : {}),
        },
      };
      const created = state.draft.createdSessionId;
      return result(next, [
        created
          ? { type: 'applyDraftConfig', tag, sessionId: created, config: state.draft.config }
          : { type: 'createSession', tag, workspaceId: state.draft.workspaceId },
      ]);
    }
    case 'SESSION_CREATED': {
      if (!isCurrent(state, action.tag) || !state.draft || !state.starting) return result(state);
      const draft = { ...state.draft, createdSessionId: action.sessionId };
      return result({ ...state, draft }, [
        { type: 'applyDraftConfig', tag: action.tag, sessionId: action.sessionId, config: draft.config },
      ]);
    }
    case 'DRAFT_CONFIG_APPLIED': {
      if (!isCurrent(state, action.tag) || !state.draft || !state.starting) return result(state);
      return result(
        {
          ...state,
          starting: false,
          sendIntent: null,
          pendingFirstSend: { sessionId: action.sessionId, ...state.sendIntent },
        },
        [{ type: 'navigate', sessionId: action.sessionId }],
      );
    }
    case 'DRAFT_START_FAILED': {
      if (!isCurrent(state, action.tag)) return result(state);
      return result({ ...state, starting: false, sendIntent: null, startError: action.message });
    }
    case 'CONFIG_LOADED':
      return isCurrent(state, action.tag) && action.config.sessionId === state.openChat
        ? result({ ...state, config: action.config })
        : result(state);
    case 'STAGED_CHANGED':
      return result({ ...state, staged: action.staged });
    case 'READY_TO_SEND': {
      const pending = state.pendingFirstSend;
      if (!pending || pending.sessionId !== state.openChat || action.sessionId !== state.openChat) return result(state);
      return result({ ...state, pendingFirstSend: null }, [
        {
          type: 'submitFirst',
          sessionId: pending.sessionId,
          ...(pending.delivery ? { delivery: pending.delivery } : {}),
          ...(pending.overrideText !== undefined ? { overrideText: pending.overrideText } : {}),
        },
      ]);
    }
  }
}
