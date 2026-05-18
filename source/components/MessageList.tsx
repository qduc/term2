import React, { FC, useMemo, useRef } from 'react';
import { Box, Static, useStdout } from 'ink';
import CommandMessage from './CommandMessage.js';
import ChatMessage from './ChatMessage.js';
import Banner from './Banner.js';
import SubagentActivityMessage from './SubagentActivityMessage.js';
import type { SettingsService } from '../services/settings-service.js';

type Props = {
  messages: any[];
  bannerItems?: string[];
  settingsService?: SettingsService;
  isShellMode?: boolean;
};

type MessageLike = {
  id: string;
  sender?: string;
  status?: string;
};

type StaticBannerItem = {
  kind: 'banner';
  id: string;
};

type StaticMessageItem = {
  kind: 'message';
  id: string;
  message: MessageLike;
};

type StaticItem = StaticBannerItem | StaticMessageItem;

export const MESSAGE_HORIZONTAL_PADDING = 2;

const canRenderStatically = (message: MessageLike) => {
  if (message.sender === 'reasoning') {
    return message.status === 'finalized';
  }

  if (message.sender === 'command') {
    return message.status !== 'pending' && message.status !== 'running';
  }

  if (message.sender === 'subagent') {
    return message.status !== 'running';
  }

  if (message.sender === 'bot') {
    return message.status !== 'streaming';
  }

  return true;
};

export const splitStaticHistory = <T extends MessageLike>(messages: T[]) => {
  const activeStart = messages.findIndex((message) => !canRenderStatically(message));
  if (activeStart === -1) {
    return { history: messages, active: [] };
  }

  const firstActiveMessage = messages[activeStart];
  const previousMessage = activeStart > 0 ? messages[activeStart - 1] : undefined;
  const activeStartWithToolLeadIn =
    firstActiveMessage?.sender === 'command' &&
    (firstActiveMessage.status === 'pending' || firstActiveMessage.status === 'running') &&
    previousMessage?.sender === 'bot' &&
    previousMessage.status === 'finalized'
      ? activeStart - 1
      : activeStart;

  return {
    history: messages.slice(0, activeStartWithToolLeadIn),
    active: messages.slice(activeStartWithToolLeadIn),
  };
};

const createStaticItems = (bannerItems: string[], history: MessageLike[]): StaticItem[] => [
  ...bannerItems.map((id) => ({ kind: 'banner' as const, id })),
  ...history.map((message) => ({ kind: 'message' as const, id: message.id, message })),
];

const createMessageSignature = (message: MessageLike) => {
  try {
    return JSON.stringify(message);
  } catch {
    return `${message.id}:${message.sender ?? ''}:${message.status ?? ''}`;
  }
};

const MessageList: FC<Props> = ({ messages, bannerItems = [], settingsService, isShellMode = false }) => {
  const { stdout } = useStdout();

  const terminalColumns = stdout.columns || 80;
  const contentWidth = Math.max(1, terminalColumns - MESSAGE_HORIZONTAL_PADDING * 2);

  // Use useMemo to prevent array recreation on every render.
  // This stabilizes the references passed to Static and the active Box,
  // preventing unnecessary re-renders and fixing flickering in long sessions.
  const { history, active } = useMemo(() => {
    return splitStaticHistory(messages);
  }, [messages]);

  const staticItemsRef = useRef<StaticItem[]>(createStaticItems(bannerItems, []));
  const seenBannerIdsRef = useRef<Set<string>>(new Set(bannerItems));
  const committedMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const candidateMessageSignaturesRef = useRef<Map<string, string>>(new Map());
  const previousActiveMessageIdsRef = useRef<Set<string>>(new Set());

  const { staticItems, deferredHistory } = useMemo(() => {
    const additions: StaticItem[] = [];
    const deferred: MessageLike[] = [];
    const hasActiveMessages = active.length > 0;
    const previousActiveMessageIds = previousActiveMessageIdsRef.current;

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

    for (const message of history) {
      const signature = createMessageSignature(message);
      const committedSignature = committedMessageSignaturesRef.current.get(message.id);

      if (committedSignature === signature) {
        continue;
      }

      if (committedSignature !== undefined) {
        candidateMessageSignaturesRef.current.set(message.id, signature);
        deferred.push(message);
        continue;
      }

      const shouldCommitImmediately = hasActiveMessages || previousActiveMessageIds.has(message.id);
      if (!shouldCommitImmediately && candidateMessageSignaturesRef.current.get(message.id) !== signature) {
        candidateMessageSignaturesRef.current.set(message.id, signature);
        deferred.push(message);
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

    return { staticItems: staticItemsRef.current, deferredHistory: deferred };
  }, [active, bannerItems, history]);

  const dynamicItems = useMemo(() => [...deferredHistory, ...active], [deferredHistory, active]);

  const renderMessage = (msg: any, idx: number, collection: any[], maxWidth?: number) => {
    // Use consistent marginTop to prevent layout reflow.
    // This ensures stable spacing regardless of message order or streaming updates.
    // The first message in each collection has no top margin to avoid extra space.
    const isFirst = idx === 0 && collection === dynamicItems && staticItems.length === 0;

    return (
      <Box key={msg.id} marginTop={isFirst ? 0 : 1} width={maxWidth}>
        {msg.sender === 'command' ? (
          <CommandMessage
            command={msg.command}
            output={msg.output}
            status={msg.status}
            success={msg.success}
            failureReason={msg.failureReason}
            toolName={msg.toolName}
            toolArgs={msg.toolArgs}
            isApprovalRejection={msg.isApprovalRejection}
            hadApproval={msg.hadApproval}
          />
        ) : msg.sender === 'subagent' ? (
          <SubagentActivityMessage msg={msg} />
        ) : (
          <ChatMessage msg={msg} maxWidth={maxWidth} />
        )}
      </Box>
    );
  };

  const renderStaticItem = (item: StaticItem, idx: number) => {
    if (item.kind === 'banner') {
      return (
        <Box key={item.id}>
          {settingsService && <Banner settingsService={settingsService} isShellMode={isShellMode} />}
        </Box>
      );
    }

    const isLast = idx === staticItems.length - 1;
    if (isLast) {
      return (
        <Box key={item.id} flexDirection="column">
          {renderMessage(item.message, idx, staticItems, contentWidth)}
          <Box height={1} />
        </Box>
      );
    }

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

      <Box flexDirection="column" paddingX={MESSAGE_HORIZONTAL_PADDING}>
        {dynamicItems.map((msg, idx) => renderMessage(msg, idx, dynamicItems, contentWidth))}
      </Box>
    </Box>
  );
};

export default React.memo(MessageList);
