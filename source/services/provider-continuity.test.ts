import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ProviderContinuity } from './provider-continuity.js';

it('initial state is clear', () => {
  const pc = new ProviderContinuity();
  expect(pc.previousResponseId).toBe(null);
  expect(pc.chainingBroken).toBe(false);
  expect(pc.isChainingAvailable(2)).toBe(false);
  expect(pc.isChainingAvailable(1)).toBe(true);
});

it('update sets previousResponseId', () => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  expect(pc.previousResponseId).toBe('resp-1');
  expect(pc.chainingBroken).toBe(false);
});

it('clear resets previousResponseId', () => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  pc.clear();
  expect(pc.previousResponseId).toBe(null);
});

it('breakChaining marks chaining broken and clears previousResponseId', () => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  pc.breakChaining();
  expect(pc.previousResponseId).toBe(null);
  expect(pc.chainingBroken).toBe(true);
});

it('isChainingAvailable requires previousResponseId or short history and unbroken chaining', () => {
  const pc = new ProviderContinuity();
  expect(pc.isChainingAvailable(2)).toBe(false);
  expect(pc.isChainingAvailable(1)).toBe(true);
  pc.update('resp-1');
  expect(pc.isChainingAvailable(2)).toBe(true);
  pc.breakChaining();
  expect(pc.isChainingAvailable(1)).toBe(false);
  expect(pc.isChainingAvailable(2)).toBe(false);
});

it('update after breakChaining keeps chaining broken', () => {
  const pc = new ProviderContinuity();
  pc.breakChaining();
  pc.update('resp-2');
  expect(pc.previousResponseId).toBe('resp-2');
  expect(pc.chainingBroken).toBe(true);
  expect(pc.isChainingAvailable()).toBe(false);
});
