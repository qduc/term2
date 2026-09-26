import { describe, expect, it, vi } from 'vitest';
import { getModelContextWindow } from '../../providers/model-catalog/catalog.js';
import { isSecretSetting } from '../settings/settings-ui-metadata.js';
import { createControlSessionPort } from './control-session-port.js';

describe('control session port', () => {
  it('refuses large-input confirmation without calling the orchestrator', async () => {
    const sendUserMessage = vi.fn();
    const conversationService = {
      previewLargeUncachedInput: () => ({ action: 'confirm' }),
      previewInputSurge: () => ({ action: 'allow' }),
    } as any;
    const port = createControlSessionPort({
      conversationService,
      orchestrator: { sendUserMessage } as any,
      settingsService: { get: () => null } as any,
      usageAccumulator: { get: () => ({}) } as any,
      controlSocket: { name: 'worker', startedAt: '' } as any,
      sessionMetadata: () => ({ workspaceRoot: null, version: '', createdAt: '', logPath: '' }),
    });
    await expect(port.submit?.({ text: 'brief', clientRequestId: 'id' })).resolves.toEqual({
      delivery: 'rejected',
      reason: 'needs_confirmation',
    });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('returns an accepted receipt at admission while the turn is still running', async () => {
    let finishTurn!: () => void;
    const turn = new Promise<void>((resolve) => (finishTurn = resolve));
    const addSystemMessage = vi.fn();
    const sendUserMessage = vi.fn((_text, options) => {
      options.onAdmitted('message-1', 'started');
      return turn;
    });
    const port = createControlSessionPort({
      conversationService: {
        previewLargeUncachedInput: () => ({ action: 'allow' }),
        previewInputSurge: () => ({ action: 'allow' }),
      } as any,
      orchestrator: { sendUserMessage } as any,
      settingsService: { get: () => null } as any,
      usageAccumulator: { get: () => ({}) } as any,
      controlSocket: { name: 'worker', startedAt: '' } as any,
      sessionMetadata: () => ({ workspaceRoot: null, version: '', createdAt: '', logPath: '' }),
      addSystemMessage,
    });
    await expect(port.submit?.({ text: 'brief', clientRequestId: 'id' })).resolves.toEqual({
      messageId: 'message-1',
      delivery: 'started',
    });
    expect(addSystemMessage).toHaveBeenCalledWith('Control submit message-1');
    finishTurn();
  });

  it('projects the documented read sources and never returns a schema-secret setting', () => {
    const secret = 'schema-secret-fixture';
    expect(isSecretSetting('agent.openai.apiKey')).toBe(true);
    const settings = {
      get: vi.fn((key: string) => {
        const values: Record<string, unknown> = {
          'agent.provider': 'openai',
          'agent.model': 'gpt-4o',
          'agent.reasoningEffort': 'high',
          'shell.autoApproveMode': 'ask',
          'app.activeProfileId': 'builtin:standard',
          'agent.openai.apiKey': secret,
        };
        return values[key];
      }),
    };
    const pendingSnapshot = {
      interactionId: 41,
      revision: 2,
      currentAskUserQuestionIndex: 0,
      askUserAnswers: [],
      approval: {
        toolName: 'ask_user',
        callId: 'call-1',
        checkIn: false,
        argumentsText: JSON.stringify({
          questions: [
            {
              question: 'Choose one?',
              options: [{ label: 'Alpha'.repeat(30) }, { label: 'Beta' }],
              is_multi_select: true,
            },
            { question: 'Text response?' },
          ],
        }),
      },
    };
    const conversationService = {
      sessionId: 'session-id',
      sessionStartedAt: '2026-09-26T00:00:00.000Z',
      getPendingInteractionSnapshot: () => pendingSnapshot,
      getNestedApprovalSnapshot: () => null,
      isQueueOwningSubmissions: () => true,
      isQueueActive: () => false,
      queueStateKind: () => 'awaiting_preflight',
      getUnsettledToolExecutions: () => [{ callId: 'tool-1', toolName: 'shell', status: 'started' }],
      backgroundTaskControl: {
        listDetails: () => [
          { kind: 'shell', id: 'bg-1', status: 'running', startedAt: 12, command: 'echo safe', output: secret },
        ],
      },
    } as any;
    const orchestrator = {
      isTurnActive: () => false,
      listOutstandingSubmissions: () => [{ id: 'queued-id', text: 'x'.repeat(700), stage: 'queued' }],
      getCostSummary: () => ({ state: 'exact', knownUsdMicros: 123 }),
    } as any;
    const usageAccumulator = {
      get: () => ({ prompt_tokens: 5, completion_tokens: 7, cache_read_tokens: 2, cache_creation_tokens: 1 }),
    } as any;
    const port = createControlSessionPort({
      conversationService,
      orchestrator,
      settingsService: settings as any,
      usageAccumulator,
      controlSocket: { name: 'worker', startedAt: 'kernel-token' } as any,
      sessionMetadata: () => ({
        workspaceRoot: '/workspace',
        version: '0.27.0',
        createdAt: 'created',
        logPath: '/logs/session-id.jsonl',
      }),
    });

    expect(port.status()).toMatchObject({
      phase: 'awaiting_approval',
      waitKind: 'question',
      queueStateKind: 'awaiting_preflight',
      queue: [{ id: 'queued-id', text: 'x'.repeat(500), stage: 'queued' }],
      currentTool: { callId: 'tool-1', toolName: 'shell', status: 'started' },
      context: { contextWindow: getModelContextWindow('openai', 'gpt-4o'), promptTokens: null },
    });
    expect(port.get('session')).toEqual({
      sessionId: 'session-id',
      socketName: 'worker',
      pid: expect.any(Number),
      host: expect.any(String),
      cwd: process.cwd(),
      workspaceRoot: '/workspace',
      version: '0.27.0',
      createdAt: 'created',
      startedAt: 'kernel-token',
      logPath: '/logs/session-id.jsonl',
      profileId: 'builtin:standard',
    });
    expect(port.get('model')).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
      reasoningEffort: 'high',
      autoApproveMode: 'ask',
    });
    expect(port.get('usage')).toMatchObject({
      cumulative: { prompt_tokens: 5, completion_tokens: 7, cache_read_tokens: 2, cache_creation_tokens: 1 },
      contextWindow: getModelContextWindow('openai', 'gpt-4o'),
      lastRequest: null,
    });
    expect(port.get('pending')).toMatchObject({
      foreground: {
        interactionId: 41,
        currentAskUserQuestionIndex: 0,
        questions: [
          {
            question: 'Choose one?',
            options: [{ label: 'Alpha'.repeat(30).slice(0, 80) }, { label: 'Beta' }],
            is_multi_select: true,
          },
          { question: 'Text response?', options: [], is_multi_select: false },
        ],
      },
      nested: null,
    });
    expect(port.get('tools')).toEqual({ calls: [{ callId: 'tool-1', toolName: 'shell', status: 'started' }] });
    expect(port.get('background')).toEqual({
      tasks: [{ kind: 'shell', id: 'bg-1', status: 'running', startedAt: 12, labelExcerpt: 'echo safe' }],
    });
    expect(
      JSON.stringify([
        port.status(),
        ...(['session', 'model', 'usage', 'pending', 'tools', 'background'] as const).map((topic) => port.get(topic)),
      ]),
    ).not.toContain(secret);
    expect(settings.get).not.toHaveBeenCalledWith('agent.openai.apiKey');
  });
});
