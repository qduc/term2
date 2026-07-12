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

it('requires task-specific context without repeating automatically supplied context', () => {
  const result = getSubagentDelegationAddendum();

  expect(result).toContain(
    'Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or skills catalog.',
  );
  expect(result).toContain(
    'objective, task-specific scope, non-discoverable parent findings or decisions, constraints',
  );
  expect(result).toContain('deliverable or acceptance criteria, and validation when applicable');
  expect(result).toContain('The subagent does not see your conversation or reasoning');
});

it('orchestrator mode includes splitting rule and worker-sized definition', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result.includes('Split work at learning and verification boundaries')).toBe(true);
  expect(result.includes('First delegate investigation or the next implementable checkpoint')).toBe(true);
  expect(result.includes('one cohesive unit that can be understood, implemented, and verified')).toBe(true);
  expect(result.includes('The orchestrator decides where execution units begin and end')).toBe(true);
});

it('includes librarian delegation trigger', () => {
  const result = getSubagentDelegationAddendum();
  expect(result.includes('librarian')).toBe(true);
});
