import test from 'ava';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';

test('getSubagentDelegationAddendum returns non-empty delegation guidance', (t) => {
  const result = getSubagentDelegationAddendum();

  t.is(typeof result, 'string');
  t.true(result.length > 0);
  t.true(result.includes('Delegating to subagents'));
  t.true(result.includes('run_subagent'));
});

test('getSubagentDelegationAddendum includes orchestrator-specific text when orchestratorMode is true', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });

  t.true(result.includes('Orchestrator mode'));
  t.true(result.includes('delegate workspace inspection'));
});

test('getSubagentDelegationAddendum includes self-service fallback when orchestratorMode is false', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: false });

  t.true(result.includes('just do it yourself'));
});
