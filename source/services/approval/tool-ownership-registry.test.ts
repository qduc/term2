import { it, expect } from 'vitest';
import { ToolOwnershipRegistry } from './tool-ownership-registry.js';
import { PARENT_TOOL_OWNER } from './tool-owner.js';

const worker = { kind: 'subagent' as const, agentId: 'worker-1', role: 'worker' };
const explorer = { kind: 'subagent' as const, agentId: 'explorer-1', role: 'explorer' };

it('an unclaimed call belongs to the parent agent', () => {
  const registry = new ToolOwnershipRegistry();

  expect(registry.ownerOf('never-claimed')).toEqual(PARENT_TOOL_OWNER);
});

it('a missing call id belongs to the parent agent', () => {
  const registry = new ToolOwnershipRegistry();

  expect(registry.ownerOf(undefined)).toEqual(PARENT_TOOL_OWNER);
});

it('claim attributes every listed call to the claiming subagent', () => {
  const registry = new ToolOwnershipRegistry();

  registry.claim(['nested-a', 'nested-b'], worker);

  expect(registry.ownerOf('nested-a')).toEqual(worker);
  expect(registry.ownerOf('nested-b')).toEqual(worker);
});

it('claims from different subagents stay separated by call id', () => {
  const registry = new ToolOwnershipRegistry();

  registry.claim(['other-call'], worker);
  registry.claim(['target-call'], explorer);

  expect(registry.ownerOf('target-call')).toEqual(explorer);
  expect(registry.ownerOf('other-call')).toEqual(worker);
});

it('a later claim for the same call id wins', () => {
  const registry = new ToolOwnershipRegistry();

  registry.claim(['shared-call'], worker);
  registry.claim(['shared-call'], explorer);

  expect(registry.ownerOf('shared-call')).toEqual(explorer);
});

it('empty call ids are ignored rather than claimed', () => {
  const registry = new ToolOwnershipRegistry();

  registry.claim(['', 'real-call'], worker);

  expect(registry.size).toBe(1);
  expect(registry.ownerOf('real-call')).toEqual(worker);
});

it('release drops a single claim back to the parent', () => {
  const registry = new ToolOwnershipRegistry();
  registry.claim(['nested-a', 'nested-b'], worker);

  registry.release('nested-a');

  expect(registry.ownerOf('nested-a')).toEqual(PARENT_TOOL_OWNER);
  expect(registry.ownerOf('nested-b')).toEqual(worker);
});

it('clear drops every claim', () => {
  const registry = new ToolOwnershipRegistry();
  registry.claim(['nested-a', 'nested-b'], worker);

  registry.clear();

  expect(registry.size).toBe(0);
  expect(registry.ownerOf('nested-a')).toEqual(PARENT_TOOL_OWNER);
});

it('does not evict an unreleased pending ownership claim', () => {
  const registry = new ToolOwnershipRegistry({ limit: 2 });

  registry.claim(['pending'], worker);
  registry.claim(['later-a'], explorer);
  registry.claim(['later-b'], explorer);

  expect(registry.ownerOf('pending')).toEqual(worker);
});

it('retains every live claim until its owner releases it', () => {
  const registry = new ToolOwnershipRegistry({ limit: 2 });

  registry.claim(['first'], worker);
  registry.claim(['second'], worker);
  registry.claim(['third'], explorer);

  expect(registry.size).toBe(3);
  expect(registry.ownerOf('first')).toEqual(worker);
  expect(registry.ownerOf('second')).toEqual(worker);
  expect(registry.ownerOf('third')).toEqual(explorer);
});

it('re-claiming a call id preserves its live ownership', () => {
  const registry = new ToolOwnershipRegistry({ limit: 2 });

  registry.claim(['first'], worker);
  registry.claim(['second'], worker);
  registry.claim(['first'], worker);
  registry.claim(['third'], explorer);

  expect(registry.ownerOf('first')).toEqual(worker);
  expect(registry.ownerOf('second')).toEqual(worker);
  expect(registry.ownerOf('third')).toEqual(explorer);
});
