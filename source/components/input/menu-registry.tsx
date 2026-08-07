import React from 'react';
import type {
  MenuController,
  MenuFrame,
  MenuInteractionRegistry,
} from './menu-types.js';

export type MenuServices = Record<string, unknown>;

export type MenuComponentProps<F extends MenuFrame> = {
  frame: F;
  active: boolean;
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  services: MenuServices;
};

export type MenuRegistry = {
  [K in MenuFrame['kind']]: React.ComponentType<
    MenuComponentProps<Extract<MenuFrame, { kind: K }>>
  >;
};

const defaultRegistry: Partial<MenuRegistry> = {};

export function registerMenuComponent<K extends MenuFrame['kind']>(
  kind: K,
  component: React.ComponentType<MenuComponentProps<Extract<MenuFrame, { kind: K }>>>,
): void {
  (defaultRegistry as any)[kind] = component;
}

export function getMenuRegistry(): Partial<MenuRegistry> {
  return defaultRegistry;
}
