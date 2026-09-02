import { describe, expect, it, vi } from 'vitest';
import {
  MENTOR_MODE_ENTER_NOTICE,
  MENTOR_MODE_EXIT_NOTICE,
  PLAN_MODE_ENTER_NOTICE,
  PLAN_MODE_EXIT_NOTICE,
} from '../mode-notices.js';
import { ProfileTransitionService, classifyProfileTransition, planProfileTransition } from './profile-transition.js';
import { resolveProfile } from './resolver.js';

function makeSettings(activeProfileId = 'builtin:standard') {
  let active = activeProfileId;
  const set = vi.fn((_key: string, value: string) => {
    active = value;
  });
  return {
    get: vi.fn(() => active),
    set,
    current: () => active,
  } as any;
}

describe('ProfileTransitionService', () => {
  it('activates an alias and can toggle back to Standard', () => {
    const settings = makeSettings();
    const queueModeNotice = vi.fn();
    const service = new ProfileTransitionService(settings, { queueModeNotice });

    expect(service.activate('lite').targetId).toBe('builtin:lite');
    expect(settings.current()).toBe('builtin:lite');
    expect(service.activate('builtin:standard').targetId).toBe('builtin:standard');
    expect(settings.current()).toBe('builtin:standard');
    expect(settings.set).toHaveBeenCalledTimes(2);
    expect(queueModeNotice).not.toHaveBeenCalled();
  });

  it('applies a previously planned transition after canonical settings are already committed', () => {
    const settings = makeSettings();
    const rebuildAgent = vi.fn();
    const queueModeNotice = vi.fn();
    const service = new ProfileTransitionService(settings, { rebuildAgent, queueModeNotice });
    const plan = service.plan('builtin:mentor');

    settings.set('app.activeProfileId', plan.targetId);
    service.commit(plan);

    expect(rebuildAgent).toHaveBeenCalledOnce();
    expect(queueModeNotice).toHaveBeenCalledWith(MENTOR_MODE_ENTER_NOTICE);
    expect(settings.set).toHaveBeenCalledOnce();
  });

  it('resolves before mutation and leaves the current Profile on failure', () => {
    const settings = makeSettings();
    const service = new ProfileTransitionService(settings, {
      availableIntegrations: new Map([['builtin:integration/async-subagents', false]]),
    });

    expect(() => service.activate('builtin:does-not-exist')).toThrow(/Profile/);
    expect(() => service.activate('builtin:orchestrator')).toThrow(/async-subagents.*unavailable/);
    expect(settings.current()).toBe('builtin:standard');
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('classifies Lite changes as structural and runs the confirmation/clear path', () => {
    const settings = makeSettings();
    const requiresHistoryConfirmation = vi.fn(() => true);
    const clearConversation = vi.fn();
    const rebuildAgent = vi.fn();
    const service = new ProfileTransitionService(settings, {
      requiresHistoryConfirmation,
      clearConversation,
      rebuildAgent,
    });

    const plan = service.activate('builtin:lite');

    expect(plan.class).toBe('structural');
    expect(requiresHistoryConfirmation).toHaveBeenCalledOnce();
    expect(clearConversation).toHaveBeenCalledOnce();
    expect(rebuildAgent).toHaveBeenCalledOnce();
  });

  it('classifies Plan changes as notice-only without rebuilding the agent', () => {
    const settings = makeSettings();
    const rebuildAgent = vi.fn();
    const queueModeNotice = vi.fn();
    const service = new ProfileTransitionService(settings, { rebuildAgent, queueModeNotice });

    const plan = service.activate('builtin:plan');

    expect(plan.class).toBe('notice-only');
    expect(rebuildAgent).not.toHaveBeenCalled();
    expect(queueModeNotice).toHaveBeenCalledTimes(1);
    expect(queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_ENTER_NOTICE);
  });

  it('rebuilds once and queues one notice for Mentor and Orchestrator', () => {
    const settings = makeSettings();
    const rebuildAgent = vi.fn();
    const queueModeNotice = vi.fn();
    const service = new ProfileTransitionService(settings, { rebuildAgent, queueModeNotice });

    const plan = service.activate('builtin:mentor');

    expect(plan.class).toBe('agent-rebuild');
    expect(rebuildAgent).toHaveBeenCalledOnce();
    expect(queueModeNotice).toHaveBeenCalledTimes(1);
    expect(queueModeNotice).toHaveBeenCalledWith(MENTOR_MODE_ENTER_NOTICE);
  });

  it('composes exit and enter notices into one coherent pending notice', () => {
    const settings = makeSettings('builtin:plan');
    const queueModeNotice = vi.fn();
    const service = new ProfileTransitionService(settings, { queueModeNotice });

    const plan = service.activate('builtin:mentor');

    expect(plan.class).toBe('agent-rebuild');
    expect(plan.exitNotice).toBe(PLAN_MODE_EXIT_NOTICE);
    expect(plan.enterNotice).toBe(MENTOR_MODE_ENTER_NOTICE);
    expect(plan.composedNotice).toBe(`${PLAN_MODE_EXIT_NOTICE}\n\n${MENTOR_MODE_ENTER_NOTICE}`);
    expect(queueModeNotice).toHaveBeenCalledTimes(1);
    expect(queueModeNotice).toHaveBeenCalledWith(plan.composedNotice);
  });

  it('does nothing for a same-Profile activation', () => {
    const settings = makeSettings('builtin:plan');
    const service = new ProfileTransitionService(settings, {
      rebuildAgent: vi.fn(),
      queueModeNotice: vi.fn(),
    });

    const plan = service.activate('builtin:plan');

    expect(plan).toEqual({
      targetId: 'builtin:plan',
      class: 'noop',
      exitNotice: null,
      enterNotice: null,
      composedNotice: null,
    });
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('uses the exit notice when leaving Plan so a primed enter notice is replaced', () => {
    const settings = makeSettings('builtin:plan');
    const queueModeNotice = vi.fn();
    const service = new ProfileTransitionService(settings, { queueModeNotice });

    service.activate('builtin:lite');

    expect(queueModeNotice).toHaveBeenCalledTimes(1);
    expect(queueModeNotice).toHaveBeenCalledWith(PLAN_MODE_EXIT_NOTICE);
  });
});

describe('Profile transition planning', () => {
  it('classifies resolved Profiles using Lite semantics before workflow semantics', () => {
    const standard = resolveProfile('builtin:standard');
    const lite = resolveProfile('builtin:lite');
    const plan = resolveProfile('builtin:plan');

    expect(classifyProfileTransition(standard, lite)).toBe('structural');
    expect(classifyProfileTransition(standard, plan)).toBe('notice-only');
    expect(planProfileTransition(makeSettings() as any, 'builtin:plan')).toMatchObject({
      targetId: 'builtin:plan',
      class: 'notice-only',
      composedNotice: PLAN_MODE_ENTER_NOTICE,
    });
  });
});
