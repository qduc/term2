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

  ApprovalFrame: FC<ApprovalFrameProps>;
  ApprovalChoices: FC<ApprovalChoicesProps>;

  StatusBar: FC<StatusView>;
}
