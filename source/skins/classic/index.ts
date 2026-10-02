import type { Skin } from '../types.js';
import { ClassicApprovalChoices, ClassicApprovalFrame } from './approval.js';
import {
  ClassicHints,
  ClassicInputFrame,
  ClassicLiveDivider,
  ClassicPromptMarker,
  ClassicWorkingIndicator,
} from './live-region.js';
import { ClassicAssistantFrame, ClassicBanner, ClassicUserMessage } from './messages.js';
import { ClassicMenuFrame } from './menu.js';
import { ClassicQuestionPrompt } from './question.js';
import { ClassicStatusBar } from './status.js';
import { ClassicSubagentFeed } from './subagent.js';
import { ClassicToolSection } from './tool-section.js';
import { ClassicToolFrame, ClassicToolGroupSummary, ClassicToolHeader } from './tools.js';

/**
 * The original look. It is also the base every other skin spreads from, so a skin
 * only has to override the slots it actually draws differently.
 */
export const classicSkin: Skin = {
  name: 'classic',
  assistantGutter: 0,
  Banner: ClassicBanner,
  UserMessage: ClassicUserMessage,
  AssistantFrame: ClassicAssistantFrame,
  ToolFrame: ClassicToolFrame,
  ToolHeader: ClassicToolHeader,
  ToolGroupSummary: ClassicToolGroupSummary,
  WorkingIndicator: ClassicWorkingIndicator,
  LiveDivider: ClassicLiveDivider,
  PromptMarker: ClassicPromptMarker,
  InputFrame: ClassicInputFrame,
  Hints: ClassicHints,
  ApprovalFrame: ClassicApprovalFrame,
  ApprovalChoices: ClassicApprovalChoices,
  QuestionPrompt: ClassicQuestionPrompt,
  SubagentFeed: ClassicSubagentFeed,
  ToolSection: ClassicToolSection,
  MenuFrame: ClassicMenuFrame,
  StatusBar: ClassicStatusBar,
};
