import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import { createAcpV1Agent } from '../../../src/clients/acp/v1-agent.js';
import { createAcpBackend } from '../../../src/clients/acp/session-backend.js';
import { createDirectInProcessHost } from '../../../src/host/in-process-direct.js';
import { createDirectSessionStore } from '../../../src/session/store.js';
import type { Fact } from '../../../src/session/facts.js';
import type { ItemId, Model, ModelRequest, ToolCallId } from '../../../src/model/index.js';
import type { Tool } from '../../../src/tools/index.js';

const questionInput = {
  questions: [
    { question: 'Color', options: [{ label: 'Blue', description: 'The blue option' }, { label: 'Green' }] },
    { question: 'Letters', is_multi_select: true, options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Free text' },
  ],
};

type ClientOptions = {
  capabilities?: acp.InitializeRequest['clientCapabilities'];
  elicitation?: (request: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;
  permission?: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
};

// This is a real native Session with an external fixture model/tool, not a
// projection double. Assertions inspect the facts the Session actually accepts.
async function interactionFixture(
  mode: 'question' | 'budget' | 'approval',
  body: (fixture: {
    workspace: string;
    requests: ModelRequest[];
    facts: Fact[];
    connect(options: ClientOptions): Promise<{
      context: acp.ClientContext;
      updates: acp.SessionNotification[];
      disconnect(): Promise<void>;
    }>;
    observe(sessionId: string): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-interaction-verifier-'));
  await mkdir(path.join(temp, 'workspace'));
  const workspace = await realpath(path.join(temp, 'workspace'));
  const facts: Fact[] = [];
  const requests: ModelRequest[] = [];
  const tool: Tool = {
    spec: {
      name: mode === 'question' ? 'ask_user' : 'noop',
      description: 'Fixture tool',
      inputSchema: { type: 'object' },
    },
    parse: (input) => input,
    approval: () =>
      mode === 'approval'
        ? {
            kind: 'ask',
            summary: 'Approve exact scoped fixture call',
            grants: ['allow-folder-session', 'unsandboxed-once'],
          }
        : { kind: 'none' },
    async execute(input, context) {
      if (mode === 'budget') return { output: 'Tool complete', isError: false };
      if (mode === 'approval')
        return { output: `Grant received: ${context.approvalGrant}`, isError: false, providerOutput: [] };
      const decision = await context.interact!({
        kind: 'question',
        toolName: 'ask_user',
        input,
        summary: 'Answer the set',
      });
      return {
        output: decision.kind === 'answer' ? decision.answer : '',
        isError: false,
        ...(decision.stopAfterApprovalResolution ? { stopAfterExecution: true as const } : {}),
      };
    },
  };
  const model: Model = {
    ref: { provider: 'fixture', model: 'interactions' },
    contextWindow: 100_000,
    async *stream(request) {
      requests.push(request);
      yield {
        type: 'item',
        item:
          requests.length === 1
            ? {
                type: 'tool_call',
                id: 'first-call' as ItemId,
                callId: 'first-call' as ToolCallId,
                toolName: tool.spec.name,
                input: questionInput,
              }
            : {
                type: 'assistant_message',
                id: 'final-answer' as ItemId,
                content: [{ type: 'text', text: 'Resolved' }],
              },
      };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const grant = { root: workspace, access: 'read_write' as const, target: 'local' };
  const sessions = createDirectSessionStore({
    directory: path.join(temp, 'sessions'),
    resolveWorkspace: () => grant,
    createRuntime: () => ({
      appVersion: 'fixture',
      profile: { id: 'fixture', version: '1', digest: 'fixture' },
      request: { instructions: 'Fixture', tools: [tool.spec] },
      deps: {
        models: { resolve: () => model, list: () => [model.ref] },
        tools: { get: (name) => (name === tool.spec.name ? tool : undefined), available: () => [tool] },
        toolContext: { workspace: grant, settings: { get: () => undefined, watch: () => () => {} } },
        ...(mode === 'budget'
          ? {
              budget: {
                policy: {
                  maxUsdMicros: 1_000_000_000,
                  maxUnpricedTokens: 1_000_000_000,
                  maxActiveTimeMs: 1_000_000_000,
                  warningHeadroomUsdMicros: 0,
                  warningHeadroomUnpricedTokens: 0,
                  warningHeadroomActiveTimeMs: 0,
                  softHeadroomUsdMicros: 0,
                  softHeadroomUnpricedTokens: 0,
                  softHeadroomActiveTimeMs: 0,
                  turnBackstop: 1,
                  extensionPercent: 100,
                  maxParentExtensions: 0,
                  identicalToolCallThreshold: 100,
                  escalation: 'contain' as const,
                },
              },
            }
          : {}),
      },
    }),
  });
  const principal = { userId: 'fixture', via: 'local' as const };
  const host = createDirectInProcessHost({
    sessions,
    defaultModel: model.ref,
    authorize: () => {},
    resolveWorkspace: () => grant,
  });
  const disposals: Array<() => void | Promise<void>> = [];
  try {
    await body({
      workspace,
      requests,
      facts,
      async observe(sessionId) {
        const capture = (await sessions.open(sessionId)).capture((update) => {
          if (update.type === 'fact') facts.push(update.fact);
        });
        disposals.push(capture.unsubscribe);
      },
      async connect(options) {
        const logger = { error: () => {} };
        const backend = createAcpBackend({
          host,
          principal,
          logger,
          workspaces: {
            authorize: async () => ({ workspaceId: 'fixture', access: 'read_write' }),
            cwd: async () => workspace,
          },
        });
        const updates: acp.SessionNotification[] = [];
        const inbound = new TransformStream<Uint8Array, Uint8Array>();
        const outbound = new TransformStream<Uint8Array, Uint8Array>();
        const agent = createAcpV1Agent({ backend, logger, version: 'fixture' }).connect(
          acp.ndJsonStream(outbound.writable, inbound.readable),
        );
        let app = acp
          .client({ name: 'independent-interaction-verifier' })
          .onNotification(acp.methods.client.session.update, ({ params }) => {
            updates.push(params);
          });
        if (options.elicitation)
          app = app.onRequest(acp.methods.client.elicitation.create, ({ params }) => options.elicitation!(params));
        if (options.permission)
          app = app.onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
            options.permission!(params),
          );
        const client = app.connect(acp.ndJsonStream(inbound.writable, outbound.readable));
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
          protocolVersion: 1,
          clientInfo: { name: 'independent-interaction-verifier', version: '1' },
          ...(options.capabilities ? { clientCapabilities: options.capabilities } : {}),
        });
        return { context: client.agent, updates, disconnect };
      },
    });
  } finally {
    for (const dispose of disposals.reverse()) await dispose();
    await host.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}

const sendPrompt = (context: acp.ClientContext, sessionId: string) =>
  context.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'start' }] });
async function finished(facts: Fact[]) {
  await expect.poll(() => facts.some((fact) => fact.type === 'turn_ended'), { timeout: 5_000 }).toBe(true);
}

describe('ACP v1 native permissions and cancellation', () => {
  it.each(['approve', 'reject', 'allow-folder-session', 'unsandboxed-once', 'allow-once'])(
    'preserves approval policy and accepted provenance: %s',
    async (selection) => {
      await interactionFixture('approval', async ({ connect, observe, workspace, facts, requests }) => {
        const client = await connect({
          permission: async (request) => {
            expect(request.toolCall.toolCallId).toBeTruthy();
            expect(request.options.map((option) => option.optionId)).toEqual([
              'approve',
              'reject',
              'allow-folder-session',
            ]);
            expect(request).not.toHaveProperty('subject');
            return { outcome: { outcome: 'selected', optionId: selection } };
          },
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [],
        });
        await observe(sessionId);
        expect(await sendPrompt(client.context, sessionId)).toEqual({ stopReason: 'end_turn' });
        await finished(facts);
        const allowed = selection === 'approve' || selection === 'allow-folder-session';
        expect(facts.filter((fact) => fact.type === 'interaction_closed')).toMatchObject([
          {
            resolution: allowed ? { kind: 'allow' } : { kind: 'deny' },
            resolutionSource: ['unsandboxed-once', 'allow-once'].includes(selection) ? 'system' : 'user',
          },
        ]);
        if (allowed) {
          const completed = client.updates.flatMap(({ update }) =>
            (update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'tool_call') &&
            update.status === 'completed'
              ? [update]
              : [],
          );
          expect(completed.at(-1)?.content).toEqual([
            { type: 'content', content: { type: 'text', text: expect.stringContaining('Grant received:') } },
          ]);
          expect(JSON.stringify(requests[1]?.input)).toContain('Grant received:');
        } else expect(JSON.stringify(requests)).not.toContain('Grant received:');
        expect(client.updates.some(({ update }) => update.sessionUpdate === 'tool_call')).toBe(true);
        expect(client.updates.some(({ update }) => update.sessionUpdate === 'tool_call_update')).toBe(true);
      });
    },
    15_000,
  );

  it('keeps prompt pending for approval, rejects overlapping work, and cancels without accepting a late allow', async () => {
    await interactionFixture('approval', async ({ connect, observe, workspace, facts, requests }) => {
      let allow!: (value: acp.RequestPermissionResponse) => void;
      let opened = false;
      const client = await connect({
        permission: async () => {
          opened = true;
          return await new Promise((resolve) => {
            allow = resolve;
          });
        },
      });
      const { sessionId } = await client.context.request(acp.methods.agent.session.new, {
        cwd: workspace,
        mcpServers: [],
      });
      await observe(sessionId);
      let settled = false;
      const prompt = sendPrompt(client.context, sessionId).finally(() => {
        settled = true;
      });
      await expect.poll(() => opened).toBe(true);
      expect(settled).toBe(false);
      await expect(sendPrompt(client.context, sessionId)).rejects.toMatchObject({ code: -32010 });
      await client.context.notify(acp.methods.agent.session.cancel, { sessionId });
      expect(await prompt).toEqual({ stopReason: 'cancelled' });
      allow({ outcome: { outcome: 'selected', optionId: 'approve' } });
      await finished(facts);
      expect(JSON.stringify(requests)).not.toContain('Grant received:');
      expect(facts.some((fact) => fact.type === 'turn_ended')).toBe(true);
    });
  }, 15_000);

  it.each(['accept', 'decline', 'cancel', 'invalid'] as const)(
    'uses negotiated v1 forms for questions: %s',
    async (action) => {
      await interactionFixture('question', async ({ connect, observe, workspace, facts }) => {
        let requested = false;
        const client = await connect({
          capabilities: { elicitation: { form: {} } },
          elicitation: async (request) => {
            requested = true;
            expect(request).toMatchObject({ mode: 'form', requestedSchema: { type: 'object' } });
            return action === 'accept'
              ? { action: 'accept', content: { q0: 'Blue', q1: ['A', 'B'], q2_custom: 'typed answer' } }
              : action === 'invalid'
              ? { action: 'accept', content: { q0: 'Purple' } }
              : { action };
          },
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [],
        });
        await observe(sessionId);
        await sendPrompt(client.context, sessionId);
        await finished(facts);
        expect(requested).toBe(true);
        const resolved = facts.filter((fact) => fact.type === 'interaction_closed');
        expect(resolved).toHaveLength(1);
        if (action === 'accept') {
          expect(JSON.stringify(resolved)).toContain('Blue');
          expect(JSON.stringify(resolved)).toContain('typed answer');
        } else {
          expect(resolved).toMatchObject([
            {
              resolution: {
                kind: 'answer',
                answer: 'User declined to answer.',
                ...(action === 'decline' ? {} : { stopAfterApprovalResolution: true }),
              },
              resolutionSource: action === 'invalid' ? 'system' : 'user',
            },
          ]);
        }
      });
    },
    15_000,
  );

  it.each(['extend', 'stop', 'invalid'] as const)(
    'uses negotiated budget form: %s',
    async (choice) => {
      await interactionFixture('budget', async ({ connect, observe, workspace, facts, requests }) => {
        let elicited = 0;
        const client = await connect({
          capabilities: { elicitation: { form: {} } },
          elicitation: async () => {
            elicited++;
            return { action: 'accept', content: { decision: choice === 'invalid' ? 'continue' : choice } };
          },
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [],
        });
        await observe(sessionId);
        await sendPrompt(client.context, sessionId);
        await finished(facts);
        expect(elicited).toBe(1);
        expect(facts.filter((fact) => fact.type === 'budget_closed')).toMatchObject([
          {
            decision: choice === 'extend' ? { kind: 'extend', grantedBy: 'human' } : { kind: 'stop' },
            source: choice === 'invalid' ? 'system' : 'user',
          },
        ]);
        expect(requests).toHaveLength(choice === 'extend' ? 2 : 1);
      });
    },
    15_000,
  );

  it.each(['question', 'budget'] as const)(
    'stops unsupported %s interactions without requesting fabricated approval',
    async (mode) => {
      await interactionFixture(mode, async ({ connect, workspace }) => {
        const client = await connect({
          permission: async () => {
            throw new Error('Unexpected permission request');
          },
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [],
        });
        const result = await sendPrompt(client.context, sessionId);
        expect(['end_turn', 'cancelled', 'refusal']).toContain(result.stopReason);
      });
    },
    15_000,
  );
});
