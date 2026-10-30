// Goal slice evidence through the real app factory, owned AgentClient and canonical writer.
// PROBE_MODE: set | fsync | achieve | propose-approve | propose-reject | propose-race
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSessionStore } from '../src/session/local-store.ts';
import { CanonicalSessionLog, loadCanonicalConversation } from '../src/session/adopted/conversation-log.ts';
import { createAppAdoptedSessionHandleFactory } from '../src/app/adopted/session.ts';
import { createAdoptedSettings } from '../src/config/adopted/settings.ts';
import { createAdoptedModelRegistry } from '../src/model/adopted/index.ts';
import { createProviderRegistry } from '../../source/providers/registry.ts';
import { SessionContextService } from '../../source/services/session/session-context-service.ts';
import { LoggingService } from '../../source/services/logging/logging-service.ts';
import { ExecutionContext } from '../../source/services/execution-context.ts';
import { ToolOwnershipRegistry } from '../../source/services/approval/tool-ownership-registry.ts';

const mode = process.env.PROBE_MODE ?? 'set';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c3a-goal-'));
const sessionsRoot = path.join(root, 'sessions');
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);

// Each provider request takes the next scripted response; the input is kept for assertions.
const requests: { tools: string[]; input: unknown }[] = [];
let script: ('final' | { name: string; args: object })[] = [];
const provider: any = {
  id: 'openai',
  label: 'fixture',
  fetchModels: async () => [],
  capabilities: { supportsConversationChaining: false },
  createStreamedModel() {
    return {
      async *stream(request: any) {
        requests.push({ tools: (request.tools ?? []).map((tool: any) => tool.name), input: request.input });
        const next = script.shift() ?? 'final';
        if (next === 'final') {
          yield {
            type: 'completion',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
            responseId: `r${requests.length}`,
          };
          return;
        }
        const call = {
          type: 'tool_call',
          id: `call${requests.length}`,
          name: next.name,
          arguments: JSON.stringify(next.args),
        };
        yield call;
        yield { type: 'completion', output: [call], responseId: `r${requests.length}` };
      },
    };
  },
};
const providers = createProviderRegistry();
providers.upsertProvider(provider);
const { service: host, source } = createAdoptedSettings({
  disableLogging: true,
  disableFilePersistence: true,
  cli: {
    agent: {
      modelSelection: { provider: 'openai', model: 'fixture' },
      contextCompaction: { enabled: false },
      runBudget: { escalation: 'disabled' },
      completionVerification: false,
      retryAttempts: 0,
    } as any,
    memory: { enabled: false } as any,
    shell: { autoApproveMode: 'off' } as any,
    // With shell on, propose_goal is reachable only inside run_code, which refuses
    // approval-requiring tools (old CLI behavior); the shell toggle makes it direct.
    ...(mode.startsWith('propose') ? { tools: { shell: { enabled: false } } as any } : {}),
  },
});
const pair = source.forSessionBinding(
  { readable: Object.keys(host.getAll()) as any, writable: [] },
  new Map([['shell.autoApproveMode', 'off']]) as any,
);
const logger = new LoggingService({ disableLogging: true });
const models = createAdoptedModelRegistry({
  settingsService: pair.service,
  loggingService: logger,
  sessionContextService: new SessionContextService(),
  providerRegistry: providers,
  ownership: 'borrowed',
});

let failGoalFsync = false;
let goalWritten = false;
const faultFs = new Proxy(fs, {
  get(target, key) {
    if (key === 'writeSync')
      return (...args: any[]) => {
        if (String(args[1]).includes('"type":"goal_changed"')) goalWritten = true;
        return (fs.writeSync as any)(...args);
      };
    if (key === 'fsyncSync')
      return (...args: any[]) => {
        if (failGoalFsync && goalWritten) throw new Error('injected goal fsync');
        return (fs.fsyncSync as any)(...args);
      };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const workspaceConfig: any = { root: workspace, access: 'read_write', target: 'local' };
const modelRef: any = { provider: 'openai', model: 'fixture' };
function makeStore() {
  let ownership: ToolOwnershipRegistry;
  let graphContext: SessionContextService;
  return new LocalSessionStore({
    fileSystem: faultFs,
    root: sessionsRoot,
    logger,
    defaultWorkspace: workspaceConfig,
    defaultModel: modelRef,
    driverFactory: () => {
      throw new Error('combined handle expected');
    },
    adoptedHandleFactory: createAppAdoptedSessionHandleFactory({
      engine: () => {
        ownership = new ToolOwnershipRegistry();
        graphContext = new SessionContextService();
        const execution = new ExecutionContext();
        execution.enterWorkspace(workspace);
        return {
          models,
          settings: pair.settings,
          clientOptions: {
            selection: { provider: 'openai', model: 'fixture' },
            toolOwnership: ownership,
            deps: { settings: pair.service, logger, sessionContextService: graphContext, executionContext: execution },
          },
        };
      },
      runtime: () => ({
        toolOwnership: ownership,
        deps: { logger, settingsService: pair.service, sessionContextService: graphContext },
      }),
    }),
  });
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timeout waiting for ${label}`);
}
const goalFacts = (id: string) =>
  CanonicalSessionLog.readOnly(sessionsRoot, id)
    .filter((entry: any) => entry.fact.type === 'goal_changed')
    .map((entry: any) => entry);
const goal = (id: string, outcome = 'Ship the goal slice', status = 'active') => ({ id, outcome, status } as any);

async function open(id?: string) {
  const store = makeStore();
  const opened: any = id ? await (store as any).openAdopted(id) : await store.createAdopted(workspaceConfig, modelRef);
  const facts: any[] = [];
  opened.session.subscribe(0, (event: any) => {
    if (event.kind === 'fact') facts.push(event.entry.fact);
  });
  const settled = (requestId: string) =>
    until(
      () => facts.find((fact) => fact.type === 'session_admission_settled' && fact.clientRequestId === requestId),
      `settlement ${requestId}`,
    );
  const pending = (index: number) =>
    until(() => facts.filter((fact) => fact.type === 'session_interaction_pending')[index], `pending ${index}`);
  const choose = (fact: any, answer: string) =>
    opened.submission.decide({
      kind: 'choose',
      turnId: fact.turnId,
      interactionId: fact.interaction.interactionId,
      revision: fact.interaction.revision,
      generation: fact.generation,
      decisions: [{ callId: fact.interaction.descriptor.callId, choice: { answer } }],
    });
  return { ...opened, facts, settled, pending, choose };
}
const propose = (outcome: string) => ({ name: 'propose_goal', args: { outcome } });
const lastToolOutput = () => JSON.stringify(requests.at(-1)?.input ?? []);

try {
  if (mode === 'set') {
    const first = await open();
    const control = first.submission.goal!;
    assert.deepEqual(control.get(), { goal: undefined, revision: null });
    assert.equal(await control.set(goal('g1'), null), 'applied');
    const afterFirst = control.get();
    assert.deepEqual(afterFirst.goal, goal('g1'));
    assert.ok(afterFirst.revision?.logId && afterFirst.revision.eventId);
    assert.equal(await control.set(goal('g2'), null), 'stale', 'null is not a wildcard');
    assert.equal(goalFacts(first.session.id).length, 1, 'stale set appends nothing');
    assert.equal(await control.set(goal('g1'), afterFirst.revision), 'applied', 'identical content, exact ref');
    const afterSame = control.get();
    assert.notDeepEqual(afterSame.revision, afterFirst.revision, 'a repeated goal gets a new event identity');
    assert.equal(await control.set(goal('g3'), afterFirst.revision), 'stale', 'old ref is stale after same-value set');
    await assert.rejects(control.set({ id: '', outcome: 'x', status: 'active' } as any, afterSame.revision));
    await assert.rejects(control.set({ ...goal('g4'), extra: true } as any, afterSame.revision));
    await assert.rejects(control.set(goal('g4'), { logId: afterSame.revision!.logId } as any));
    assert.equal(goalFacts(first.session.id).length, 2, 'invalid commands append nothing');
    const racers = await Promise.all([
      control.set(goal('race-a'), afterSame.revision),
      control.set(goal('race-b'), afterSame.revision),
    ]);
    assert.deepEqual([...racers].sort(), ['applied', 'stale'], 'concurrent setters: exactly one applies');
    const final = control.get();
    assert.equal(final.goal!.id, racers[0] === 'applied' ? 'race-a' : 'race-b');
    const id = first.session.id;
    await first.session.close();
    const reopened = await open(id);
    assert.deepEqual(reopened.submission.goal!.get(), final, 'cold open restores the exact goal and ref');
    await reopened.session.closeLog();
    await assert.rejects(reopened.submission.goal!.set(goal('late'), final.revision), /Session handle is closed/);
    const closedTypes = CanonicalSessionLog.readOnly(sessionsRoot, id).map((entry: any) => entry.fact.type);
    assert.equal(closedTypes.at(-1), 'session_closed', 'no goal is appended after the log closes');
    await reopened.session.close();
    console.log('PASS set: null/exact/stale/same-value/invalid/concurrent/reopen/closed');
  } else if (mode === 'fsync') {
    const first = await open();
    failGoalFsync = true;
    await assert.rejects(
      first.submission.goal!.set(goal('g1'), null),
      (error: any) => error.code === 'fatal_persistence' && /injected goal fsync/.test(String(error.cause)),
    );
    assert.deepEqual(first.submission.goal!.get(), { goal: undefined, revision: null }, 'no read before fsync');
    failGoalFsync = false;
    await assert.rejects(first.submission.goal!.set(goal('g2'), null), 'goal writer stays poisoned');
    await assert.rejects(first.submission.submit({ requestId: 'after', input: { text: 'hi' } }), 'session poisoned');
    assert.equal(requests.length, 0);
    await first.session.close().catch(() => {});
    console.log('PASS fsync: failed goal append poisons the session and is never acknowledged');
  } else if (mode === 'achieve') {
    const first = await open();
    assert.equal(await first.submission.goal!.set(goal('g1'), null), 'applied');
    script = [{ name: 'goal_check', args: { status: 'achieved', evidence: 'The slice is built.' } }, 'final'];
    await first.submission.submit({ requestId: 't1', input: { text: 'finish it' } });
    await first.settled('t1');
    assert.ok(requests[0]!.tools.includes('goal_check'), 'adopted root agent exposes goal_check');
    const written = goalFacts(first.session.id);
    assert.equal(written.length, 2, 'one achievement write');
    assert.deepEqual(written[1].fact, {
      type: 'goal_changed',
      version: 1,
      goal: goal('g1', 'Ship the goal slice', 'achieved'),
      source: 'goal_check',
    });
    const types = CanonicalSessionLog.readOnly(sessionsRoot, first.session.id).map((entry: any) => entry.fact.type);
    const achievedAt = types.lastIndexOf('goal_changed');
    assert.ok(achievedAt < types.lastIndexOf('session_turn_ended'), 'achievement is ordered inside the turn');
    assert.ok(
      types.slice(types.lastIndexOf('session_turn_started'), achievedAt).includes('assistant_journal_item'),
      `buffered turn facts are flushed before the achievement: ${types.join(',')}`,
    );
    assert.equal(first.submission.goal!.get().goal!.status, 'achieved');
    await first.session.close();
    console.log('PASS achieve: recorded goal_check closes the goal once, durably, before the turn ends');
  } else if (mode === 'propose-approve' || mode === 'propose-race') {
    const first = await open();
    script = [propose('Proposed outcome'), 'final'];
    await first.submission.submit({ requestId: 't1', input: { text: 'start building' } });
    const prompt = await first.pending(0);
    assert.ok(requests[0]!.tools.includes('propose_goal'), `propose_goal offered: ${requests[0]!.tools}`);
    assert.equal(prompt.interaction.descriptor.toolName, 'propose_goal');
    if (mode === 'propose-race') {
      assert.equal(await first.submission.goal!.set(goal('manual'), null), 'applied');
    }
    await first.choose(prompt, 'approve');
    await first.settled('t1');
    const written = goalFacts(first.session.id);
    if (mode === 'propose-race') {
      assert.equal(written.length, 1, 'the manual goal wins; the proposal adds nothing');
      assert.equal(written[0].fact.goal.id, 'manual');
      // The tool's own execute-time check refuses first. The authority's
      // compare-and-append guard behind it is not reachable from a bench.
      assert.match(lastToolOutput(), /propose_goal refused because a durable goal is already set/);
      assert.doesNotMatch(lastToolOutput(), /Goal proposed and persisted/);
      console.log('PASS propose-race: a manual goal set while the proposal waits wins, with no success text');
    } else {
      assert.equal(written.length, 1);
      assert.equal(written[0].fact.goal.outcome, 'Proposed outcome');
      assert.equal(written[0].fact.source, undefined);
      assert.match(lastToolOutput(), /Goal proposed and persisted/);
      console.log('PASS propose-approve: approved proposal appends one goal before its success text');
    }
    await first.session.close();
  } else if (mode === 'propose-reject') {
    const first = await open();
    script = [propose('Proposed outcome'), 'final'];
    await first.submission.submit({ requestId: 't1', input: { text: 'start building' } });
    await first.choose(await first.pending(0), 'reject');
    await first.settled('t1');
    assert.equal(goalFacts(first.session.id).length, 0, 'rejection changes nothing');
    const id = first.session.id;
    await first.session.close();
    const replayed = loadCanonicalConversation(id, sessionsRoot).history as any[];
    assert.ok(
      replayed.some((item) => item.type === 'function_call' && item.name === 'propose_goal'),
      'the rejected call is durable in canonical replay',
    );
    const reopened = await open(id);
    script = [propose('Second try'), 'final'];
    await reopened.submission.submit({ requestId: 't2', input: { text: 'keep going' } });
    await reopened.settled('t2');
    const secondTurn = reopened.facts.find((fact) => fact.type === 'session_admitted' && fact.clientRequestId === 't2');
    assert.equal(
      reopened.facts.filter((fact) => fact.type === 'session_interaction_pending' && fact.turnId === secondTurn.turnId)
        .length,
      0,
      'the refused proposal never reaches the approval surface',
    );
    assert.match(lastToolOutput(), /a proposal was already made this session/);
    assert.equal(goalFacts(id).length, 0);
    await reopened.session.close();
    console.log('PASS propose-reject: a rejected proposal survives reopen and refuses a second one unprompted');
  } else throw new Error(`unknown PROBE_MODE ${mode}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
