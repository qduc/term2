// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act, useMemo } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useTriggerDetection } from './use-trigger-detection.js';
import type { InputMode } from '../context/InputContext.js';
import type { SlashCommand } from '../slash-commands.js';

type Counts = Record<string, number>;

const count = (counts: Counts, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

type TestComponentProps = {
  counts: Counts;
  mode: InputMode;
  value: string;
  cursorOffset: number;
  slashCommands?: SlashCommand[];
};

const TestComponent = ({ counts, mode, value, cursorOffset, slashCommands = [] }: TestComponentProps) => {
  const handles = useMemo(
    () => ({
      slash: { open: () => count(counts, 'slash.open'), close: () => count(counts, 'slash.close') },
      path: { open: () => count(counts, 'path.open'), close: () => count(counts, 'path.close') },
      settings: {
        open: () => count(counts, 'settings.open'),
        close: () => count(counts, 'settings.close'),
      },
      settingsValue: {
        open: () => count(counts, 'settingsValue.open'),
        close: () => count(counts, 'settingsValue.close'),
      },
      models: { open: () => count(counts, 'models.open'), close: () => count(counts, 'models.close') },
    }),
    [counts],
  );

  useTriggerDetection({
    value,
    cursorOffset,
    mode,
    dismissedCompletionRef: { current: null } as any,
    inputRevisionRef: { current: 0 },
    slash: handles.slash,
    path: handles.path,
    settings: handles.settings,
    settingsValue: handles.settingsValue,
    models: handles.models,
    slashCommands,
  });

  return <Text>test</Text>;
};

test('useTriggerDetection keeps model selection open when cursor moves before the model trigger', async (t) => {
  const counts: Counts = {};
  const slashCommands: SlashCommand[] = [
    {
      name: '/model',
      description: 'Select model',
      action: () => {},
      completion: { type: 'model', trigger: '/model ' },
    },
  ];

  await act(async () => {
    render(
      <TestComponent
        counts={counts}
        mode="model_selection"
        value="/model gpt-5"
        cursorOffset={1}
        slashCommands={slashCommands}
      />,
    );
  });

  t.is(counts['models.close'] ?? 0, 0);
  t.is(counts['models.open'] ?? 0, 0);
});

test('useTriggerDetection closes model selection on none outside model mode', async (t) => {
  const counts: Counts = {};

  await act(async () => {
    render(<TestComponent counts={counts} mode="text" value="/model gpt-5" cursorOffset={1} />);
  });

  t.is(counts['models.close'], 1);
});
