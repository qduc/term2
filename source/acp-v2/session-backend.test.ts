import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAcpV2SessionBackend, mapAcpPermissionChoices } from './session-backend.js';
import { createConversationLogWriter, LockConflictError } from '../services/logging/conversation-log-writer.js';

const makeRuntime = (session: any) => ({
  create: vi.fn(async (_binding: unknown, options: any) => {
    session.eventSink = options.eventSink;
    return session;
  }),
});

const noopWriterFactory = () => ({
  init: () => {},
  append: () => {},
  rotate: () => {},
  flush: async () => {},
  close: async () => {},
});

const makeSession = (sessionId = 'session-1'): any => ({
  sessionId,
  binding: { canonicalRoot: '/tmp' },
  settings: { modelId: 'test-model', providerId: 'test-provider' },
  service: {
    setLogSink: vi.fn(),
    getPendingInteractionSnapshot: () => undefined,
    handleApprovalDecision: vi.fn(async () => null),
  },
  resources: { runtime: undefined },
  prepareMessage: vi.fn(async () => ({ kind: 'prepared', leaseId: 'lease-1', turnId: 'turn-1' })),
  commitMessage: vi.fn(async () => {}),
  abort: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
});

describe('ACP v2 production session backend', () => {
  it('offers only explicitly supported ACP permission choices', () => {
    expect(
      mapAcpPermissionChoices([
        { id: 'allow-once', label: 'Allow once' },
        { id: 'allow-folder-session', label: 'Allow folder for session' },
        { id: 'allow-remember', label: 'Allow and remember' },
        { id: 'unsandboxed-once', label: 'Run unsandboxed once' },
        { id: 'reject', label: 'Reject' },
        { id: 'future-choice', label: 'Future choice' },
      ]),
    ).toEqual([
      {
        choice: { id: 'allow-once', label: 'Allow once' },
        option: { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      },
      {
        choice: { id: 'allow-folder-session', label: 'Allow folder for session' },
        option: { optionId: 'allow-folder-session', name: 'Allow folder for session', kind: 'allow_always' },
      },
      {
        choice: { id: 'reject', label: 'Reject' },
        option: { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      },
    ]);
  });

  it('rejects relative, missing, and non-directory cwd values', async () => {
    const session = makeSession();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      writerFactory: noopWriterFactory as any,
    });
    await expect(backend.createSession({ cwd: 'relative' })).rejects.toMatchObject({ code: -32602 });
    await expect(backend.createSession({ cwd: '/definitely/missing' })).rejects.toMatchObject({ code: -32602 });
    const file = mkdtempSync('/tmp/acp-backend-');
    try {
      await expect(backend.createSession({ cwd: path.join(file, 'not-created') })).rejects.toMatchObject({
        code: -32602,
      });
    } finally {
      rmSync(file, { recursive: true, force: true });
    }
  });

  it('converts text and resource prompt blocks and rejects unsupported blocks', async () => {
    const session = makeSession();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      writerFactory: noopWriterFactory as any,
    });
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await backend.createSession({ cwd });
      await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [
          { type: 'text', text: 'hello' },
          { type: 'resource_link', name: 'readme', uri: 'file:///tmp/readme' },
        ],
      });
      expect(session.prepareMessage).toHaveBeenCalledWith(
        { text: 'hello\n[Resource: file:///tmp/readme]' },
        expect.any(Object),
      );
      await expect(
        backend.preparePrompt({
          sessionId: 'session-1',
          prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }] as any,
        }),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('maps runtime text, reasoning, and tool events with bounded payloads', async () => {
    const session = makeSession();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      writerFactory: noopWriterFactory as any,
    });
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await backend.createSession({ cwd });
      const execution = await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'run' }],
      });
      const updates: unknown[] = [];
      const run = execution.run(async (update) => {
        updates.push(update);
      }, new AbortController().signal);
      await vi.waitFor(() => expect(session.commitMessage).toHaveBeenCalled());
      await session.eventSink({ type: 'text_delta', delta: 'answer' });
      await session.eventSink({ type: 'reasoning_delta', delta: 'private' });
      await session.eventSink({
        type: 'tool_started',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        arguments: { path: '/tmp/a' },
      });
      await session.eventSink({ type: 'final', finalText: '' });
      await expect(run).resolves.toEqual({ stopReason: 'end_turn' });
      expect(updates).toEqual([
        expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
        expect.objectContaining({ sessionUpdate: 'agent_thought_chunk' }),
        expect.objectContaining({ sessionUpdate: 'tool_call' }),
      ]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not duplicate assistant text when final repeats streamed content', async () => {
    const session = makeSession();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      writerFactory: noopWriterFactory as any,
    });
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await backend.createSession({ cwd });
      const execution = await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'run' }],
      });
      const updates: any[] = [];
      const run = execution.run(async (update) => {
        updates.push(update);
      }, new AbortController().signal);
      await vi.waitFor(() => expect(session.commitMessage).toHaveBeenCalled());
      await session.eventSink({ type: 'text_delta', delta: 'ab' });
      await session.eventSink({ type: 'final', finalText: 'abc' });
      await expect(run).resolves.toEqual({ stopReason: 'end_turn' });
      expect(
        updates
          .filter((update) => update.sessionUpdate === 'agent_message_chunk')
          .map((update) => update.content.text)
          .join(''),
      ).toBe('abc');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('denies approval even when the client update throws', async () => {
    const session = makeSession();
    session.service.getPendingInteractionSnapshot = () => ({ interactionId: 8 } as any);
    session.resolvePendingInteraction = vi.fn();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      writerFactory: noopWriterFactory as any,
    });
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await backend.createSession({ cwd });
      const execution = await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'run' }],
      });
      const run = execution.run(async () => {
        throw new Error('client disconnected');
      }, new AbortController().signal);
      await vi.waitFor(() => expect(session.commitMessage).toHaveBeenCalled());
      await expect(
        session.eventSink({
          type: 'approval_required',
          approval: { toolName: 'shell', callId: 'tool-1', argumentsText: '{}' },
        }),
      ).resolves.toBeUndefined();
      expect(session.resolvePendingInteraction).toHaveBeenCalledWith(expect.objectContaining({ answer: 'n' }));
      expect(session.abort).not.toHaveBeenCalled();
      void run;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses an injected approval policy while the default remains denial', async () => {
    const session = makeSession();
    const resolvePendingInteraction = vi.fn();
    session.service.getPendingInteractionSnapshot = () => ({ interactionId: 7 } as any);
    session.resolvePendingInteraction = resolvePendingInteraction;
    const decideApproval = vi.fn(async () => ({ answer: 'n', reason: 'policy denied' }));
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      decideApproval,
      writerFactory: noopWriterFactory as any,
    });
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await backend.createSession({ cwd });
      const execution = await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'run' }],
      });
      const updates: unknown[] = [];
      const run = execution.run(async (update) => {
        updates.push(update);
      }, new AbortController().signal);
      await vi.waitFor(() => expect(session.commitMessage).toHaveBeenCalled());
      await session.eventSink({
        type: 'approval_required',
        approval: { toolName: 'apply_patch', callId: 'tool-1', argumentsText: '{}' },
      });
      await session.eventSink({ type: 'final', finalText: '' });
      await expect(run).resolves.toEqual({ stopReason: 'end_turn' });
      expect(decideApproval).toHaveBeenCalledWith(
        { toolName: 'apply_patch', callId: 'tool-1', argumentsText: '{}' },
        { sessionId: 'session-1', cwd: '/tmp' },
      );
      expect(resolvePendingInteraction).toHaveBeenCalledWith({
        expectedInteractionId: 7,
        answer: 'n',
        rejectionReason: 'policy denied',
      });
      expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects resume when the persisted conversation writer is locked', async () => {
    const session = makeSession();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      writerFactory: () => {
        throw new LockConflictError('session-1', '/tmp/session-1.lock', null);
      },
      load: () => ({
        id: 'session-1',
        createdAt: new Date().toISOString(),
        previousResponseId: null,
        messages: [],
        history: [],
        toolLedger: [],
        replayWarnings: [],
      }),
    });
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await expect(backend.resumeSession({ sessionId: 'session-1', cwd }, async () => {})).rejects.toMatchObject({
        code: -32009,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('maps budget termination and treats unknown close as a no-op', async () => {
    const session = makeSession();
    const backend = createAcpV2SessionBackend({
      runtimeFactory: makeRuntime(session) as any,
      createId: () => 'session-1',
      writerFactory: noopWriterFactory as any,
    });
    await expect(backend.closeSession('missing')).resolves.toBeUndefined();
    const cwd = mkdtempSync('/tmp/acp-backend-');
    try {
      await backend.createSession({ cwd });
      const execution = await backend.preparePrompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'run' }],
      });
      let result!: Promise<unknown>;
      result = execution.run(async () => {}, new AbortController().signal);
      await vi.waitFor(() => expect(session.commitMessage).toHaveBeenCalled());
      await session.eventSink({ type: 'final', finalText: '', terminalCause: 'budget_exhausted' });
      await expect(result).resolves.toEqual({ stopReason: 'max_turn_requests' });
      await expect(backend.closeSession('session-1')).resolves.toBeUndefined();
      await expect(backend.closeSession('session-1')).resolves.toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('closes every session and releases every lock when one cancellation rejects', async () => {
    const cwd = mkdtempSync('/tmp/acp-backend-');
    const writerDir = mkdtempSync('/tmp/acp-backend-logs-');
    // `createId` hands the first two generated ids to the two session
    // creations, and `createSession` reports the session object's own id, so the
    // doubles carry the generated ids to address them by what the backend returns.
    const sessions = [makeSession('acp-1'), makeSession('acp-2')];
    // The session the shutdown cancels first cannot be aborted at all: the
    // close pass must still run for it and for every other live session.
    sessions[0]!.abort = vi.fn(async () => {
      throw new Error('abort failed');
    });
    let createdCount = 0;
    let idSequence = 0;
    const backend = createAcpV2SessionBackend({
      runtimeFactory: {
        create: vi.fn(async (_binding: unknown, options: any) => {
          const session = sessions[createdCount++];
          session.eventSink = options.eventSink;
          return session;
        }),
      } as any,
      createId: () => `acp-${(idSequence += 1)}`,
      writerFactory: ({ sessionId, logger }) =>
        createConversationLogWriter({ sessionId, dir: writerDir, logger, saveLast: () => {} }),
    });
    const lockFor = (sessionId: string) => path.join(writerDir, `${sessionId}.lock`);
    try {
      const first = await backend.createSession({ cwd });
      const second = await backend.createSession({ cwd });
      // A live turn on the failing session is what makes the cancel pass reach it.
      const execution = await backend.preparePrompt({
        sessionId: first.sessionId,
        prompt: [{ type: 'text', text: 'run' }],
      });
      void execution.run(async () => {}, new AbortController().signal);
      await vi.waitFor(() => expect(sessions[0]!.commitMessage).toHaveBeenCalled());
      expect(existsSync(lockFor(first.sessionId))).toBe(true);
      expect(existsSync(lockFor(second.sessionId))).toBe(true);

      await expect(backend.shutdown()).rejects.toThrow('abort failed');

      expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
      expect(sessions[1]!.dispose).toHaveBeenCalledTimes(1);
      expect(existsSync(lockFor(first.sessionId))).toBe(false);
      expect(existsSync(lockFor(second.sessionId))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(writerDir, { recursive: true, force: true });
    }
  });
});
