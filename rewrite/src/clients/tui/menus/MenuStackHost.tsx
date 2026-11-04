import React from 'react';
import type { MenuController, MenuFrame, MenuInteractionRegistry } from './menu-types.js';
import { getMenuRegistry, type MenuServices } from './menu-registry.js';

export interface MenuStackHostProps {
  stack: readonly MenuFrame[];
  controller: MenuController;
  interactions: MenuInteractionRegistry;
  services: MenuServices;
  enabled?: boolean;
}

export function MenuStackHost({ stack, controller, interactions, services, enabled = true }: MenuStackHostProps) {
  const registry = getMenuRegistry();

  return (
    <>
      {stack.map((frame, index) => {
        const Component = registry[frame.kind] as React.ComponentType<any> | undefined;
        if (!Component) return null;

        const active = index === stack.length - 1;

        return (
          <Component
            key={frame.id}
            frame={frame}
            active={active && enabled}
            controller={controller}
            interactions={interactions}
            services={services}
          />
        );
      })}
    </>
  );
}
