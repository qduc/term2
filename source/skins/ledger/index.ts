import { classicSkin } from '../classic/index.js';
import type { Skin } from '../types.js';
import { LedgerApprovalChoices, LedgerApprovalFrame } from './approval.js';
import {
  LedgerHints,
  LedgerInputFrame,
  LedgerLiveDivider,
  LedgerPromptMarker,
  LedgerWorkingIndicator,
} from './live-region.js';
import { LedgerAssistantFrame, LedgerBanner, LedgerUserMessage } from './messages.js';
import { LedgerStatusBar } from './status.js';
import { LedgerToolFrame, LedgerToolGroupSummary, LedgerToolHeader } from './tools.js';

/**
 * "Ledger": dense and IDE-like. A header bar, role chips instead of glyph prefixes,
 * tool calls as aligned rows (status, tool, action), a footer bar of chips with
 * context and quota gauges, and an approval whose class is readable by shape.
 *
 * The role and status chips are surfaces on `codeBackground`; where a theme has none
 * (`mono`) they become bracketed labels of the same width, so meaning never rests on colour.
 */
export const ledgerSkin: Skin = {
  ...classicSkin,
  name: 'ledger',
  // The answer's chip sits on its own line above the text, so markdown keeps the full width.
  assistantGutter: 0,
  Banner: LedgerBanner,
  UserMessage: LedgerUserMessage,
  AssistantFrame: LedgerAssistantFrame,
  ToolFrame: LedgerToolFrame,
  ToolHeader: LedgerToolHeader,
  ToolGroupSummary: LedgerToolGroupSummary,
  WorkingIndicator: LedgerWorkingIndicator,
  LiveDivider: LedgerLiveDivider,
  PromptMarker: LedgerPromptMarker,
  InputFrame: LedgerInputFrame,
  Hints: LedgerHints,
  ApprovalFrame: LedgerApprovalFrame,
  ApprovalChoices: LedgerApprovalChoices,
  StatusBar: LedgerStatusBar,
};
