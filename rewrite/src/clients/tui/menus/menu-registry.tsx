import React from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';

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
const defaultRegistry: Partial<MenuRegistry> = {};

export function getMenuRegistry(): Partial<MenuRegistry> {
  return defaultRegistry;
}
