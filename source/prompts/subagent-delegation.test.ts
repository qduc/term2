import { it, expect } from 'vitest';
import { getSubagentDelegationAddendum } from './subagent-delegation.js';

it('getSubagentDelegationAddendum returns non-empty delegation guidance', () => {
  const result = getSubagentDelegationAddendum();

  expect(typeof result).toBe('string');
  expect(result.length > 0).toBe(true);
  expect(result.includes('Delegating to subagents')).toBe(true);
  expect(result.includes('run_subagent')).toBe(true);
});

it('getSubagentDelegationAddendum gives orchestrators adaptive delegation and direct-work guidance', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });

  expect(result.includes('Orchestrator mode')).toBe(true);
  expect(result).toContain('Delegate when it provides meaningful leverage');
  expect(result).toContain('directly inspect, edit, run commands, and test small or clear work');
  expect(result).not.toContain('Delegate workspace inspection');
});

it('getSubagentDelegationAddendum includes self-service fallback when orchestratorMode is false', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: false });

  expect(result.includes('just do it yourself')).toBe(true);
});

it('orchestrator mode protects outcome ownership and safe coordination', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result).toContain('Delegation transfers execution, never outcome ownership');
  expect(result).toContain('Avoid concurrent overlapping edits');
  expect(result).not.toContain('Coordination checklist');
  expect(result).not.toContain('First delegate investigation');
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

it('retains worker autonomy without mandatory pre-delegation ceremony', () => {
  const result = getSubagentDelegationAddendum({ orchestratorMode: true });
  expect(result.includes('one cohesive unit that can be understood, implemented, and verified')).toBe(true);
  expect(result.includes('The orchestrator decides where execution units begin and end')).toBe(true);
  expect(result).not.toContain('Before any `run_subagent` call, plan silently');
});

it('includes librarian delegation trigger when persistent memory is enabled', () => {
  const result = getSubagentDelegationAddendum({ memoryEnabled: true });
  expect(result.includes('librarian')).toBe(true);
});

it('does not advertise the librarian when persistent memory is disabled', () => {
  const result = getSubagentDelegationAddendum({ memoryEnabled: false });
  expect(result.includes('librarian')).toBe(false);
});
