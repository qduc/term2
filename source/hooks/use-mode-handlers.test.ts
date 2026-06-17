// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { useModeHandlers } from './use-mode-handlers.js';
import type { ProviderSelectionPhase } from './use-provider-selection.js';

const TestComponent = ({
  providers,
  onHookResult,
}: {
  providers: any;
  onHookResult: (hook: ReturnType<typeof useModeHandlers>) => void;
}) => {
  const hook = useModeHandlers({
    slash: {
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
      executeSelected: () => {},
      completeSelected: () => {},
      getSelectedItem: () => undefined,
    } as any,
    path: {
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
    } as any,
    settings: {
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
      switchCategory: () => {},
    } as any,
    settingsValue: {
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
    } as any,
    models: {
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
      canSwitchProvider: false,
      toggleProvider: () => {},
    } as any,
    undo: {
      moveUp: () => {},
      moveDown: () => {},
      moveHome: () => {},
      moveEnd: () => {},
      pageUp: () => {},
      pageDown: () => {},
      confirmSelection: () => {},
    } as any,
    providers,
    insertSelectedPath: () => false,
    insertSelectedSetting: () => false,
    insertSelectedSettingValue: () => false,
    resetSettingValue: () => {},
    insertSelectedModel: () => false,
    onSubmit: () => {},
    onSlashCommandRemount: () => {},
  });

  useEffect(() => {
    onHookResult(hook);
  }, [hook, onHookResult]);

  return null;
};

it('provider_selection submit uses text submit for wizard phases', async () => {
  const handleTextInputSubmitCalls: string[] = [];
  const selectItemCalls: number[] = [];

  let renderer: any;
  let hook: ReturnType<typeof useModeHandlers> | undefined;

  await act(async () => {
    renderer = render(
      React.createElement(TestComponent, {
        providers: {
          phase: 'wizard_name' as ProviderSelectionPhase,
          moveUp: () => {},
          moveDown: () => {},
          selectItem: () => selectItemCalls.push(1),
          goBack: () => {},
          handleTextInputSubmit: (value: string) => {
            handleTextInputSubmitCalls.push(value);
            return true;
          },
        },
        onHookResult: (nextHook) => {
          hook = nextHook;
        },
      }),
    );
  });

  if (!hook) {
    throw new Error('Expected hook result');
  }

  const onSubmit = hook.provider_selection.onSubmit;
  if (!onSubmit) {
    throw new Error('Expected provider_selection onSubmit handler');
  }

  let result: ReturnType<typeof onSubmit> = undefined as unknown as ReturnType<typeof onSubmit>;
  await act(async () => {
    result = onSubmit('my-custom-provider');
  });

  expect(result).toBe('handled');
  expect(handleTextInputSubmitCalls).toEqual(['my-custom-provider']);
  expect(selectItemCalls).toEqual([]);

  await act(async () => {
    renderer.unmount();
  });
});
