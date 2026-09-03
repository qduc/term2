import { it, expect, vi } from 'vitest';
import { createProfileCommand } from './mode-commands.js';
import { ProfileTransitionService } from '../services/profiles/profile-transition.js';
import { PROFILE_TRIGGER } from '../components/input/triggers.js';

function createHarness() {
  const settings = new Map<string, any>([['app.activeProfileId', 'builtin:standard']]);
  const settingsService = {
    get: (key: string) => settings.get(key) ?? false,
    set: (key: string, value: any) => settings.set(key, value),
    setDynamic: (key: string, value: any) => {
      settings.set(key, value);
      return { key, value };
    },
    isRuntimeModifiable: () => true,
  } as any;
  const transitionService = new ProfileTransitionService(settingsService, {
    rebuildAgent: () => {},
    queueModeNotice: () => {},
  });
  const messages: string[] = [];
  const replaceInput = vi.fn();
  const command = createProfileCommand({
    settingsService,
    transitionService,
    addSystemMessage: (text) => messages.push(text),
    replaceInput,
  });
  return { command, settings, replaceInput, messages };
}

it('profile command carries the profile completion trigger', () => {
  const { command } = createHarness();
  expect(command.completion).toEqual({ type: 'profile', trigger: PROFILE_TRIGGER });
});

it('bare /profile opens the picker via replaceInput and keeps the buffer', () => {
  const { command, replaceInput } = createHarness();
  expect(command.action(undefined)).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(PROFILE_TRIGGER);
});

it('/profile with an id still switches directly', () => {
  const { command, settings, replaceInput } = createHarness();
  expect(command.action('plan')).toBe(true);
  expect(settings.get('app.activeProfileId')).toBe('builtin:plan');
  expect(replaceInput).not.toHaveBeenCalled();
});
