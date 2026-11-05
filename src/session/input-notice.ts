import type { Item } from '../model/index.js';

/** Prefix the first user message without changing its identity. */
export function withNotice(input: readonly Item[], notice: string): readonly Item[] {
  let prefixed = false;
  return input.map((item) => {
    if (prefixed || item.type !== 'user_message') return item;
    const textIndex = item.content.findIndex((part) => part.type === 'text');
    const part = item.content[textIndex];
    if (part?.type !== 'text') {
      prefixed = true;
      return { ...item, content: [{ type: 'text', text: notice }, ...item.content] };
    }
    prefixed = true;
    const content = [...item.content];
    content[textIndex] = { ...part, text: `${notice}\n\n${part.text}` };
    return { ...item, content };
  });
}
