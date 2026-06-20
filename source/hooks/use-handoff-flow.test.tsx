// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { it, expect, vi } from 'vitest';
import React, { act, useEffect, useState } from 'react';
import { render } from 'ink-testing-library';
import { useHandoffFlow, type HandoffState } from './use-handoff-flow.js';

type HarnessSnapshot = {
  handoffState: HandoffState | null;
  input: string;
  mode: string;
  triggerIndex: number | null;
  hook: ReturnType<typeof useHandoffFlow>;
  setMode: (mode: string) => void;
};

type HarnessProps = {
  onSnapshot: (snapshot: HarnessSnapshot) => void;
  clearConversationAndRefreshBanner: () => Promise<void>;
  addSystemMessage: (text: string) => void;
  sendUserMessage: (turn: { text: string; images?: unknown[] }) => Promise<void>;
  settingsService: { set: (key: string, value: unknown) => void; get: (key: string) => unknown };
  applyRuntimeSetting: (key: string, value: unknown) => void;
  setModel: (model: string) => void;
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const createDeps = () => {
  const clearConversationAndRefreshBanner = vi.fn(async () => {});
  const addSystemMessage = vi.fn();
  const sendUserMessage = vi.fn(async () => {});
  const settingsService = {
    set: vi.fn(),
    get: vi.fn(),
  };
  const applyRuntimeSetting = vi.fn();
  const setModel = vi.fn();

  return {
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    settingsService,
    applyRuntimeSetting,
    setModel,
  };
};

const Harness = ({
  onSnapshot,
  clearConversationAndRefreshBanner,
  addSystemMessage,
  sendUserMessage,
  settingsService,
  applyRuntimeSetting,
  setModel,
}: HarnessProps) => {
  const [mode, setMode] = useState('text');
  const [input, setInput] = useState('');
  const [triggerIndex, setTriggerIndex] = useState<number | null>(null);
  const hook = useHandoffFlow({
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    setInput,
    setMode,
    setTriggerIndex,
    mode,
    settingsService: settingsService as any,
    applyRuntimeSetting,
    setModel,
  });

  useEffect(() => {
    onSnapshot({
      handoffState: hook.handoffState,
      input,
      mode,
      triggerIndex,
      hook,
      setMode,
    });
  });

  return null;
};

const renderHarness = async () => {
  const deps = createDeps();
  let snapshot: HarnessSnapshot | undefined;
  let renderer: { unmount: () => void } | undefined;

  await act(async () => {
    renderer = render(
      <Harness
        {...deps}
        onSnapshot={(next) => {
          snapshot = next;
        }}
      />,
    );
  });
  await flush();

  return { deps, getSnapshot: () => snapshot!, renderer: renderer! };
};

it.sequential('startHandoff and submitting entering_message captures the handoff message', async () => {
  const { getSnapshot, renderer } = await renderHarness();
  const snapshot = getSnapshot();

  await act(async () => {
    snapshot.hook.startHandoff('Captured text');
  });
  await flush();

  expect(getSnapshot().handoffState).toEqual({
    capturedText: 'Captured text',
    stage: 'entering_message',
  });

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: '  Implement this now  ' } as any);
  });
  await flush();

  expect(getSnapshot().handoffState).toEqual({
    capturedText: 'Captured text',
    handoffMessage: 'Implement this now',
    stage: 'confirm_model',
  });
  expect(getSnapshot().input).toBe('');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('confirmHandoff clears conversation and opens model selection', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.confirmHandoff();
  });
  await flush();

  expect(deps.clearConversationAndRefreshBanner).toHaveBeenCalledTimes(1);
  expect(getSnapshot().handoffState?.stage).toBe('selecting_model');
  expect(getSnapshot().mode).toBe('model_selection');
  expect(getSnapshot().input).toBe('/model ');
  expect(getSnapshot().triggerIndex).toBe('/model '.length);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('declineHandoff clears conversation and sends the captured text', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.declineHandoff();
  });
  await flush();

  expect(deps.clearConversationAndRefreshBanner).toHaveBeenCalledTimes(1);
  expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });
  expect(getSnapshot().handoffState).toBeNull();
  expect(getSnapshot().input).toBe('');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('cancelHandoff clears state and reports cancellation', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    getSnapshot().hook.cancelHandoff();
  });
  await flush();

  expect(getSnapshot().handoffState).toBeNull();
  expect(getSnapshot().input).toBe('');
  expect(deps.addSystemMessage).toHaveBeenCalledWith('Handoff cancelled');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('submitHandoffInput in selecting_model updates model and provider settings before sending', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.confirmHandoff();
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: '/model gpt-4 --provider=anthropic' } as any);
  });
  await flush();

  expect(deps.settingsService.set).toHaveBeenNthCalledWith(1, 'agent.model', 'gpt-4');
  expect(deps.settingsService.set).toHaveBeenNthCalledWith(2, 'agent.provider', 'anthropic');
  expect(deps.applyRuntimeSetting).toHaveBeenNthCalledWith(1, 'agent.provider', 'anthropic');
  expect(deps.applyRuntimeSetting).toHaveBeenNthCalledWith(2, 'agent.model', 'gpt-4');
  expect(deps.setModel).toHaveBeenCalledWith('gpt-4');
  expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('submitHandoffInput in selecting_model sends once even after mode returns to text', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.confirmHandoff();
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: '/model gpt-4' } as any);
  });
  await flush();

  expect(deps.sendUserMessage).toHaveBeenCalledTimes(1);

  await act(async () => {
    getSnapshot().setMode('text');
  });
  await flush();

  expect(deps.sendUserMessage).toHaveBeenCalledTimes(1);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('submitHandoffInput in selecting_model sends the handoff even without a model argument', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.confirmHandoff();
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: '/model ' } as any);
  });
  await flush();

  expect(deps.settingsService.set).not.toHaveBeenCalled();
  expect(deps.setModel).not.toHaveBeenCalled();
  expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });
  expect(deps.sendUserMessage).toHaveBeenCalledTimes(1);

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('when in plan mode, declineHandoff transitions to confirm_standard_mode stage', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();
  deps.settingsService.get.mockImplementation((key: string) => {
    if (key === 'app.planMode') return true;
    return undefined;
  });

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.declineHandoff();
  });
  await flush();

  expect(deps.clearConversationAndRefreshBanner).toHaveBeenCalledTimes(1);
  expect(deps.sendUserMessage).not.toHaveBeenCalled();
  expect(getSnapshot().handoffState?.stage).toBe('confirm_standard_mode');

  // Test confirmStandardMode
  await act(async () => {
    await getSnapshot().hook.confirmStandardMode();
  });
  await flush();

  expect(deps.settingsService.set).toHaveBeenCalledWith('app.planMode', false);
  expect(deps.applyRuntimeSetting).toHaveBeenCalledWith('app.planMode', false);
  expect(deps.addSystemMessage).toHaveBeenCalledWith('Plan mode disabled - switched to Standard mode');
  expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });
  expect(getSnapshot().handoffState).toBeNull();

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('when in plan mode, confirmStandardMode disables plan mode and sends handoff', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();
  deps.settingsService.get.mockImplementation((key: string) => {
    if (key === 'app.planMode') return true;
    return undefined;
  });

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.declineHandoff();
  });
  await flush();

  // Test declineStandardMode (keeps plan mode enabled but sends)
  deps.settingsService.set.mockClear();
  deps.applyRuntimeSetting.mockClear();
  deps.addSystemMessage.mockClear();

  await act(async () => {
    await getSnapshot().hook.declineStandardMode();
  });
  await flush();

  expect(deps.settingsService.set).not.toHaveBeenCalled();
  expect(deps.applyRuntimeSetting).not.toHaveBeenCalled();
  expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });
  expect(getSnapshot().handoffState).toBeNull();

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential(
  'when in plan mode, selecting model transitions to confirm_standard_mode instead of sending',
  async () => {
    const { deps, getSnapshot, renderer } = await renderHarness();
    deps.settingsService.get.mockImplementation((key: string) => {
      if (key === 'app.planMode') return true;
      return undefined;
    });

    await act(async () => {
      getSnapshot().hook.startHandoff('Captured text');
    });
    await flush();

    await act(async () => {
      await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
    });
    await flush();

    await act(async () => {
      await getSnapshot().hook.confirmHandoff();
    });
    await flush();

    await act(async () => {
      await getSnapshot().hook.submitHandoffInput({ text: '/model gpt-4' } as any);
    });
    await flush();

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(getSnapshot().handoffState?.stage).toBe('confirm_standard_mode');

    await act(async () => {
      renderer.unmount();
    });
  },
);

it.sequential(
  'when in plan mode, cancelling model selection transitions to confirm_standard_mode instead of sending',
  async () => {
    const { deps, getSnapshot, renderer } = await renderHarness();
    deps.settingsService.get.mockImplementation((key: string) => {
      if (key === 'app.planMode') return true;
      return undefined;
    });

    await act(async () => {
      getSnapshot().hook.startHandoff('Captured text');
    });
    await flush();

    await act(async () => {
      await getSnapshot().hook.submitHandoffInput({ text: 'Implement this' } as any);
    });
    await flush();

    await act(async () => {
      await getSnapshot().hook.confirmHandoff();
    });
    await flush();

    await act(async () => {
      getSnapshot().setMode('text');
    });
    await flush();

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(getSnapshot().handoffState?.stage).toBe('confirm_standard_mode');

    await act(async () => {
      renderer.unmount();
    });
  },
);
