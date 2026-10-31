import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../../../source/components/theme.js';
import { useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiState } from './state.js';

/** Render the durable transcript and live drafts using the selected product skin. */
export function Transcript({ state }: { readonly state: TuiState }): React.ReactElement {
  const { UserMessage, AssistantFrame, ToolFrame } = useSkin();
  const theme = useTheme();
  return <Box flexDirection="column">
    {state.messages.map(message => message.role === 'user'
      ? <UserMessage key={message.id} text={message.text} />
      : message.role === 'assistant'
        ? <AssistantFrame key={message.id} kind="answer"><Text>{message.text}</Text></AssistantFrame>
        : <Box key={message.id}><Text color={message.error ? theme.danger : theme.textSubtle}>{message.role}: {message.text}</Text></Box>)}
    {Object.entries(state.reasoning).map(([id, text]) =>
      <AssistantFrame key={`reasoning:${id}`} kind="reasoning"><Text>{text}</Text></AssistantFrame>)}
    {Object.entries(state.drafts).map(([id, text]) =>
      <AssistantFrame key={`draft:${id}`} kind="answer"><Text>{text}</Text></AssistantFrame>)}
    {state.tools.map(tool => <ToolFrame key={tool.id} status={tool.status} display="standard" toolName={tool.name}>
      <Text>{tool.parent ? `${tool.parent} · ` : ''}{tool.name} — {tool.status}{tool.detail ? `\n${tool.detail}` : ''}</Text>
    </ToolFrame>)}
  </Box>;
}

/** Keep pending work and every independently owned interaction visible. */
export function Activity({ state }: { readonly state: TuiState }): React.ReactElement {
  const theme = useTheme();
  return <Box flexDirection="column">
    <Text color={theme.textSubtle}>{state.model} · {state.status}{state.usage ? ` · ${state.usage}` : ''}</Text>
    {state.tasks.map(task => <Text key={task.id}>Task {task.label}: {task.status}{task.detail ? ` — ${task.detail}` : ''}</Text>)}
    {state.queue.map(item => <Text key={item.id}>Queued ({item.delivery}): {item.text}</Text>)}
    {state.interactions.map((interaction, index) => <Box key={interaction.id} flexDirection="column">
      <Text bold>{index + 1}. {interaction.kind === 'approval' ? 'Approval' : 'Question'}{interaction.owner ? ` · ${interaction.owner}` : ''}: {interaction.title}</Text>
      {interaction.detail ? <Text>{interaction.detail}</Text> : null}
      {interaction.choices.map((choice, choiceIndex) => <Text key={choice.id}>  {choiceIndex + 1}. {choice.label}</Text>)}
      <Text color={theme.textSubtle}>/answer {index + 1} &lt;choice number&gt;{interaction.acceptsText ? ' [text]' : ''}</Text>
    </Box>)}
    {state.notices.map((notice, index) => <Text key={index}>{notice}</Text>)}
  </Box>;
}
