#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { startFakeProviderHttpServer } from './provider-black-box/fake-provider-http-server.js';
import { fixtureRequest } from './provider-black-box/provider-wire-fixtures.js';
import { createFixtureRecorder, createRecordingMiddleware } from './provider-black-box/fixture-recorder.js';
import { sanitizeFixtureEnvelope } from './provider-black-box/fixture-sanitizer.js';
import { validateFixtureEnvelope, type FixtureTransport } from './provider-black-box/fixture-envelope.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const get = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);
const providerArg = get('--provider');
const modelArg = get('--model');
const probe = get('--probe');
const outArg = get('--out');
const fromFake = has('--from-fake');
const protocolArg = args[args.indexOf('--from-fake') + 1];
const scenario = args[args.indexOf('--from-fake') + 2] ?? 'success';
if (!fromFake) {
  if (!has('--yes')) fail('Live recording is disabled by default. Re-run with --yes and an explicit probe.');
  if (!probe) fail('An explicit --probe scenario is required.');
  if (!providerArg || !modelArg) fail('Both --provider and --model are required.');
  if (!process.env[credentialFor(providerArg)])
    fail(`Missing credentials for ${providerArg} (${credentialFor(providerArg)}).`);
}
if (!fromFake) {
  await runLiveRecording(providerArg!, modelArg!, probe!, outArg);
  process.exit(0);
}
if (!protocolArg || !['chat-completions', 'responses', 'anthropic', 'google'].includes(protocolArg))
  fail('Usage: --from-fake <protocol> <scenario>');
const provider = providerArg ?? 'fixture';
const model = modelArg ?? 'fixture-model';
const protocol = protocolArg as 'chat-completions' | 'responses' | 'anthropic' | 'google';
const transport: FixtureTransport = 'http-sse';
const server = await startFakeProviderHttpServer({ protocol, scenario: scenario as any });
const recorder = createFixtureRecorder({
  provider,
  wireFamily: protocol === 'chat-completions' ? 'openai-chat' : protocol,
  transport,
  capture: {
    sdkPackage: 'fixture-fake-provider',
    apiSdkVersion: '1.0.0',
    model,
    modelFamily: 'fixture',
    capturedAt: new Date().toISOString(),
    recorderVersion: '1',
    probeScenario: probe ?? `fake:${scenario}`,
  },
});
try {
  const fetchWithCapture = createRecordingMiddleware({ recorder })(
    {
      url: `${server.baseUrl}/v1/chat/completions`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, ...fixtureRequest, stream: true }),
      },
    },
    (ctx) => fetch(ctx.url, ctx.init),
  );
  await fetchWithCapture;
  const { envelope } = sanitizeFixtureEnvelope(await recorder.flush());
  validateFixtureEnvelope(envelope);
  const replay = await startFakeProviderHttpServer({ fixture: envelope });
  try {
    const requestFrame = envelope.turns[0]?.frames.find((frame) => frame.kind === 'http-request');
    if (!requestFrame || requestFrame.kind !== 'http-request') fail('Recorded probe did not contain an HTTP request');
    await fetch(`${replay.baseUrl}${requestFrame.urlPath}`, {
      method: requestFrame.method,
      headers: requestFrame.headers,
      body: JSON.stringify(requestFrame.body),
    });
    replay.assertReplayValid();
  } finally {
    await replay.close();
  }
  const destination = recordingPath(outArg, provider, protocol, scenario);
  await mkdir(destination.dir, { recursive: true });
  await writeFile(destination.file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  server.assertReplayValid();
  console.log(destination.file);
} finally {
  await server.close();
}

function recordingPath(out: string | undefined, providerId: string, protocolId: string, scenarioId: string) {
  const dir = out
    ? isAbsolute(out)
      ? out
      : fail('Recording output must be an absolute path')
    : join(process.env.TERM2_RECORDING_DIR ?? join(homedir(), '.term2', 'provider-recordings'));
  if (resolve(dir) === resolve(process.cwd())) fail('Recorder never writes to the current working directory');
  return { dir, file: join(dir, `${providerId}-${protocolId}-${scenarioId}.json`) };
}
async function runLiveRecording(
  providerId: string,
  modelId: string,
  probeId: string,
  out: string | undefined,
): Promise<void> {
  if (process.env.TERM2_RECORDING_TRANSPORT === 'websocket')
    fail('WebSocket live recording requires the ResponsesWS adapter; use HTTP recording for this pilot.');
  const { getProbeScenario } = await import('./provider-black-box/probe-scenarios.js');
  const { getProvider } = await import('../source/providers/registry.js');
  await import('../source/providers/index.js');
  const scenarioDefinition = getProbeScenario(probeId);
  const nativeFetch = globalThis.fetch;
  const recorder = createFixtureRecorder({
    provider: providerId,
    wireFamily: providerId === 'openai' ? 'openai-responses' : providerId === 'openrouter' ? 'ai-sdk' : providerId,
    transport: 'http-sse',
    capture: {
      sdkPackage: sdkPackageFor(providerId),
      apiSdkVersion: installedVersion(sdkPackageFor(providerId)),
      model: modelId,
      modelFamily: providerId,
      capturedAt: new Date().toISOString(),
      recorderVersion: '1',
      probeScenario: probeId,
    },
  });
  const captureFetch = createRecordingMiddleware({ recorder });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    captureFetch({ url: input, init }, (ctx) => nativeFetch(ctx.url, ctx.init))) as typeof fetch;
  try {
    const settingsValues: Record<string, unknown> = {
      'agent.model': modelId,
      'agent.retryAttempts': 0,
      'agent.transport': 'http',
      'agent.openai.apiKey': process.env.OPENAI_API_KEY,
      'agent.anthropic.apiKey': process.env.ANTHROPIC_API_KEY,
      'agent.google.apiKey': process.env.GOOGLE_API_KEY,
      'agent.openrouter.apiKey': process.env.OPENROUTER_API_KEY,
    };
    const settings = { get: (key: string) => settingsValues[key] } as any;
    const loggingService = {
      providerTraffic: undefined,
      info() {},
      warn() {},
      error() {},
      debug() {},
      security() {},
    } as any;
    const provider = getProvider(providerId);
    if (!provider?.createStreamedModel) fail(`Provider '${providerId}' is not registered`);
    const model = await provider.createStreamedModel(modelId, { settingsService: settings, loggingService });
    const initial = {
      ...fixtureRequest,
      input: [{ type: 'message', role: 'user', content: [{ type: 'text', text: scenarioDefinition.prompt }] }],
    } as any;
    const firstEvents: any[] = [];
    for await (const event of model.stream(initial)) firstEvents.push(event);
    const call =
      firstEvents.find((event) => event.type === 'tool_call') ??
      firstEvents
        .flatMap((event) => event.output ?? [])
        .find((item: any) => item.type === 'tool_call' || item.type === 'function_call');
    if (!call) fail('Probe model did not produce the required fixture tool call');
    const callId = call.id ?? call.callId;
    const continuation = {
      ...initial,
      input: [
        ...initial.input,
        { type: 'tool_call', id: callId, name: call.name, arguments: call.arguments },
        { type: 'tool_result', id: callId, output: scenarioDefinition.toolResult },
        { type: 'message', role: 'user', content: [{ type: 'text', text: scenarioDefinition.followUp }] },
      ],
    };
    for await (const _event of model.stream(continuation)) {
      /* recorder owns wire frames */
    }
    const envelope = await recorder.flush();
    const destination = recordingPath(out, providerId, providerId, probeId);
    await mkdir(destination.dir, { recursive: true });
    await writeFile(destination.file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    console.log(destination.file);
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

function sdkPackageFor(id: string): string {
  return id === 'anthropic'
    ? '@ai-sdk/anthropic'
    : id === 'google' || id === 'gemini'
    ? '@ai-sdk/google'
    : id === 'openrouter'
    ? '@openrouter/ai-sdk-provider'
    : 'openai';
}
function installedVersion(packageName: string): string {
  try {
    return String((require(`${packageName}/package.json`) as { version?: string }).version ?? 'unknown');
  } catch {
    return 'unknown';
  }
}
function credentialFor(id: string): string {
  return id === 'anthropic'
    ? 'ANTHROPIC_API_KEY'
    : id === 'google' || id === 'gemini'
    ? 'GOOGLE_API_KEY'
    : 'OPENAI_API_KEY';
}
function fail(message: string): never {
  console.error(`provider:record: ${message}`);
  process.exit(2);
}
