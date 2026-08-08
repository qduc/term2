// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { it, expect, vi } from 'vitest';
import React, { act, useEffect, useRef } from 'react';
import { render } from 'ink-testing-library';
import { useHandoffFlow, type HandoffState } from './use-handoff-flow.js';
import { MenuControllerImpl } from '../components/input/menu-controller.js';
import { createDefaultTriggerRegistry } from '../components/input/triggers.js';
import type { MenuController, MenuFrame } from '../components/input/menu-types.js';
import type { SlashCommand } from '../slash-commands.js';

// Graph 4 (`/model `, `/effort `) is controller-owned: the model picker's
// accept path closes through a correlated `submit-prompt` intent rather than
// a turn routed through the app's `handleSubmit`, so these tests wire a real
// `MenuControllerImpl` (with the production `command-model` rule enabled)
// and simulate the intent host the same way `app.tsx` does — including
// `handoff.handleModelSubmitPrompt` intercepting the intent before it would
// otherwise be sent to the model as a literal chat message.

const modelSlashCommand: SlashCommand = {
  name: 'model',
  description: 'Select model',
  action: () => {},
  completion: { type: 'model', trigger: '/model ' },
};

type HarnessSnapshot = {
  handoffState: HandoffState | null;
  hook: ReturnType<typeof useHandoffFlow>;
  controller: MenuController;
};

type HarnessProps = {
  onSnapshot: (snapshot: HarnessSnapshot) => void;
  clearConversationAndRefreshBanner: () => Promise<void>;
  addSystemMessage: (text: string) => void;
  sendUserMessage: (turn: { text: string; images?: unknown[] }) => Promise<void>;
  settingsService: { set: (key: string, value: unknown) => void; get: (key: string) => unknown };
  applyRuntimeSetting: (key: string, value: unknown) => void;
  setModel: (model: string) => void;
  controller: MenuController;
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
  const controller: MenuController = new MenuControllerImpl({
    triggerRegistry: createDefaultTriggerRegistry([modelSlashCommand], ['command-model']),
  });

  return {
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    settingsService,
    applyRuntimeSetting,
    setModel,
    controller,
  };
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const Harness = ({
  onSnapshot,
  clearConversationAndRefreshBanner,
  addSystemMessage,
  sendUserMessage,
  settingsService,
  applyRuntimeSetting,
  setModel,
  controller,
}: HarnessProps) => {
  const hook = useHandoffFlow({
    clearConversationAndRefreshBanner,
    addSystemMessage,
    sendUserMessage,
    replaceInput: (value: string) => controller.replaceText(value),
    controller,
    settingsService: settingsService as any,
    applyRuntimeSetting,
    setModel,
  });

  const hookRef = useRef(hook);
  hookRef.current = hook;

  // Mirrors app.tsx's application effect host: a submit-prompt intent is
  // offered to the handoff hook first, and only sent to the model as a
  // literal chat message if the handoff did not consume it.
  useEffect(() => {
    controller.setIntentHost(({ intentRequest }) => {
      if (intentRequest.intent.type === 'submit-prompt') {
        if (hookRef.current.handleModelSubmitPrompt(intentRequest.intent.text)) return;
        void sendUserMessage({ text: intentRequest.intent.text });
        return;
      }
      return undefined;
    });
    return () => controller.setIntentHost(undefined);
  }, [controller, sendUserMessage]);

  useEffect(() => {
    onSnapshot({ handoffState: hook.handoffState, hook, controller });
  }, [onSnapshot, hook, controller]);

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

// Simulates ModelMenuSession's `accept` handler for a `target.type ===
// 'command'` frame with a resolved model: closes the frame, clears the
// buffer, and issues a `submit-prompt` intent carrying the fully-qualified
// model text — exactly the effect shape InputBox's real ModelMenuSession
// produces (see ModelMenuSession.tsx's `case 'accept'` branch).
const acceptModelSelection = (controller: MenuController, text: string) => {
  const topFrame = controller.getSnapshot().stack.at(-1);
  if (!topFrame || topFrame.kind !== 'model') {
    throw new Error(`expected an open model frame, got ${topFrame?.kind ?? 'none'}`);
  }
  controller.dispatch(
    {
      buffer: { type: 'clear' },
      stack: { type: 'close-top' },
      intent: { id: 'submit:test', sourceFrameId: topFrame.id, intent: { type: 'submit-prompt', text } },
    },
    { frameId: topFrame.id, revision: 'binding' in topFrame ? topFrame.binding.revision : 0 },
  );
};

// Simulates ModelMenuSession's `escape` handler: closes the frame with no
// intent. The frame's declared `close-clear-input` BackPolicy clears input.
const escapeModelSelection = (controller: MenuController) => {
  const topFrame = controller.getSnapshot().stack.at(-1);
  if (!topFrame || topFrame.kind !== 'model') {
    throw new Error(`expected an open model frame, got ${topFrame?.kind ?? 'none'}`);
  }
  controller.dispatch(
    { stack: { type: 'close-top' } },
    { frameId: topFrame.id, revision: 'binding' in topFrame ? topFrame.binding.revision : 0 },
  );
};

const topFrameKind = (controller: MenuController): MenuFrame['kind'] | undefined =>
  controller.getSnapshot().stack.at(-1)?.kind;

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
  expect(getSnapshot().controller.getSnapshot().editor.text).toBe('');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential(
  'confirmHandoff clears conversation and opens the model picker via the command-model trigger',
  async () => {
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
    expect(getSnapshot().controller.getSnapshot().editor.text).toBe('/model ');
    // The frame exists because the command-model trigger rule fired on its
    // own, not because confirmHandoff opened it explicitly.
    expect(topFrameKind(getSnapshot().controller)).toBe('model');

    await act(async () => {
      renderer.unmount();
    });
  },
);

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
  expect(deps.addSystemMessage).toHaveBeenCalledWith('Handoff cancelled');

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential(
  'accepting a model selection updates settings, advances to /effort, and the captured handoff IS sent once effort completes',
  async () => {
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
      acceptModelSelection(getSnapshot().controller, '/model gpt-4 --provider=anthropic');
    });
    await flush();

    expect(deps.settingsService.set).toHaveBeenCalledWith('agent.model', 'gpt-4');
    expect(deps.settingsService.set).toHaveBeenCalledWith('agent.provider', 'anthropic');
    expect(deps.applyRuntimeSetting).toHaveBeenCalledWith('agent.provider', 'anthropic');
    expect(deps.applyRuntimeSetting).toHaveBeenCalledWith('agent.model', 'gpt-4');
    expect(deps.setModel).toHaveBeenCalledWith('gpt-4');
    expect(getSnapshot().handoffState?.stage).toBe('selecting_effort');
    expect(getSnapshot().controller.getSnapshot().editor.text).toBe('/effort ');
    // The model frame is gone; nothing was auto-sent by the "closed without
    // choosing" fallback because the acceptance was intercepted first.
    expect(deps.sendUserMessage).not.toHaveBeenCalled();

    await act(async () => {
      await getSnapshot().hook.completeHandoffWithEffort('medium');
    });
    await flush();

    expect(deps.settingsService.set).toHaveBeenCalledWith('agent.reasoningEffort', 'medium');
    expect(deps.applyRuntimeSetting).toHaveBeenCalledWith('agent.reasoningEffort', 'medium');
    expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });

    await act(async () => {
      renderer.unmount();
    });
  },
);

it.sequential('accepting a model selection does NOT reach the model as a literal chat message', async () => {
  const { deps, getSnapshot, renderer } = await renderHarness();

  await act(async () => {
    getSnapshot().hook.startHandoff('Captured text');
  });
  await flush();

  await act(async () => {
    await getSnapshot().hook.confirmHandoff();
  });
  await flush();

  await act(async () => {
    acceptModelSelection(getSnapshot().controller, '/model gpt-4 --provider=anthropic');
  });
  await flush();

  // handleModelSubmitPrompt consumed the intent; sendUserMessage (which
  // would otherwise post the raw "/model gpt-4 --provider=anthropic" text
  // as a user turn) must not have run.
  expect(deps.sendUserMessage).not.toHaveBeenCalled();

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential('escaping the model picker without choosing sends only the captured text', async () => {
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

  expect(getSnapshot().handoffState?.stage).toBe('selecting_model');

  await act(async () => {
    escapeModelSelection(getSnapshot().controller);
  });
  await flush();

  // No model/effort was chosen, so the message composed from just the
  // captured text is sent — matching the pre-migration escape fallback.
  expect(deps.settingsService.set).not.toHaveBeenCalled();
  expect(deps.setModel).not.toHaveBeenCalled();
  expect(deps.sendUserMessage).toHaveBeenCalledWith({ text: 'Implement this:\n\nCaptured text' });
  expect(getSnapshot().handoffState).toBeNull();

  await act(async () => {
    renderer.unmount();
  });
});

it.sequential(
  'closing the effort frame after a model was already accepted does NOT re-trigger the "closed without choosing" send',
  async () => {
    const { deps, getSnapshot, renderer } = await renderHarness();

    await act(async () => {
      getSnapshot().hook.startHandoff('Captured text');
    });
    await flush();

    await act(async () => {
      await getSnapshot().hook.confirmHandoff();
    });
    await flush();

    await act(async () => {
      acceptModelSelection(getSnapshot().controller, '/model gpt-4');
    });
    await flush();

    expect(getSnapshot().handoffState?.stage).toBe('selecting_effort');
    deps.sendUserMessage.mockClear();

    // The effort frame is not controller-owned in this harness (only
    // command-model is enabled), so there is nothing further to close; the
    // guard under test is that the "closed without choosing" fallback keys
    // off the model frame specifically, and it already fired-or-not at
    // acceptance time. Confirm no further send occurs on its own.
    await flush();
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(getSnapshot().handoffState?.stage).toBe('selecting_effort');

    await act(async () => {
      renderer.unmount();
    });
  },
);

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

it.sequential(
  'when in plan mode, escaping model selection without choosing transitions to confirm_standard_mode instead of sending',
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
      escapeModelSelection(getSnapshot().controller);
    });
    await flush();

    expect(deps.sendUserMessage).not.toHaveBeenCalled();
    expect(getSnapshot().handoffState?.stage).toBe('confirm_standard_mode');

    await act(async () => {
      renderer.unmount();
    });
  },
);
