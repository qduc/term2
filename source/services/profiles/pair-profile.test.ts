import { expect, it, vi } from 'vitest';
import { resolveProfile } from './resolver.js';
import { legacyModeFromProfileId } from './legacy-adapter.js';
import { ProfileTransitionService, classifyProfileTransition } from './profile-transition.js';
import { profileEnterNotice, profileExitNotice, primeActiveProfileNoticeIfActive } from '../mode-notices.js';
import { buildPromptSpec } from '../../prompts/prompt-constructor.js';

it('inherits Standard capabilities and authority while supplying the human-led workflow', () => {
  const pair = resolveProfile('pair');
  const standard = resolveProfile('standard');
  expect(pair.tools).toEqual(standard.tools);
  expect(pair.context).toEqual(standard.context);
  expect(pair.enforcement).toEqual(standard.enforcement);
  expect(pair.integrations).toEqual(standard.integrations);
  expect(pair.instructions.workflow).toMatchObject({ kind: 'markdown' });
  expect(legacyModeFromProfileId('builtin:pair')).toEqual(legacyModeFromProfileId('builtin:standard'));
  expect(buildPromptSpec({ model: 'gpt-4o', profile: pair })).toEqual(
    buildPromptSpec({ model: 'gpt-4o', profile: standard }),
  );
});

it('enters and exits Pair without rebuilding, and primes it on session start or restoration', () => {
  let active = 'builtin:standard';
  const settings = {
    get: () => active,
    set: (_key: string, value: string) => {
      active = value;
    },
  } as any;
  const queueModeNotice = vi.fn();
  const rebuildAgent = vi.fn();
  const service = new ProfileTransitionService(settings, { queueModeNotice, rebuildAgent });
  expect(service.activate('pair').class).toBe('notice-only');
  expect(active).toBe('builtin:pair');
  expect(queueModeNotice).toHaveBeenLastCalledWith(profileEnterNotice('builtin:pair'));
  expect(profileEnterNotice('builtin:pair')).toContain("obtain the human's approval");
  expect(profileEnterNotice('builtin:pair')).toContain('then stop');
  primeActiveProfileNoticeIfActive(settings, queueModeNotice);
  expect(queueModeNotice).toHaveBeenCalledTimes(2);
  expect(service.activate('standard').class).toBe('notice-only');
  expect(queueModeNotice).toHaveBeenLastCalledWith(profileExitNotice('builtin:pair'));
  expect(profileExitNotice('builtin:pair')).toContain('Pair Mode is now OFF');
  expect(rebuildAgent).not.toHaveBeenCalled();
});

it.each([
  ['standard', 'notice-only'],
  ['plan', 'notice-only'],
  ['lite', 'structural'],
  ['mentor', 'agent-rebuild'],
  ['orchestrator', 'agent-rebuild'],
] as const)('preserves transition requirements between Pair and %s', (id, expected) => {
  const pair = resolveProfile('pair');
  const other = resolveProfile(id);
  expect(classifyProfileTransition(pair, other)).toBe(expected);
  expect(classifyProfileTransition(other, pair)).toBe(expected);
});
