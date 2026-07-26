import { expect, it, vi } from 'vitest';
import { createAskOrchestratorToolDefinition } from './ask-orchestrator.js';

it('validates a bounded question and waits only for the supplied orchestrator answer', async () => {
  let resolve!: (answer: string) => void;
  const answer = new Promise<string>((next) => (resolve = next));
  const ask = vi.fn(() => answer);
  const tool = createAskOrchestratorToolDefinition(ask);

  expect(tool.name).toBe('ask_orchestrator');
  expect(tool.needsApproval({ question: 'Which API?' }, undefined)).toBe(false);
  expect(tool.parameters.safeParse({ question: 'Which API?' }).success).toBe(true);
  expect(tool.parameters.safeParse({ question: '   ' }).success).toBe(false);
  expect(tool.parameters.safeParse({ question: 'x'.repeat(1_201) }).success).toBe(false);

  const pending = tool.execute({ question: 'Which API?' }, undefined, undefined as never);
  expect(ask).toHaveBeenCalledWith('Which API?');
  resolve('Use the public API.');
  await expect(pending).resolves.toBe('Use the public API.');
});
