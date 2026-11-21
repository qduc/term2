import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import {
  GROK_CONSTANT_CLIENT_VERSION,
  GROK_FIXTURE_ACCESS_TOKEN,
  GROK_FIXTURE_MODEL,
  TOOL_CALL_ID,
  createdFrame,
  grokConfigDir,
  grokEnvironment,
  grokSettings,
  inputItems,
  sendSse,
  startGrokFixtureServer,
  startRefusingProxy,
  textFrames,
  toolCallFrames,
  toolResultItems,
  writeGrokCredentials,
  writeGrokVersionCache,
  type GrokCapturedRequest,
  type GrokFixtureServer,
  type RefusingProxy,
} from './grok-fixture.js';
import {
  createIsolatedWorkspaceLease,
  writePtyTextAndSubmit,
  type IsolatedWorkspaceLease,
  type PtyChildDriver,
} from './provider-test-harness.js';

/**
 * Grok lifecycle through the shipped CLI, on the default lane: OpenAI Responses
 * over HTTP to a loopback stand-in for the CLI chat proxy. Grok is a stateless
 * Responses route (`supportsConversationChaining: false`: the real proxy answers
 * `previous_response_id` with a Zero Data Retention 404), so "two-turn
 * continuity" here means full-history replay, and the assertion that matters is
 * that nothing chains. The Grok-specific header/version/outdated-client cases
 * live in provider-session-grok-client.blackbox.ts.
 */

export { GROK_CAPABILITY_EXECUTIONS as EXECUTED_CAPABILITY_SCENARIO_IDS } from './provider-session-capability-manifest.js';

const VERSION_FIXTURE = '4.5.6';
const APPROVE_CALL_ID = 'call-grok-approve';
const REJECT_CALL_ID = 'call-grok-reject';

type Mode = 'lifecycle' | 'native-error' | 'incomplete';

let server: GrokFixtureServer | undefined;
let proxy: RefusingProxy | undefined;
let workspace: IsolatedWorkspaceLease | undefined;
let child: PtyChildDriver | undefined;

afterEach(async () => {
  await child?.cleanup({ timeoutMs: 2_000 }).catch(() => undefined);
  await workspace?.cleanup().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  child = workspace = proxy = server = undefined;
});

describe('Grok lifecycle through the shipped CLI (Responses over HTTP, stateless)', () => {
  it('grok-http.two-user-turn replays full history on turn two and never chains', async () => {
    await start('lifecycle');
    await sendUserTurn('first user turn', 'first-response');
    await sendUserTurn('second user turn', 'second-response');

    const requests = server!.requests;
    expect(requests).toHaveLength(2);
    assertEveryRequestIsGrokShaped(requests);
    // The proxy is a Zero Data Retention org: a chained request would 404 there.
    for (const request of requests) expect(request.body.previous_response_id, 'previous_response_id').toBeUndefined();
    expect(userTexts(requests[0]!)).toEqual(['first user turn']);
    // Turn two carries the whole conversation, in order, because nothing is stored server-side.
    const replay = JSON.stringify(inputItems(requests[1]!));
    expect(replay.indexOf('first user turn')).toBeGreaterThan(-1);
    expect(replay.indexOf('first-response')).toBeGreaterThan(replay.indexOf('first user turn'));
    expect(replay.indexOf('second user turn')).toBeGreaterThan(replay.indexOf('first-response'));
    expect(userTexts(requests[1]!)).toEqual(['first user turn', 'second user turn']);
  });

  it('grok-http.approval-approve resumes an approved tool with its result and no chaining', async () => {
    await start('lifecycle');
    await sendApprovalTurn('approve this tool', 'approved-response', 'y');

    const requests = server!.requests;
    expect(requests).toHaveLength(2);
    assertEveryRequestIsGrokShaped(requests);
    const resume = requests[1]!;
    expect(resume.body.previous_response_id).toBeUndefined();
    const calls = inputItems(resume).filter((item) => item.type === 'function_call');
    expect(calls.map((item) => [item.call_id, item.name])).toEqual([[APPROVE_CALL_ID, 'shell']]);
    const results = toolResultItems(resume);
    expect(results.map((item) => item.call_id)).toEqual([APPROVE_CALL_ID]);
    // `pwd` really ran in the isolated workspace: the approved result is the command's output.
    expect(JSON.stringify(results[0])).toContain(workspace!.root);
    expect(child!.getVisibleOutput()).not.toContain('Approval Rejected');
  });

  it('grok-http.approval-reject resumes a rejected tool with the user reason, once', async () => {
    await start('lifecycle');
    await sendApprovalTurn('reject this tool', 'rejected-response', 'n');

    const requests = server!.requests;
    expect(requests).toHaveLength(2);
    assertEveryRequestIsGrokShaped(requests);
    const resume = requests[1]!;
    expect(resume.body.previous_response_id).toBeUndefined();
    const results = toolResultItems(resume);
    expect(results.map((item) => item.call_id)).toEqual([REJECT_CALL_ID]);
    expect(JSON.stringify(results[0])).toContain('black-box rejection');
    expect(JSON.stringify(results[0])).not.toContain(workspace!.root);
  });

  it('grok-http.native-error surfaces a response.failed event and fabricates no completion', async () => {
    await start('native-error');
    await submitPrompt('exercise native error');
    await child!.waitForVisibleOutput('Injected native provider failure', 20_000);
    // Text that arrived before the failure is not promoted to an answer.
    expect(child!.getVisibleOutput()).not.toContain('PARTIAL');
    expect(server!.requests).toHaveLength(1);
    assertEveryRequestIsGrokShaped(server!.requests);
  });

  it('grok-http.incomplete-stream rejects a stream that ends without a terminal event', async () => {
    await start('incomplete');
    await submitPrompt('exercise the truncated case');
    // The shared Responses adapter's wording names no provider.
    await child!.waitForVisibleOutput('Streamed response ended without a completion.', 20_000);
    const visible = child!.getVisibleOutput();
    // The partial text was not promoted to an answer.
    expect(visible).not.toContain('PARTIAL');
    expect(server!.requests).toHaveLength(1);
  });
});

/* ---- scenario plumbing -------------------------------------------------- */

async function start(mode: Mode): Promise<void> {
  server = await startGrokFixtureServer((request, _number, response) => reply(mode, request, response));
  proxy = await startRefusingProxy();
  workspace = await createIsolatedWorkspaceLease({
    prefix: `term2-grok-${mode}-`,
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(join(paths.logDir, 'settings.json'), grokSettings());
      await writeGrokCredentials(grokConfigDir(paths));
      // A fresh cache answers the version lookup without leaving the machine.
      await writeGrokVersionCache(paths.cacheDir, VERSION_FIXTURE, 0);
    },
  });
  child = await workspace.start({
    command: process.execPath,
    // --lite: workspace.root is HOME and the CLI blocks interactive non-lite starts in the home directory.
    args: [
      testCliPath(join(process.cwd(), 'dist/cli.js')),
      '--lite',
      '--provider',
      'grok',
      '--model',
      GROK_FIXTURE_MODEL,
    ],
    cwd: workspace.root,
    env: grokEnvironment(workspace.paths, { server, proxy }),
    cols: 120,
    rows: 40,
  });
  await child.waitForIdleInput();
}

function reply(mode: Mode, request: GrokCapturedRequest, response: import('node:http').ServerResponse): void {
  const requestNumber = server!.requests.length;
  if (mode === 'native-error') {
    sendSse(response, [
      createdFrame('resp-grok-native-error'),
      { type: 'response.output_text.delta', delta: 'PARTIAL' },
      {
        type: 'response.failed',
        response: {
          id: 'resp-grok-native-error',
          status: 'failed',
          output: [],
          error: { code: 'fixture_error', message: 'Injected native provider failure' },
        },
      },
    ]);
    return;
  }
  if (mode === 'incomplete') {
    // Text, then the stream just ends: no response.completed / failed / incomplete.
    sendSse(response, [createdFrame('resp-grok-incomplete'), { type: 'response.output_text.delta', delta: 'PARTIAL' }]);
    return;
  }
  const results = toolResultItems(request);
  if (results.length > 0) {
    const rejected = JSON.stringify(results.at(-1)).includes('black-box rejection');
    sendSse(response, textFrames(`resp-grok-${requestNumber}`, rejected ? 'rejected-response' : 'approved-response'));
    return;
  }
  const prompt = userTexts(request).at(-1) ?? '';
  if (prompt.startsWith('approve this'))
    sendSse(response, toolCallFrames(`resp-grok-${requestNumber}`, APPROVE_CALL_ID));
  else if (prompt.startsWith('reject this'))
    sendSse(response, toolCallFrames(`resp-grok-${requestNumber}`, REJECT_CALL_ID));
  else
    sendSse(
      response,
      textFrames(`resp-grok-${requestNumber}`, prompt.startsWith('first') ? 'first-response' : 'second-response'),
    );
}

async function submitPrompt(text: string): Promise<void> {
  await writePtyTextAndSubmit(child!, text);
}

async function sendUserTurn(prompt: string, expected: string): Promise<void> {
  const idle = child!.readIdleGeneration();
  await submitPrompt(prompt);
  await child!.waitForVisibleOutput(expected);
  await child!.waitForIdleInput({ after: idle });
}

async function sendApprovalTurn(prompt: string, expected: string, decision: 'y' | 'n'): Promise<void> {
  const idle = child!.readIdleGeneration();
  await submitPrompt(prompt);
  await child!.waitForVisibleOutput('Allow this action?');
  // ApprovalPrompt takes y/n as single-key shortcuts, not as a submitted line.
  await child!.write(decision);
  if (decision === 'n') {
    await child!.waitForVisibleOutput('Why?');
    await submitPrompt('black-box rejection');
  }
  await child!.waitForVisibleOutput(expected);
  await child!.waitForIdleInput({ after: idle });
}

function userTexts(request: GrokCapturedRequest): string[] {
  return inputItems(request)
    .filter((item) => item.role === 'user' && item.type !== 'function_call_output')
    .map((item) =>
      typeof item.content === 'string'
        ? item.content
        : (item.content as Array<{ text?: string }>).map((part) => part.text ?? '').join(''),
    );
}

/** What every Grok request must look like, whichever turn it belongs to. */
function assertEveryRequestIsGrokShaped(requests: readonly GrokCapturedRequest[]): void {
  const conversationIds = new Set<string>();
  for (const request of requests) {
    // GROK_BASE_URL was honoured: the request reached the loopback route, not cli-chat-proxy.grok.com.
    expect(request.method).toBe('POST');
    expect(request.url, 'request path on the GROK_BASE_URL loopback').toBe('/v1/responses');
    expect(request.body.model).toBe(GROK_FIXTURE_MODEL);
    expect(request.body.stream).toBe(true);
    // The credential came from the token file, via the real token manager.
    expect(request.headers.authorization).toBe(`Bearer ${GROK_FIXTURE_ACCESS_TOKEN}`);
    // The version cache fixture, not the constant fallback, answered the lookup.
    expect(request.headers['x-grok-client-version'], 'x-grok-client-version header').toBe(VERSION_FIXTURE);
    expect(request.headers['x-grok-client-version']).not.toBe(GROK_CONSTANT_CLIENT_VERSION);
    expect(request.headers['x-grok-client-identifier']).toBe('term2');
    expect(request.headers['x-grok-conv-id']).toMatch(/^conv_[0-9a-f-]{36}$/);
    expect(request.headers['x-grok-session-id']).toBe(request.headers['x-grok-conv-id']);
    conversationIds.add(request.headers['x-grok-conv-id']!);
  }
  // One conversation, one server-affinity key, across every turn and continuation.
  expect(conversationIds.size).toBe(1);
  expect(requests.length).toBeGreaterThan(0);
}
