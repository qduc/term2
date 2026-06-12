import type { CommandMessage as BaseCommandMessage } from '../tools/types.js';
import type { NormalizedUsage } from '../utils/ai/token-usage.js';

export interface UserMessage {
  id: string;
  sender: 'user';
  text: string;
  /**
   * True when the input was consumed as resolution for an aborted tool approval
   * rather than added to the conversation store as a new user turn. /undo and the
   * undo selection menu must skip these so UI and store stay aligned.
   */
  consumedForAbort?: boolean;
}

export interface BotMessage {
  id: string;
  sender: 'bot';
  text: string;
  status?: 'streaming' | 'finalized';
  reasoningText?: string;
  usage?: NormalizedUsage;
}

export type CommandMessage = BaseCommandMessage & {
  hadApproval?: boolean;
};

export interface SystemMessage {
  id: string;
  sender: 'system';
  text: string;
}

export interface ReasoningMessage {
  id: string;
  sender: 'reasoning';
  text: string;
  status?: 'finalized';
}

export interface SubagentActivityMessage {
  id: string;
  sender: 'subagent';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  callId?: string;
  agentId: string;
  role: string;
  task: string;
  tools: (string | CommandMessage)[];
}

export type Message =
  | UserMessage
  | BotMessage
  | CommandMessage
  | SystemMessage
  | ReasoningMessage
  | SubagentActivityMessage;

export const isUserMessage = (message: Message): message is UserMessage => message.sender === 'user';

export const isBotMessage = (message: Message): message is BotMessage => message.sender === 'bot';

export const isCommandMessage = (message: Message): message is CommandMessage => message.sender === 'command';

export const isReasoningMessage = (message: Message): message is ReasoningMessage => message.sender === 'reasoning';

export const isSubagentActivityMessage = (message: Message): message is SubagentActivityMessage =>
  message.sender === 'subagent';
