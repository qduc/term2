import React from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { RewindMenuSession } from './RewindMenuSession.js';
import { ProviderMenuSession } from './ProviderMenuSession.js';
import { PathMenuSession } from './PathMenuSession.js';
import { SkillsMenuSession } from './SkillsMenuSession.js';
import { SlashMenuSession } from './SlashMenuSession.js';

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

const defaultRegistry: Partial<MenuRegistry> = {
  path: PathMenuSession as React.ComponentType<any>,
  skills: SkillsMenuSession as React.ComponentType<any>,
  rewind: RewindMenuSession,
  providers: ProviderMenuSession,
  slash: SlashMenuSession as React.ComponentType<any>,
};

export function registerMenuComponent<K extends MenuFrame['kind']>(
  kind: K,
  component: React.ComponentType<MenuComponentProps<Extract<MenuFrame, { kind: K }>>>,
): void {
  (defaultRegistry as any)[kind] = component;
}

export function getMenuRegistry(): Partial<MenuRegistry> {
  return defaultRegistry;
}
