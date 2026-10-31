import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentClient } from '../../source/lib/agent-client.ts';
import { AgentChatFailure } from '../../source/lib/agent-chat-service.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';
import {
  decodeLogEnvelope,
  validateCompactionSequence,
} from '../../source/services/conversation/conversation-decoder.ts';
import { replayConversationEvents } from '../../source/services/conversation/conversation-replay.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { sanitizeLogFact } from '../../source/services/logging/conversation-log-writer.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { CanonicalSessionLog, loadCanonicalConversation } from '../src/session/adopted/conversation-log.ts';
import { createNetworkAuthority } from '../src/session/adopted/network-authority.ts';
import { projectNetworkFacts } from '../src/session/adopted/network.ts';
import { LocalSessionStore } from '../src/session/local-store.ts';

const requestedMode = process.env.PROBE_MODE;
const modes = requestedMode ? [requestedMode] : ['local', 'accounting', 'native', 'interleaving'];

function makeHarness(options: {
  providerId?: string;
  modelId?: string;
  streamHandler: (request: any, callIndex: number) => AsyncGenerator<any, void, unknown>;
  chatDetailedHandler?: (prompt: string, chatOptions: any) => Promise<any>;
  compactCodexHandler?: (history: readonly any[], signal?: AbortSignal) => Promise<any>;
  onSourceEvent?: (update: any) => void;
  workspaceSetup?: (workspaceDir: string) => void;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-compaction-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  options.workspaceSetup?.(workspace);

  const providerId = options.providerId ?? 'openai';
  const modelId = options.modelId ?? 'gpt-5';
  let failFsync = false;
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (key === 'fsyncSync') {
        return (fd: number) => {
          if (failFsync) {
            failFsync = false;
            throw new Error('injected compaction fsync failure');
          }
          return target.fsyncSync(fd);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const requests: any[] = [];
  const provider: any = {
    id: providerId,
    label: 'CompactionFixture',
    fetchModels: async () => [{ id: modelId, name: modelId, contextWindow: 128_000, maxOutputTokens: 16_384 }],
    capabilities: { supportsConversationChaining: true },
    createStreamedModel() {
      return {
        async *stream(request: any) {
          requests.push(request);
          yield* options.streamHandler(request, requests.length);
        },
      };
    },
  };
  const providers = createProviderRegistry();
  providers.upsertProvider(provider);
  if (providerId !== 'grok') {
    providers.upsertProvider({
      id: 'grok',
      label: 'GrokFixture',
      fetchModels: async () => [{ id: 'grok-4', name: 'grok-4', contextWindow: 128_000, maxOutputTokens: 16_384 }],
      capabilities: { supportsConversationChaining: true },
      createStreamedModel() {
        return {
          async *stream(request: any) {
            requests.push(request);
            yield* options.streamHandler(request, requests.length);
          },
        };
      },
    } as any);
  }

  const { service: host, source } = createAdoptedSettings({
    disableLogging: true,
    disableFilePersistence: true,
    cli: {
      agent: {
        modelSelection: { provider: providerId, model: modelId },
        contextCompaction: { enabled: false, compactThreshold: 0.8 },
        runBudget: { escalation: 'disabled' },
        retryAttempts: 0,
      } as any,
      memory: { enabled: false } as any,
      shell: { autoApproveMode: 'always' } as any,
    },
  });
  const readable = Object.keys(host.getAll()) as any;
  const pair = source.forSessionBinding(
    { readable, writable: [] },
    new Map([['shell.autoApproveMode', 'always']]) as any,
  );

  const logger = new LoggingService({ disableLogging: true });
  const context = new SessionContextService();
  const executionContext = new ExecutionContext();
  executionContext.enterWorkspace(workspace);
  const models = createAdoptedModelRegistry({
    settingsService: pair.service,
    loggingService: logger,
    sessionContextService: context,
    providerRegistry: providers,
    ownership: 'borrowed',
  });
  const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
  const modelRef: any = { provider: providerId, model: modelId };
  const ownership = new ToolOwnershipRegistry();

  const makeStore = (sourceEventSink?: (update: any) => void) =>
    new LocalSessionStore({
      root: path.join(root, 'sessions'),
      logger,
      defaultWorkspace: workspaceConfig,
      defaultModel: modelRef,
      fileSystem,
      adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
        onSourceEvent: sourceEventSink ?? options.onSourceEvent,
        engine: () => ({
          models,
          settings: pair.settings,
          clientOptions: {
            selection: { provider: providerId, model: modelId },
            toolOwnership: ownership,
            deps: { settings: pair.service, logger, sessionContextService: context, executionContext },
          },
        }),
        runtime: () => ({
          toolOwnership: ownership,
          deps: { logger, settingsService: pair.service, sessionContextService: context },
        }),
      }),
    });

  return {
    root,
    workspace,
    sessionsRoot: path.join(root, 'sessions'),
    workspaceConfig,
    modelRef,
    requests,
    setFailFsync(value: boolean) {
      failFsync = value;
    },
    makeStore,
  };
}

async function waitForSettledAdmission(events: any[], requestId: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (
      events.some(
        (e) =>
          e.kind === 'fact' &&
          e.entry.fact.type === 'session_admission_settled' &&
          e.entry.fact.clientRequestId === requestId,
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for admission ${requestId} to settle`);
}

async function runTurn(submission: any, events: any[], requestId: string, input: any) {
  const res = await submission.submit({ requestId, input });
  assert.equal(res.kind, 'started');
  await waitForSettledAdmission(events, requestId);
}

async function testLocalMode() {
  const sourceEvents: any[] = [];
  let summaryCalls = 0;
  const origCreateGen = (AgentClient.prototype as any).createContextSummaryGenerator;
  const origChatDetailed = AgentClient.prototype.chatDetailed;
  (AgentClient.prototype as any).createContextSummaryGenerator = undefined;
  AgentClient.prototype.chatDetailed = async function (prompt: string) {
    summaryCalls += 1;
    return {
      text: `Summary checkpoint #${summaryCalls}: preserved cold context.`,
      usage: { prompt_tokens: 110, completion_tokens: 40, total_tokens: 150 },
      costRecords: [
        {
          requestId: 'compaction-req-1',
          provider: 'openai',
          model: 'gpt-5',
          serviceTier: 'standard',
          outcome: 'completed',
          usage: { prompt_tokens: 110, completion_tokens: 40, total_tokens: 150 },
          usdMicros: 420,
          source: 'catalog',
          pricingVersion: 'test-v1',
        },
        // Duplicate requestId must be deduplicated within one operation
        {
          requestId: 'compaction-req-1',
          provider: 'openai',
          model: 'gpt-5',
          serviceTier: 'standard',
          outcome: 'completed',
          usage: { prompt_tokens: 110, completion_tokens: 40, total_tokens: 150 },
          usdMicros: 420,
          source: 'catalog',
          pricingVersion: 'test-v1',
        },
        // Credit-signed provider cost record with distinct requestId must be preserved
        {
          requestId: 'compaction-req-credit',
          provider: 'openai',
          model: 'gpt-5',
          serviceTier: 'standard',
          outcome: 'completed',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          usdMicros: -50,
          source: 'provider',
        },
      ],
    };
  };

  try {
    const harness = makeHarness({
      onSourceEvent: (update) => sourceEvents.push(update),
      streamHandler: async function* (_req, idx) {
        yield {
          type: 'completion',
          output: [
            {
              type: 'message',
              content: [{ type: 'text', text: `assistant reply ${idx} ` + 'detail '.repeat(250) }],
            },
          ],
          responseId: `resp-${idx}`,
          usage: { inputTokens: 250, outputTokens: 250 },
        };
      },
    });
    const store = harness.makeStore();
    const { session, submission } = await store.createAdopted(harness.workspaceConfig, harness.modelRef);
    const events: any[] = [];
    session.subscribe(0, (e) => events.push(e));

    // 1. Pre-start refusal when < 3 complete turns exist (2 newest turns are hot tail)
    await runTurn(submission!, events, 'req-1', {
      text: 'turn 1 literal JSON {"nestedRunResult":{"preserve":true}}',
    });
    const earlyCompact = await submission!.compact();
    assert.equal(earlyCompact.kind, 'nothing_to_compact');
    assert.equal(
      sourceEvents.filter((e) => e.event.type.startsWith('context_compaction')).length,
      0,
      'pre-start refusal must emit no compaction frames',
    );

    // 2. Complete turns 2 and 3 (turn 3 carries multimodal image + skill)
    await runTurn(submission!, events, 'req-2', { text: 'turn 2 body' });
    const img: TurnImage = {
      id: 'img-1',
      data: Buffer.from('hello-image').toString('base64'),
      mimeType: 'image/png',
      byteSize: 11,
      displayNumber: 1,
    };
    const skill = { name: 'demo-skill', description: 'desc', body: 'Follow demo-skill rules.' };
    await runTurn(submission!, events, 'req-3', {
      text: 'turn 3 with image and skill',
      images: [img],
      skill,
    });

    // 3. Run local manual compaction via submission.compact()
    sourceEvents.length = 0;
    const outcome = await submission!.compact();
    assert.equal(outcome.kind, 'compacted', `${outcome.kind}: ${outcome.message}`);
    assert.equal(summaryCalls, 1);

    // Verify source event order: started -> usage_update -> cost_update (x2 deduplicated) -> completed
    const compactionEventTypes = sourceEvents.map((u) => u.event.type);
    assert.deepEqual(compactionEventTypes, [
      'context_compaction_started',
      'usage_update',
      'cost_update',
      'cost_update',
      'context_compaction_completed',
    ]);

    // Verify canonical log facts: context_checkpoint_created and context_compaction_recorded
    const logEntries = CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id);
    const checkpointEntries = logEntries.filter((e) => e.fact.type === 'context_checkpoint_created');
    const recordedEntries = logEntries.filter((e) => e.fact.type === 'context_compaction_recorded');
    assert.equal(checkpointEntries.length, 1);
    assert.equal(recordedEntries.length, 1);
    assert.ok(checkpointEntries[0]!.seq < recordedEntries[0]!.seq);

    const recordedFact = recordedEntries[0]!.fact as any;
    assert.equal(recordedFact.strategy, 'local');
    assert.equal(recordedFact.provider, 'openai');
    assert.equal(recordedFact.model, 'gpt-5');
    assert.equal(recordedFact.result.kind, 'compacted');
    assert.equal(recordedFact.result.snapshot.previousResponseId, null);
    assert.equal(recordedFact.result.snapshot.provider, 'openai');
    assert.equal(recordedFact.result.snapshot.model, 'gpt-5');
    assert.deepEqual(recordedFact.usage, {
      prompt_tokens: 110,
      completion_tokens: 40,
      total_tokens: 150,
    });
    assert.equal(recordedFact.costRecords.length, 2);
    assert.equal(recordedFact.costRecords[0].requestId, 'compaction-req-1');
    assert.equal(recordedFact.costRecords[1].requestId, 'compaction-req-credit');
    assert.equal(recordedFact.costRecords[1].usdMicros, -50);

    // Verify literal user JSON {"nestedRunResult":{"preserve":true}} survived sanitizeLogFact in snapshot
    assert.ok(
      recordedFact.result.snapshot.history.some(
        (item: any) =>
          typeof item?.content === 'string' && item.content.includes('{"nestedRunResult":{"preserve":true}}'),
      ),
      'genuine user JSON with nestedRunResult key must be preserved in compaction snapshot',
    );

    // 4. Cold reopen in a fresh store and verify state, chain reset, and retry preservation
    await session.close();
    const store2 = harness.makeStore();
    const reopened = await store2.openAdopted(session.id);
    const restoredConv = loadCanonicalConversation(session.id, harness.sessionsRoot);
    assert.equal(restoredConv.previousResponseId, null);
    assert.equal(reopened.session.state().messages.filter((m: any) => m.sender === 'user').length, 3);
    assert.deepEqual(reopened.session.state().retryEligibility, { turn: true, tool: false });
    assert.ok(restoredConv.costRecords?.some((r) => r.requestId === 'compaction-req-credit' && r.usdMicros === -50));

    // Next turn after reopen must dispatch with previousResponseId === undefined and compacted history
    const reopenedEvents: any[] = [];
    reopened.session.subscribe(0, (e) => reopenedEvents.push(e));
    const reqCountBefore = harness.requests.length;
    await runTurn(reopened.submission!, reopenedEvents, 'req-4', { text: 'turn 4 after compaction' });
    assert.equal(harness.requests.length, reqCountBefore + 1);
    const postCompactionReq = harness.requests.at(-1);
    assert.equal(postCompactionReq.previousResponseId, undefined);
    assert.ok(
      JSON.stringify(postCompactionReq.input).includes('Summary checkpoint #1'),
      'next request after cold reopen must include compacted summary checkpoint',
    );

    // Retry turn after compaction must still use canonical submittedTurn
    const retryRes = await reopened.submission!.retry('turn');
    assert.equal(retryRes.kind, 'started');
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && reopened.session.state().status !== 'idle') {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(reopened.session.state().status, 'idle');
    await reopened.session.close();
    console.log('PASS compaction local mode');
  } finally {
    (AgentClient.prototype as any).createContextSummaryGenerator = origCreateGen;
    AgentClient.prototype.chatDetailed = origChatDetailed;
  }
}

type TurnImage = {
  id: string;
  data: string;
  mimeType: string;
  byteSize: number;
  displayNumber: number;
};

async function testAccountingMode() {
  const origCreateGen = (AgentClient.prototype as any).createContextSummaryGenerator;
  const origChatDetailed = AgentClient.prototype.chatDetailed;
  (AgentClient.prototype as any).createContextSummaryGenerator = undefined;

  try {
    let behavior: 'zero-usage' | 'absent-usage' | 'partial-throw' | 'no-accounting-fail' = 'zero-usage';
    let chunkIndex = 0;
    AgentClient.prototype.chatDetailed = async function () {
      chunkIndex += 1;
      if (behavior === 'zero-usage') {
        return {
          text: 'Short summary.',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      }
      if (behavior === 'absent-usage') {
        return {
          text: 'Short summary without usage.',
        };
      }
      if (behavior === 'partial-throw') {
        throw new AgentChatFailure(
          [
            {
              requestId: 'failed-chunk-cost-1',
              provider: 'openai',
              model: 'gpt-5',
              serviceTier: 'standard',
              outcome: 'failed',
              usdMicros: 125,
              source: 'provider',
            },
          ],
          new Error('upstream summary failure after billing'),
        );
      }
      throw new Error('upstream summary failure without accounting');
    };

    const sourceEvents: any[] = [];
    const harness = makeHarness({
      onSourceEvent: (u) => sourceEvents.push(u),
      streamHandler: async function* (_req, idx) {
        yield {
          type: 'completion',
          output: [
            {
              type: 'message',
              content: [{ type: 'text', text: `Long assistant response ${idx}: ` + 'word '.repeat(250) }],
            },
          ],
          responseId: `resp-${idx}`,
          usage: { inputTokens: 300, outputTokens: 250 },
        };
      },
    });
    const store = harness.makeStore();
    const { session, submission } = await store.createAdopted(harness.workspaceConfig, harness.modelRef);
    const events: any[] = [];
    session.subscribe(0, (e) => events.push(e));

    for (let i = 1; i <= 4; i += 1) {
      await runTurn(submission!, events, `acct-req-${i}`, {
        text: `User message ${i}: ` + 'context '.repeat(200),
      });
    }

    // 1. Reported zero usage is preserved on context_compaction_recorded
    behavior = 'zero-usage';
    const resZero = await submission!.compact();
    assert.equal(resZero.kind, 'compacted');
    let logEntries = CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id);
    let compFacts = logEntries.filter((e) => e.fact.type === 'context_compaction_recorded').map((e) => e.fact as any);
    assert.equal(compFacts.length, 1);
    assert.deepEqual(compFacts[0].usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    assert.equal(Object.hasOwn(compFacts[0], 'costRecords'), false);

    // Add 2 more turns so another cold turn exists
    await runTurn(submission!, events, 'acct-req-5', { text: 'User message 5: ' + 'context '.repeat(200) });
    await runTurn(submission!, events, 'acct-req-6', { text: 'User message 6: ' + 'context '.repeat(200) });

    // 2. Absent usage is omitted from context_compaction_recorded (not synthesized as zero)
    behavior = 'absent-usage';
    const resAbsent = await submission!.compact();
    assert.equal(resAbsent.kind, 'compacted');
    logEntries = CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id);
    compFacts = logEntries.filter((e) => e.fact.type === 'context_compaction_recorded').map((e) => e.fact as any);
    assert.equal(compFacts.length, 2);
    assert.equal(Object.hasOwn(compFacts[1], 'usage'), false);
    assert.equal(Object.hasOwn(compFacts[1], 'costRecords'), false);

    await runTurn(submission!, events, 'acct-req-7', { text: 'User message 7: ' + 'context '.repeat(200) });
    await runTurn(submission!, events, 'acct-req-8', { text: 'User message 8: ' + 'context '.repeat(200) });

    // 3. Throw with AgentChatFailure costRecords persists not_compacted with costRecords before rethrowing
    behavior = 'partial-throw';
    sourceEvents.length = 0;
    await assert.rejects(submission!.compact(), /upstream summary failure after billing/);
    logEntries = CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id);
    compFacts = logEntries.filter((e) => e.fact.type === 'context_compaction_recorded').map((e) => e.fact as any);
    assert.equal(compFacts.length, 3);
    assert.deepEqual(compFacts[2].result, { kind: 'not_compacted' });
    assert.equal(compFacts[2].costRecords.length, 1);
    assert.equal(compFacts[2].costRecords[0].requestId, 'failed-chunk-cost-1');
    assert.deepEqual(
      sourceEvents.map((u) => u.event.type),
      ['context_compaction_started', 'context_compaction_failed'],
    );

    // 4. Throw with no reported accounting writes no durable fact
    behavior = 'no-accounting-fail';
    await assert.rejects(submission!.compact(), /upstream summary failure without accounting/);
    logEntries = CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id);
    compFacts = logEntries.filter((e) => e.fact.type === 'context_compaction_recorded').map((e) => e.fact as any);
    assert.equal(compFacts.length, 3);

    await session.close();
    console.log('PASS compaction accounting mode');
  } finally {
    (AgentClient.prototype as any).createContextSummaryGenerator = origCreateGen;
    AgentClient.prototype.chatDetailed = origChatDetailed;
  }
}

async function testNativeMode() {
  const origCompactCodex = (AgentClient.prototype as any).compactCodexSessionHistory;
  try {
    let codexBehavior: 'unchanged' | 'failed' | 'compacted' = 'unchanged';
    (AgentClient.prototype as any).compactCodexSessionHistory = async function (
      _history: readonly any[],
      signal?: AbortSignal,
    ) {
      signal?.throwIfAborted();
      if (codexBehavior === 'unchanged') return { kind: 'unchanged' as const };
      if (codexBehavior === 'failed') return { kind: 'failed' as const, provider: 'codex' };
      return {
        kind: 'compacted' as const,
        history: [
          {
            type: 'provider_opaque',
            provider: 'codex',
            item: {
              type: 'compaction',
              encrypted_content: '{"nestedRunResult":"keep-opaque-encrypted-bytes"}',
            },
          },
          {
            type: 'message',
            role: 'user',
            content: 'compacted native user summary item',
          },
          {
            type: 'function_call',
            callId: 'native-retained-call',
            name: 'view_file',
            arguments: '{"path":"a.txt"}',
          },
          {
            type: 'function_call_output',
            callId: 'native-retained-call',
            output: 'retained output',
          },
        ],
      };
    };

    const sourceEvents: any[] = [];
    let turnNum = 0;
    const harness = makeHarness({
      providerId: 'codex',
      modelId: 'gpt-5-codex',
      onSourceEvent: (u) => sourceEvents.push(u),
      workspaceSetup(ws) {
        fs.writeFileSync(path.join(ws, 'sample.txt'), 'line 1\nline 2\n', 'utf8');
      },
      streamHandler: async function* () {
        turnNum += 1;
        if (turnNum === 1 || turnNum === 3) {
          const call = {
            type: 'tool_call',
            id: 'shared-call-1',
            name: 'view_file',
            arguments: JSON.stringify({ path: 'sample.txt' }),
          };
          yield call;
          yield {
            type: 'completion',
            output: [call],
            responseId: `codex-call-${turnNum}`,
            usage: { inputTokens: 15, outputTokens: 5 },
          };
          return;
        }
        yield {
          type: 'completion',
          output: [{ type: 'message', content: [{ type: 'text', text: `codex answer ${turnNum}` }] }],
          responseId: `codex-resp-${turnNum}`,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
    });

    const store = harness.makeStore();
    const { session, submission } = await store.createAdopted(harness.workspaceConfig, harness.modelRef);
    const events: any[] = [];
    session.subscribe(0, (e) => events.push(e));

    // Turn 1 executes a real tool call (view_file) and completes on Turn 2 of the stream
    await runTurn(submission!, events, 'codex-turn-1', { text: 'inspect sample.txt' });
    assert.deepEqual(session.state().retryEligibility, { turn: true, tool: true });

    // 1. Native 'unchanged' -> native_unavailable, no durable fact
    codexBehavior = 'unchanged';
    const unchangedRes = await submission!.compact();
    assert.deepEqual(unchangedRes, {
      kind: 'failed',
      message: 'Native context compaction is unavailable for this model.',
      reason: 'native_unavailable',
    });
    assert.equal(
      CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id).filter(
        (e) => e.fact.type === 'context_compaction_recorded',
      ).length,
      0,
    );

    // 2. Native 'failed' -> native_failed, no durable fact
    codexBehavior = 'failed';
    const failedRes = await submission!.compact();
    assert.deepEqual(failedRes, {
      kind: 'failed',
      message: 'Native context compaction failed.',
      reason: 'native_failed',
    });
    assert.equal(
      CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id).filter(
        (e) => e.fact.type === 'context_compaction_recorded',
      ).length,
      0,
    );

    // 3. Native 'compacted' with direct provider_opaque item and covered toolLedger occurrence
    codexBehavior = 'compacted';
    const compactedRes = await submission!.compact();
    assert.equal(compactedRes.kind, 'compacted');

    const logEntries = CanonicalSessionLog.readOnly(harness.sessionsRoot, session.id);
    assert.equal(
      logEntries.filter((e) => e.fact.type === 'context_checkpoint_created').length,
      0,
      'native compaction must not manufacture a local checkpoint provenance event',
    );
    const compFacts = logEntries.filter((e) => e.fact.type === 'context_compaction_recorded').map((e) => e.fact as any);
    assert.equal(compFacts.length, 1);
    assert.equal(compFacts[0].strategy, 'native');
    assert.equal(Object.hasOwn(compFacts[0], 'usage'), false);
    assert.equal(Object.hasOwn(compFacts[0], 'costRecords'), false);
    assert.equal(compFacts[0].result.kind, 'compacted');
    // Verify opaque encrypted_content with nestedRunResult substring was NOT corrupted by sanitizeLogFact
    assert.equal(
      compFacts[0].result.snapshot.history[0].item.encrypted_content,
      '{"nestedRunResult":"keep-opaque-encrypted-bytes"}',
    );
    // Verify pre-compaction toolLedger entry 'shared-call-1' was NOT re-injected into snapshot.history
    assert.equal(
      compFacts[0].result.snapshot.history.some((item: any) => item.callId === 'shared-call-1'),
      false,
      'covered pre-compaction tool occurrence must not be re-inserted into native compacted history',
    );

    // Immediately after native compaction, retryEligibility must be { turn: false, tool: false }
    // even though native replacement history contains a user message and function_call_output!
    assert.deepEqual(session.state().retryEligibility, { turn: false, tool: false });
    assert.deepEqual(await submission!.retry('turn'), { kind: 'ineligible', target: 'turn' });
    assert.deepEqual(await submission!.retry('tool'), { kind: 'ineligible', target: 'tool' });

    // Cold reopen after native compaction preserves coveredToolOccurrences, provider_opaque, and retryEligibility
    await session.close();
    const store2 = harness.makeStore();
    const reopened = await store2.openAdopted(session.id);
    assert.deepEqual(reopened.session.state().retryEligibility, { turn: false, tool: false });
    assert.equal(
      reopened.session.state().providerHistory.some((item: any) => item.callId === 'shared-call-1'),
      false,
      'cold reopen must not re-insert covered pre-compaction tool occurrence',
    );

    // 4. Next turn after native compaction adapts direct provider_opaque item for codex and executes a new tool call reusing 'shared-call-1'
    const reopenedEvents: any[] = [];
    reopened.session.subscribe(0, (e) => reopenedEvents.push(e));
    const reqBefore = harness.requests.length;
    await runTurn(reopened.submission!, reopenedEvents, 'codex-turn-2', {
      text: 'post-compaction user turn with tool',
    });
    assert.ok(harness.requests.length > reqBefore);
    const firstPostCompactReq = harness.requests[reqBefore];
    assert.ok(
      firstPostCompactReq.input.some(
        (item: any) =>
          item.type === 'provider_opaque' &&
          item.provider === 'codex' &&
          item.item?.type === 'compaction' &&
          item.item?.encrypted_content === '{"nestedRunResult":"keep-opaque-encrypted-bytes"}',
      ),
      'direct provider_opaque item must be adapted to StreamedModelTurnInput on next request',
    );

    // Now that a genuine post-compaction user+tool turn completed, retryEligibility is { turn: true, tool: true }!
    assert.deepEqual(reopened.session.state().retryEligibility, { turn: true, tool: true });
    const toolRetry = await reopened.submission!.retry('tool');
    assert.equal(toolRetry.kind, 'started');
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && reopened.session.state().status !== 'idle') {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(reopened.session.state().status, 'idle');

    // Foreign-provider switch refuses direct provider_opaque codex compaction item before model invocation
    const modelSwitch = await reopened.submission!.setRuntimeSettings({
      kind: 'model',
      selection: { provider: 'grok', model: 'grok-4' },
    });
    assert.equal(modelSwitch.kind, 'applied');
    const reqCountBeforeGrok = harness.requests.length;
    await runTurn(reopened.submission!, reopenedEvents, 'grok-refusal-turn', {
      text: 'attempt grok turn with codex opaque compaction item',
    });
    const refusalDeadline = Date.now() + 5_000;
    while (
      Date.now() < refusalDeadline &&
      !sourceEvents.some((u: any) => u.event?.type === 'error' && u.event?.kind === 'foreign_provider_opaque_history')
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      harness.requests.length,
      reqCountBeforeGrok,
      'foreign provider turn must be refused before model invocation',
    );
    assert.ok(
      sourceEvents.some(
        (u: any) =>
          u.event?.type === 'error' &&
          u.event?.kind === 'foreign_provider_opaque_history' &&
          String(u.event?.message ?? '').includes('from codex to grok'),
      ),
      'foreign provider refusal must emit foreign_provider_opaque_history error',
    );
    await reopened.session.close();

    // 5. Verify sanitizeLogFact scrubs actual tool result nestedRunResult while preserving user/opaque strings
    const sanitizedAssistant = sanitizeLogFact({
      type: 'assistant_turn',
      turn: {
        items: [
          {
            type: 'provider_opaque',
            provider: 'codex',
            item: { type: 'compaction', encrypted_content: '{"nestedRunResult":"preserve-opaque"}' },
          },
        ],
      },
      providerHistory: [
        { role: 'user', type: 'message', content: '{"nestedRunResult":"preserve-user"}' },
        {
          type: 'function_call_output',
          callId: 'c1',
          output: JSON.stringify({ ok: true, nestedRunResult: { secret: 'scrub-me' } }),
        },
      ],
    } as any) as any;
    assert.equal(sanitizedAssistant.turn.items[0].item.encrypted_content, '{"nestedRunResult":"preserve-opaque"}');
    assert.equal(sanitizedAssistant.providerHistory[0].content, '{"nestedRunResult":"preserve-user"}');
    assert.equal(
      JSON.parse(sanitizedAssistant.providerHistory[1].output).nestedRunResult,
      undefined,
      'tool output nestedRunResult must be scrubbed',
    );

    console.log('PASS compaction native mode');
  } finally {
    (AgentClient.prototype as any).compactCodexSessionHistory = origCompactCodex;
  }
}

async function testInterleavingMode() {
  const origCreateGen = (AgentClient.prototype as any).createContextSummaryGenerator;
  const origChatDetailed = AgentClient.prototype.chatDetailed;
  (AgentClient.prototype as any).createContextSummaryGenerator = undefined;

  let holdSummary = false;
  let summaryStartedResolve: (() => void) | undefined;
  let releaseSummary: (() => void) | undefined;
  AgentClient.prototype.chatDetailed = async function (_prompt: string, chatOptions: any) {
    if (holdSummary) {
      summaryStartedResolve?.();
      await new Promise<void>((resolve, reject) => {
        releaseSummary = resolve;
        chatOptions?.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('Context compaction cancelled.');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    }
    return {
      text: 'Interleaved summary checkpoint.',
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    };
  };

  try {
    // 1. Post-preparation prompt refresh (21:53 UTC Correction 2):
    // In a workspace with AGENTS.md, #prepareStart refreshes instructions after makeInput.
    const harness = makeHarness({
      providerId: 'openai',
      modelId: 'gpt-5',
      workspaceSetup(ws) {
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Custom Workspace Instructions\nAlways be concise.\n', 'utf8');
      },
      streamHandler: async function* (_req, idx) {
        yield {
          type: 'completion',
          output: [
            {
              type: 'message',
              content: [{ type: 'text', text: `reply ${idx} ` + 'detail '.repeat(250) }],
            },
          ],
          responseId: `r-${idx}`,
          usage: { inputTokens: 250, outputTokens: 250 },
        };
      },
    });
    const store = harness.makeStore();
    const { session, submission } = await store.createAdopted(harness.workspaceConfig, harness.modelRef);
    const events: any[] = [];
    session.subscribe(0, (e) => events.push(e));

    // Modify AGENTS.md before first turn so #prepareStart rebuilds the agent prompt after makeInput()
    fs.writeFileSync(
      path.join(harness.workspace, 'AGENTS.md'),
      '# Updated Workspace Instructions\nChanged after session creation.\n',
      'utf8',
    );
    await runTurn(submission!, events, 'refresh-1', { text: 'turn 1 with refreshed AGENTS.md' });
    assert.ok(
      String(harness.requests[0]?.instructions ?? '').includes('Updated Workspace Instructions'),
      'prepared turn must refresh selectedInput.instructions to match rebuilt agent instructions',
    );
    await runTurn(submission!, events, 'refresh-2', { text: 'turn 2' });
    await runTurn(submission!, events, 'refresh-3', { text: 'turn 3' });

    // Codex getApplicationAgent returns a copy, so a reference check against
    // agentBuild.agent would skip the refresh and fail the next turn.
    const codexHarness = makeHarness({
      providerId: 'codex',
      modelId: 'gpt-5',
      workspaceSetup(ws) {
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Codex Workspace Instructions\nBe brief.\n', 'utf8');
      },
      streamHandler: async function* (_req, idx) {
        yield {
          type: 'completion',
          output: [{ type: 'message', content: [{ type: 'text', text: `codex reply ${idx}` }] }],
          responseId: `codex-${idx}`,
          usage: { inputTokens: 20, outputTokens: 10 },
        };
      },
    });
    const codexStore = codexHarness.makeStore();
    const codexSession = await codexStore.createAdopted(codexHarness.workspaceConfig, codexHarness.modelRef);
    const codexEvents: any[] = [];
    codexSession.session.subscribe(0, (e) => codexEvents.push(e));
    fs.writeFileSync(
      path.join(codexHarness.workspace, 'AGENTS.md'),
      '# Updated Codex Workspace Instructions\nChanged after session creation.\n',
      'utf8',
    );
    await runTurn(codexSession.submission!, codexEvents, 'codex-refresh-1', {
      text: 'codex turn after AGENTS.md change',
    });
    assert.equal(codexSession.session.state().status, 'idle');
    assert.ok(
      String(codexHarness.requests[0]?.instructions ?? '').includes('Updated Codex Workspace Instructions'),
      'Codex post-preparation refresh must accept the rebuilt workspace prompt',
    );

    // 2. Cancellation while compaction is in flight + in-process duplicate join
    holdSummary = true;
    const summaryStarted = new Promise<void>((resolve) => {
      summaryStartedResolve = resolve;
    });
    const compactPromise1 = submission!.compact();
    const compactPromise2 = submission!.compact();
    assert.equal(compactPromise1, compactPromise2, 'in-process duplicate compact() must join existing promise');
    await summaryStarted;
    await submission!.interruptFromUser();
    const cancelledOutcome = await compactPromise1;
    assert.deepEqual(cancelledOutcome, {
      kind: 'failed',
      message: 'Context compaction cancelled.',
      reason: 'cancelled',
    });

    // 3. N/M Network Authority reservation & exact request identity (21:53 UTC Correction 1)
    const netCommits: any[] = [];
    let netState: any = { status: 'idle' };
    const netAuth = createNetworkAuthority(
      {
        id: 'net-sess' as any,
        root: harness.sessionsRoot,
        log: {} as any,
        state: () => netState,
        reserveSettings: () => () => {},
        poison: () => {},
        assertHealthy: () => {},
        commit: async (facts) => {
          netCommits.push(...facts);
          return [];
        },
      },
      () => {},
    );
    const releaseNet = netAuth.reserveForCompaction();
    assert.ok(releaseNet, 'idle network authority must grant compaction reservation');
    assert.equal(netAuth.reserveForCompaction(), null, 'overlapping compaction reservation must be refused');
    const originalReq = { host: 'example.com', port: 443 };
    let netResolved = false;
    const approvalPromise = netAuth
      .requestApproval(originalReq, Promise.resolve({ kind: 'applied' as const }), new AbortController().signal)
      .then((ans) => {
        netResolved = true;
        return ans;
      });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      netCommits.length,
      0,
      'network request must wait outside serial queue while compaction holds reservation',
    );
    assert.equal(netAuth.hasPending(), true, 'waiting network request must report pending');
    // Release compaction reservation: waiting network request must now enter serial queue and commit session_network_requested
    releaseNet!();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !netAuth.getSnapshot().active) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const snap = netAuth.getSnapshot().active;
    assert.ok(snap);
    assert.equal(netCommits.length, 1);
    assert.equal(netCommits[0].type, 'session_network_requested');
    await netAuth.decide({ requestId: snap.requestId, generation: snap.generation, answer: 'allow-once' });
    assert.equal(await approvalPromise, 'allow-once');
    assert.equal(netResolved, true);

    // Also verify closing network authority while compaction holds a waiter denies & wakes the waiter with exact request identity
    const cancelledReqs: any[] = [];
    const netAuth2 = createNetworkAuthority(
      {
        id: 'net-sess-2' as any,
        root: harness.sessionsRoot,
        log: {} as any,
        state: () => netState,
        reserveSettings: () => () => {},
        poison: () => {},
        assertHealthy: () => {},
        commit: async () => [],
      },
      () => {},
      (req, reason) => cancelledReqs.push({ req, reason }),
    );
    const releaseNet2 = netAuth2.reserveForCompaction()!;
    const heldReq = { host: 'held.example.com', port: 8443 };
    const heldPromise = netAuth2.requestApproval(
      heldReq,
      Promise.resolve({ kind: 'applied' as const }),
      new AbortController().signal,
    );
    await netAuth2.close();
    assert.equal(await heldPromise, 'deny');
    assert.equal(cancelledReqs.length, 1);
    assert.equal(cancelledReqs[0].req, heldReq, 'cancelled callback must receive the exact original request reference');
    releaseNet2();

    // 4. Temporal and structural validation negative cases
    assert.throws(
      () =>
        projectNetworkFacts([
          {
            type: 'session_bound',
            version: 1,
            workspace: harness.workspaceConfig,
            model: { provider: 'codex', model: 'gpt-5-codex' },
          },
          {
            type: 'session_settings_initialized',
            version: 1,
            model: { provider: 'codex', model: 'gpt-5-codex' },
            reasoningEffort: 'default',
          },
          {
            type: 'session_network_requested',
            version: 1,
            requestId: 'nr-1',
            generation: 'g-1',
            host: 'example.com',
          },
          {
            type: 'context_compaction_recorded',
            version: 1,
            operationId: 'op-1',
            provider: 'codex',
            model: 'gpt-5-codex',
            strategy: 'local',
            result: { kind: 'not_compacted' },
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        ]),
      /context_compaction_recorded while network approval is pending/,
    );
    assert.throws(
      () =>
        validateCompactionSequence(
          [
            {
              type: 'context_compaction_recorded',
              version: 1,
              operationId: 'op-unbound',
              provider: 'codex',
              model: 'gpt-5-codex',
              strategy: 'local',
              result: { kind: 'not_compacted' },
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            } as any,
          ],
          { requireSessionBound: true },
        ),
      /before session binding/,
    );
    assert.equal(
      decodeLogEnvelope({
        v: 1,
        seq: 1,
        ts: new Date().toISOString(),
        event: {
          type: 'context_compaction_recorded',
          version: 1,
          operationId: 'op-empty-not-compacted',
          provider: 'openai',
          model: 'gpt-5',
          strategy: 'local',
          result: { kind: 'not_compacted' },
        },
      }),
      null,
      'not_compacted without accounting must be rejected by decoder',
    );

    // 5. Fsync failure during compaction poisons the handle and suppresses completion
    holdSummary = false;
    harness.setFailFsync(true);
    await assert.rejects(submission!.compact(), (err: any) =>
      String(err?.cause?.message ?? err?.message ?? '').includes('injected compaction fsync failure'),
    );
    await assert.rejects(submission!.submit({ requestId: 'after-poison', input: { text: 'no' } }));
    await assert.rejects(submission!.compact());
    await session.close().catch(() => {});

    console.log('PASS compaction interleaving mode');
  } finally {
    (AgentClient.prototype as any).createContextSummaryGenerator = origCreateGen;
    AgentClient.prototype.chatDetailed = origChatDetailed;
  }
}

for (const mode of modes) {
  if (mode === 'local') await testLocalMode();
  else if (mode === 'accounting') await testAccountingMode();
  else if (mode === 'native') await testNativeMode();
  else if (mode === 'interleaving') await testInterleavingMode();
  else throw new Error(`Unknown PROBE_MODE: ${mode}`);
}
