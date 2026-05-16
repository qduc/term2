import test from 'ava';
import type { Message } from './use-conversation.js';
import { createUsageSlashCommand, getLastFinalAssistantText } from './use-app-commands.js';
import { parseModelProviderArg } from '../utils/model-provider-arg.js';

test('getLastFinalAssistantText returns the response from the latest assistant turn', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'bot', text: 'First answer' },
    { id: '3', sender: 'user', text: 'Second question' },
    { id: '4', sender: 'bot', text: 'Final answer' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Final answer');
});

test('getLastFinalAssistantText combines contiguous bot messages to return the full message', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Tell me a story' },
    { id: '2', sender: 'bot', text: 'Paragraph 1\n\n' },
    { id: '3', sender: 'bot', text: 'Paragraph 2\n\n' },
    { id: '4', sender: 'bot', text: 'Paragraph 3' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Paragraph 1\n\nParagraph 2\n\nParagraph 3');
});

test('getLastFinalAssistantText ignores reasoning and system messages', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'bot', text: 'Earlier answer' },
    { id: '2', sender: 'reasoning', text: 'hidden chain of thought' },
    { id: '3', sender: 'system', text: 'Stopped' },
  ];

  t.is(getLastFinalAssistantText(messages), 'Earlier answer');
});

test('getLastFinalAssistantText returns null when no bot message exists', (t) => {
  const messages: Message[] = [
    { id: '1', sender: 'user', text: 'Hi' },
    { id: '2', sender: 'reasoning', text: 'thinking' },
    { id: '3', sender: 'system', text: 'No response yet' },
  ];

  t.is(getLastFinalAssistantText(messages), null);
});

test('parseModelProviderArg supports provider names with spaces for /model', (t) => {
  t.deepEqual(parseModelProviderArg('deepseek-v4-flash --provider=opencode go'), {
    modelId: 'deepseek-v4-flash',
    provider: 'opencode go',
  });
});

test('createUsageSlashCommand shows current session usage', (t) => {
  const messages: string[] = [];
  const command = createUsageSlashCommand(
    (text) => messages.push(text),
    () => 'Token usage: 20,000 input (1,000,000 cached), 20,000 output',
  );

  t.is(command.name, 'usage');
  t.is(command.action(), true);
  t.deepEqual(messages, ['Token usage: 20,000 input (1,000,000 cached), 20,000 output']);
});
