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

test('orchestrator mode includes safe coordination guidance', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  t.true(result.includes('safe coordination over maximum parallelism'));
});

test('orchestrator mode includes coupled or multi-worker language', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  t.true(result.includes('coupled or multi-worker'));
});

test('orchestrator mode includes ownership language', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  t.true(result.includes('Which worker owns'));
});

test('orchestrator mode says not to over-process simple single-worker tasks', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  t.true(result.includes('Do not over-process'));
});

test('non-orchestrator mode does not include coordination checklist', (t) => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: false });
  t.false(result.includes('coupled or multi-worker'));
  t.false(result.includes('Coordination checklist'));
});
