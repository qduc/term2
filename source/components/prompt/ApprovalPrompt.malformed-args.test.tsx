// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import ApprovalPrompt from './ApprovalPrompt.js';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';

// Regression: `argumentsText` is unvalidated model output. A `search_replace`
// whose `replacements` is not an array used to reach `.map` during render and
// throw, taking down the approval surface itself — the user could then neither
// approve nor deny. Degrading one preview is acceptable; losing the consent UI
// is not.
it.sequential('search_replace approval renders when replacements is not an array', async () => {
  const approval: ApprovalDescriptor = {
    agentName: 'Agent',
    toolName: 'search_replace',
    argumentsText: JSON.stringify({
      path: 'source/a.ts',
      replacements: '[{"search_content":"a","replace_content":"b"}]',
    }),
    rawInterruption: { type: 'tool_approval_item' },
  };

  const result = await renderInAct(<ApprovalPrompt approval={approval} onApprove={() => {}} onReject={() => {}} />);

  const text = toVisibleText(result.lastFrame() ?? '');
  expect(text).toContain('source/a.ts');
  // The prompt must still be answerable.
  expect(text.toLowerCase()).toContain('allow');
});
