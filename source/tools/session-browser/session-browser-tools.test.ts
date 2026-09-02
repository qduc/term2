import { expect, it } from 'vitest';
import { createSessionBrowserToolDefinitions } from './session-browser-tools.js';

const browser = {
  list: () => ({ sessions: [], total: 0, omitted: 0, unavailable: 0, charsUsed: 72 }),
  search: () => ({ results: [], total: 0, omitted: 0, unavailable: 0, skippedMessageCount: 0, charsUsed: 92 }),
  read: () => ({
    session: { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    items: [],
    total: 0,
    omitted: 0,
    skippedMessageCount: 0,
    charsUsed: 140,
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

  // Descriptions are product behavior: pin the `total`/`omitted` semantics and
  // the live-session demotion rule so a cleanup cannot silently drop them.
  expect(tools[0]!.description).toContain('`total` is the number of browsable sessions in scope');
  expect(tools[1]!.description).toContain('`total` is the number of ranked matches before `limit` is applied');
  expect(tools[1]!.description).toContain('Matches from the currently active session sort last');
  expect(tools[2]!.description).toContain('`total - omitted` records were started here');
  expect(tools[2]!.description).toContain('`from: "end"`');
  expect(tools[2]!.parameters.safeParse({ id: 'a', from: 'end' }).success).toBe(true);
  expect(tools[2]!.parameters.safeParse({ id: 'a', from: 'start' }).success).toBe(false);
  expect(tools[2]!.parameters.safeParse({ id: 'a', from: 'end', cursor: 'c1' }).success).toBe(false);
});
