#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAndSelfValidate } from './provider-black-box/fixture-self-validation.js';
import { fixtureRequest } from './provider-black-box/provider-wire-fixtures.js';
import { createFixtureRecorder, createRecordingMiddleware } from './provider-black-box/fixture-recorder.js';
import type { FixtureTransport } from './provider-black-box/fixture-envelope.js';
import type { FakeProviderScenario } from './provider-black-box/fake-provider-http-server.js';
import { selectOpencodeModelTransport } from '../source/providers/opencode-routing.js';

const require = createRequire(import.meta.url);

// Resolves to the repository root (this file lives at <root>/scripts/provider-record.ts).
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

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

const fakeProtocols = ['chat-completions', 'responses', 'anthropic', 'google'] as const;
const fakeScenarios = [
  'success',
  'error',
  'early-close',
  'incomplete',
  'tool-fragments',
  'reasoning',
  'reasoning-field',
  // `satisfies` keeps a renamed or removed scenario from silently lingering
  // here; a newly added one still has to be listed by hand.
] as const satisfies readonly FakeProviderScenario[];

if (!fromFake) {
  if (!has('--yes')) fail('Live recording is disabled by default. Re-run with --yes and an explicit probe.');
  if (!probe) fail('An explicit --probe scenario is required.');
  if (!providerArg || !modelArg) fail('Both --provider and --model are required.');
  const credentialNames = credentialNamesFor(providerArg);
  if (!credentialNames.some((name) => process.env[name]))
    fail(`Missing credentials for ${providerArg} (${credentialNames.join(' or ')}).`);
  await runLiveRecording(providerArg!, modelArg!, probe!, outArg);
  process.exit(0);
}

// --from-fake drives the deterministic fake scenario only. The --probe flag is
// for live tool-call probes; accepting it here would stamp a label on frames
// that never came from the probe.
if (probe) fail('--probe drives the live tool-call probe only; --from-fake records the deterministic fake scenario.');
const protocolArg = args[args.indexOf('--from-fake') + 1];
const scenarioArg = args[args.indexOf('--from-fake') + 2] ?? 'success';
if (!(fakeProtocols as readonly string[]).includes(protocolArg ?? ''))
  fail(`Usage: --from-fake <protocol> <scenario>; protocols: ${fakeProtocols.join(', ')}`);
if (!(fakeScenarios as readonly string[]).includes(scenarioArg))
  fail(`Unknown scenario '${scenarioArg}'. Available: ${fakeScenarios.join(', ')}`);
const provider = providerArg ?? 'fixture';
const model = modelArg ?? 'fixture-model';
try {
  const file = await recordAndSelfValidate({
    provider,
    model,
    protocol: protocolArg as (typeof fakeProtocols)[number],
    scenario: scenarioArg as (typeof fakeScenarios)[number],
    file: recordingPath(outArg, provider, protocolArg!, scenarioArg).file,
  });
  console.log(file);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function recordingPath(out: string | undefined, providerId: string, protocolId: string, scenarioId: string) {
  const dir = out
    ? isAbsolute(out)
      ? out
      : fail('Recording output must be an absolute path')
    : join(process.env.TERM2_RECORDING_DIR ?? join(homedir(), '.term2', 'provider-recordings'));
  const resolved = resolve(dir);
  if (resolved === resolve(process.cwd())) fail('Recorder never writes to the current working directory');
  if (resolved === repoRoot || resolved.startsWith(repoRoot + sep))
    fail(
      'Recorder never writes inside the repository; raw recordings stay out of the repo permanently (use ~/.term2 or --out elsewhere)',
    );
  return {
    dir: resolved,
    file: join(resolved, `${safeName(providerId)}-${safeName(protocolId)}-${safeName(scenarioId)}.json`),
  };
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
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
  const { getProvider, upsertProvider } = await import('../source/providers/registry.js');
  await import('../source/providers/index.js');
  const scenarioDefinition = getProbeScenario(probeId);
  const nativeFetch = globalThis.fetch;
  const recorder = createFixtureRecorder({
    provider: providerId,
    wireFamily: wireFamilyFor(providerId, modelId),
    transport: 'http-sse',
    capture: {
      sdkPackage: sdkPackageFor(providerId, modelId),
      apiSdkVersion: installedVersion(sdkPackageFor(providerId, modelId)),
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
      'agent.anthropic.apiKey': anthropicApiKey(),
      'agent.google.apiKey': googleApiKey(),
      'agent.openrouter.apiKey': process.env.OPENROUTER_API_KEY,
      'agent.opencode.apiKey': process.env.OPENCODE_API_KEY,
    };
    const runtimeConfig = runtimeProviderConfig(providerId);
    if (!getProvider(providerId) && runtimeConfig) {
      const { createOpenAICompatibleProviderDefinition } = await import(
        '../source/providers/openai-compatible.provider.js'
      );
      upsertProvider(createOpenAICompatibleProviderDefinition(runtimeConfig));
    }
    const settings = {
      get: (key: string) => settingsValues[key],
      getDynamic: (key: string) => (key === 'providers' && runtimeConfig ? [runtimeConfig] : undefined),
    } as any;
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
        {
          type: 'tool_result',
          id: callId,
          // AI SDK providers accept text/content parts for tool results, while
          // OpenAI Responses accepts the structured probe value directly.
          output:
            providerId === 'openai' ? scenarioDefinition.toolResult : JSON.stringify(scenarioDefinition.toolResult),
        },
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

function sdkPackageFor(id: string, modelId?: string): string {
  return id === 'anthropic' ||
    (id === 'opencode' && selectOpencodeModelTransport(modelId ?? '') === 'anthropic-messages')
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
    try {
      return String(
        (
          JSON.parse(readFileSync(join(process.cwd(), 'node_modules', packageName, 'package.json'), 'utf8')) as {
            version?: string;
          }
        ).version ?? 'unknown',
      );
    } catch {
      return 'unknown';
    }
  }
}
function runtimeProviderConfig(id: string):
  | {
      name: string;
      label: string;
      type: 'anthropic' | 'google' | 'opencode';
      baseUrl: string;
      apiKey: string | undefined;
    }
  | undefined {
  if (id === 'anthropic') {
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
    return {
      name: id,
      label: 'Anthropic',
      type: 'anthropic',
      baseUrl,
      apiKey: anthropicApiKey(baseUrl),
    };
  }
  if (id === 'opencode')
    return {
      name: id,
      label: 'OpenCode',
      type: 'opencode',
      baseUrl: process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/go/v1',
      apiKey: process.env.OPENCODE_API_KEY,
    };
  if (id === 'google' || id === 'gemini')
    return {
      name: id,
      label: id === 'gemini' ? 'Gemini' : 'Google',
      type: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: googleApiKey(),
    };
  return undefined;
}

function wireFamilyFor(providerId: string, modelId: string): string {
  if (providerId === 'openai') return 'openai-responses';
  if (providerId === 'openrouter') return 'ai-sdk';
  if (providerId === 'anthropic') return 'anthropic';
  if (providerId === 'google' || providerId === 'gemini') return 'google';
  if (providerId === 'opencode')
    return selectOpencodeModelTransport(modelId) === 'anthropic-messages' ? 'anthropic' : 'openai-chat';
  return providerId;
}

function googleApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

function anthropicApiKey(
  baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1',
): string | undefined {
  return process.env.ANTHROPIC_API_KEY ?? (isOpencodeUrl(baseUrl) ? process.env.OPENCODE_API_KEY : undefined);
}

function isOpencodeUrl(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes('opencode.ai');
}

function credentialNamesFor(id: string): string[] {
  if (id === 'google' || id === 'gemini') return ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY'];
  if (id === 'anthropic') {
    const baseUrl = process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
    return isOpencodeUrl(baseUrl) ? ['ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'] : ['ANTHROPIC_API_KEY'];
  }
  if (id === 'opencode') return ['OPENCODE_API_KEY'];
  if (id === 'openrouter') return ['OPENROUTER_API_KEY'];
  return ['OPENAI_API_KEY'];
}
function fail(message: string): never {
  console.error(`provider:record: ${message}`);
  process.exit(2);
}
