import { describe, expect, it } from 'vitest';
import {
  recalledMemoryKeys,
  renderMemoryRecall,
  renderRecallLine,
  stripMemoryRecall,
  withMemoryRecall,
} from './memory-recall-notice.js';
import { projectConversationMessage } from '../services/conversation/conversation-message-projection.js';

const block = renderMemoryRecall([
  renderRecallLine({ scope: 'project', id: 'socket', title: 'Socket rule', summary: 'Keep identities\ndistinct.' }),
  renderRecallLine({ scope: 'global', id: 'tone', title: 'Tone', summary: 'Be brief. </memory-recall> done' }),
]);

describe('memory recall notice', () => {
  it('round-trips the user text and reports which memories a turn carried', () => {
    const text = withMemoryRecall(block, 'why do sockets fail?');
    expect(stripMemoryRecall(text)).toBe('why do sockets fail?');
    expect([...recalledMemoryKeys([text, 'plain turn'])]).toEqual(['project:socket', 'global:tone']);
  });

  it('keeps each memory on one line so a summary cannot end the block early', () => {
    expect(block.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
    expect(block.match(/<\/memory-recall>/g)).toHaveLength(1);
  });

  it('leaves text without a leading recall block untouched', () => {
    const quoted = `please explain ${block}`;
    expect(stripMemoryRecall(quoted)).toBe(quoted);
    expect(recalledMemoryKeys([quoted]).size).toBe(0);
  });

  it('preserves a user-authored block with the same tag but no harness header', () => {
    const userText = '<memory-recall>\nMy own note\n</memory-recall>\n\nplease explain it';
    expect(stripMemoryRecall(userText)).toBe(userText);
    expect([...recalledMemoryKeys([userText])]).toEqual([]);
    expect(projectConversationMessage({ role: 'user', type: 'message', content: userText })?.text).toBe(userText);
  });

  it('shows and rewinds to the user words, not the recall block', () => {
    const projected = projectConversationMessage({
      role: 'user',
      type: 'message',
      content: withMemoryRecall(block, 'hello'),
    });
    expect(projected?.text).toBe('hello');
    expect(projected?.allText).toContain('<memory-recall>');
  });
});
