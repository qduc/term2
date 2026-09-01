import React, { useMemo, useRef } from 'react';
import { Box, Static, useStdout } from 'ink';
import CommandMessage from './CommandMessage.js';
import CommandGroupSummary from './CommandGroupSummary.js';
import ChatMessage from './ChatMessage.js';
import Banner from '../layout/Banner.js';
import SubagentActivityMessage from './SubagentActivityMessage.js';
import { groupCommandRuns, type CommandGroupMessage } from './command-grouping.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { Message } from '../../types/message.js';

type Props<T extends MessageLike = Message> = {
  messages: T[];
  bannerItems?: string[];
  settingsService?: SettingsService;
  restoredStaticMessageIds?: readonly string[];
  /** The turn is held at an approval or check-in prompt, so no tool is executing. */
  turnPaused?: boolean;
};

type MessageLike = {
  id: string;
  sender?: string;
  status?: string;
  callId?: string;
  agentId?: string;
  text?: string;
  command?: string;
  output?: string;
  success?: boolean;
  failureReason?: string;
  toolName?: string;
  toolArgs?: unknown;
  isApprovalRejection?: boolean;
  autoApprovedByLlm?: boolean;
  hadApproval?: boolean;
  role?: string;
  task?: string;
  async?: boolean;
  tools?: (string | import('../../types/message.js').CommandMessage)[];
  finalText?: string;
};

export type StaticCommitBlocker = {
  id: string;
  index: number;
  sender?: string;
  status?: string;
  reason:
    | 'bot_streaming'
    | 'reasoning_streaming'
    | 'command_pending'
    | 'command_running'
    | 'subagent_activity'
    | 'unknown_active';
  dynamicMessageCount: number;
  dynamicTextLength: number;
};

type StaticCommitBlockerOptions = {
  messageCountThreshold?: number;
  textLengthThreshold?: number;
  displayMode?: string;
};

type StaticBannerItem = {
  kind: 'banner';
  id: string;
};

type StaticMessageItem = {
  kind: 'message';
  id: string;
  message: MessageLike | CommandGroupMessage;
};

type StaticItem = StaticBannerItem | StaticMessageItem;

type RenderableMessage = MessageLike | CommandGroupMessage;

export const MESSAGE_HORIZONTAL_PADDING = 2;
export const EMPTY_RESTORED_STATIC_MESSAGE_IDS: readonly string[] = [];

const STATIC_BLOCKER_MESSAGE_COUNT_THRESHOLD = 12;
const STATIC_BLOCKER_TEXT_LENGTH_THRESHOLD = 12_000;

const canRenderStatically = (message: MessageLike) => {
  if (message.sender === 'reasoning') {
    return message.status === 'finalized';
  }

  if (message.sender === 'command') {
    return message.status !== 'pending' && message.status !== 'running';
  }

  if (message.sender === 'subagent') {
    return (
      message.status === 'completed' ||
      message.status === 'failed' ||
      message.status === 'cancelled' ||
      message.status === 'interrupted' ||
      message.status === 'backgrounded'
    );
  }

  if (message.sender === 'bot') {
    return message.status !== 'streaming';
  }

  return true;
};

const isGroupableToolMessage = (message: MessageLike | undefined): boolean =>
  message?.sender === 'command' || message?.sender === 'subagent' || message?.sender === 'command-group';

// These rows are produced asynchronously by background work. They are
// chronological relative to the session, but must not be frozen into
// <Static> while a streamed assistant response is still being assembled.
const isBackgroundNotification = (message: RenderableMessage): boolean =>
  message.sender === 'command' && message.toolName?.endsWith('_notification') === true;

// A run of command or subagent messages that reaches the very end of the array
// might still grow (another tool call could land right after it). Concise-mode
// grouping keeps that whole run in the dynamic/active region — never committed
// to <Static> — until something else closes it, so its summary line can keep
// counting up in place. <Static> writes each item exactly once, so committing
// any member early would strand it as a separate frozen line beside the group
// that later absorbs it.
//
// This includes a run of one: a lone completed tool call must stay dynamic too,
// or the next tool call would form a group whose first member is already frozen
// in static history.
const findOpenTrailingCommandRunStart = (messages: MessageLike[]): number => {
  const lastIndex = messages.length - 1;
  if (lastIndex < 0 || !isGroupableToolMessage(messages[lastIndex])) {
    return -1;
  }

  let runStart = lastIndex;
  while (runStart > 0 && isGroupableToolMessage(messages[runStart - 1])) {
    runStart -= 1;
  }

  return runStart;
};

export const splitStaticHistory = <T extends MessageLike>(messages: T[], options: { groupCommands?: boolean } = {}) => {
  const canRenderStart = messages.findIndex((message) => !canRenderStatically(message));
  let activeStart = canRenderStart === -1 ? messages.length : canRenderStart;

  if (options.groupCommands) {
    const openRunStart = findOpenTrailingCommandRunStart(messages);
    if (openRunStart !== -1 && openRunStart < activeStart) {
      activeStart = openRunStart;
    }
  }

  if (activeStart >= messages.length) {
    return { history: messages, active: [] };
  }

  const firstActiveMessage = messages[activeStart];
  const previousMessage = activeStart > 0 ? messages[activeStart - 1] : undefined;
  const previousMessageIsToolLeadIn =
    previousMessage?.status === 'finalized' &&
    (previousMessage.sender === 'bot' || previousMessage.sender === 'reasoning');
  const activeStartWithToolLeadIn =
    isGroupableToolMessage(firstActiveMessage) &&
    (firstActiveMessage.status === 'pending' || firstActiveMessage.status === 'running') &&
    previousMessageIsToolLeadIn
      ? activeStart - 1
      : activeStart;

  return {
    history: messages.slice(0, activeStartWithToolLeadIn),
    active: messages.slice(activeStartWithToolLeadIn),
  };
};

const getStaticBlockerReason = (message: MessageLike): StaticCommitBlocker['reason'] => {
  if (message.sender === 'bot' && message.status === 'streaming') {
    return 'bot_streaming';
  }

  if (message.sender === 'reasoning' && message.status !== 'finalized') {
    return 'reasoning_streaming';
  }

  if (message.sender === 'command' && message.status === 'pending') {
    return 'command_pending';
  }

  if (message.sender === 'command' && message.status === 'running') {
    return 'command_running';
  }

  if (message.sender === 'subagent') {
    return 'subagent_activity';
  }

  return 'unknown_active';
};

export const detectStaticCommitBlocker = <T extends MessageLike>(
  messages: T[],
  options: StaticCommitBlockerOptions = {},
): StaticCommitBlocker | null => {
  const filteredMessages =
    options.displayMode === 'concise' ? messages.filter((message) => message.sender !== 'reasoning') : messages;
  const activeStart = filteredMessages.findIndex((message) => !canRenderStatically(message));

  if (activeStart === -1) {
    return null;
  }

  const active = filteredMessages.slice(activeStart);
  const dynamicTextLength = active.reduce((sum, message) => sum + (message.text?.length ?? 0), 0);
  const messageCountThreshold = options.messageCountThreshold ?? STATIC_BLOCKER_MESSAGE_COUNT_THRESHOLD;
  const textLengthThreshold = options.textLengthThreshold ?? STATIC_BLOCKER_TEXT_LENGTH_THRESHOLD;

  if (active.length < messageCountThreshold && dynamicTextLength < textLengthThreshold) {
    return null;
  }

  const blocker = filteredMessages[activeStart];
  return {
    id: blocker.id,
    index: activeStart,
    sender: blocker.sender,
    status: blocker.status,
    reason: getStaticBlockerReason(blocker),
    dynamicMessageCount: active.length,
    dynamicTextLength,
  };
};

const createStaticItems = (bannerItems: string[], history: RenderableMessage[]): StaticItem[] => [
  ...bannerItems.map((id) => ({ kind: 'banner' as const, id })),
  ...history.map((message) => ({ kind: 'message' as const, id: message.id, message })),
];

const createMessageSignature = (message: RenderableMessage) => {
  try {
    return JSON.stringify(message);
  } catch {
    return `${message.id}:${message.sender ?? ''}:${message.status ?? ''}`;
  }
};

export const shouldCommitMessageToStatic = ({
  hasActiveMessages,
  hasExistingStaticHistory,
  wasPreviouslyActive,
  hasPendingCandidateSignature,
  isRestoredMessage,
  isCompletedCommand = false,
}: {
  hasActiveMessages: boolean;
  hasExistingStaticHistory: boolean;
  wasPreviouslyActive: boolean;
  hasPendingCandidateSignature: boolean;
  isRestoredMessage: boolean;
  isCompletedCommand?: boolean;
}) => {
  if (isCompletedCommand) {
    return true;
  }

  if (hasActiveMessages || wasPreviouslyActive) {
    return true;
  }

  // Resumed conversations can arrive with a fully finalized history and no
  // live tail. Commit that backlog immediately so Ink can keep it in Static.
  if (isRestoredMessage && !hasExistingStaticHistory) {
    return true;
  }

  return hasPendingCandidateSignature;
};

const MessageList = <T extends MessageLike = Message>({
  messages,
  bannerItems = [],
  settingsService,
  restoredStaticMessageIds = EMPTY_RESTORED_STATIC_MESSAGE_IDS,
  turnPaused = false,
}: Props<T>) => {
  const { stdout } = useStdout();
  const terminalColumns = stdout.columns || 80;
  const contentWidth = Math.max(1, terminalColumns - MESSAGE_HORIZONTAL_PADDING * 2);
  const displayMode = settingsService?.get('ui.displayMode') ?? 'concise';
  const restoredStaticMessageIdSet = useMemo(() => new Set(restoredStaticMessageIds), [restoredStaticMessageIds]);

  const filteredMessages = useMemo(() => {
    if (displayMode === 'concise') {
      return messages.filter((message) => {
        if (message.sender === 'reasoning') {
          return false;
        }
        if (message.sender === 'bot' && message.status !== 'streaming' && (!message.text || !message.text.trim())) {
          return false;
        }
        return true;
      });
    }
    return messages;
  }, [messages, displayMode]);

  // Use useMemo to prevent array recreation on every render.
  // This stabilizes the references passed to Static and the active Box,
  // preventing unnecessary re-renders and fixing flickering in long sessions.
  const { history, active } = useMemo(() => {
    const groupCommands = displayMode === 'concise';
    const split = splitStaticHistory(filteredMessages, { groupCommands });
    if (!groupCommands) {
      return split;
    }

    // Grouping is a pure display transform on top of the static/active split
    // above, which already guarantees every run in `split.history` is closed.
    // A still-open run lives in `split.active`, where it is re-rendered each
    // frame, so it can be grouped just as eagerly and simply count up.
    return {
      history: groupCommandRuns(split.history, { isClosed: true }),
      active: groupCommandRuns(split.active),
    };
  }, [filteredMessages, displayMode]);

  const staticItemsRef = useRef<StaticItem[]>(createStaticItems(bannerItems, []));
  const seenBannerIdsRef = useRef<Set<string>>(new Set(bannerItems));
  const committedMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const candidateMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const previousActiveMessageIdsRef = useRef<Set<string>>(new Set());

  const { staticItems, deferredHistory, deferredNotifications } = useMemo(() => {
    if (history.length === 0 && active.length === 0) {
      staticItemsRef.current = staticItemsRef.current.filter((item) => item.kind === 'banner');
      committedMessageSignaturesRef.current.clear();
      candidateMessageSignaturesRef.current.clear();
      previousActiveMessageIdsRef.current.clear();
    }

    const additions: StaticItem[] = [];
    const deferred: RenderableMessage[] = [];
    const deferredNotifications: RenderableMessage[] = [];
    const hasActiveMessages = active.length > 0;
    const previousActiveMessageIds = previousActiveMessageIdsRef.current;
    const hasExistingStaticHistory = staticItemsRef.current.some((item) => item.kind === 'message');

    for (const bannerId of bannerItems) {
      if (seenBannerIdsRef.current.has(bannerId)) {
        continue;
      }

      seenBannerIdsRef.current.add(bannerId);
      additions.push({ kind: 'banner', id: bannerId });
    }

    const historyIds = new Set(history.map((message) => message.id));
    for (const messageId of candidateMessageSignaturesRef.current.keys()) {
      if (!historyIds.has(messageId)) {
        candidateMessageSignaturesRef.current.delete(messageId);
      }
    }

    let hasDeferred = false;
    for (const message of history) {
      const signature = createMessageSignature(message);
      const committedSignature = committedMessageSignaturesRef.current.get(message.id);
      const isCompletedCommand =
        (message.sender === 'command' && message.status !== 'pending' && message.status !== 'running') ||
        // A command-group only ever holds settled calls, and one reaching
        // `history` is closed by construction (an open run is held in the
        // active region), so it is as safe to commit as a completed command.
        message.sender === 'command-group';

      if (committedSignature === signature) {
        continue;
      }

      if (committedSignature !== undefined) {
        if (message.sender === 'command-group') {
          // A command group is write-once to <Static>. If already committed,
          // do not append another copy into additions.
          continue;
        }
        candidateMessageSignaturesRef.current.set(message.id, signature);
        (isBackgroundNotification(message) ? deferredNotifications : deferred).push(message);
        hasDeferred = true;
        continue;
      }

      const shouldCommitImmediately =
        (!isBackgroundNotification(message) || !hasActiveMessages) &&
        !hasDeferred &&
        shouldCommitMessageToStatic({
          hasActiveMessages,
          hasExistingStaticHistory,
          wasPreviouslyActive: previousActiveMessageIds.has(message.id),
          hasPendingCandidateSignature: candidateMessageSignaturesRef.current.get(message.id) === signature,
          isRestoredMessage: restoredStaticMessageIdSet.has(message.id),
          isCompletedCommand,
        });
      const isFinishedSubagent =
        message.sender === 'subagent' &&
        (message.status === 'completed' ||
          message.status === 'failed' ||
          message.status === 'cancelled' ||
          message.status === 'backgrounded');

      // Keep finished subagent summaries dynamic while sibling work is still
      // running. Committing them to <Static> mid-flight causes an extra Ink
      // write and visible flicker when parallel subagents finish one by one.
      if (isFinishedSubagent && hasActiveMessages) {
        if (candidateMessageSignaturesRef.current.get(message.id) !== signature) {
          candidateMessageSignaturesRef.current.set(message.id, signature);
        }
        (isBackgroundNotification(message) ? deferredNotifications : deferred).push(message);
        hasDeferred = true;
        continue;
      }

      if (!shouldCommitImmediately) {
        if (candidateMessageSignaturesRef.current.get(message.id) !== signature) {
          candidateMessageSignaturesRef.current.set(message.id, signature);
        }
        (isBackgroundNotification(message) ? deferredNotifications : deferred).push(message);
        hasDeferred = true;
        continue;
      }

      committedMessageSignaturesRef.current.set(message.id, signature);
      candidateMessageSignaturesRef.current.delete(message.id);
      additions.push({ kind: 'message', id: message.id, message });
    }

    if (additions.length > 0) {
      staticItemsRef.current = [...staticItemsRef.current, ...additions];
    }

    previousActiveMessageIdsRef.current = new Set(active.map((message) => message.id));

    return {
      staticItems: staticItemsRef.current,
      deferredHistory: deferred,
      deferredNotifications,
    };
  }, [active, bannerItems, history, restoredStaticMessageIdSet]);

  // Active messages that were already committed to <Static> in a prior render
  // (e.g. a bot lead-in text that became a toolLeadIn) must not be rendered again
  // in the dynamic area, or they would appear twice – once in the permanent
  // static output and once in the re-rendered dynamic region.
  const dynamicItems = useMemo(() => {
    const committedActiveIds = new Set<string>();
    for (const message of active) {
      const committedSignature = committedMessageSignaturesRef.current.get(message.id);
      if (committedSignature !== undefined && committedSignature === createMessageSignature(message)) {
        committedActiveIds.add(message.id);
      }
    }
    const filteredActive = committedActiveIds.size > 0 ? active.filter((m) => !committedActiveIds.has(m.id)) : active;
    return [...deferredHistory, ...filteredActive, ...deferredNotifications];
  }, [deferredHistory, deferredNotifications, active]);

  const renderMessage = (
    msg: MessageLike | CommandGroupMessage,
    idx: number,
    collection: readonly (StaticItem | MessageLike | CommandGroupMessage)[],
    maxWidth?: number,
  ) => {
    // Helper to get previous message safely from either StaticItem[] or MessageLike[]
    const getPreviousMessage = () => {
      if (idx <= 0) return null;
      const prev = collection[idx - 1];
      if (!prev) return null;
      if ('sender' in prev) {
        return prev;
      }
      if ('kind' in prev && prev.kind === 'message') {
        return prev.message;
      }
      return null;
    };

    // Helper to peek at the last static item when this is the first dynamic message.
    // Streaming splits flush earlier finalized chunks to static while the tail stays
    // dynamic, so continuation detection must cross the static/dynamic boundary.
    const getCrossBoundaryPreviousMessage = () => {
      if (collection !== dynamicItems) return null;
      if (idx !== 0) return null;
      if (staticItems.length === 0) return null;
      const lastStatic = staticItems[staticItems.length - 1];
      if (lastStatic.kind === 'message') {
        return lastStatic.message;
      }
      return null;
    };

    // Use consistent marginTop to prevent layout reflow.
    // This ensures stable spacing regardless of message order or streaming updates.
    // The first message in each collection has no top margin to avoid extra space.
    // Consecutive split bot response messages (continuation messages) also have no top margin
    // because their inner markdown renderer already provides correct spacing/newlines.
    const prevMsg = getPreviousMessage() ?? getCrossBoundaryPreviousMessage();
    const isContinuation = prevMsg && prevMsg.sender === 'bot' && msg.sender === 'bot';
    const isFirst = idx === 0 && collection === dynamicItems && staticItems.length === 0;
    const marginTop = isFirst || isContinuation ? 0 : 1;

    return (
      <Box key={msg.id} marginTop={marginTop} width={maxWidth}>
        {'members' in msg ? (
          <CommandGroupSummary members={msg.members} status={msg.status} />
        ) : msg.sender === 'command' ? (
          <CommandMessage
            command={msg.command ?? ''}
            output={msg.output}
            status={msg.status as 'pending' | 'running' | 'completed' | 'failed' | 'aborted' | undefined}
            success={msg.success}
            failureReason={msg.failureReason}
            toolName={msg.toolName}
            toolArgs={msg.toolArgs}
            isApprovalRejection={msg.isApprovalRejection}
            autoApprovedByLlm={msg.autoApprovedByLlm}
            hadApproval={msg.hadApproval}
            displayMode={displayMode}
            awaitingDecision={turnPaused}
          />
        ) : msg.sender === 'subagent' ? (
          <SubagentActivityMessage msg={msg} />
        ) : (
          <ChatMessage msg={msg as Message} maxWidth={maxWidth} />
        )}
      </Box>
    );
  };

  const renderStaticItem = (item: StaticItem, idx: number) => {
    if (item.kind === 'banner') {
      return <Box key={item.id}>{settingsService && <Banner settingsService={settingsService} />}</Box>;
    }

    // The trailing blank line is rendered outside <Static> (see below). It must
    // not be committed here: <Static> writes each item exactly once, so an
    // "is this the last item?" decision made at commit time gets frozen and
    // strands stray blank lines mid-history when more items are appended later
    // (e.g. during chunked reasoning streaming).
    return renderMessage(item.message, idx, staticItems, contentWidth);
  };

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Static
        items={staticItems}
        style={{ paddingLeft: MESSAGE_HORIZONTAL_PADDING, paddingRight: MESSAGE_HORIZONTAL_PADDING }}
      >
        {renderStaticItem}
      </Static>

      {/* Trailing spacer for the static block. Rendered here (not inside
          <Static>) so it is recomputed every render: it appears only while
          there is genuinely no dynamic content below, and is never baked into
          the write-once static buffer. */}
      {staticItems.length > 0 && dynamicItems.length === 0 && <Box height={1} />}

      <Box flexDirection="column" paddingX={MESSAGE_HORIZONTAL_PADDING}>
        {dynamicItems.map((msg, idx) => renderMessage(msg, idx, dynamicItems, contentWidth))}
      </Box>
    </Box>
  );
};

export default React.memo(MessageList);
