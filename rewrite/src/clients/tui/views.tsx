import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../source/components/theme.js';
import MarkdownRenderer from '../../../../source/components/MarkdownRenderer.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { Message, TuiState } from './state.js';
import { ToolCall } from './tool-view.js';

/** Render mixed history only in the authoritative wire order; separate items with unknown order. */
export function Transcript({ state, messages, columns, live }: { readonly state: TuiState; readonly messages: readonly Message[]; readonly columns: number; readonly live: boolean }): React.ReactElement {
  const { UserMessage, AssistantFrame, assistantGutter } = useSkin();
  const theme = useTheme();
  const width = Math.max(1, columns - assistantGutter);
  const messageById = new Map(messages.map(message => [message.id, message]));
  const toolById = new Map((live ? state.tools : []).map(tool => [tool.id, tool]));
  const usedMessages = new Set<string>();
  const usedTools = new Set<string>();
  const renderMessage = (message: Message) => message.role === 'user'
    ? <UserMessage key={`message:${message.id}`} text={message.text} />
    : message.role === 'assistant'
      ? <AssistantFrame key={`message:${message.id}`} kind="answer"><MarkdownRenderer maxWidth={width}>{message.text}</MarkdownRenderer></AssistantFrame>
      : <Box key={`message:${message.id}`}><Text color={message.error ? theme.danger : theme.textSubtle}>{message.role}: {message.text}</Text></Box>;
  const ordered = state.timeline?.flatMap<React.ReactNode>(item => {
    if (item.kind === 'message') {
      const message = messageById.get(item.id);
      if (!message || usedMessages.has(item.id)) return [];
      usedMessages.add(item.id);
      return [renderMessage(message)];
    }
    const tool = toolById.get(item.id);
    if (!tool || usedTools.has(item.id)) return [];
    usedTools.add(item.id);
    return [<ToolCall key={`tool:${tool.id}`} tool={tool} />];
  }) ?? [];
  const remainingMessages = messages.filter(message => !usedMessages.has(message.id));
  const remainingTools = live ? state.tools.filter(tool => !usedTools.has(tool.id)) : [];
  return <Box flexDirection="column">
    {ordered}
    {state.timeline && (remainingMessages.length || remainingTools.length) ? <Text color={theme.textSubtle}>Additional items (order unavailable)</Text> : null}
    {remainingMessages.map(renderMessage)}
    {live && Object.entries(state.reasoning).map(([id, text]) =>
      <AssistantFrame key={`reasoning:${id}`} kind="reasoning"><MarkdownRenderer defaultColor={theme.reasoning} maxWidth={width}>{text}</MarkdownRenderer></AssistantFrame>)}
    {live && Object.entries(state.drafts).map(([id, text]) =>
      <AssistantFrame key={`draft:${id}`} kind="answer"><MarkdownRenderer maxWidth={width}>{text}</MarkdownRenderer></AssistantFrame>)}
    {!state.timeline && remainingTools.length ? <Text color={theme.textSubtle}>Tool executions (transcript order unavailable)</Text> : null}
    {remainingTools.map(tool => <ToolCall key={`tool:${tool.id}`} tool={tool} />)}
  </Box>;
}

/** Keep pending work and every independently owned interaction visible. */
export function Activity({ state }: { readonly state: TuiState }): React.ReactElement {
  const theme = useTheme();
  const { TaskPanel } = useSkin();
  const active = state.tasks.filter(task => task.status === 'running' || task.status === 'awaiting_interaction').length;
  return <Box flexDirection="column">
    <Text color={theme.textSubtle}>{state.model} · {state.status}{state.usage ? ` · ${state.usage}` : ''}{state.cost ? ` · ${state.cost}` : ''}</Text>
    {state.queueState !== 'idle' ? <Text>Queue: {state.queueState}{state.queuePauseReason ? ` · ${state.queuePauseReason}` : ''}</Text> : null}
    {state.budgets.length ? <Text>Pending budget decisions: {state.budgets.length} · Ctrl+B</Text> : null}
    {state.goal ? <Text>Goal: {state.goal}</Text> : null}
    {state.verification ? <Text>Verification: {state.verification}</Text> : null}
    {state.lastError ? <Text color={theme.danger}>Error: {state.lastError}</Text> : null}
    {state.tasks.length ? <TaskPanel header={`Tasks · ${active} active · /tasks manage`}>
      {state.tasks.map(task => <Text key={task.id}>  {task.status === 'running' ? '◐' : task.status === 'awaiting_interaction' ? '○' : task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : '–'} {task.label} [{task.id}] · {task.status}{task.detail ? ` — ${task.detail.split('\n')[0]}` : ''}</Text>)}
    </TaskPanel> : null}
    {state.queue.map((item, index) => <Text key={item.id}>Queued {index + 1} ({item.delivery}): {item.text}</Text>)}
    {state.interactions.map((interaction, index) => <Box key={interaction.id} flexDirection="column">
      <Text bold>{index + 1}. {interaction.kind === 'approval' ? 'Approval' : 'Question'}{interaction.owner ? ` · ${interaction.owner}` : ''}: {interaction.title}</Text>
      {interaction.detail ? <Text>{interaction.detail}</Text> : null}
      {interaction.choices.map((choice, choiceIndex) => <Text key={choice.id}>  {choiceIndex + 1}. {choice.label}</Text>)}
      <Text color={theme.textSubtle}>/answer {index + 1} &lt;choice number&gt;{interaction.acceptsText ? ' [text]' : ''}</Text>
    </Box>)}
    {state.unmatchedTools.map((tool, index) => <Box key={`${tool.executionId}:${index}`} flexDirection="column">
      <Text>Unmatched tool result · {tool.toolName ?? 'name unavailable'} · {tool.executionId}{tool.isError ? ' · error' : ''}</Text>
      <Text>{tool.output}</Text>
      {tool.content?.map((part, partIndex) => <Text key={partIndex}>{part.type === 'text' ? part.text : `[image: ${part.mediaType}]`}</Text>)}
    </Box>)}
    {state.notices.map((notice, index) => <Text key={index}>{notice}</Text>)}
  </Box>;
}
