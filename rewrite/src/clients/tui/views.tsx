import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../source/components/theme.js';
import MarkdownRenderer from '../../../../source/components/MarkdownRenderer.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { Message, TuiState } from './state.js';

/** Render the durable transcript and live drafts using the selected product skin. */
export function Transcript({ state, messages, columns, live }: { readonly state: TuiState; readonly messages: readonly Message[]; readonly columns: number; readonly live: boolean }): React.ReactElement {
  const { UserMessage, AssistantFrame, ToolFrame, assistantGutter } = useSkin();
  const theme = useTheme();
  const width = Math.max(1, columns - assistantGutter);
  return <Box flexDirection="column">
    {messages.map(message => message.role === 'user'
      ? <UserMessage key={message.id} text={message.text} />
      : message.role === 'assistant'
        ? <AssistantFrame key={message.id} kind="answer"><MarkdownRenderer maxWidth={width}>{message.text}</MarkdownRenderer></AssistantFrame>
        : <Box key={message.id}><Text color={message.error ? theme.danger : theme.textSubtle}>{message.role}: {message.text}</Text></Box>)}
    {live && Object.entries(state.reasoning).map(([id, text]) =>
      <AssistantFrame key={`reasoning:${id}`} kind="reasoning"><MarkdownRenderer defaultColor={theme.reasoning} maxWidth={width}>{text}</MarkdownRenderer></AssistantFrame>)}
    {live && Object.entries(state.drafts).map(([id, text]) =>
      <AssistantFrame key={`draft:${id}`} kind="answer"><MarkdownRenderer maxWidth={width}>{text}</MarkdownRenderer></AssistantFrame>)}
    {live && state.tools.map(tool => <ToolFrame key={tool.id} status={tool.status} display="standard" toolName={tool.name}>
      <Text>{tool.parent ? `${tool.parent} · ` : ''}{tool.name} — {tool.status}{tool.detail ? `\n${tool.detail}` : ''}</Text>
    </ToolFrame>)}
  </Box>;
}

/** Keep pending work and every independently owned interaction visible. */
export function Activity({ state }: { readonly state: TuiState }): React.ReactElement {
  const theme = useTheme();
  return <Box flexDirection="column">
    <Text color={theme.textSubtle}>{state.model} · {state.status}{state.usage ? ` · ${state.usage}` : ''}{state.cost ? ` · ${state.cost}` : ''}</Text>
    {state.queueState !== 'idle' ? <Text>Queue: {state.queueState}</Text> : null}
    {state.goal ? <Text>Goal: {state.goal}</Text> : null}
    {state.verification ? <Text>Verification: {state.verification}</Text> : null}
    {state.lastError ? <Text color={theme.danger}>Error: {state.lastError}</Text> : null}
    {state.tasks.map(task => <Text key={task.id}>Task {task.label}: {task.status}{task.detail ? ` — ${task.detail}` : ''}</Text>)}
    {state.queue.map((item, index) => <Text key={item.id}>Queued {index + 1} ({item.delivery}): {item.text}</Text>)}
    {state.interactions.map((interaction, index) => <Box key={interaction.id} flexDirection="column">
      <Text bold>{index + 1}. {interaction.kind === 'approval' ? 'Approval' : 'Question'}{interaction.owner ? ` · ${interaction.owner}` : ''}: {interaction.title}</Text>
      {interaction.detail ? <Text>{interaction.detail}</Text> : null}
      {interaction.choices.map((choice, choiceIndex) => <Text key={choice.id}>  {choiceIndex + 1}. {choice.label}</Text>)}
      <Text color={theme.textSubtle}>/answer {index + 1} &lt;choice number&gt;{interaction.acceptsText ? ' [text]' : ''}</Text>
    </Box>)}
    {state.notices.map((notice, index) => <Text key={index}>{notice}</Text>)}
  </Box>;
}
