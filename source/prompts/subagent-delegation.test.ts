import test from 'ava';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';

test('getSubagentDelegationAddendum frames delegation as a first-class strategy', (t) => {
  const result = getSubagentDelegationAddendum();

  t.true(result.includes('### Delegating to subagents'));
  t.true(result.includes('first-class strategy'));
});

test('getSubagentDelegationAddendum includes concrete delegate / do-it-yourself triggers', (t) => {
  const result = getSubagentDelegationAddendum();

  t.true(result.includes('Default to delegating when'));
  t.true(result.includes('Do it yourself when'));
  t.true(result.includes('self-contained'));
});

test('getSubagentDelegationAddendum embeds the generated roles section', (t) => {
  const result = getSubagentDelegationAddendum();

  t.true(result.includes('## Roles'));
});
