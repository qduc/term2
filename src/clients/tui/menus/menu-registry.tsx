import React from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { SlashMenuSession } from './SlashMenuSession.js';
import { PathMenuSession } from './PathMenuSession.js';
import { ProviderMenuSession } from './ProviderMenuSession.js';
import { ModelMenuSession } from './ModelMenuSession.js';
import { SubagentPoolMenuSession } from './SubagentPoolMenuSession.js';
import { SettingsMenuSession } from './SettingsMenuSession.js';
import { SettingsValueMenuSession } from './SettingsValueMenuSession.js';
import { ResumeMenuSession } from './ResumeMenuSession.js';
import { ProfileMenuSession } from './ProfileMenuSession.js';
import { SkillsMenuSession } from './SkillsMenuSession.js';
import { CopyMenuSession } from './CopyMenuSession.js';
import { RewindMenuSession } from './RewindMenuSession.js';

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

/** Each ported menu session registers here; a frame without a session renders nothing. */
const defaultRegistry: Partial<MenuRegistry> = {
  path: PathMenuSession as React.ComponentType<any>,
  slash: SlashMenuSession as React.ComponentType<any>,
  providers: ProviderMenuSession,
  model: ModelMenuSession as React.ComponentType<any>,
  subagent_pool: SubagentPoolMenuSession as React.ComponentType<any>,
  settings: SettingsMenuSession as React.ComponentType<any>,
  settings_value: SettingsValueMenuSession as React.ComponentType<any>,
  resume: ResumeMenuSession as React.ComponentType<any>,
  profile: ProfileMenuSession as React.ComponentType<any>,
  skills: SkillsMenuSession as React.ComponentType<any>,
  copy: CopyMenuSession as React.ComponentType<any>,
  rewind: RewindMenuSession as React.ComponentType<any>,
};

export function getMenuRegistry(): Partial<MenuRegistry> {
  return defaultRegistry;
}
