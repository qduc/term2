import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';

it('dedupeToolStarted scopes subagent starts by agent and call ID', () => {
  const tracker = new SessionToolTracker(new ConversationStore());
  const event = {
    type: 'subagent_tool_started' as const,
    agentId: 'worker-1',
    role: 'worker',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'pwd' },
  };

  expect(tracker.dedupeToolStarted(event)).toBe(event);
  expect(tracker.dedupeToolStarted(event)).toBe(null);
  expect(tracker.dedupeToolStarted({ ...event, agentId: 'worker-2' })).toBeTruthy();
});
