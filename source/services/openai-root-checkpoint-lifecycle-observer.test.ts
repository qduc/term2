import { expect, it } from 'vitest';
import { DefaultOpenAIRootCheckpointLifecycleObserver } from './openai-root-checkpoint-lifecycle-observer.js';

it('records frozen sanitized lifecycle evidence', () => {
  const evidence: unknown[] = [];
  const observer = new DefaultOpenAIRootCheckpointLifecycleObserver();
  observer.setEvidenceRecorder((value) => evidence.push(value));

  observer.candidate('missing_prefix_binding');
  observer.publication('history_not_committed');

  expect(evidence).toEqual([
    { type: 'openai_root_checkpoint_lifecycle', version: 1, stage: 'candidate', outcome: 'missing_prefix_binding' },
    { type: 'openai_root_checkpoint_lifecycle', version: 1, stage: 'publication', outcome: 'history_not_committed' },
  ]);
  expect(Object.isFrozen(evidence[0])).toBe(true);
  expect(Object.isFrozen(evidence[1])).toBe(true);
});

it('swallows recorder failures', () => {
  const observer = new DefaultOpenAIRootCheckpointLifecycleObserver();
  observer.setEvidenceRecorder(() => {
    throw new Error('log unavailable');
  });

  expect(() => observer.candidate('observed')).not.toThrow();
});
