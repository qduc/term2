import { CardsMenuFrame, CardsQuestionPrompt, CardsSubagentFeed, CardsToolSection } from './body.js';
import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';
import { CardsApprovalChoices, CardsApprovalFrame } from './approval.js';
import {
  CardsHints,
  CardsInputFrame,
  CardsLiveDivider,
  CardsPromptMarker,
  CardsWorkingIndicator,
} from './live-region.js';
import { ASSISTANT_GUTTER, CardsAssistantFrame, CardsBanner, CardsUserMessage } from './messages.js';
import { CardsStatusBar } from './status.js';
import { CardsToolFrame, CardsToolGroupSummary, CardsToolHeader } from './tools.js';

/**
 * "Cards": the banner, each user turn, each standard-display tool call, the input and
 * the approval are rounded boxes; answers stay bare text; status is a row of pills;
 * approval options are button chips. Concise tool calls are deliberately not carded,
 * so a long run of them stays a list.
 */
export const cardsSkin: Skin = {
  ...classicSkin,
  name: 'cards',
  assistantGutter: ASSISTANT_GUTTER,
  Banner: CardsBanner,
  UserMessage: CardsUserMessage,
  AssistantFrame: CardsAssistantFrame,
  ToolFrame: CardsToolFrame,
  ToolHeader: CardsToolHeader,
  ToolGroupSummary: CardsToolGroupSummary,
  WorkingIndicator: CardsWorkingIndicator,
  LiveDivider: CardsLiveDivider,
  PromptMarker: CardsPromptMarker,
  InputFrame: CardsInputFrame,
  Hints: CardsHints,
  ApprovalFrame: CardsApprovalFrame,
  ApprovalChoices: CardsApprovalChoices,
  QuestionPrompt: CardsQuestionPrompt,
  SubagentFeed: CardsSubagentFeed,
  ToolSection: CardsToolSection,
  MenuFrame: CardsMenuFrame,
  StatusBar: CardsStatusBar,
};
