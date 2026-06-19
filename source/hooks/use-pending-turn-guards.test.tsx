// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { usePendingTurnGuards, type UsePendingTurnGuardsOptions } from './use-pending-turn-guards.js';
import type { UserTurn } from '../types/user-turn.js';

type HookResult = ReturnType<typeof usePendingTurnGuards>;

const baseTurn: UserTurn = { text: 'Describe the change', images: [] };

const allowSurgeDecision = {
  action: 'allow' as const,
  stats: {
    messageCount: 1,
    totalSerializedBytes: 16,
    duplicateToolCallSignatures: 0,
    maxDuplicateToolCallSignatureCount: 0,
  },
};

const allowLargeDecision = {
  action: 'allow' as const,
  warningKey: 'allow',
  reasons: [] as const,
  estimatedTokens: 8,
  estimatedBytes: 32,
};

const warnLargeDecision = {
  action: 'warn' as const,
  warningKey: 'warn',
  reasons: ['idle_timeout'] as const,
  estimatedTokens: 12_345,
  estimatedBytes: 49_380,
};

const createLoggingService = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  security: vi.fn(),
  setCorrelationId: vi.fn(),
  clearCorrelationId: vi.fn(),
});

const createOptions = (overrides: Partial<UsePendingTurnGuardsOptions> = {}): UsePendingTurnGuardsOptions => {
  const conversationService = {
    previewInputSurge: vi.fn(() => allowSurgeDecision),
    previewLargeUncachedInput: vi.fn(() => allowLargeDecision),
  } as any;
  const historyService = {
    addMessage: vi.fn(),
  } as any;
  const loggingService = createLoggingService() as any;
  const sendUserMessage = vi.fn(async () => {});
  const setInput = vi.fn();
  const setImages = vi.fn();

  return {
    input: 'Describe the change',
    mode: 'text',
    images: [],
    conversationService,
    historyService,
    loggingService,
    sendUserMessage,
    setInput,
    setImages,
    ...overrides,
  };
};

const renderHook = async (options: UsePendingTurnGuardsOptions) => {
  let hook: HookResult | undefined;
  let renderer: ReturnType<typeof render> | undefined;

  const Harness = ({ onHookResult }: { onHookResult: (value: HookResult) => void }) => {
    const value = usePendingTurnGuards(options);
    onHookResult(value);
    return null;
  };

  await act(async () => {
    renderer = render(<Harness onHookResult={(value) => (hook = value)} />);
    await Promise.resolve();
    await Promise.resolve();
  });

  if (!hook) {
    throw new Error('Expected hook result');
  }

  return {
    hook,
    renderer: renderer!,
    getHook: () => hook!,
  };
};

const flushMicrotasks = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

it.sequential('sendGuardedTurn sends a ready turn after adding it to history and clearing input', async () => {
  const options = createOptions();
  const { hook, renderer } = await renderHook(options);
  const turn = { text: 'Ship the refactor', images: [] };

  let result: boolean | undefined;
  await act(async () => {
    result = await hook.sendGuardedTurn(turn);
  });

  expect(result).toBe(true);
  expect(options.conversationService.previewInputSurge).toHaveBeenCalledWith(turn);
  expect(options.conversationService.previewLargeUncachedInput).toHaveBeenCalledWith(turn, expect.any(Number));
  expect(options.historyService.addMessage).toHaveBeenCalledWith(turn);
  expect(options.setInput).toHaveBeenCalledWith('');
  expect(options.sendUserMessage).toHaveBeenCalledWith(turn);
  expect(options.loggingService.debug).not.toHaveBeenCalledWith('Input surge warning shown', expect.anything());

  act(() => {
    renderer.unmount();
  });
});

it.sequential('sendGuardedTurn stores a pending surge turn and logs when surge preview blocks', async () => {
  const options = createOptions({
    input: '',
    mode: 'plan',
    conversationService: {
      previewInputSurge: vi.fn(() => ({
        action: 'block' as const,
        reason: 'Too many repeated tool calls',
        stats: {
          messageCount: 9,
          totalSerializedBytes: 900,
          duplicateToolCallSignatures: 4,
          maxDuplicateToolCallSignatureCount: 6,
        },
        previousStats: {
          messageCount: 8,
          totalSerializedBytes: 700,
          duplicateToolCallSignatures: 3,
          maxDuplicateToolCallSignatureCount: 5,
        },
      })),
      previewLargeUncachedInput: vi.fn(() => allowLargeDecision),
    } as any,
  });
  const { hook, getHook, renderer } = await renderHook(options);

  let result: boolean | undefined;
  await act(async () => {
    result = await hook.sendGuardedTurn(baseTurn);
  });

  expect(result).toBe(false);
  expect(options.conversationService.previewInputSurge).toHaveBeenCalledTimes(1);
  expect(options.conversationService.previewLargeUncachedInput).not.toHaveBeenCalled();
  expect(getHook().pendingSurgeTurn).toEqual(baseTurn);
  expect(getHook().pendingSurgeReason).toBe('Too many repeated tool calls');
  expect(options.loggingService.debug).toHaveBeenCalledWith(
    'Input surge warning shown',
    expect.objectContaining({
      eventType: 'input_surge_warning_shown',
      category: 'provider',
      reason: 'Too many repeated tool calls',
    }),
  );
  expect(options.historyService.addMessage).not.toHaveBeenCalled();
  expect(options.sendUserMessage).not.toHaveBeenCalled();

  act(() => {
    renderer.unmount();
  });
});

it.sequential(
  'sendGuardedTurn stores a pending large uncached turn and logs when large uncached preview warns',
  async () => {
    const options = createOptions({
      input: '',
      mode: 'plan',
      conversationService: {
        previewInputSurge: vi.fn(() => allowSurgeDecision),
        previewLargeUncachedInput: vi.fn(() => warnLargeDecision),
      } as any,
    });
    const { hook, getHook, renderer } = await renderHook(options);
    const turn = { text: 'A very large prompt', images: [] };

    let result: boolean | undefined;
    await act(async () => {
      result = await hook.sendGuardedTurn(turn);
    });

    expect(result).toBe(false);
    expect(options.conversationService.previewInputSurge).toHaveBeenCalledWith(turn);
    expect(options.conversationService.previewLargeUncachedInput).toHaveBeenCalledWith(turn, expect.any(Number));
    expect(getHook().pendingLargeUncachedTurn).toEqual(turn);
    expect(getHook().pendingLargeUncachedTokens).toBeGreaterThan(0);
    expect(options.loggingService.debug).toHaveBeenCalledWith(
      'Large uncached input warning shown',
      expect.objectContaining({
        eventType: 'large_uncached_input_warning_shown',
        category: 'provider',
        estimatedTokens: warnLargeDecision.estimatedTokens,
        estimatedBytes: warnLargeDecision.estimatedBytes,
      }),
    );
    expect(options.historyService.addMessage).not.toHaveBeenCalled();
    expect(options.sendUserMessage).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  },
);

it.sequential(
  'large uncached decline restores the original input on a microtask and clears pending state',
  async () => {
    const options = createOptions({
      input: '',
      mode: 'plan',
      conversationService: {
        previewInputSurge: vi.fn(() => allowSurgeDecision),
        previewLargeUncachedInput: vi.fn(() => warnLargeDecision),
      } as any,
    });
    const { hook, getHook, renderer } = await renderHook(options);

    await act(async () => {
      await hook.sendGuardedTurn(baseTurn);
    });
    expect(getHook().pendingLargeUncachedTurn).toEqual(baseTurn);

    const pendingHook = getHook();
    await act(async () => {
      pendingHook.handleLargeUncachedDecline();
      await Promise.resolve();
      await Promise.resolve();
    });

    await flushMicrotasks();

    expect(getHook().pendingLargeUncachedTurn).toBe(null);
    expect(getHook().pendingLargeUncachedTokens).toBe(0);
    expect(options.setInput).toHaveBeenLastCalledWith(baseTurn.text);

    act(() => {
      renderer.unmount();
    });
  },
);

it.sequential('surge approve clears pending state and sends the turn with the surge guard bypassed', async () => {
  const options = createOptions({
    input: '',
    mode: 'plan',
    conversationService: {
      previewInputSurge: vi.fn(() => ({
        action: 'block' as const,
        reason: 'Too many repeated tool calls',
        stats: {
          messageCount: 9,
          totalSerializedBytes: 900,
          duplicateToolCallSignatures: 4,
          maxDuplicateToolCallSignatureCount: 6,
        },
      })),
      previewLargeUncachedInput: vi.fn(() => allowLargeDecision),
    } as any,
  });
  const { hook, getHook, renderer } = await renderHook(options);

  await act(async () => {
    await hook.sendGuardedTurn(baseTurn);
  });

  const pendingHook = getHook();
  await act(async () => {
    await pendingHook.handleSurgeApprove();
  });

  await flushMicrotasks();

  expect(getHook().pendingSurgeTurn).toBe(null);
  expect(getHook().pendingSurgeReason).toBe('');
  expect(options.setImages).toHaveBeenCalledWith([]);
  expect(options.historyService.addMessage).toHaveBeenLastCalledWith(baseTurn);
  expect(options.setInput).toHaveBeenLastCalledWith('');
  expect(options.sendUserMessage).toHaveBeenLastCalledWith(baseTurn, { bypassInputSurgeGuard: true });

  act(() => {
    renderer.unmount();
  });
});

it.sequential('large uncached approve clears pending state and sends the original turn', async () => {
  const options = createOptions({
    input: '',
    mode: 'plan',
    conversationService: {
      previewInputSurge: vi.fn(() => allowSurgeDecision),
      previewLargeUncachedInput: vi.fn(() => warnLargeDecision),
    } as any,
  });
  const { hook, getHook, renderer } = await renderHook(options);

  await act(async () => {
    await hook.sendGuardedTurn(baseTurn);
  });

  const pendingHook = getHook();
  await act(async () => {
    await pendingHook.handleLargeUncachedApprove();
  });

  await flushMicrotasks();

  expect(getHook().pendingLargeUncachedTurn).toBe(null);
  expect(getHook().pendingLargeUncachedTokens).toBe(0);
  expect(options.setImages).toHaveBeenCalledWith([]);
  expect(options.historyService.addMessage).toHaveBeenLastCalledWith(baseTurn);
  expect(options.setInput).toHaveBeenLastCalledWith('');
  expect(options.sendUserMessage).toHaveBeenLastCalledWith(baseTurn);

  act(() => {
    renderer.unmount();
  });
});

it.sequential('live warning only appears for plain text in text mode', async () => {
  const textModeOptions = createOptions({
    input: 'A cache-heavy prompt',
    mode: 'text',
    images: [],
    conversationService: {
      previewInputSurge: vi.fn(() => allowSurgeDecision),
      previewLargeUncachedInput: vi.fn(() => warnLargeDecision),
    } as any,
  });
  const slashModeOptions = createOptions({
    input: '/model ',
    mode: 'text',
    images: [],
  });
  const planModeOptions = createOptions({
    input: 'A cache-heavy prompt',
    mode: 'plan',
    images: [],
  });

  const { hook: textHook, renderer: textRenderer } = await renderHook(textModeOptions);
  const { hook: slashHook, renderer: slashRenderer } = await renderHook(slashModeOptions);
  const { hook: planHook, renderer: planRenderer } = await renderHook(planModeOptions);

  expect(textHook.largeUncachedWarning).not.toBe(null);
  expect(slashHook.largeUncachedWarning).toBe(null);
  expect(planHook.largeUncachedWarning).toBe(null);

  act(() => {
    textRenderer.unmount();
    slashRenderer.unmount();
    planRenderer.unmount();
  });
});
