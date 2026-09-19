import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAcpV2SessionBackend } from './session-backend.js';
import { LockConflictError } from '../services/logging/conversation-log-writer.js';

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

const makeSession = (): any => ({
  sessionId: 'session-1',
  binding: { canonicalRoot: '/tmp' },
  settings: { modelId: 'test-model', providerId: 'test-provider' },
  service: { setLogSink: vi.fn() },
  resources: { runtime: undefined },
  prepareMessage: vi.fn(async () => ({ kind: 'prepared', leaseId: 'lease-1', turnId: 'turn-1' })),
  commitMessage: vi.fn(async () => {}),
  abort: vi.fn(async () => {}),
  dispose: vi.fn(async () => {}),
});

describe('ACP v2 production session backend', () => {
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

  it('uses an injected approval policy while the default remains denial', async () => {
    const session = makeSession();
    const resolvePendingInteraction = vi.fn();
    session.resources.runtime = {
      pendingInteraction: { getSnapshot: () => ({ interactionId: 7 }) },
    };
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
});
