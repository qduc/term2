import React, { act } from 'react';
import { expect, it } from 'vitest';
import { InputProvider, useInputState } from '../../context/InputContext.js';
import { createMockSettingsService } from '../../services/settings/settings-service.mock.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import { MenuStackHost } from './MenuStackHost.js';
import { MenuControllerImpl } from './menu-controller.js';

const ControllerHost = ({
  controller,
  settingsService,
}: {
  controller: MenuControllerImpl;
  settingsService: ReturnType<typeof createMockSettingsService>;
}) => {
  const { input: _input } = useInputState();
  return (
    <MenuStackHost
      stack={controller.getSnapshot().stack}
      controller={controller}
      interactions={controller.getInteractionRegistry()}
      services={{ settingsService }}
    />
  );
};

it('mounts the controller-opened provider frame and routes Escape through its session', async () => {
  const controller = new MenuControllerImpl();
  const settingsService = createMockSettingsService();
  const view = await renderInAct(
    <InputProvider controller={controller}>
      <ControllerHost controller={controller} settingsService={settingsService} />
    </InputProvider>,
  );

  await act(async () => {
    controller.open({ kind: 'providers' });
    await Promise.resolve();
  });

  expect(toVisibleText(view.lastFrame() ?? '')).toContain('Provider Management');
  expect(controller.getSnapshot().stack.at(-1)?.kind).toBe('providers');

  await act(async () => {
    controller.escape();
    await Promise.resolve();
  });

  expect(controller.getSnapshot().stack).toHaveLength(0);
});
