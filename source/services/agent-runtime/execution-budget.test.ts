import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionBudget, createRootBudget, AcquiredChildSlot } from './execution-budget.js';

describe('ExecutionBudget', () => {
  describe('createRootBudget', () => {
    it('creates a budget with provided limits', () => {
      const budget = createRootBudget({
        maxChildren: 5,
        maxDepth: 3,
        maxConcurrency: 2,
        maxTokens: 100_000,
      });
      expect(budget.maxChildren).toBe(5);
      expect(budget.maxDepth).toBe(3);
      expect(budget.maxConcurrency).toBe(2);
      expect(budget.maxTokens).toBe(100_000);
      expect(budget.currentDepth).toBe(0);
    });

    it('creates a budget with no limits', () => {
      const budget = createRootBudget({});
      expect(budget.maxChildren).toBeUndefined();
      expect(budget.maxDepth).toBeUndefined();
      expect(budget.maxConcurrency).toBeUndefined();
      expect(budget.maxTokens).toBeUndefined();
    });
  });

  describe('tryAcquireChild', () => {
    it('acquires a child slot when under limits', () => {
      const budget = createRootBudget({ maxChildren: 5, maxConcurrency: 3 });
      const slot = budget.tryAcquireChild();
      expect(slot).toBeInstanceOf(AcquiredChildSlot);
      expect(budget.childCount).toBe(1);
      expect(budget.activeChildren).toBe(1);
    });

    it('rejects when maxChildren is exceeded', () => {
      const budget = createRootBudget({ maxChildren: 2 });
      const a = budget.tryAcquireChild();
      if (a instanceof AcquiredChildSlot) a.release();
      const b = budget.tryAcquireChild();
      if (b instanceof AcquiredChildSlot) b.release();
      // Both slots released, but childCount remains incremented
      expect(budget.childCount).toBe(2);

      // Third attempt is rejected
      const rejected = budget.tryAcquireChild();
      expect('accepted' in rejected && !(rejected as any).accepted).toBe(true);
      if (!('accepted' in rejected) || (rejected as any).accepted !== false) {
        expect.fail('Expected rejection');
      }
    });

    it('rejects when maxConcurrency is exceeded', () => {
      const budget = createRootBudget({ maxChildren: 10, maxConcurrency: 1 });
      const slot1 = budget.tryAcquireChild();
      expect(slot1).toBeInstanceOf(AcquiredChildSlot);

      const rejected = budget.tryAcquireChild();
      expect('accepted' in rejected && !(rejected as any).accepted).toBe(true);
    });

    it('rejects when maxTokens is exceeded', () => {
      const budget = createRootBudget({ maxTokens: 1000 });
      budget.recordUsage({ prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 });
      // Tokens at limit
      const rejected = budget.tryAcquireChild();
      expect('accepted' in rejected && !(rejected as any).accepted).toBe(true);
    });

    it('rejects when budget is released', () => {
      const budget = createRootBudget({ maxChildren: 5 });
      budget.release();
      const rejected = budget.tryAcquireChild();
      expect('accepted' in rejected && !(rejected as any).accepted).toBe(true);
    });

    it('rejects when aborted', () => {
      const budget = createRootBudget({ maxChildren: 5 });
      budget.abortController.abort();
      const rejected = budget.tryAcquireChild();
      expect('accepted' in rejected && !(rejected as any).accepted).toBe(true);
    });
  });

  describe('AcquiredChildSlot release', () => {
    it('decrements active children on release', () => {
      const budget = createRootBudget({ maxChildren: 5, maxConcurrency: 2 });
      const slot1 = budget.tryAcquireChild() as AcquiredChildSlot;
      const slot2 = budget.tryAcquireChild() as AcquiredChildSlot;
      expect(budget.activeChildren).toBe(2);

      slot1.release();
      expect(budget.activeChildren).toBe(1);

      // Now a new slot can be acquired
      const slot3 = budget.tryAcquireChild();
      expect(slot3).toBeInstanceOf(AcquiredChildSlot);
    });
  });

  describe('createChildBudget', () => {
    it('increments depth', () => {
      const budget = createRootBudget({ maxDepth: 3 });
      const child = budget.createChildBudget();
      expect(child.currentDepth).toBe(1);
    });

    it('throws when maxDepth is exceeded', () => {
      const budget = createRootBudget({ maxDepth: 1 });
      const child = budget.createChildBudget();
      expect(child.currentDepth).toBe(1);
      // Grandchild at depth 2 exceeds maxDepth 1
      expect(() => child.createChildBudget()).toThrow(/Maximum agent depth/);
    });

    it('shares abort controller', () => {
      const budget = createRootBudget({ maxDepth: 3 });
      const child = budget.createChildBudget();
      expect(child.abortController).toBe(budget.abortController);
    });

    it('inherits limits', () => {
      const budget = createRootBudget({
        maxChildren: 5,
        maxConcurrency: 3,
        maxTokens: 50_000,
        maxDepth: 3,
      });
      const child = budget.createChildBudget();
      expect(child.maxChildren).toBe(5);
      expect(child.maxConcurrency).toBe(3);
      expect(child.maxTokens).toBe(50_000);
      expect(child.maxDepth).toBe(3);
    });
  });

  describe('recordUsage', () => {
    it('accumulates token usage', () => {
      const budget = createRootBudget({});
      budget.recordUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
      expect(budget.aggregateTokens).toBe(150);

      budget.recordUsage({ prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 });
      expect(budget.aggregateTokens).toBe(450);
    });

    it('uses total_tokens when available', () => {
      const budget = createRootBudget({});
      budget.recordUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
      expect(budget.aggregateTokens).toBe(150);
    });

    it('sums prompt + completion when total_tokens is absent', () => {
      const budget = createRootBudget({});
      budget.recordUsage({ prompt_tokens: 100, completion_tokens: 50 });
      expect(budget.aggregateTokens).toBe(150);
    });

    it('aborts when aggregate exceeds maxTokens', () => {
      const budget = createRootBudget({ maxTokens: 500 });
      const abortSpy = { aborted: false };
      budget.abortController.signal.addEventListener('abort', () => {
        abortSpy.aborted = true;
      });

      budget.recordUsage({ prompt_tokens: 300, completion_tokens: 300, total_tokens: 600 });
      expect(budget.aggregateTokens).toBe(600);
      expect(budget.abortController.signal.aborted).toBe(true);
    });
  });

  describe('abort propagation', () => {
    it('child abort aborts root controller', () => {
      const budget = createRootBudget({});
      const child = budget.createChildBudget();
      child.abort();
      expect(budget.abortController.signal.aborted).toBe(true);
    });

    it('root abort aborts everything', () => {
      const budget = createRootBudget({});
      budget.abortController.abort();
      expect(budget.isExhausted).toBe(true);
      const rejected = budget.tryAcquireChild();
      expect('accepted' in rejected && !(rejected as any).accepted).toBe(true);
    });
  });

  describe('slot.createChildBudget', () => {
    it('delegates to parent createChildBudget', () => {
      const budget = createRootBudget({ maxDepth: 3 });
      const slot = budget.tryAcquireChild() as AcquiredChildSlot;
      const child = slot.createChildBudget();
      expect(child.currentDepth).toBe(1);
      expect(child.abortController).toBe(budget.abortController);
      slot.release();
    });
  });
});
