import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';
import { ZenApprovalChoices, ZenApprovalFrame } from './approval.js';
import { ZenHints, ZenInputFrame, ZenLiveDivider, ZenPromptMarker, ZenWorkingIndicator } from './live-region.js';
import { ASSISTANT_GUTTER, ZenAssistantFrame, ZenBanner, ZenUserMessage } from './messages.js';
import { ZenStatusBar } from './status.js';
import { ZenToolFrame, ZenToolGroupSummary, ZenToolHeader } from './tools.js';

/**
 * "Zen": conversation first. One column of prose with a `◆` in its margin, tool
 * calls collapsed to quiet one-liners that only turn red when they fail, a
 * borderless prompt, a status line you only notice when it has something to say,
 * and an approval that reads as a sentence with the answers on one line.
 *
 * It spends colour on trouble and shape on danger, and carries the rest in
 * weight and whitespace, so it reads the same in a terminal with no colour.
 */
export const zenSkin: Skin = {
  ...classicSkin,
  name: 'zen',
  assistantGutter: ASSISTANT_GUTTER,
  Banner: ZenBanner,
  UserMessage: ZenUserMessage,
  AssistantFrame: ZenAssistantFrame,
  ToolFrame: ZenToolFrame,
  ToolHeader: ZenToolHeader,
  ToolGroupSummary: ZenToolGroupSummary,
  WorkingIndicator: ZenWorkingIndicator,
  LiveDivider: ZenLiveDivider,
  PromptMarker: ZenPromptMarker,
  InputFrame: ZenInputFrame,
  Hints: ZenHints,
  ApprovalFrame: ZenApprovalFrame,
  ApprovalChoices: ZenApprovalChoices,
  StatusBar: ZenStatusBar,
};
