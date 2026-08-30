import { expect, it } from 'vitest';
import { createSessionBrowserToolDefinitions } from './session-browser-tools.js';

const browser = {
  list: () => ({ sessions: [], omitted: 0, unavailable: 0, charsUsed: 62 }),
  search: () => ({ results: [], omitted: 0, unavailable: 0, skippedMessageCount: 0, charsUsed: 82 }),
  read: () => ({
    session: { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    items: [],
    omitted: 0,
    skippedMessageCount: 0,
    charsUsed: 130,
  }),
} as any;

it('exposes read-only browser tools with strict bounded parameter schemas', async () => {
  const tools = createSessionBrowserToolDefinitions(browser);
  expect(tools.map((tool) => tool.name)).toEqual(['session_list', 'session_search', 'session_read']);
  expect(tools.every((tool) => tool.preserveSerializedOutput)).toBe(true);
  for (const tool of tools) expect(tool.needsApproval({} as never)).toBe(false);
  expect(tools[0]!.parameters.safeParse({ maxChars: 511 }).success).toBe(false);
  expect(tools[1]!.parameters.safeParse({ query: '   ' }).success).toBe(false);
  expect(tools[2]!.parameters.safeParse({ id: '../escape' }).success).toBe(false);
  expect(JSON.parse((await tools[0]!.execute({})) as string)).toMatchObject({ sessions: [] });
});
