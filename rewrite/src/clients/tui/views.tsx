import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../source/components/theme.js';
import MarkdownRenderer from '../../../../source/components/MarkdownRenderer.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { Message, TuiState } from './state.js';
import { ToolCall } from './tool-view.js';

/** Render mixed history only in the authoritative wire order; separate items with unknown order. */
export function Transcript({
  state,
  messages,
  columns,
  live,
  expanded = false,
}: {
  readonly state: TuiState;
  readonly messages: readonly Message[];
  readonly columns: number;
  readonly live: boolean;
  /** Show every tool's output, not only failures. */
  readonly expanded?: boolean;
}): React.ReactElement {
  const { UserMessage, AssistantFrame, assistantGutter } = useSkin();
  const theme = useTheme();
  const width = Math.max(1, columns - 2 - assistantGutter);
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const toolById = new Map((live ? state.tools : []).map((tool) => [tool.id, tool]));
  const usedMessages = new Set<string>();
  const usedTools = new Set<string>();
  const renderMessage = (message: Message) =>
    message.role === 'user' ? (
      <Box key={`message:${message.id}`} marginTop={1}>
        <UserMessage text={message.text} />
      </Box>
    ) : message.role === 'assistant' ? (
      <Box key={`message:${message.id}`} marginTop={1} paddingLeft={2}>
        <AssistantFrame kind="answer">
          <MarkdownRenderer maxWidth={width}>{message.text}</MarkdownRenderer>
        </AssistantFrame>
      </Box>
    ) : (
      <Box key={`message:${message.id}`} marginTop={1}>
        <Text color={message.error ? theme.danger : theme.textSubtle}>
          {message.role}: {message.text}
        </Text>
      </Box>
    );
  const ordered =
    state.timeline?.flatMap<React.ReactNode>((item) => {
      if (item.kind === 'message') {
        const message = messageById.get(item.id);
        if (!message || usedMessages.has(item.id)) return [];
        usedMessages.add(item.id);
        return [renderMessage(message)];
      }
      const tool = toolById.get(item.id);
      if (!tool || usedTools.has(item.id)) return [];
      usedTools.add(item.id);
      return [
        <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
          <ToolCall tool={tool} expanded={expanded} />
        </Box>,
      ];
    }) ?? [];
  const remainingMessages = messages.filter((message) => !usedMessages.has(message.id));
  const remainingTools = live ? state.tools.filter((tool) => !usedTools.has(tool.id)) : [];
  return (
    <Box flexDirection="column" paddingBottom={1}>
      {ordered}
      {state.timeline && (remainingMessages.length || remainingTools.length) ? (
        <Text color={theme.textSubtle}>Additional items (order unavailable)</Text>
      ) : null}
      {remainingMessages.map(renderMessage)}
      {live &&
        Object.entries(state.reasoning).map(([id, text]) => (
          <Box key={`reasoning:${id}`} marginTop={1} paddingLeft={2}>
            <AssistantFrame kind="reasoning">
              <MarkdownRenderer defaultColor={theme.reasoning} maxWidth={width}>
                {text}
              </MarkdownRenderer>
            </AssistantFrame>
          </Box>
        ))}
      {live &&
        Object.entries(state.drafts).map(([id, text]) => (
          <Box key={`draft:${id}`} marginTop={1} paddingLeft={2}>
            <AssistantFrame kind="answer">
              <MarkdownRenderer maxWidth={width}>{text}</MarkdownRenderer>
            </AssistantFrame>
          </Box>
        ))}
      {!state.timeline && remainingTools.length ? (
        <Text color={theme.textSubtle}>Tool executions (transcript order unavailable)</Text>
      ) : null}
      {remainingTools.map((tool) => (
        <Box key={`tool:${tool.id}`} marginTop={1} paddingLeft={2}>
          <ToolCall tool={tool} expanded={expanded} />
        </Box>
      ))}
    </Box>
  );
}

/** Keep pending work visible unless its active dialog already presents it. */
export function Activity({
  state,
  dialogInteractionId,
}: {
  readonly state: TuiState;
  readonly dialogInteractionId?: string;
}): React.ReactElement {
  const theme = useTheme();
  const { TaskPanel } = useSkin();
  // Only running work belongs in the live region; settled tasks stay in the task manager, and ids stay out of the transcript.
  const liveTasks = state.tasks.filter((task) => task.status === 'running' || task.status === 'awaiting_interaction');
  return (
    <Box flexDirection="column">
      {state.status !== 'idle' || state.cost ? (
        <Text color={theme.textSubtle}>
          {[state.status !== 'idle' ? state.status : '', state.cost].filter(Boolean).join(' · ')}
        </Text>
      ) : null}
      {state.queueState !== 'idle' ? (
        <Text>
          Queue: {state.queueState}
          {state.queuePauseReason ? ` · ${state.queuePauseReason}` : ''}
        </Text>
      ) : null}
      {state.commands
        .filter(
          (receipt) =>
            receipt.request.operation.kind !== 'configure' ||
            (receipt.outcome?.kind !== 'configured' && receipt.outcome?.kind !== 'rejected'),
        )
        .map((receipt) => (
          <Text key={receipt.request.commandId}>
            Command {receipt.request.commandId} · {receipt.request.operation.kind} ·{' '}
            {receipt.outcome?.kind ?? 'pending'}
            {receipt.outcome?.kind === 'rejected' ? `: ${receipt.outcome.message}` : ''}
            {receipt.outcome?.kind === 'interrupted' ? ' · outcome unknown' : ''}
          </Text>
        ))}
      {state.budgets.length ? <Text>Pending budget decisions: {state.budgets.length} · Ctrl+B</Text> : null}
      {state.goal ? <Text>Goal: {state.goal}</Text> : null}
      {state.verification ? <Text>Verification: {state.verification}</Text> : null}
      {state.lastError ? <Text color={theme.danger}>Error: {state.lastError}</Text> : null}
      {liveTasks.length ? (
        <TaskPanel header={`Tasks · ${liveTasks.length} active · /tasks manage`}>
          {liveTasks.map((task) => (
            <Text key={task.id}>
              {' '}
              {task.status === 'running' ? '◐' : '○'} {task.label} · {task.status}
              {task.detail ? ` — ${task.detail.split('\n')[0]}` : ''}
            </Text>
          ))}
        </TaskPanel>
      ) : null}
      {state.queue.map((item, index) => (
        <Text key={item.id}>
          Queued {index + 1} ({item.delivery}): {item.text}
        </Text>
      ))}
      {state.interactions.map((interaction, index) =>
        interaction.id === dialogInteractionId ? null : (
          <Box key={interaction.id} flexDirection="column">
            <Text bold>
              {index + 1}. {interaction.kind === 'approval' ? 'Approval' : 'Question'}
              {interaction.owner ? ` · ${interaction.owner}` : ''}: {interaction.title}
            </Text>
            {interaction.detail ? <Text>{interaction.detail}</Text> : null}
            {interaction.choices.map((choice, choiceIndex) => (
              <Text key={choice.id}>
                {' '}
                {choiceIndex + 1}. {choice.label}
              </Text>
            ))}
            <Text color={theme.textSubtle}>
              /answer {index + 1} &lt;choice number&gt;{interaction.acceptsText ? ' [text]' : ''}
            </Text>
          </Box>
        ),
      )}
      {state.unmatchedTools.map((tool, index) => (
        <Box key={`${tool.executionId}:${index}`} flexDirection="column">
          <Text>
            Unmatched tool result · {tool.toolName ?? 'name unavailable'} · {tool.executionId}
            {tool.isError ? ' · error' : ''}
          </Text>
          <Text>{tool.output}</Text>
          {tool.content?.map((part, partIndex) => (
            <Text key={partIndex}>{part.type === 'text' ? part.text : `[image: ${part.mediaType}]`}</Text>
          ))}
        </Box>
      ))}
      {state.notices.map((notice, index) => (
        <Text key={index}>{notice}</Text>
      ))}
    </Box>
  );
}

/** The one-off lines above the composer: connection trouble in the danger colour, the rest as plain text. */
export function LiveNotices({
  connectionError,
  transitionNotice,
  notice,
  historyError,
}: {
  readonly connectionError?: string | null;
  readonly transitionNotice?: string | null;
  readonly notice?: string | null;
  readonly historyError?: string | null;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <>
      {connectionError ? <Text color={theme.danger}>{connectionError}</Text> : null}
      {[transitionNotice, notice, historyError].map((text, index) => (text ? <Text key={index}>{text}</Text> : null))}
    </>
  );
}
