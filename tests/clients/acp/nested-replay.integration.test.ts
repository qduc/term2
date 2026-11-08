import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpAgent } from '../../../src/clients/acp/agent.js';
import { createAcpBackend } from '../../../src/clients/acp/session-backend.js';
import { createDirectInProcessHost } from '../../../src/host/in-process-direct.js';
import { createDirectSessionStore } from '../../../src/session/store.js';
import type { ItemId, Model, ToolCallId } from '../../../src/model/index.js';
import type { Tool } from '../../../src/tools/index.js';
import type { Fact } from '../../../src/session/facts.js';
import type { WireEvent } from '../../../src/protocol/wire.js';

it.each(['replay', 'approval', 'question', 'invalid-question', 'resumed-question'] as const)(
  'preserves native nested %s identities, provenance and replay',
  async (scenario) => {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-nested-verifier-'));
    const workspace = path.join(temp, 'workspace');
    await mkdir(workspace);
    const grant = { root: workspace, access: 'read_write' as const, target: 'local' };
    let finishRoot!: () => void;
    const rootBoundary = new Promise<void>((resolve) => {
      finishRoot = resolve;
    });
    let rootCalls = 0;
    let childCalls = 0;
    const questions = scenario.endsWith('question');
    const questionInput = {
      questions: [{ question: 'Nested color', options: [{ label: 'Blue' }, { label: 'Green' }] }],
    };
    const facts: Fact[] = [];
    const wireEvents: WireEvent[] = [];
    const leaf: Tool = {
      spec: {
        name: questions ? 'ask_user' : 'leaf',
        description: 'Native nested fixture',
        inputSchema: { type: 'object' },
      },
      parse: (input) => input,
      approval: () => (scenario === 'approval' ? { kind: 'ask', summary: 'Nested approval' } : { kind: 'none' }),
      async execute(input, context) {
        if (!questions) return { output: 'Child tool result', isError: false };
        const decision = await context.interact!({
          kind: 'question',
          toolName: 'ask_user',
          input,
          summary: 'Nested color',
        });
        return {
          output: decision.kind === 'answer' ? decision.answer : '',
          isError: false,
          ...(decision.stopAfterApprovalResolution ? { stopAfterExecution: true as const } : {}),
        };
      },
    };
    const launch: Tool = {
      spec: { name: 'launch', description: 'Launch real native branch', inputSchema: { type: 'object' } },
      parse: (input) => input,
      approval: () => ({ kind: 'none' }),
      async execute(_input, context) {
        const result = await context.runNested({
          mode: 'foreground',
          role: 'fixture',
          instructions: 'Child fixture',
          items: [
            { type: 'user_message', id: 'child-input' as ItemId, content: [{ type: 'text', text: 'Child input' }] },
          ],
          toolNames: [leaf.spec.name],
          model: { provider: 'fixture', model: 'child' },
          budget: { maxModelCalls: 5, maxToolCalls: 5 },
        });
        return { output: JSON.stringify(result.outcome), isError: false };
      },
    };
    const model: Model = {
      ref: { provider: 'fixture', model: 'root' },
      contextWindow: 100_000,
      async *stream(request) {
        if (request.model.model === 'child') {
          childCalls++;
          if (childCalls === 1) {
            yield {
              type: 'item',
              item: {
                type: 'assistant_message',
                id: 'child-before' as ItemId,
                content: [{ type: 'text', text: 'Child before tool' }],
              },
            };
            yield {
              type: 'item',
              item: {
                type: 'tool_call',
                id: 'child-call' as ItemId,
                callId: 'reused-provider-id' as ToolCallId,
                toolName: leaf.spec.name,
                input: questions ? questionInput : {},
              },
            };
          } else {
            yield {
              type: 'item',
              item: {
                type: 'assistant_message',
                id: 'child-final' as ItemId,
                content: [{ type: 'text', text: 'Child final answer' }],
              },
            };
          }
        } else {
          rootCalls++;
          if (rootCalls === 1) {
            yield {
              type: 'item',
              item: {
                type: 'tool_call',
                id: 'root-call' as ItemId,
                callId: 'reused-provider-id' as ToolCallId,
                toolName: 'launch',
                input: {},
              },
            };
          } else {
            await rootBoundary;
            yield {
              type: 'item',
              item: {
                type: 'assistant_message',
                id: 'root-final' as ItemId,
                content: [{ type: 'text', text: 'Root final answer' }],
              },
            };
          }
        }
        yield { type: 'done', stopReason: 'end_turn' };
      },
    };
    const tools = {
      get: (name: string) => (name === leaf.spec.name ? leaf : name === 'launch' ? launch : undefined),
      available: () => [launch, leaf],
    };
    const childTools = { get: (name: string) => (name === leaf.spec.name ? leaf : undefined), available: () => [leaf] };
    const makeStore = () =>
      createDirectSessionStore({
        directory: path.join(temp, 'sessions'),
        resolveWorkspace: () => grant,
        createRuntime: () => ({
          appVersion: 'fixture',
          profile: { id: 'fixture', version: '1', digest: 'fixture' },
          request: { instructions: 'Root fixture', tools: [launch.spec] },
          deps: {
            models: { resolve: () => model, list: () => [model.ref, { provider: 'fixture', model: 'child' }] },
            tools,
            toolContext: { workspace: grant, settings: { get: () => undefined, watch: () => () => {} } },
            authorizeNested: (request) => ({
              request,
              workspace: grant,
              tools: childTools,
              role: 'fixture',
              label: 'Child fixture',
            }),
          },
        }),
      });
    const sessions = makeStore();
    const principal = { userId: 'fixture', via: 'local' as const };
    const host = createDirectInProcessHost({
      sessions,
      defaultModel: model.ref,
      authorize: () => {},
      resolveWorkspace: () => grant,
    });
    const logger = { error: () => {} };
    const updates: acp.SessionUpdate[] = [];
    let elicitationCalls = 0;
    let lateAnswer: ((response: acp.CreateElicitationResponse) => void) | undefined;
    const disposals: Array<() => Promise<void> | void> = [];
    const connect = async (first: boolean) => {
      const backend = createAcpBackend({
        host,
        principal,
        logger,
        workspaces: {
          authorize: async () => ({ workspaceId: 'fixture', access: 'read_write' }),
          cwd: async () => workspace,
        },
      });
      const inbound = new TransformStream<Uint8Array, Uint8Array>();
      const outbound = new TransformStream<Uint8Array, Uint8Array>();
      const agent = createAcpAgent({ backend, logger, version: 'fixture' }).connect(
        acp.ndJsonStream(outbound.writable, inbound.readable),
      );
      const client = acp
        .client({ name: 'independent-nested-verifier' })
        .onNotification(acp.methods.client.session.update, ({ params }) => {
          updates.push(params.update);
        })
        .onRequest(acp.methods.client.session.requestPermission, async () => ({
          outcome: { outcome: 'selected', optionId: 'approve' },
        }))
        .onRequest(acp.methods.client.elicitation.create, async () => {
          elicitationCalls++;
          if (scenario === 'resumed-question' && first)
            return await new Promise<acp.CreateElicitationResponse>((resolve) => {
              lateAnswer = resolve;
            });
          return { action: 'accept', content: scenario === 'invalid-question' ? { invented: 'Blue' } : { q0: 'Blue' } };
        })
        .connect(acp.ndJsonStream(inbound.writable, outbound.readable));
      let disconnected = false;
      const disconnect = async () => {
        if (disconnected) return;
        disconnected = true;
        client.close();
        agent.close();
        await backend.shutdown();
      };
      disposals.push(disconnect);
      await client.agent.request(acp.methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: 'independent-nested-verifier', version: '1' },
        capabilities: { elicitation: { form: {} } },
      });
      return { client, disconnect };
    };
    let connection = await connect(true);
    let client = connection.client;
    try {
      const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: workspace });
      const captured = (await sessions.open(sessionId)).capture((update) => {
        if (update.type === 'fact') facts.push(update.fact);
      });
      disposals.push(captured.unsubscribe);
      const wireObserver = await host.connect(principal, sessionId);
      const wirePump = (async () => {
        for await (const event of wireObserver.events) wireEvents.push(event);
      })();
      disposals.push(async () => {
        wireObserver.close();
        await wirePump;
      });
      const from = updates.length;
      await client.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Run child' }],
      });
      if (scenario === 'resumed-question') {
        await expect.poll(() => elicitationCalls).toBe(1);
        const pending = await host.connect(principal, sessionId);
        expect(pending.snapshot.pendingInteractions).toHaveLength(1);
        pending.close();
        await connection.disconnect();
        connection = await connect(false);
        client = connection.client;
        await client.agent.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: workspace,
          replayFrom: { type: 'start' },
        });
      }
      await expect.poll(() => rootCalls).toBe(2);
      expect(childCalls).toBe(scenario === 'invalid-question' ? 1 : 2);
      if (scenario !== 'replay') {
        const opened = facts.find((fact) => fact.type === 'task_interaction_opened');
        const closures = facts.filter((fact) => fact.type === 'task_interaction_closed');
        expect(closures).toHaveLength(1);
        const requestId = opened?.type === 'task_interaction_opened' ? opened.request.requestId : '';
        const source = scenario === 'invalid-question' ? 'system' : 'user';
        expect(closures[0]).toMatchObject({
          requestId,
          resolutionSource: source,
          resolution: {
            kind: 'decision',
            decision:
              scenario === 'approval'
                ? { kind: 'allow' }
                : { kind: 'answer', answer: scenario === 'invalid-question' ? 'User declined to answer.' : '["Blue"]' },
          },
        });
        const resolved = wireEvents.find(
          (event) => event.type === 'interaction_resolved' && event.payload.requestId === requestId,
        );
        expect(resolved).toMatchObject({ payload: { requestId, provenance: { source } } });
        lateAnswer?.({ action: 'accept', content: { q0: 'Green' } });
        expect(elicitationCalls).toBe(scenario === 'approval' ? 0 : scenario === 'resumed-question' ? 2 : 1);
      }
      expect(
        updates.slice(from).some((update) => update.sessionUpdate === 'state_update' && update.state === 'idle'),
      ).toBe(false);
      const childBefore = updates.find(
        (update) =>
          update.sessionUpdate === 'agent_message' &&
          (update.content as readonly acp.ContentBlock[]).some(
            (content) => content.type === 'text' && content.text === 'Child before tool',
          ),
      );
      const childFinal = updates.find(
        (update) =>
          update.sessionUpdate === 'agent_message' &&
          (update.content as readonly acp.ContentBlock[]).some(
            (content) => content.type === 'text' && content.text === 'Child final answer',
          ),
      );
      expect(childBefore).toBeDefined();
      if (scenario !== 'invalid-question') expect(childFinal).toBeDefined();
      const childTool = updates.find(
        (update) => update.sessionUpdate === 'tool_call' && update.name === leaf.spec.name,
      );
      expect(childTool?.sessionUpdate).toBe('tool_call');
      finishRoot();
      await expect
        .poll(() =>
          updates.some(
            (update) =>
              update.sessionUpdate === 'state_update' && update.state === 'idle' && update.stopReason === 'end_turn',
          ),
        )
        .toBe(true);
      const observer = await host.connect(principal, sessionId);
      expect(observer.snapshot.branches).toHaveLength(1);
      const branch = observer.snapshot.branches![0]!;
      if (scenario !== 'invalid-question')
        expect(branch.messages.map((message) => message.id)).toContain('child-final');
      observer.close();
      const replayFrom = updates.length;
      await client.agent.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd: workspace,
        replayFrom: { type: 'start' },
      });
      const replay = updates.slice(replayFrom);
      expect(replay).toContainEqual(childBefore);
      if (childFinal) expect(replay).toContainEqual(childFinal);
      if (childTool?.sessionUpdate !== 'tool_call') throw new Error('Missing real child tool identity');
      const childToolId = childTool.toolCallId;
      expect(replay.some((update) => update.sessionUpdate === 'tool_call' && update.toolCallId === childToolId)).toBe(
        true,
      );
      expect(
        replay.findIndex(
          (update) =>
            update.sessionUpdate === 'agent_message' &&
            childBefore?.sessionUpdate === 'agent_message' &&
            update.messageId === childBefore.messageId,
        ),
      ).toBeLessThan(
        replay.findIndex((update) => update.sessionUpdate === 'tool_call' && update.toolCallId === childToolId),
      );
      expect(replay.at(-1)).toEqual({ sessionUpdate: 'state_update', state: 'idle' });
      if (scenario !== 'replay') {
        expect(facts.filter((fact) => fact.type === 'task_interaction_closed')).toHaveLength(1);
        const logPath = sessions.metadata(sessionId).logPath;
        for (const dispose of disposals.splice(0).reverse()) await dispose();
        await host.dispose();
        const reopen = async (source: 'user' | 'system' | undefined) => {
          const restoredStore = makeStore();
          try {
            const restored = await restoredStore.open(sessionId);
            const capture = restored.captureFrom(0, () => {});
            capture.unsubscribe();
            const closures = capture.replay
              .map((update) => update.fact)
              .filter((fact) => fact.type === 'task_interaction_closed');
            expect(closures).toHaveLength(1);
            expect(closures[0]?.resolutionSource).toBe(source);
            expect(rootCalls).toBe(2);
          } finally {
            await restoredStore.close();
          }
        };
        // A fresh store must parse the accepted new fact schema from disk.
        await reopen(scenario === 'invalid-question' ? 'system' : 'user');
        // Simulate the previous on-disk shape in this isolated fixture only:
        // older accepted closures lack both additive provenance fields.
        const legacyLog =
          (await readFile(logPath, 'utf8'))
            .trimEnd()
            .split('\n')
            .map((raw) => {
              const line = JSON.parse(raw) as { fact: Record<string, unknown> };
              if (line.fact.type === 'task_interaction_closed') {
                delete line.fact.resolutionSource;
                delete line.fact.automaticApproval;
              }
              return JSON.stringify(line);
            })
            .join('\n') + '\n';
        await writeFile(logPath, legacyLog);
        await reopen(undefined);
      }
    } finally {
      finishRoot();
      for (const dispose of disposals.splice(0).reverse()) await dispose();
      await host.dispose();
      await rm(temp, { recursive: true, force: true });
    }
  },
  15_000,
);
