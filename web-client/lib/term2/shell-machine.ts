/**
 * The chat shell's policy as one pure function: `step(state, action) → { state, commands }`. No React, no I/O.
 * Term2SessionShell holds the state and runs the returned commands in one place
 * (docs/plans/web-client/web-transcript-single-source-spec.md, section 5).
 *
 * The address bar owns which chat is open: `URL_CHANGED` is the only action that changes it. Every change of
 * what the page shows (another chat, a new or discarded draft) bumps `generation`. A command carries the
 * `{ sessionId, generation }` it was issued under and its result action echoes that tag; a result whose tag is no
 * longer current is dropped. That single rule is what stops a late response from one chat landing on another:
 * a config read, a send's outcome, a rewound prompt put back, an image that finished reading.
 *
 * Slices: selection and draft (the open chat, the draft and its first send, the open chat's config and the staged
 * model/effort); the composer (the message box, sending, notices, the user's chosen folder, the transcript pin, the
 * delayed post-tool status and the background-notice drain); and the panels (running tasks, sidebar, dialogs, the
 * skills picker).
 */
import type { ImageAttachmentPayload, SessionConfigRecord, SessionConfigUpdate } from './types';

export type DraftConfig = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'approvalMode'>;
export type StagedConfig = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort'>;
export type Delivery = 'auto' | 'steer' | 'follow_up';
export type Tag = { readonly sessionId: string | null; readonly generation: number };

/** A status that follows a finished tool row waits this long, so a quick next step does not flash it. */
export const POST_TOOL_STATUS_DELAY_MS = 400;
/** A busy or failed background-notice drain is asked once more after this long. */
export const BACKGROUND_DRAIN_RETRY_MS = 2_000;

export interface ComposerImage extends ImageAttachmentPayload {
  readonly id: string;
  readonly name: string;
  readonly previewUrl: string;
}

/** What the user is writing: reset whenever the page shows something else, except a draft's own handoff. */
export type Composer = {
  readonly input: string;
  readonly attachments: readonly ComposerImage[];
  readonly armedSkill: string | null;
  /** Position in the prompt history while browsing it with the arrow keys. */
  readonly historyIndex: number | null;
  /** The slash-command palette. */
  readonly paletteOpen: boolean;
};

export type Notices = {
  /** A rewound Edit or Retry whose message was not sent: the text is back in the message box. */
  readonly resend: string | null;
  readonly config: string | null;
  readonly attachment: string | null;
};
export type NoticeKey = keyof Notices;

export type Dialog = 'folder' | 'help' | 'rewind' | 'provider';

export type Panels = {
  /** The running tasks panel: only the user opens or closes it (#394, #396). */
  readonly tasks: boolean;
  readonly sidebar: boolean;
  readonly dialog: Dialog | null;
  readonly skills: boolean;
};

/** One message as the user sent it, fixed when Send was pressed. */
export type OutgoingMessage = {
  readonly requestId: string;
  readonly text: string;
  readonly delivery: Delivery;
  readonly expectedSteerTurnId?: string;
  readonly skill?: string;
  readonly attachments?: readonly ComposerImage[];
  /** It came from the message box (not an Edit or Retry), so acceptance clears the box. */
  readonly fromComposer: boolean;
  /** An Edit or Retry: if it is refused, its text goes back into the message box with the resend notice. */
  readonly restoreOnFailure: boolean;
};

export type ShellState = {
  /** The chat the address bar names, as last reported by URL_CHANGED. */
  readonly openChat: string | null;
  readonly generation: number;
  /** The folder the user last chose (a folder pick, a new chat in it, a chat opened from it). */
  readonly chosenFolder: string | null;
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
  readonly composer: Composer;
  readonly notices: Notices;
  /** A message on its way: the staged picks are being applied, or the message is being submitted. */
  readonly sending: OutgoingMessage | null;
  /** The transcript follows new output. */
  readonly pinned: boolean;
  /** The page's live status line; a deferred one is shown only once its timer fires. */
  readonly liveStatus: { readonly text: string | null; readonly defer: boolean; readonly shown: string | null; readonly timer: number };
  /** The background-notice boundary last asked about, and whether its one retry was used. */
  readonly drain: { readonly boundary: string; readonly retried: boolean } | null;
  readonly panels: Panels;
};

/** The facts of the open chat the page reports with a send. */
export type SendContext = { readonly runningTurnId: string | null };

export type ShellAction =
  | { readonly type: 'URL_CHANGED'; readonly sessionId: string | null }
  | { readonly type: 'NEW_DRAFT'; readonly workspaceId: string }
  /** Back to the welcome screen: no draft and no chat. */
  | { readonly type: 'DRAFT_DISCARDED' }
  | { readonly type: 'FOLDER_CHOSEN'; readonly workspaceId: string | null }
  | { readonly type: 'DRAFT_CONFIG_PICKED'; readonly selection: DraftConfig }
  /**
   * Send pressed, or an Edit or Retry. In a draft it starts the first send; in a chat it applies any staged picks
   * first (unless a turn is running: a steer or queued message leaves them staged), then submits.
   */
  | {
      readonly type: 'SEND_REQUESTED';
      readonly requestId: string;
      readonly context: SendContext;
      readonly delivery?: Delivery;
      readonly overrideText?: string;
      /** Edit and Retry resend one message's text without the composer's attachments or skill. */
      readonly textOnly?: boolean;
    }
  | { readonly type: 'SESSION_CREATED'; readonly tag: Tag; readonly sessionId: string }
  | { readonly type: 'DRAFT_CONFIG_APPLIED'; readonly tag: Tag; readonly sessionId: string }
  | { readonly type: 'DRAFT_START_FAILED'; readonly tag: Tag; readonly message: string }
  | { readonly type: 'CONFIG_LOADED'; readonly tag: Tag; readonly config: SessionConfigRecord }
  | { readonly type: 'STAGED_CHANGED'; readonly staged: StagedConfig | null }
  | { readonly type: 'STAGED_APPLIED'; readonly tag: Tag; readonly requestId: string; readonly ok: boolean }
  | { readonly type: 'SUBMIT_SETTLED'; readonly tag: Tag; readonly requestId: string; readonly accepted: boolean }
  /** Fed from the page: the open chat's config is loaded, sending is not blocked and its stream is live. */
  | { readonly type: 'READY_TO_SEND'; readonly sessionId: string; readonly context: SendContext; readonly requestId: string }
  /** The user edits the message box. */
  | { readonly type: 'COMPOSER_EDITED'; readonly patch: Partial<Composer> }
  /** Text put back into the message box after an await (a rewind that restores its prompt). */
  | { readonly type: 'TEXT_RESTORED'; readonly tag: Tag; readonly text: string }
  | { readonly type: 'ATTACHMENTS_ADDED'; readonly tag: Tag; readonly images: readonly ComposerImage[]; readonly error: string | null }
  | { readonly type: 'NOTICE'; readonly tag: Tag; readonly key: NoticeKey; readonly message: string | null }
  | { readonly type: 'SCROLLED'; readonly pinned: boolean }
  /** Fed from the page whenever its status line or whether it follows a tool row changes. */
  | { readonly type: 'LIVE_STATUS'; readonly text: string | null; readonly defer: boolean }
  | { readonly type: 'STATUS_TIMER_FIRED'; readonly timer: number }
  /** Fed from the page: the open chat is idle with undelivered background notices at this accepted boundary. */
  | { readonly type: 'BOUNDARY'; readonly sessionId: string; readonly boundary: string }
  | { readonly type: 'DRAIN_ANSWERED'; readonly tag: Tag; readonly boundary: string; readonly retry: boolean }
  | { readonly type: 'DRAIN_RETRY_DUE'; readonly tag: Tag; readonly boundary: string }
  | { readonly type: 'TASKS_PANEL_TOGGLED' }
  | { readonly type: 'TASKS_PANEL_CLOSED' }
  /** The user opens or closes the sidebar (the page also closes it after a pick on a small screen). */
  | { readonly type: 'SIDEBAR_SET'; readonly open: boolean }
  | { readonly type: 'DIALOG_OPENED'; readonly dialog: Dialog }
  | { readonly type: 'DIALOG_CLOSED' }
  | { readonly type: 'SKILLS_SET'; readonly open: boolean };

export type ShellCommand =
  | { readonly type: 'createSession'; readonly tag: Tag; readonly workspaceId: string }
  | { readonly type: 'applyDraftConfig'; readonly tag: Tag; readonly sessionId: string; readonly config: DraftConfig }
  | { readonly type: 'navigate'; readonly sessionId: string | null }
  | { readonly type: 'loadConfig'; readonly tag: Tag }
  | { readonly type: 'applyStaged'; readonly tag: Tag; readonly requestId: string; readonly changes: StagedConfig }
  | { readonly type: 'submit'; readonly tag: Tag; readonly message: OutgoingMessage }
  /** The message was accepted: remember it in the prompt history. */
  | { readonly type: 'rememberPrompt'; readonly text: string }
  | { readonly type: 'drainNotifications'; readonly tag: Tag; readonly boundary: string }
  /** Dispatch `action` after `ms`. A stale one is dropped like any other result. */
  | { readonly type: 'later'; readonly ms: number; readonly action: ShellAction };

export const EMPTY_COMPOSER: Composer = { input: '', attachments: [], armedSkill: null, historyIndex: null, paletteOpen: false };
export const NO_NOTICES: Notices = { resend: null, config: null, attachment: null };
const NO_LIVE_STATUS = { text: null, defer: false, shown: null, timer: 0 };
const CLOSED_PANELS: Panels = { tasks: false, sidebar: false, dialog: null, skills: false };

export const initialShellState = (openChat: string | null): ShellState => ({
  openChat,
  generation: 0,
  chosenFolder: null,
  draft: null,
  starting: false,
  sendIntent: null,
  startError: null,
  pendingFirstSend: null,
  config: null,
  staged: null,
  composer: EMPTY_COMPOSER,
  notices: NO_NOTICES,
  sending: null,
  pinned: true,
  liveStatus: NO_LIVE_STATUS,
  drain: null,
  panels: CLOSED_PANELS,
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

/**
 * What leaving the current screen clears: the message box, its notices, a send in flight and the drain boundary.
 * The status line is not cleared here: it follows the transcript the page shows (LIVE_STATUS).
 */
const LEFT_SCREEN: Pick<ShellState, 'composer' | 'notices' | 'sending' | 'pinned' | 'drain'> = {
  composer: EMPTY_COMPOSER,
  notices: NO_NOTICES,
  sending: null,
  pinned: true,
  drain: null,
};

/**
 * Panels that belong to the chat on screen close when it changes: the rewind dialog (it rewinds that chat) and
 * the skills picker (it arms a skill in that chat's message). The running tasks panel and the sidebar stay as
 * the user left them.
 */
const panelsLeaving = (panels: Panels): Panels =>
  panels.dialog === 'rewind' || panels.skills
    ? { ...panels, dialog: panels.dialog === 'rewind' ? null : panels.dialog, skills: false }
    : panels;

/** The message a send carries, fixed now; null when there is nothing to send. */
function outgoing(
  state: ShellState,
  requestId: string,
  context: SendContext,
  delivery: Delivery | undefined,
  overrideText: string | undefined,
  textOnly: boolean,
): OutgoingMessage | null {
  const { composer } = state;
  const text = (overrideText ?? composer.input).trim();
  const withExtras = !textOnly;
  if (!text && !(withExtras && composer.attachments.length > 0)) return null;
  const effective = delivery ?? (context.runningTurnId ? 'steer' : 'auto');
  return {
    requestId,
    text,
    delivery: effective,
    ...(effective === 'steer' && context.runningTurnId ? { expectedSteerTurnId: context.runningTurnId } : {}),
    ...(withExtras && composer.armedSkill ? { skill: composer.armedSkill } : {}),
    ...(withExtras && composer.attachments.length > 0 ? { attachments: composer.attachments } : {}),
    fromComposer: overrideText === undefined,
    restoreOnFailure: overrideText !== undefined && textOnly,
  };
}

/** Starts sending `message` in the open chat: staged picks first when no turn is running, else submit now. */
function sendInChat(state: ShellState, message: OutgoingMessage, running: boolean) {
  const tag = currentTag(state);
  const next = { ...state, sending: message };
  if (state.staged && !running)
    return result(next, [{ type: 'applyStaged', tag, requestId: message.requestId, changes: state.staged }]);
  return result(next, [{ type: 'submit', tag, message }]);
}

export function step(state: ShellState, action: ShellAction): { state: ShellState; commands: readonly ShellCommand[] } {
  switch (action.type) {
    case 'URL_CHANGED': {
      if (action.sessionId === state.openChat) return result(state);
      // A draft handing off to the chat it just created keeps its first send and its message box; any other
      // change drops them.
      const handoff = state.pendingFirstSend?.sessionId === action.sessionId ? state.pendingFirstSend : null;
      const next: ShellState = {
        ...state,
        ...(handoff ? { pinned: true } : LEFT_SCREEN),
        panels: panelsLeaving(state.panels),
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
          ...LEFT_SCREEN,
          panels: panelsLeaving(state.panels),
          // A new draft is a new thing on screen: results for an earlier draft no longer apply.
          generation: state.generation + 1,
          chosenFolder: action.workspaceId,
          draft: { workspaceId: action.workspaceId, config: {}, ...(created ? { createdSessionId: created } : {}) },
          startError: null,
          staged: null,
        },
        state.openChat ? [{ type: 'navigate', sessionId: null }] : [],
      );
    }
    case 'DRAFT_DISCARDED':
      return result(
        {
          ...state,
          ...LEFT_SCREEN,
          panels: panelsLeaving(state.panels),
          generation: state.generation + 1,
          draft: null,
          starting: false,
          sendIntent: null,
          startError: null,
        },
        state.openChat ? [{ type: 'navigate', sessionId: null }] : [],
      );
    case 'FOLDER_CHOSEN':
      return result({ ...state, chosenFolder: action.workspaceId });
    case 'DRAFT_CONFIG_PICKED':
      return state.draft
        ? result({ ...state, draft: { ...state.draft, config: { ...state.draft.config, ...action.selection } } })
        : result(state);
    case 'SEND_REQUESTED': {
      if (state.openChat) {
        if (state.sending) return result(state);
        const message = outgoing(
          state,
          action.requestId,
          action.context,
          action.delivery,
          action.overrideText,
          Boolean(action.textOnly),
        );
        return message ? sendInChat(state, message, Boolean(action.context.runningTurnId)) : result(state);
      }
      // A draft: create its chat first; the message goes once that chat is open and live (READY_TO_SEND).
      if (!state.draft || state.starting) return result(state);
      if (!(action.overrideText ?? state.composer.input).trim() && state.composer.attachments.length === 0)
        return result(state);
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
    case 'STAGED_APPLIED': {
      if (!isCurrent(state, action.tag) || state.sending?.requestId !== action.requestId) return result(state);
      // A failed apply keeps the picks staged and the text in the box; its notice says why.
      if (!action.ok) return result({ ...state, sending: null });
      return result({ ...state, staged: null }, [{ type: 'submit', tag: action.tag, message: state.sending }]);
    }
    case 'SUBMIT_SETTLED': {
      const message = state.sending;
      if (!isCurrent(state, action.tag) || message?.requestId !== action.requestId) return result(state);
      if (action.accepted) {
        if (!message.fromComposer) return result({ ...state, sending: null });
        const { composer } = state;
        return result(
          {
            ...state,
            sending: null,
            composer: {
              ...composer,
              // Text typed while the message was on its way stays.
              input: composer.input.trim() === message.text ? '' : composer.input,
              attachments: [],
              armedSkill: null,
              historyIndex: null,
            },
            notices: { ...state.notices, attachment: null },
          },
          message.text ? [{ type: 'rememberPrompt', text: message.text }] : [],
        );
      }
      if (!message.restoreOnFailure) return result({ ...state, sending: null });
      // The chat is already rewound and this turn is gone: the text waits in the message box.
      return result({
        ...state,
        sending: null,
        composer: { ...state.composer, input: message.text },
        notices: { ...state.notices, resend: 'The chat was rewound, but the message wasn’t sent. Send it again from here.' },
      });
    }
    case 'READY_TO_SEND': {
      const pending = state.pendingFirstSend;
      if (!pending || pending.sessionId !== state.openChat || action.sessionId !== state.openChat) return result(state);
      const message = outgoing(
        state,
        action.requestId,
        action.context,
        pending.delivery,
        pending.overrideText,
        false,
      );
      const next = { ...state, pendingFirstSend: null };
      // A new chat has nothing staged: the draft's picks were applied when it was created.
      return message ? sendInChat(next, message, Boolean(action.context.runningTurnId)) : result(next);
    }
    case 'COMPOSER_EDITED':
      return result({ ...state, composer: { ...state.composer, ...action.patch } });
    case 'TEXT_RESTORED':
      return isCurrent(state, action.tag)
        ? result({ ...state, composer: { ...state.composer, input: action.text, historyIndex: null } })
        : result(state);
    case 'ATTACHMENTS_ADDED': {
      if (!isCurrent(state, action.tag)) return result(state);
      return result({
        ...state,
        composer: { ...state.composer, attachments: [...state.composer.attachments, ...action.images].slice(0, 4) },
        notices: { ...state.notices, attachment: action.error },
      });
    }
    case 'NOTICE':
      return isCurrent(state, action.tag)
        ? result({ ...state, notices: { ...state.notices, [action.key]: action.message } })
        : result(state);
    case 'SCROLLED':
      return action.pinned === state.pinned ? result(state) : result({ ...state, pinned: action.pinned });
    case 'LIVE_STATUS': {
      const current = state.liveStatus;
      if (action.text === current.text && action.defer === current.defer) return result(state);
      const timer = current.timer + 1;
      if (!action.defer || !action.text)
        return result({
          ...state,
          liveStatus: { text: action.text, defer: action.defer, shown: action.defer ? null : action.text, timer },
        });
      return result({ ...state, liveStatus: { text: action.text, defer: true, shown: null, timer } }, [
        { type: 'later', ms: POST_TOOL_STATUS_DELAY_MS, action: { type: 'STATUS_TIMER_FIRED', timer } },
      ]);
    }
    case 'STATUS_TIMER_FIRED': {
      const current = state.liveStatus;
      if (action.timer !== current.timer || !current.defer || !current.text) return result(state);
      return result({ ...state, liveStatus: { ...current, shown: current.text } });
    }
    case 'BOUNDARY': {
      // Ask once per accepted boundary; the Session dedupes concurrent asks from other tabs.
      if (action.sessionId !== state.openChat || state.drain?.boundary === action.boundary) return result(state);
      return result({ ...state, drain: { boundary: action.boundary, retried: false } }, [
        { type: 'drainNotifications', tag: currentTag(state), boundary: action.boundary },
      ]);
    }
    case 'DRAIN_ANSWERED': {
      // A busy or failed ask gets exactly one delayed re-ask for the same boundary: the Session can be busy while
      // a finished turn's completion is held, which ends without a new event.
      const { drain } = state;
      if (!isCurrent(state, action.tag) || !action.retry || drain?.boundary !== action.boundary || drain.retried)
        return result(state);
      return result({ ...state, drain: { ...drain, retried: true } }, [
        {
          type: 'later',
          ms: BACKGROUND_DRAIN_RETRY_MS,
          action: { type: 'DRAIN_RETRY_DUE', tag: action.tag, boundary: action.boundary },
        },
      ]);
    }
    case 'DRAIN_RETRY_DUE':
      if (!isCurrent(state, action.tag) || state.drain?.boundary !== action.boundary) return result(state);
      return result(state, [{ type: 'drainNotifications', tag: action.tag, boundary: action.boundary }]);
    case 'TASKS_PANEL_TOGGLED':
      return result({ ...state, panels: { ...state.panels, tasks: !state.panels.tasks } });
    case 'TASKS_PANEL_CLOSED':
      return state.panels.tasks ? result({ ...state, panels: { ...state.panels, tasks: false } }) : result(state);
    case 'SIDEBAR_SET':
      return state.panels.sidebar === action.open
        ? result(state)
        : result({ ...state, panels: { ...state.panels, sidebar: action.open } });
    case 'DIALOG_OPENED':
      return result({
        ...state,
        panels: { ...state.panels, dialog: action.dialog },
      });
    case 'DIALOG_CLOSED':
      return state.panels.dialog === null
        ? result(state)
        : result({ ...state, panels: { ...state.panels, dialog: null } });
    case 'SKILLS_SET':
      return state.panels.skills === action.open
        ? result(state)
        : result({ ...state, panels: { ...state.panels, skills: action.open } });
  }
}
