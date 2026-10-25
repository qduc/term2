import process from 'node:process';
import console from 'node:console';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.env.SOURCE_ROOT || process.cwd());
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createSessionRuntimeInternals, buildSessionRuntime } = await load(
  'source/services/session/session-composition.ts',
);
const { ToolOwnershipRegistry } = await load('source/services/approval/tool-ownership-registry.ts');
const { ApplicationRunLoop } = await load('source/services/agent-runtime/application-run-loop.ts');
const { setConversationsDirForTest, readConversationLogEnvelopes } = await load(
  'source/services/conversation/conversation-persistence.ts',
);
const { createConversationLogWriter } = await load('source/services/logging/conversation-log-writer.ts');
const { replayEvents } = await load('source/services/conversation/conversation-replay.ts');
const dir = fs.mkdtempSync(path.join(process.env.OCCURRENCE_EVIDENCE_DIR, 'adapter-'));
const observations = [];
for (const variant of ['distinct', 'reused', 'identical', 'three-reused'])
  for (const settled of [false, true]) {
    const reused = variant !== 'distinct',
      identical = variant === 'identical';
    const width = variant === 'three-reused' ? 3 : 1;
    const expected = width * 2;
    const name = `${variant}-${settled ? 'final' : 'cut'}`;
    const warnings = [];
    const logger = {
      getCorrelationId: () => undefined,
      warn: (...x) => warnings.push(x),
      debug() {},
      info() {},
      error() {},
    };
    let loop, agent;
    const client = {
      getProvider: () => 'openai',
      getModel: () => 'fixture',
      abort() {
        loop?.abort();
      },
      addToolInterceptor: () => () => {},
      async runTurn(session) {
        await loop.runTurn({
          ...session,
          async prepare(signal) {
            const p = await session.prepare(signal);
            return p ? { ...p, agent, options: { ...p.options, maxTurns: 4, providerId: 'openai' } } : undefined;
          },
        });
      },
    };
    const internals = createSessionRuntimeInternals({
      sessionId: name,
      agentClient: client,
      toolOwnership: new ToolOwnershipRegistry(),
      deps: { logger, sessionContextService: {} },
    });
    let writer;
    try {
      const runtime = buildSessionRuntime(internals),
        record = internals.record;
      const file = path.join(dir, name + '.jsonl');
      writer = createConversationLogWriter({ sessionId: name, dir, logger, saveLast: () => {} });
      writer.init({ id: name, createdAt: new Date().toISOString(), projectPath: dir });
      runtime.logs.setLogSink((event) => writer.append(event));
      let body = 0,
        round = 0,
        resolveProjected;
      const secondProjected = new Promise((r) => {
        resolveProjected = r;
      });
      const requests = [],
        projected = [],
        errors = [];
      agent = {
        name: 'offline',
        model: 'fixture',
        instructions: 'Offline occurrence fixture',
        tools: [
          {
            name: 'fake',
            parameters: { type: 'object', properties: {} },
            effect: 'read',
            parallelSafe: false,
            needsApproval: async () => false,
            execute: async () => {
              const i = body++;
              return `turn-result-${identical ? 0 : i}`;
            },
          },
        ],
      };
      const model = {
        async *stream(request) {
          requests.push(JSON.parse(JSON.stringify(request)));
          const i = round++;
          if (i < 2) {
            const calls = Array.from({ length: width }, (_, j) => ({
              type: 'tool_call',
              id: reused ? `same-${j}` : `call-${i}-${j}`,
              name: 'fake',
              arguments: JSON.stringify({ iteration: identical ? 0 : i * width + j }),
            }));
            for (const call of calls) yield call;
            yield { type: 'completion', responseId: `response-${i}`, output: calls };
          } else {
            if (!settled) {
              await secondProjected;
              await writer.flush();
              fs.copyFileSync(file, path.join(dir, name + '-prefix.jsonl'));
              throw new Error('OFFLINE_CUT_BEFORE_FINAL');
            }
            yield {
              type: 'completion',
              responseId: 'response-final',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
            };
          }
        },
      };
      loop = new ApplicationRunLoop({ resolveModel: () => model });
      try {
        for await (const e of runtime.turns.start('synthetic full-turn occurrence fixture', { maxModelRetries: 0 })) {
          projected.push(e);
          runtime.logs.dispatchEventToLog(e);
          if (projected.filter((x) => x.type === 'command_message').length === expected) resolveProjected();
        }
      } catch (error) {
        errors.push({ name: error.name, message: error.message });
      }

      await writer.flush();
      setConversationsDirForTest(dir);
      const envelopes = readConversationLogEnvelopes(settled ? name : name + '-prefix');
      assert(envelopes);
      assert.equal(
        envelopes.some((envelope) => envelope.event.type === 'assistant_turn'),
        settled,
        'native final/cut boundary',
      );
      assert(
        envelopes.every((envelope) => envelope.logId && envelope.eventId),
        'native envelope identities',
      );
      if (!settled) {
        const prefix = fs.readFileSync(path.join(dir, name + '-prefix.jsonl'));
        assert(fs.readFileSync(file).subarray(0, prefix.length).equals(prefix), 'exact native byte prefix');
      }
      const replay = replayEvents(envelopes);
      fs.writeFileSync(path.join(dir, name + '-replay.json'), JSON.stringify(replay, null, 2));
      // Fresh loop and model: capture the actual next application model request.
      const resumed = [];
      const nextLoop = new ApplicationRunLoop({
        resolveModel: () => ({
          async *stream(r) {
            resumed.push(JSON.parse(JSON.stringify(r)));
            yield {
              type: 'completion',
              responseId: 'offline-resumed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'offline resumed' }] }],
            };
          },
        }),
      });
      const nextClient = {
        getProvider: () => 'openai',
        getModel: () => 'fixture',
        abort() {
          nextLoop.abort();
        },
        addToolInterceptor: () => () => {},
        async runTurn(session) {
          await nextLoop.runTurn({
            ...session,
            async prepare(signal) {
              const p = await session.prepare(signal);
              return p
                ? { ...p, agent: { ...agent, tools: [] }, options: { ...p.options, maxTurns: 1, providerId: 'openai' } }
                : undefined;
            },
          });
        },
      };
      const fresh = createSessionRuntimeInternals({
        sessionId: name + '-resumed',
        agentClient: nextClient,
        toolOwnership: new ToolOwnershipRegistry(),
        deps: { logger, sessionContextService: {} },
      });
      try {
        fresh.record.importState({ history: replay.history, toolLedger: replay.toolLedger, previousResponseId: null });
        const freshRuntime = buildSessionRuntime(fresh);
        for await (const event of freshRuntime.turns.start('offline resume', { maxModelRetries: 0 })) {
          assert.notEqual(event.type, 'approval_required', 'resume must reach model without surge confirmation');
        }
        assert.equal(resumed.length, 1);
      } finally {
        fresh.dispose();
      }

      const observation = {
        name,
        reused,
        settled,
        identical,
        expected,
        body,
        requests,
        projected,
        errors,
        memory: record.exportToolEvidence(),
        replay,
        resumed,
        warnings,
      };
      observations.push(observation);
      fs.writeFileSync(path.join(dir, 'observations.json'), JSON.stringify(observations, null, 2));
      assert.equal(body, expected);
      assert.equal(observation.memory.length, expected);
      assert.equal(requests.length, 3);
      assert(JSON.stringify(requests[2].input).includes(`turn-result-${identical ? 0 : expected - 1}`));
      assert(JSON.stringify(replay.messages).includes(`turn-result-${identical ? 0 : expected - 1}`));
      if (process.env.ASSERT_PRESERVATION === '1')
        assert.equal(replay.toolLedger.length, observation.memory.length, 'full occurrence preservation: ' + name);
      assert.equal(
        JSON.stringify(replay.history).includes(`turn-result-${identical ? 0 : expected - 1}`),
        process.env.ASSERT_PRESERVATION === '1' || !reused || settled,
      );
      assert.equal(
        JSON.stringify(resumed[0].input).includes(`turn-result-${identical ? 0 : expected - 1}`),
        process.env.ASSERT_PRESERVATION === '1' || !reused || settled,
      );
      assert.equal(projected.filter((e) => e.type === 'command_message').length, expected);
      assert.equal(
        replay.toolLedger.length,
        process.env.ASSERT_PRESERVATION === '1' ? expected : reused ? 1 : expected,
        'full occurrence preservation: ' + name,
      );

      for (const [index, entry] of replay.toolLedger.entries()) {
        assert.equal(entry.output, `turn-result-${identical ? 0 : index}`, 'output/occurrence pairing ' + name);
        assert.deepEqual(JSON.parse(entry.arguments), { iteration: identical ? 0 : index });
        const own = entry.historyItems.filter((x) => x.type?.includes('function_call'));
        assert.equal(own.length, 2);
        assert.equal(own[1].output, entry.output);
        assert.equal(own[0].arguments, entry.arguments);
        assert.equal(entry.occurrence, reused ? Math.floor(index / width) + 1 : 1);
      }
      const nextTools = resumed[0].input.filter((x) => x.type === 'tool_call' || x.type === 'tool_result');
      assert.equal(nextTools.length, expected * 2, 'actual next request full cardinality ' + name);
      const nextCalls = nextTools.filter((x) => x.type === 'tool_call'),
        nextResults = nextTools.filter((x) => x.type === 'tool_result');
      for (let i = 0; i < expected; i++) {
        assert.deepEqual(JSON.parse(nextCalls[i].arguments), { iteration: identical ? 0 : i });
        assert.equal(nextResults[i].output, `turn-result-${identical ? 0 : i}`);
        assert.equal(nextCalls[i].id, nextResults[i].id);
        assert(nextTools.indexOf(nextCalls[i]) < nextTools.indexOf(nextResults[i]));
        assert(!('occurrence' in nextCalls[i]));
      }
      assert.equal(body, expected, 'restart never executes a tool');
      console.log(
        JSON.stringify({
          name,
          body,
          memory: observation.memory.length,
          ledger: replay.toolLedger.length,
          historyLatest: JSON.stringify(replay.history).includes(`turn-result-${identical ? 0 : expected - 1}`),
          nextRequestLatest: JSON.stringify(resumed[0].input).includes(`turn-result-${identical ? 0 : expected - 1}`),
          errors,
        }),
      );
    } finally {
      internals.dispose();
      await writer?.close();
    }
  }
console.log(JSON.stringify({ dir, sourceRoot: root }));
if (process.env.ASSERT_PRESERVATION === '1')
  for (const o of observations) {
    assert.equal(o.replay.toolLedger.length, o.memory.length, 'full occurrence preservation: ' + o.name);
    for (let i = 0; i < o.expected; i++)
      assert(
        JSON.stringify(o.replay.history).includes(`turn-result-${o.identical ? 0 : i}`),
        'history occurrence ' + i + ' ' + o.name,
      );
  }
