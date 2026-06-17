import { it, expect } from 'vitest';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';

it('getSubagentDelegationAddendum returns non-empty delegation guidance', () => {
  const result = getSubagentDelegationAddendum();

  expect(typeof result).toBe('string');
  expect(result.length > 0).toBe(true);
  expect(result.includes('Delegating to subagents')).toBe(true);
  expect(result.includes('run_subagent')).toBe(true);
});

it('getSubagentDelegationAddendum includes orchestrator-specific text when orchestratorMode is true', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });

  expect(result.includes('Orchestrator mode')).toBe(true);
  expect(result.includes('Delegate workspace inspection')).toBe(true);
});

it('getSubagentDelegationAddendum includes self-service fallback when orchestratorMode is false', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: false });

  expect(result.includes('just do it yourself')).toBe(true);
});

it('orchestrator mode includes safe coordination guidance', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result.includes('safe coordination over maximum parallelism')).toBe(true);
});

it('orchestrator mode includes coupled or multi-worker language', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result.includes('coupled or multi-worker')).toBe(true);
});

it('orchestrator mode includes ownership language', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result.includes('Which worker owns')).toBe(true);
});

it('orchestrator mode says not to over-process simple single-worker tasks', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result.includes('Do not over-process')).toBe(true);
});

it('non-orchestrator mode does not include coordination checklist', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: false });
  expect(result.includes('coupled or multi-worker')).toBe(false);
  expect(result.includes('Coordination checklist')).toBe(false);
});

it('includes task framing guidance about autonomous workers', () => {
  const result = getSubagentDelegationAddendum();
  expect(result.includes('Task framing')).toBe(true);
  expect(result.includes('autonomous agents')).toBe(true);
  expect(result.includes('goal, relevant context, and constraints')).toBe(true);
  expect(result.includes('not implementation steps')).toBe(true);
});
