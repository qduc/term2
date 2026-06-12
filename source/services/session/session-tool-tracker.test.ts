import test from 'ava';
import { ConversationStore } from '../conversation/conversation-store.js';
import { SessionToolTracker } from './session-tool-tracker.js';

test('dedupeToolStarted scopes subagent starts by agent and call ID', (t) => {
  const tracker = new SessionToolTracker(new ConversationStore());
  const event = {
    type: 'subagent_tool_started' as const,
    agentId: 'worker-1',
    role: 'worker',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'pwd' },
  };

  t.is(tracker.dedupeToolStarted(event), event);
  t.is(tracker.dedupeToolStarted(event), null);
  t.truthy(tracker.dedupeToolStarted({ ...event, agentId: 'worker-2' }));
});
