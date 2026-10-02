import type { FC, ReactNode } from 'react';
import type { ColorRole, ModeBadge, ToolStatusKind } from '../theme/palettes.js';
import type { SkinName } from './names.js';

/**
 * The skin contract.
 *
 * A *theme* decides colour; a *skin* decides layout: how a message, a tool call,
 * an approval or the status bar is drawn. The split is deliberate. Containers
 * (`CommandMessage`, `ApprovalPrompt`, `StatusBar`, ...) keep owning behaviour,
 * data, formatting and input handling, and hand a skin finished *view data* plus
 * the pieces of content it must place. A skin therefore never reimplements what a
 * tool call means, only where its parts go and how they are framed.
 *
 * Rules every skin follows (enforced by `skin-conformance.test.tsx`):
 *  - take colour from `useTheme()`, never a literal;
 *  - never emit a line wider than the terminal, at any width down to 40 columns;
 *  - render every piece of content it is given (a skin may restyle or reorder,
 *    not drop, a command, an option label, or an error);
 *  - stay legible with the `mono` theme, i.e. carry meaning in glyphs and weight
 *    as well as colour.
 */

// --- Messages ---------------------------------------------------------------

export interface BannerView {
  version: string;
  mode: ModeBadge;
  /** True when the Mentor profile is active (a second badge, and a mentor model). */
  mentor: boolean;
  providerLabel: string;
  model: string | undefined;
  reasoningEffort: string;
  mentorModel: string | undefined;
  mentorReasoningEffort: string;
}

export interface UserMessageView {
  text: string;
}

export type AssistantKind = 'answer' | 'reasoning';

export interface AssistantFrameProps {
  kind: AssistantKind;
  /** Already-rendered markdown. */
  children: ReactNode;
}

// --- Tool calls -------------------------------------------------------------

/** `concise` is the default; `standard` shows full output. Both go through the skin. */
export type ToolDisplay = 'concise' | 'standard';

export interface ToolFrameProps {
  status: ToolStatusKind;
  display: ToolDisplay;
  /** The tool's name (`shell`, `read_file`, ...); `undefined` for a plain shell command with no tool metadata. */
  toolName: string | undefined;
  /** Header line(s) and body, as the container composed them. */
  children: ReactNode;
}

export interface ToolHeaderProps {
  status: ToolStatusKind;
  display: ToolDisplay;
  /** The tool's name, for skins that show it as its own column or label. */
  toolName: string | undefined;
  /** A call inside a subagent's own feed: dense, single-line, never framed. */
  nested?: boolean;
  /** The command or verb-plus-target, with its own emphasis. */
  action: ReactNode;
  /** Elapsed / queued / waiting marker shown while the call is in flight. */
  meta?: ReactNode;
  /** Change stats, run_code hints and similar trailing detail. */
  trailing?: ReactNode;
  /** Override for the body text colour in concise mode. */
  textColor?: string;
}

export interface ToolGroupSummaryView {
  status: 'completed' | 'partial' | 'failed';
  /** e.g. "Searched for 1 pattern, read 3 files, ran 2 shell commands". */
  summary: string;
  /** Names of the calls that failed; empty when none did. */
  failures: string;
}

// --- Live region ------------------------------------------------------------

export interface WorkingIndicatorView {
  phase: 'thinking' | 'generating' | 'processing' | 'tool_call';
  elapsedSeconds: number;
  tokensPerSecond: number | undefined;
  /** Present while the model is streaming a tool call's arguments. */
  toolName: string | undefined;
  argumentChars: number | undefined;
  /** 0-3, advanced by the container's tick; skins may ignore it and use `useSpinnerFrame`. */
  dotCount: number;
}

/** A key, what it does, and an optional role colour when the key names a coloured concept. */
export type MenuHint = readonly [key: string, action: string, keyColor?: ColorRole];

export interface HintsProps {
  hints: ReadonlyArray<MenuHint>;
}

export interface PromptMarkerProps {
  /** `rejection` is the "why?" prompt shown after denying an approval. */
  mode: 'input' | 'shell' | 'rejection';
}

export interface InputFrameProps {
  /** The marker plus the editable input. */
  children: ReactNode;
}

// --- Approvals --------------------------------------------------------------

export interface ApprovalFrameProps {
  /** `danger` is the riskiest class (e.g. Docker host control); skins should make it recognisable by shape. */
  tone: 'caution' | 'danger';
  /** The title line's content, e.g. "Agent wants to run: shell". */
  header: ReactNode;
  /** Extra lines directly under the title (e.g. the active workspace), or nothing. */
  subheader?: ReactNode;
  /** Command or diff, advisory, and the choices. */
  children: ReactNode;
}

export interface ApprovalOptionView {
  label: string;
  /** Colour when this option is the selected one. */
  tone: ColorRole;
}

export interface ApprovalChoicesProps {
  /** The question above the options, when there is one. */
  question: string | undefined;
  options: ReadonlyArray<ApprovalOptionView>;
  selectedIndex: number;
  /** `two-pane` shows the selected option's description beside the list; `list` is the list alone. */
  layout: 'two-pane' | 'list';
  description: { title: string; text: string | undefined } | undefined;
}

// --- Status bar -------------------------------------------------------------

/**
 * Stable ids of the status segments, so a skin can pick, reorder, restyle or
 * promote one (a gauge, a pill) without parsing text.
 */
export const STATUS_SEGMENT_IDS = {
  config: ['ssh-marker', 'ssh-detail', 'mode', 'queue', 'provider-model', 'reasoning', 'mentor', 'safety'],
  metrics: ['tokens', 'speed', 'cache', 'context', 'cost'],
} as const;

export interface StatusSegmentView {
  id: string;
  /** Empty means "not applicable right now". */
  text: string;
  tone?: ColorRole;
  bold?: boolean;
  /** Divider drawn before this segment when an earlier one in its group is visible. */
  separator?: 'group' | 'metric';
  /** Drop order when space runs out: lower drops first; omitted means never dropped. */
  tier?: number;
}

export interface StatusAlertView {
  id: string;
  parts: ReadonlyArray<{ text: string; tone: ColorRole; bold?: boolean }>;
}

export interface StatusQuotaWindow {
  label: string;
  percent: number;
  /** Already formatted for display (a time, a date, or a duration); absent when unknown. */
  resetText: string | undefined;
}

export interface StatusView {
  /** Usable width for the whole bar. */
  columns: number;
  config: ReadonlyArray<StatusSegmentView>;
  metrics: ReadonlyArray<StatusSegmentView>;
  /** Non-steady-state messages (cache-miss risk, Docker access, run budget, ...). */
  alerts: ReadonlyArray<StatusAlertView>;
  /** The provider-quota line exactly as the classic bar prints it; empty when none. */
  quotaText: string;
  gauges: {
    /** 0-100, the last request's prompt tokens over the model's context window; undefined when unknown. */
    contextPercent: number | undefined;
    contextUsedTokens: number | undefined;
    contextWindowTokens: number | undefined;
    cachePercent: number | undefined;
    quotaWindows: ReadonlyArray<StatusQuotaWindow>;
  };
}

// --- Live region extras -----------------------------------------------------

export interface ShellActivityProps {
  /** The command a foreground shell call is running, already truncated to fit the line. */
  command: string;
}

export interface TaskPanelProps {
  /** e.g. `Tasks · 2 active · ^G manage`. */
  header: string;
  /** The task rows. They are budgeted against the terminal width minus `Skin.taskPanelGutter`. */
  children: ReactNode;
}

// --- Ask-user question ------------------------------------------------------

export interface QuestionOptionView {
  label: string;
  selected: boolean;
  /** Multi-select only: whether this option is ticked. `undefined` for single-select, and for the built-in rows. */
  checked: boolean | undefined;
  /** The agent's first option is its recommendation. */
  recommended: boolean;
  /** Colour when selected; `undefined` leaves it in the default text colour. */
  tone: ColorRole | undefined;
}

export interface QuestionPromptProps {
  /** "Question 1 of 3"; absent when there is only one question. */
  progress: string | undefined;
  question: string;
  /** Shown while the user is typing a custom answer in the input below. */
  notice: string | undefined;
  /** Numbered by position: the first is 1. The built-in "something else" / "submit" rows are included. */
  options: ReadonlyArray<QuestionOptionView>;
  /** What the selected option does. */
  description: { title: string; text: string | undefined };
  /** The key-hint footer, already drawn through `Hints`. */
  footer: ReactNode;
}

// --- Subagent feed ----------------------------------------------------------

export interface SubagentFeedProps {
  /** e.g. `run_subagent [explorer] map the auth flow`. */
  title: string;
  /** e.g. ` — failed: timeout`; empty while running. */
  statusSuffix: string;
  status: string | undefined;
  tone: ColorRole;
  /** The first paragraph of the final answer, once completed; otherwise `undefined`. */
  summary: string | undefined;
  /** The subagent's most recent calls (already drawn, dense and single-line), when there is no summary. */
  children: ReactNode;
}

// --- Tool body --------------------------------------------------------------

/**
 * The shapes a specialised tool renderer puts beneath its header.
 *  - `indent`: a run of rows that belong to the call (matches, results, trace rows);
 *  - `panel`: a block of the tool's content (file lines, a fetched page, a memory);
 *  - `callout`: a titled highlight set apart from the rows (an answer summary, a table of contents).
 */
export type ToolSectionVariant = 'indent' | 'panel' | 'callout';

export interface ToolSectionProps {
  variant: ToolSectionVariant;
  /** `callout` only: the heading, and the colour that marks it. */
  title?: string;
  tone?: ColorRole;
  children: ReactNode;
}

// --- Menu body --------------------------------------------------------------

export interface MenuFrameProps {
  /** The line that says which menu this is, drawn dim above the body. */
  title?: string;
  /**
   * The colour the container chose to signal state (an error, an empty list); it
   * is never an identity colour. A skin may colour its frame with it or ignore it.
   */
  borderColor: string | undefined;
  /** `false` for a loading, error or empty body, which is a message rather than a list. */
  hasItems: boolean;
  /** Key hints or free text; drawn below the body (`inside`) or below the frame (`outside`). */
  footer?: ReactNode;
  footerPlacement: 'inside' | 'outside';
  /** The rows, or the state message. */
  children: ReactNode;
}

// --- The skin ---------------------------------------------------------------

export interface Skin {
  name: SkinName;

  /**
   * Columns `AssistantFrame` consumes on the left (an indent, a rail, a border).
   * Markdown wraps against an explicit width, so the container narrows it by this
   * much; a frame that indents without declaring it makes code blocks and tables
   * overflow the terminal.
   */
  assistantGutter: number;

  /** Columns `TaskPanel` consumes on the left; the panel narrows its rows by this much. */
  taskPanelGutter: number;

  Banner: FC<BannerView>;
  UserMessage: FC<UserMessageView>;
  AssistantFrame: FC<AssistantFrameProps>;

  ToolFrame: FC<ToolFrameProps>;
  ToolHeader: FC<ToolHeaderProps>;
  ToolGroupSummary: FC<ToolGroupSummaryView>;

  WorkingIndicator: FC<WorkingIndicatorView>;
  /** The rule between printed history and the live controls. */
  LiveDivider: FC;
  PromptMarker: FC<PromptMarkerProps>;
  InputFrame: FC<InputFrameProps>;
  /** Key-hint footers; used by every menu as well as the input. */
  Hints: FC<HintsProps>;
  /** The "running shell command" line shown while a foreground shell call is in flight. */
  ShellActivity: FC<ShellActivityProps>;
  /** The background-task list above the input. */
  TaskPanel: FC<TaskPanelProps>;

  ApprovalFrame: FC<ApprovalFrameProps>;
  ApprovalChoices: FC<ApprovalChoicesProps>;
  /** The ask-user prompt: a question, its options, and what the selected one does. */
  QuestionPrompt: FC<QuestionPromptProps>;

  /** A subagent's feed in the transcript: its task, its latest calls or its answer. */
  SubagentFeed: FC<SubagentFeedProps>;
  /** The body of a specialised tool renderer, beneath its (skinned) header. */
  ToolSection: FC<ToolSectionProps>;
  /** The surface every menu is drawn on. */
  MenuFrame: FC<MenuFrameProps>;

  StatusBar: FC<StatusView>;
}
