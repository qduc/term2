import React from 'react';
import { getMenuRegistry } from './menu-registry.js';
export function MenuStackHost({ stack, controller, interactions, services, enabled = true }) {
    const registry = getMenuRegistry();
    return (React.createElement(React.Fragment, null, stack.map((frame, index) => {
        const Component = registry[frame.kind];
        if (!Component)
            return null;
        const active = index === stack.length - 1;
        return (React.createElement(Component, { key: frame.id, frame: frame, active: active && enabled, controller: controller, interactions: interactions, services: services }));
    })));
}
//# sourceMappingURL=MenuStackHost.js.map