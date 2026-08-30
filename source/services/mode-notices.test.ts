import { expect, it } from 'vitest';
import {
  MENTOR_MODE_ENTER_NOTICE,
  MENTOR_MODE_EXIT_NOTICE,
  ORCHESTRATOR_MODE_ENTER_NOTICE,
  ORCHESTRATOR_MODE_EXIT_NOTICE,
  PLAN_MODE_ENTER_NOTICE,
  primeActiveModeNoticeIfActive,
  runtimeModeNotice,
} from './mode-notices.js';

it('provides enter and exit notices for Mentor and Orchestrator modes', () => {
  expect(MENTOR_MODE_ENTER_NOTICE).toContain('Mentor Mode is ON');
  expect(MENTOR_MODE_ENTER_NOTICE).toContain('Mentor Collaboration');
  expect(MENTOR_MODE_EXIT_NOTICE).toContain('Mentor Mode is now OFF');
  expect(ORCHESTRATOR_MODE_ENTER_NOTICE).toContain('Orchestrator Mode is ON');
  expect(ORCHESTRATOR_MODE_ENTER_NOTICE).toContain('single point of contact');
  expect(ORCHESTRATOR_MODE_EXIT_NOTICE).toContain('Orchestrator Mode is now OFF');
});

it('routes runtime mode notices to the matching workflow', () => {
  expect(runtimeModeNotice('plan', true)).toBe(PLAN_MODE_ENTER_NOTICE);
  expect(runtimeModeNotice('mentor', true)).toBe(MENTOR_MODE_ENTER_NOTICE);
  expect(runtimeModeNotice('orchestrator', true)).toBe(ORCHESTRATOR_MODE_ENTER_NOTICE);
});

it('primes only the highest-precedence active non-lite mode', () => {
  const queued: string[] = [];

  primeActiveModeNoticeIfActive({ planMode: true, mentorMode: true, orchestratorMode: true }, (text) =>
    queued.push(text),
  );

  expect(queued).toEqual([ORCHESTRATOR_MODE_ENTER_NOTICE]);
});
