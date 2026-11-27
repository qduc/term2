/**
 * The shell machine's state, actions and commands, and the values that are data (the empty composer, the initial
 * state, the tag helpers, the two delays). The rules are in shell-machine.ts, which re-exports all of this, so
 * importers keep importing from there. No React, no I/O.
 */
import type { ImageAttachmentPayload, ModelSummary, SessionConfigRecord, SessionConfigUpdate } from './types';

export type DraftConfig = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort' | 'approvalMode'>;
export type StagedConfig = Pick<SessionConfigUpdate, 'modelSelection' | 'reasoningEffort'>;
export type Delivery = 'auto' | 'steer' | 'follow_up';
export type Tag = { readonly sessionId: string | null; readonly generation: number };

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
  /**
   * Null until the page has measured the screen: CSS then shows it on wide screens and hides it on small ones, so the
   * server-rendered first paint already matches and the page does not slide the sidebar in on load.
   */
  readonly sidebar: boolean | null;
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
  /** The background-notice boundary last asked about, and whether its one retry was used. */
  readonly drain: { readonly boundary: string; readonly retried: boolean } | null;
  readonly panels: Panels;
  /** A settings change being applied to the open chat. Cleared when the page shows something else. */
  readonly configApply: { readonly requestId: string } | null;
  /** A Retry under a reply that could not be sent. Cleared when the page shows something else. */
  readonly retryError: RetryError | null;
  /** A failed "switch and retry": offer the prompt as a new draft with that model. Cleared likewise. */
  readonly retryDraft: RetryDraft | null;
  /** The page's one error banner. Page-level: a chat change does not clear it. */
  readonly pageError: string | null;
};

export type RetryError = { readonly turnId: string; readonly message: string };
export type RetryDraft = { readonly turnId: string; readonly model: ModelSummary };

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
  | { readonly type: 'SKILLS_SET'; readonly open: boolean }
  | { readonly type: 'CONFIG_APPLY_STARTED'; readonly tag: Tag; readonly requestId: string }
  | { readonly type: 'CONFIG_APPLY_SETTLED'; readonly tag: Tag; readonly requestId: string }
  | { readonly type: 'RETRY_ERROR'; readonly tag: Tag; readonly error: RetryError | null }
  | { readonly type: 'RETRY_DRAFT'; readonly tag: Tag; readonly draft: RetryDraft | null }
  | { readonly type: 'PAGE_ERROR'; readonly message: string | null }
  /** A chat picked from the list. The address bar changes; URL_CHANGED opens it. */
  | { readonly type: 'CHAT_PICKED'; readonly sessionId: string; readonly workspaceId: string | null }
  /** Another user signed in: nothing of the previous user's stays. */
  | { readonly type: 'USER_CHANGED' };

export type ShellCommand =
  | { readonly type: 'createSession'; readonly tag: Tag; readonly workspaceId: string }
  | { readonly type: 'applyDraftConfig'; readonly tag: Tag; readonly sessionId: string; readonly config: DraftConfig }
  /**
   * Writes the open chat into the address bar; the page reports it back as URL_CHANGED. `replace` drops it without
   * a history entry or a popstate, so the runner reports URL_CHANGED itself.
   */
  | { readonly type: 'navigate'; readonly sessionId: string | null; readonly history?: 'replace' }
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
export const CLOSED_PANELS: Panels = { tasks: false, sidebar: false, dialog: null, skills: false };

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
  drain: null,
  panels: { ...CLOSED_PANELS, sidebar: null },
  configApply: null,
  retryError: null,
  retryDraft: null,
  pageError: null,
});

/** The tag a command issued now carries. */
export const currentTag = (state: ShellState): Tag => ({ sessionId: state.openChat, generation: state.generation });
/** Whether a result issued under `tag` still belongs to what the page shows. */
export const isCurrentTag = (state: ShellState, tag: Tag) =>
  tag.generation === state.generation && tag.sessionId === state.openChat;
