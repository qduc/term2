import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';
import { RailMenuFrame, RailQuestionPrompt, RailSubagentFeed, RailToolSection } from './body.js';
import { RailApprovalChoices, RailApprovalFrame } from './approval.js';
import { RailHints, RailInputFrame, RailLiveDivider, RailPromptMarker, RailWorkingIndicator } from './live-region.js';
import { RailAssistantFrame, RailBanner, RailUserMessage } from './messages.js';
import { RailStatusBar } from './status.js';
import { RailToolFrame, RailToolGroupSummary, RailToolHeader } from './tools.js';

/**
 * "Rail": quiet and typographic. No boxes, no background bands, so it reads the
 * same on a light and a dark terminal. A tool call is a status-coloured rail with
 * its output indented behind it, the prompt sits between two hairlines, the status
 * is one line, and an approval is a rail down its whole height (heavier, with a
 * `▲`, when it is the riskiest class).
 *
 * Spread from classic so any slot added to the contract later still renders.
 */
export const railSkin: Skin = {
  ...classicSkin,
  name: 'rail',
  assistantGutter: 0,
  Banner: RailBanner,
  UserMessage: RailUserMessage,
  AssistantFrame: RailAssistantFrame,
  ToolFrame: RailToolFrame,
  ToolHeader: RailToolHeader,
  ToolGroupSummary: RailToolGroupSummary,
  WorkingIndicator: RailWorkingIndicator,
  LiveDivider: RailLiveDivider,
  PromptMarker: RailPromptMarker,
  InputFrame: RailInputFrame,
  Hints: RailHints,
  ApprovalFrame: RailApprovalFrame,
  ApprovalChoices: RailApprovalChoices,
  QuestionPrompt: RailQuestionPrompt,
  SubagentFeed: RailSubagentFeed,
  ToolSection: RailToolSection,
  MenuFrame: RailMenuFrame,
  StatusBar: RailStatusBar,
};
