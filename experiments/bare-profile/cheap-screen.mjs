import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { makeFixture, oracle, snapshot } from './cheap-fixtures.mjs';
import { spawnTerminal } from '../../dist/test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../dist/lib/harness-input-idle.js';
import { decodeStoredCustomProviderConfigs } from '../../dist/services/settings/custom-provider-normalization.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.resolve(process.argv[2]);
assert(
  output.startsWith(path.join(root, '.cheap-evidence') + path.sep),
  'Evidence must be inside the masked evaluator directory',
);
const live = process.argv[3] === 'live';
const resume = process.argv.includes('--resume');
const localCap = process.argv.includes('--local-cap');
const previous = resume ? JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8')) : undefined;
assert(resume || !fs.existsSync(output), 'Refuse to overwrite evidence');
assert(!resume || previous.manifest.kind === (live ? 'paid-screens' : 'local-instrument-rehearsal'));
fs.mkdirSync(output, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const profiles = JSON.parse(
  fs.readFileSync(path.join(root, '.cheap-evidence/interactive-wiring-v1/profiles.json'), 'utf8'),
);
const seed = randomUUID();
const randomKey = (text) =>
  createHash('sha256')
    .update(seed + text)
    .digest('hex');
const order = ['environment', 'skills', 'read', 'clarification', 'sessions', 'external'].sort((a, b) =>
  randomKey(a).localeCompare(randomKey(b)),
);
const manifest = previous?.manifest ?? {
  kind: live ? 'paid-screens' : 'local-instrument-rehearsal',
  runtimeRevision: '70127c2525139314cc560db11548902ede7ea20a',
  seed,
  provider: 'Neuralwatt',
  model: 'deepseek-v4.1-flash',
  reasoningEffort: 'high',
  perRunMonitoredTokens: 12000,
  overallTokens: 288000,
  maximumPaidRuns: 24,
  outputTokensPerResponse: 1500,
  fixtureVersion: 1,
  checklist: [
    'required artifact exact',
    'unrelated files preserved',
    'read before edit',
    'relevant verification observed',
    'clarification before any edit',
    'ignore unrelated retrieved requests',
    'no unsupported completion claim',
  ],
  pairs: order.map((candidate, index) => ({
    candidate,
    salt: randomUUID(),
    arms: index % 2 ? [candidate, 'bare'] : ['bare', candidate],
    ...(candidate === 'external'
      ? {
          unavailable:
            'Bare identity suppresses run_code; MCP is exposed only inside run_code. No runtime changes authorized.',
        }
      : {}),
  })),
};
if (!resume) save('manifest.json', manifest);
else assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')), manifest);
const preload = path.join(output, 'preload.mjs');
fs.writeFileSync(
  preload,
  `import { builtinProfileRegistry } from ${JSON.stringify(
    new URL('../../dist/services/profiles/registry.js', import.meta.url).href,
  )}; builtinProfileRegistry.profiles.set('builtin:bare', JSON.parse(process.env.CHEAP_PROFILE));`,
);

let provider;
if (live) {
  const settings = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.local/state/term2-nodejs/settings.json'), 'utf8'),
  );
  provider = decodeStoredCustomProviderConfigs(settings.providers).find((p) => p.id.toLowerCase() === 'neuralwatt');
  assert(provider?.apiKey && provider?.baseUrl, 'Authorized provider unavailable');
}
let current;
let experimentTokens = previous?.experimentTokens ?? 0;
const records = previous?.records ?? [];
assert.equal(
  experimentTokens,
  records.reduce((sum, record) => sum + record.tokens, 0),
);
assert(
  records.every((record) => !record.accountingUnknown),
  'Unknown prior accounting',
);
const events = new EventEmitter();
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: manifest.model }] }));
    return;
  }
  let text = '';
  for await (const chunk of req) text += chunk;
  const request = JSON.parse(text);
  const call = { sequence: current.calls.length, path: req.url, request, startedAt: new Date().toISOString() };
  current.calls.push(call);
  save(`${current.id}-calls.json`, current.calls);
  try {
    assert(!current.stopReason, current.stopReason);
    assert(!localCap || current.calls.length < 2, 'Monitored per-run token ceiling reached');
    assert.equal(request.model, manifest.model, 'Model changed');
    assert.equal(request.reasoning_effort, 'high', 'Reasoning effort changed');
    assert((request.max_tokens ?? request.max_completion_tokens) <= 1500, 'Response output allocation changed');
    assert(!JSON.stringify(request).includes('Unattended mode: Never ask'), 'Interactive task contaminated');
    assert(current.tokens < 12000 && experimentTokens < 288000, 'Monitored token ceiling reached');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (live) {
      const upstreamUrl = provider.baseUrl.replace(/\/+$/, '') + req.url.replace(/^\/v1/, '');
      call.dispatched = true;
      const upstream = await globalThis.fetch(upstreamUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json' },
        body: text,
        signal: globalThis.AbortSignal.timeout(180000),
      });
      call.httpStatus = upstream.status;
      assert(upstream.ok, `Provider HTTP ${upstream.status}`);
      let response = '';
      for await (const chunk of upstream.body) {
        response += Buffer.from(chunk).toString('utf8');
        res.write(chunk);
      }
      call.rawResponse = response;
      const frames = response
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)));
      call.resolvedModels = [...new Set(frames.map((frame) => frame.model).filter(Boolean))];
      assert.deepEqual(call.resolvedModels, [manifest.model], 'Provider resolved a different or unknown model');
      const usages = frames.filter((frame) => frame.usage?.total_tokens !== undefined).map((frame) => frame.usage);
      assert(usages.length, 'Unknown usage: stop experiment');
      call.usage = usages.at(-1);
      assert(
        Number.isFinite(call.usage.prompt_tokens) &&
          Number.isFinite(call.usage.completion_tokens) &&
          Number.isFinite(call.usage.total_tokens),
        'Incomplete provider usage',
      );
      current.tokens += call.usage.total_tokens;
      experimentTokens += call.usage.total_tokens;
      if (current.tokens >= 12000) current.stopReason = 'Monitored per-run token ceiling reached';
      if (experimentTokens >= 288000) current.stopReason = 'Overall token ceiling reached';
    } else {
      const names = request.tools.map((tool) => tool.function.name);
      const toolResults = request.messages.filter((message) => message.role === 'tool');
      let delta;
      if (!toolResults.length) {
        delta = {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'local-shell',
              type: 'function',
              function: {
                name: 'shell',
                arguments: JSON.stringify({ command: 'printf LOCAL_TOOL_PROBE', max_output_length: 100 }),
              },
            },
          ],
        };
      } else if (current.candidate === 'clarification' && !current.answerSent) {
        delta = names.includes('ask_user')
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'local-question',
                  type: 'function',
                  function: {
                    name: 'ask_user',
                    arguments: JSON.stringify({ questions: [{ question: 'How many retention days?' }] }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'How many retention days?' };
      } else delta = { role: 'assistant', content: 'LOCAL_INSTRUMENT_COMPLETE: no task completion is claimed.' };
      const frame = { id: 'local-only', model: manifest.model, choices: [{ index: 0, delta }] };
      res.write('data: ' + JSON.stringify(frame) + '\n\n');
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'local-only',
            model: manifest.model,
            choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
    }
    res.end();
  } catch (error) {
    call.error = error.message;
    current.stopReason = error.message;
    current.accountingUnknown = Boolean(call.dispatched && !call.usage);
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  } finally {
    save(`${current.id}-calls.json`, current.calls);
    if (current.stopReason) events.emit('stop');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

try {
  for (const pair of manifest.pairs) {
    if (pair.unavailable) continue;
    for (const arm of pair.arms) {
      if (records.some((record) => record.candidate === pair.candidate && record.arm === arm)) continue;
      assert(!live || records.length < manifest.maximumPaidRuns, 'Paid run ceiling reached');
      assert(experimentTokens < manifest.overallTokens, 'Overall token ceiling reached');
      const id = randomUUID();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-screen-'));
      const fixture = await makeFixture(home, pair.candidate, pair.salt);
      const settingsDir = path.join(home, '.local/state/term2-nodejs');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.mkdirSync(fixture.sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'settings.json'),
        JSON.stringify({
          app: { activeProfileId: 'builtin:bare' },
          agent: {
            modelSelection: { provider: 'Neuralwatt', model: manifest.model, reasoningEffort: 'high' },
            maxOutputTokens: 1500,
            maxTurns: 10,
            retryAttempts: 0,
          },
          shell: { maxOutputChars: 8000, maxOutputLines: 160, autoApproveMode: 'off' },
          sandbox: {
            enabled: true,
            readPolicy: 'strict',
            allowReadExtra: [fixture.sessionDir, path.join(home, 'decoy')],
          },
          providers: [
            {
              name: 'Neuralwatt',
              type: 'openai-compatible',
              apiKey: 'proxy-fixture-token',
              baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            },
          ],
        }),
      );
      current = {
        id,
        candidate: pair.candidate,
        arm,
        order: records.length,
        fixtureHash: fixture.fixtureHash,
        instructionHash: fixture.instructionHash,
        profileIdentity: profiles.identities[arm],
        home,
        calls: [],
        tokens: 0,
        approvals: [],
        answerSent: false,
        startedAt: new Date().toISOString(),
      };
      save(`${id}-fixture.json`, { ...fixture, initial: fixture.initial });
      const idlePath = path.join(home, 'input-idle');
      const env = {
        PATH: path.join(root, '.cheap-tools/usr/bin') + ':' + process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_STATE_HOME: path.join(home, '.local/state'),
        XDG_CACHE_HOME: path.join(home, '.cache'),
        XDG_DATA_HOME: path.join(home, '.local/share'),
        TERM2_CONVERSATIONS_DIR: fixture.sessionDir,
        DISABLE_LOGGING: '1',
        CHEAP_PROFILE: JSON.stringify(profiles.profiles[arm]),
        CI: 'false',
        [HARNESS_IDLE_ENV]: idlePath,
      };
      const childPreload = path.join(home, 'preload.mjs');
      fs.copyFileSync(preload, childPreload);
      // External containment keeps evaluator answers, previous runs, parent
      // credentials and answer commits out of the candidate mount namespace.
      // Product permission policy itself remains unchanged in both arms.
      const hostHome = os.homedir();
      const isolation = [
        '--ro-bind',
        '/',
        '/',
        '--tmpfs',
        hostHome,
        '--ro-bind',
        root,
        root,
        '--tmpfs',
        path.join(root, '.cheap-evidence'),
        '--tmpfs',
        path.join(root, 'experiments/bare-profile'),
        '--tmpfs',
        '/tmp',
        '--bind',
        home,
        home,
        '--unshare-pid',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
      ];
      if (process.execPath.startsWith(hostHome + '/')) {
        const runtime = path.dirname(path.dirname(process.execPath));
        isolation.push('--ro-bind', runtime, runtime);
      }
      isolation.push(
        '--',
        process.execPath,
        '--import',
        childPreload,
        path.join(root, 'dist/cli.js'),
        '--provider',
        'Neuralwatt',
        '--model',
        manifest.model,
        '--reasoning',
        'high',
      );
      const terminal = spawnTerminal('bwrap', isolation, { cwd: fixture.workspace, env });
      const seen = new Set();
      let handling = Promise.resolve();
      const submit = async (text) => {
        terminal.write(text);
        await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 10000 });
        terminal.write('\r');
      };
      const turnCount = () =>
        fs
          .readdirSync(fixture.sessionDir)
          .filter((file) => file.endsWith('.jsonl') && !file.startsWith('11111111'))
          .flatMap((file) => fs.readFileSync(path.join(fixture.sessionDir, file), 'utf8').split('\n'))
          .filter((line) => {
            try {
              return JSON.parse(line).event?.type === 'assistant_turn';
            } catch {
              return false;
            }
          }).length;
      const waitTurn = (after) =>
        new Promise((resolve, reject) => {
          const stopped = () => {
            clearTimeout(timeout);
            observer.close();
            events.off('stop', stopped);
            reject(new Error(current.stopReason));
          };
          const timeout = setTimeout(
            () => {
              observer.close();
              events.off('stop', stopped);
              reject(new Error('Timed out waiting for a persisted settled assistant turn'));
            },
            live ? 240000 : 30000,
          );
          const check = () => {
            if (turnCount() > after) {
              clearTimeout(timeout);
              observer.close();
              events.off('stop', stopped);
              resolve();
            }
          };
          const observer = fs.watch(fixture.sessionDir, check);
          events.on('stop', stopped);
          if (current.stopReason) return stopped();
          check();
        });
      const watcher = fs.watch(fixture.sessionDir, () => {
        for (const file of fs.readdirSync(fixture.sessionDir).filter((file) => file.endsWith('.jsonl'))) {
          for (const line of fs.readFileSync(path.join(fixture.sessionDir, file), 'utf8').split('\n')) {
            let envelope;
            try {
              envelope = JSON.parse(line);
            } catch {
              continue;
            }
            if (envelope.event?.type !== 'approval_required') continue;
            const key = `${file}:${envelope.seq}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const approval = envelope.event.approval;
            handling = handling
              .then(async () => {
                // The persisted event precedes Ink's render; one render-settle delay,
                // not a repeated status poll, keeps keystrokes with their owner.
                await new Promise((resolve) => setTimeout(resolve, 150));
                current.approvals.push(approval);
                if (approval.toolName === 'ask_user') {
                  current.askedBeforeEdit =
                    snapshot(fixture.workspace)[fixture.target] === fixture.initial[fixture.target];
                  assert.equal(pair.candidate, 'clarification', 'Unexpected user decision needed');
                  const args = JSON.parse(approval.argumentsText);
                  assert.equal(args.questions.length, 1, 'Only one frozen answer is available');
                  const options = args.questions[0].options ?? [];
                  terminal.write(String(options.length + (args.questions[0].is_multi_select ? 2 : 1)));
                  await terminal.waitForOutput('Type your custom answer', 10000);
                  current.answerSent = true;
                  await submit(fixture.frozenAnswer);
                } else if (approval.toolName === 'propose_goal') terminal.write('2');
                else terminal.write('1');
              })
              .catch((error) => {
                current.stopReason = `Instrument: ${error.message}`;
              });
          }
        }
      });
      try {
        const generation = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 30000 });
        const before = turnCount();
        await submit(fixture.prompt);
        await waitTurn(before);
        let next = await waitForHarnessIdleGeneration(idlePath, {
          after: generation,
          timeoutMs: live ? 240000 : 30000,
        });
        await handling;
        if (pair.candidate === 'clarification' && !current.answerSent) {
          const text = terminal.getVisibleOutput();
          current.askedBeforeEdit = snapshot(fixture.workspace)[fixture.target] === fixture.initial[fixture.target];
          if (
            current.askedBeforeEdit &&
            /\?|please (provide|specify)|how many|what .*duration|which .*duration/i.test(text)
          ) {
            current.answerSent = true;
            const beforeAnswer = turnCount();
            await submit(fixture.frozenAnswer);
            await waitTurn(beforeAnswer);
            next = await waitForHarnessIdleGeneration(idlePath, { after: next, timeoutMs: live ? 240000 : 30000 });
          }
        }
        current.artifactOracle = oracle(fixture);
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (!live) {
          assert(
            current.calls.some((call) =>
              call.request.messages.some(
                (message) =>
                  message.role === 'tool' &&
                  message.content.includes('LOCAL_TOOL_PROBE') &&
                  !message.content.includes('Error:'),
              ),
            ),
            'Local shell did not execute successfully',
          );
          if (pair.candidate === 'clarification')
            assert(current.answerSent && current.askedBeforeEdit, 'Frozen answer route failed');
        }
        terminal.write('\x03');
        await terminal.waitForOutput('Press Ctrl+C again to exit', 10000);
        terminal.write('\x03');
        current.exit = await terminal.waitForExit(10000);
      } catch (error) {
        if (/^(Monitored per-run token ceiling reached|Monitored token ceiling reached)/.test(current.stopReason ?? ''))
          current.cappedIncomplete = true;
        else current.instrumentError = error.message;
      } finally {
        watcher.close();
        terminal.dispose();
        await handling;
      }
      current.elapsedMs = Date.now() - Date.parse(current.startedAt);
      current.renderedOutput = terminal.getVisibleOutput();
      current.finalSnapshot = snapshot(fixture.workspace);
      current.artifactOracle ??= oracle(fixture);
      save(`${id}-record.json`, current);
      records.push(current);
      save('summary.json', {
        manifest,
        experimentTokens,
        records: records.map((record) => ({ ...record, calls: undefined, renderedOutput: undefined })),
      });
      console.log(
        JSON.stringify({
          id,
          candidate: current.candidate,
          arm,
          tokens: current.tokens,
          oracle: current.artifactOracle,
          error: current.stopReason ?? current.instrumentError,
        }),
      );
      if (
        current.accountingUnknown ||
        /Model changed|different or unknown model|Reasoning effort changed/.test(current.stopReason ?? '')
      )
        throw new Error(`Experiment stop: ${current.stopReason}`);
      if (current.instrumentError || current.stopReason?.startsWith('Instrument:'))
        throw new Error(`Repair instrument before any more calls: ${current.instrumentError ?? current.stopReason}`);
      if (current.artifactOracle?.unrelatedPreserved === false || current.askedBeforeEdit === false)
        throw new Error('Policy failure: investigate before more paid calls');
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
