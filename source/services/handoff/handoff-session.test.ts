import { expect, it, vi } from 'vitest';
import { HandoffSession } from './handoff-session.js';

const makeSession = (overrides: Record<string, unknown> = {}) => {
  const settingsService = { get: vi.fn(() => false), set: vi.fn(), ...overrides } as any;
  const session = new HandoffSession({
    clearConversationAndRefreshBanner: vi.fn(async () => {}),
    addSystemMessage: vi.fn(),
    sendUserMessage: vi.fn(async () => {}),
    settingsService,
    applyRuntimeSetting: vi.fn(),
    setModel: vi.fn(),
    queueModeNotice: vi.fn(),
  });
  return { session, settingsService };
};

it('owns the handoff state transitions and composes the captured message', async () => {
  const { session } = makeSession();

  session.startHandoff('captured');
  expect(session.getState()).toEqual({ capturedText: 'captured', stage: 'entering_message' });
  expect(session.captureMessage('  ship it  ')).toBe(true);
  expect(session.getState()).toEqual({
    capturedText: 'captured',
    handoffMessage: 'ship it',
    stage: 'confirm_model',
  });

  await session.confirmHandoff();
  expect(session.getState()?.stage).toBe('selecting_model');
});

it('applies the selected model and provider as one policy operation', async () => {
  const { session, settingsService } = makeSession();
  session.startHandoff('captured');
  session.captureMessage('ship it');
  await session.confirmHandoff();

  expect(session.selectModel('/model gpt-4 --provider=anthropic')).toBe(true);
  expect(settingsService.set).toHaveBeenCalledWith('agent.model', 'gpt-4');
  expect(settingsService.set).toHaveBeenCalledWith('agent.provider', 'anthropic');
  expect(session.getState()?.stage).toBe('selecting_effort');
});

it('sends the captured handoff after effort selection and clears its state', async () => {
  const { session } = makeSession();
  session.startHandoff('captured');
  session.captureMessage('ship it');
  await session.confirmHandoff();
  session.selectModel('gpt-4');

  await session.completeHandoffWithEffort('high');

  expect(session.getState()).toBeNull();
});

it('updates dependencies while preserving current handoff state', () => {
  const { session } = makeSession();
  session.startHandoff('captured');
  expect(session.getState()).toEqual({ capturedText: 'captured', stage: 'entering_message' });

  const newAddSystemMessage = vi.fn();
  session.updateDeps({
    clearConversationAndRefreshBanner: vi.fn(async () => {}),
    addSystemMessage: newAddSystemMessage,
    sendUserMessage: vi.fn(async () => {}),
    settingsService: { get: vi.fn(() => false), set: vi.fn() } as any,
    applyRuntimeSetting: vi.fn(),
    setModel: vi.fn(),
    queueModeNotice: vi.fn(),
  });

  expect(session.getState()).toEqual({ capturedText: 'captured', stage: 'entering_message' });
  expect(session.captureMessage('ship it')).toBe(true);
  expect(session.getState()?.handoffMessage).toBe('ship it');
});
