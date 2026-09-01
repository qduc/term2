import { expect, it } from 'vitest';
import {
  MENTOR_MODE_ENTER_NOTICE,
  MENTOR_MODE_EXIT_NOTICE,
  ORCHESTRATOR_MODE_ENTER_NOTICE,
  ORCHESTRATOR_MODE_EXIT_NOTICE,
  PLAN_MODE_ENTER_NOTICE,
  PLAN_MODE_EXIT_NOTICE,
  profileEnterNotice,
  profileExitNotice,
  primeActiveModeNoticeIfActive,
  primeActiveProfileNoticeIfActive,
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

it('maps canonical Profile IDs to their enter and exit notices', () => {
  expect(profileEnterNotice('builtin:plan')).toBe(PLAN_MODE_ENTER_NOTICE);
  expect(profileExitNotice('builtin:plan')).toBe(PLAN_MODE_EXIT_NOTICE);
  expect(profileEnterNotice('builtin:mentor')).toBe(MENTOR_MODE_ENTER_NOTICE);
  expect(profileExitNotice('builtin:mentor')).toBe(MENTOR_MODE_EXIT_NOTICE);
  expect(profileEnterNotice('builtin:orchestrator')).toBe(ORCHESTRATOR_MODE_ENTER_NOTICE);
  expect(profileExitNotice('builtin:orchestrator')).toBe(ORCHESTRATOR_MODE_EXIT_NOTICE);
  expect(profileEnterNotice('builtin:standard')).toBeNull();
  expect(profileExitNotice('builtin:lite')).toBeNull();
});

it('primes the notice for the canonical active Profile', () => {
  const queued: string[] = [];
  primeActiveProfileNoticeIfActive({ get: () => 'builtin:plan' } as any, (text) => queued.push(text));
  expect(queued).toEqual([PLAN_MODE_ENTER_NOTICE]);
});

it('does not crash or queue when the canonical active Profile cannot resolve', () => {
  const queued: string[] = [];
  expect(() =>
    primeActiveProfileNoticeIfActive({ get: () => 'builtin:missing' } as any, (text) => queued.push(text)),
  ).not.toThrow();
  expect(queued).toEqual([]);
});
