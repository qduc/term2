import React from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { RewindMenuSession } from './RewindMenuSession.js';
import { ProviderMenuSession } from './ProviderMenuSession.js';
import { PathMenuSession } from './PathMenuSession.js';
import { SkillsMenuSession } from './SkillsMenuSession.js';
import { SlashMenuSession } from './SlashMenuSession.js';
import { SettingsMenuSession } from './SettingsMenuSession.js';
import { SettingsValueMenuSession } from './SettingsValueMenuSession.js';
import { ModelMenuSession } from './ModelMenuSession.js';
import { CopyMenuSession } from './CopyMenuSession.js';
import { MentorPoolMenuSession } from './MentorPoolMenuSession.js';
import { ResumeMenuSession } from './ResumeMenuSession.js';

export type MenuServices = Record<string, unknown>;

export type MenuComponentProps<F extends MenuFrame> = {
  frame: F;
  active: boolean;
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  services: MenuServices;
};

export type MenuRegistry = {
  [K in MenuFrame['kind']]: React.ComponentType<MenuComponentProps<Extract<MenuFrame, { kind: K }>>>;
};

const defaultRegistry: MenuRegistry = {
  path: PathMenuSession as React.ComponentType<any>,
  skills: SkillsMenuSession as React.ComponentType<any>,
  resume: ResumeMenuSession as React.ComponentType<any>,
  copy: CopyMenuSession,
  rewind: RewindMenuSession,
  providers: ProviderMenuSession,
  slash: SlashMenuSession as React.ComponentType<any>,
  settings: SettingsMenuSession as React.ComponentType<any>,
  settings_value: SettingsValueMenuSession as React.ComponentType<any>,
  mentor_pool: MentorPoolMenuSession as React.ComponentType<any>,
  model: ModelMenuSession as React.ComponentType<any>,
};

export function registerMenuComponent<K extends MenuFrame['kind']>(
  kind: K,
  component: React.ComponentType<MenuComponentProps<Extract<MenuFrame, { kind: K }>>>,
): void {
  (defaultRegistry as any)[kind] = component;
}

export function getMenuRegistry(): MenuRegistry {
  return defaultRegistry;
}
