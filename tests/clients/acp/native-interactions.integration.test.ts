import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpAgent } from '../../../src/clients/acp/agent.js';
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
  capabilities?: acp.InitializeRequest['capabilities'];
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
      updates: acp.UpdateSessionNotification[];
      disconnect(): Promise<void>;
    }>;
    observe(sessionId: string): Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'acp-interaction-verifier-'));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
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
      if (mode === 'approval') return { output: `Grant received: ${context.approvalGrant}`, isError: false };
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
        const updates: acp.UpdateSessionNotification[] = [];
        const inbound = new TransformStream<Uint8Array, Uint8Array>();
        const outbound = new TransformStream<Uint8Array, Uint8Array>();
        const agent = createAcpAgent({ backend, logger, version: 'fixture' }).connect(
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
          protocolVersion: 2,
          info: { name: 'independent-interaction-verifier', version: '1' },
          ...(options.capabilities ? { capabilities: options.capabilities } : {}),
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

describe('independent ACP question and budget provenance over native Session', () => {
  it.each(['allow-folder-session', 'allow-edit-file-session', 'unsandboxed-once'])(
    'forwards only actually offered safe scoped grants: %s',
    async (selection) => {
      await interactionFixture('approval', async ({ connect, observe, workspace, facts, requests }) => {
        let permissions = 0;
        const client = await connect({
          permission: async (request) => {
            permissions++;
            expect(request.options.map((option) => option.optionId)).toEqual([
              'approve',
              'reject',
              'allow-folder-session',
            ]);
            return { outcome: { outcome: 'selected', optionId: selection } };
          },
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
        await observe(sessionId);
        await sendPrompt(client.context, sessionId);
        await finished(facts);
        expect(permissions).toBe(1);
        const allowed = selection === 'allow-folder-session';
        expect(facts.filter((fact) => fact.type === 'interaction_closed')).toMatchObject([
          {
            resolution: allowed ? { kind: 'allow', grant: selection } : { kind: 'deny' },
            resolutionSource: allowed ? 'user' : 'system',
          },
        ]);
        if (allowed) expect(JSON.stringify(requests[1]?.input)).toContain('Grant received: allow-folder-session');
        else expect(JSON.stringify(requests)).not.toContain('Grant received:');
      });
    },
    15_000,
  );

  it('answers a mixed question set once with stable request IDs and human provenance', async () => {
    await interactionFixture('question', async ({ connect, observe, workspace, facts, requests }) => {
      let elicited = 0;
      const client = await connect({
        capabilities: { elicitation: { form: {} } },
        elicitation: async (request) => {
          elicited++;
          if (request.mode !== 'form') throw new Error('Expected form elicitation');
          const schema = request.requestedSchema as acp.ElicitationSchema;
          expect(schema.properties?.q0).toMatchObject({
            type: 'string',
            oneOf: [
              { const: 'Blue', title: 'Blue', description: 'The blue option' },
              { const: 'Green', title: 'Green' },
            ],
          });
          expect(schema.properties?.q1).toMatchObject({ type: 'array', items: { enum: ['A', 'B'] } });
          return { action: 'accept', content: { q0: 'Blue', q1: ['A', 'B'], q1_custom: 'Custom', q2_custom: 'free' } };
        },
      });
      const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
      await observe(sessionId);
      await sendPrompt(client.context, sessionId);
      await finished(facts);
      const opened = facts.find((fact) => fact.type === 'interaction_opened');
      const closed = facts.filter((fact) => fact.type === 'interaction_closed');
      expect(elicited).toBe(1);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({
        requestId: opened?.type === 'interaction_opened' ? opened.request.requestId : '',
        resolution: { kind: 'answer', answer: '["Blue",["A","B","Custom"],"free"]' },
        resolutionSource: 'user',
      });
      expect(JSON.stringify(requests[1]?.input)).toContain('Blue');
    });
  }, 15_000);

  it.each([
    ['missing field', { action: 'accept', content: { q0: 'Blue' } }, 'system'],
    [
      'unknown field',
      { action: 'accept', content: { q0: 'Blue', q1: ['A'], q2_custom: 'free', invented: true } },
      'system',
    ],
    [
      'duplicate multiple choices',
      { action: 'accept', content: { q0: 'Blue', q1: ['A', 'A'], q2_custom: 'free' } },
      'system',
    ],
    ['cancelled', { action: 'cancel' }, 'user'],
    ['declined', { action: 'decline' }, 'user'],
  ] as const)(
    'fails closed for a %s question exchange',
    async (name, response, source) => {
      await interactionFixture('question', async ({ connect, observe, workspace, facts, requests }) => {
        const client = await connect({
          capabilities: { elicitation: { form: {} } },
          elicitation: async () => response as acp.CreateElicitationResponse,
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
        await observe(sessionId);
        await sendPrompt(client.context, sessionId);
        await finished(facts);
        expect(facts.filter((fact) => fact.type === 'interaction_closed')).toMatchObject([
          {
            resolution: {
              kind: 'answer',
              answer: 'User declined to answer.',
              ...(name === 'declined' ? {} : { stopAfterApprovalResolution: true }),
            },
            resolutionSource: source,
          },
        ]);
        expect(requests).toHaveLength(name === 'declined' ? 2 : 1);
      });
    },
    15_000,
  );

  it('resumes a pending question on another attachment and ignores the disconnected answer', async () => {
    await interactionFixture('question', async ({ connect, observe, workspace, facts }) => {
      let lateAnswer!: (response: acp.CreateElicitationResponse) => void;
      let firstCalls = 0;
      const first = await connect({
        capabilities: { elicitation: { form: {} } },
        elicitation: async () => {
          firstCalls++;
          return await new Promise((resolve) => {
            lateAnswer = resolve;
          });
        },
      });
      const { sessionId } = await first.context.request(acp.methods.agent.session.new, { cwd: workspace });
      await observe(sessionId);
      await sendPrompt(first.context, sessionId);
      await expect.poll(() => firstCalls).toBe(1);
      await first.disconnect();
      let resumedCalls = 0;
      const resumed = await connect({
        capabilities: { elicitation: { form: {} } },
        elicitation: async () => {
          resumedCalls++;
          return { action: 'accept', content: { q0: 'Green', q1: ['B'], q2_custom: 'resumed' } };
        },
      });
      await resumed.context.request(acp.methods.agent.session.resume, {
        sessionId,
        cwd: workspace,
        replayFrom: { type: 'start' },
      });
      await finished(facts);
      lateAnswer({ action: 'accept', content: { q0: 'Blue', q1: ['A'], q2_custom: 'late' } });
      expect(resumedCalls).toBe(1);
      expect(facts.filter((fact) => fact.type === 'interaction_closed')).toMatchObject([
        { resolution: { answer: '["Green",["B"],"resumed"]' }, resolutionSource: 'user' },
      ]);
    });
  }, 15_000);

  it.each([
    ['explicit human extension', { action: 'accept', content: { decision: 'extend' } }, 'user', true],
    ['explicit stop', { action: 'accept', content: { decision: 'stop' } }, 'user', false],
    ['cancel', { action: 'cancel' }, 'user', false],
    ['decline', { action: 'decline' }, 'user', false],
    ['invalid decision', { action: 'accept', content: { decision: 'continue' } }, 'system', false],
    ['extra field', { action: 'accept', content: { decision: 'extend', unapproved: true } }, 'system', false],
  ] as const)(
    'budget pause: %s',
    async (_name, response, source, extendsBudget) => {
      await interactionFixture('budget', async ({ connect, observe, workspace, facts, requests }) => {
        let elicited = 0;
        const client = await connect({
          capabilities: { elicitation: { form: {} } },
          elicitation: async (request) => {
            elicited++;
            expect(request.message).toContain('"dimension":"turns"');
            return response as acp.CreateElicitationResponse;
          },
        });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
        await observe(sessionId);
        await sendPrompt(client.context, sessionId);
        await finished(facts);
        const opened = facts.find((fact) => fact.type === 'budget_opened');
        const closed = facts.filter((fact) => fact.type === 'budget_closed');
        expect(elicited).toBe(1);
        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({
          requestId: opened?.type === 'budget_opened' ? opened.requestId : '',
          decision: extendsBudget ? { kind: 'extend', grantedBy: 'human' } : { kind: 'stop' },
          source,
        });
        expect(requests).toHaveLength(extendsBudget ? 2 : 1);
        expect(facts.find((fact) => fact.type === 'turn_ended')).toMatchObject(
          extendsBudget ? { outcome: 'completed' } : { outcome: 'interrupted', terminalCause: 'budget_exhausted' },
        );
      });
    },
    15_000,
  );

  it.each([{}, { elicitation: { form: {} } }])(
    'stops a budget with no supported exchange: %j',
    async (capabilities) => {
      await interactionFixture('budget', async ({ connect, observe, workspace, facts, requests }) => {
        const client = await connect({ capabilities });
        const { sessionId } = await client.context.request(acp.methods.agent.session.new, { cwd: workspace });
        await observe(sessionId);
        await sendPrompt(client.context, sessionId);
        await finished(facts);
        expect(facts.filter((fact) => fact.type === 'budget_closed')).toMatchObject([
          { decision: { kind: 'stop' }, source: 'system' },
        ]);
        expect(requests).toHaveLength(1);
      });
    },
    15_000,
  );
});
