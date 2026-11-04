import React from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { SlashMenuSession } from './SlashMenuSession.js';
import { PathMenuSession } from './PathMenuSession.js';
import { ProviderMenuSession } from './ProviderMenuSession.js';
import { ModelMenuSession } from './ModelMenuSession.js';

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
};

export function getMenuRegistry(): Partial<MenuRegistry> {
  return defaultRegistry;
}
