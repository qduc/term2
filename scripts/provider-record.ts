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
import { selectOpencodeModelTransport } from '../src/model/providers/opencode-routing.js';
import {
  KNOWN_CUSTOM_PROVIDER_TYPES,
  SETTING_KEYS,
  type KnownCustomProviderType,
} from '../src/config/settings/settings-schema.js';

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
const typeArg = get('--type');
const baseUrlArg = get('--base-url');
const apiKeyEnvArg = get('--api-key-env');

const usage = `Usage:
  Live recording (spends credits; never part of PR tests):
    pnpm provider:record --yes --provider <id> --model <model> --probe <scenario> [--out <absolute dir>]
      <id> is one of openai, openrouter, anthropic, google|gemini, opencode; credentials come from that provider's
      usual environment variables (OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, ...).
      Base URL overrides: OPENROUTER_BASE_URL (openrouter), OPENAI_BASE_URL (openai), ANTHROPIC_BASE_URL (anthropic),
      OPENCODE_BASE_URL (opencode).

  Live recording of any custom provider type against a chosen base URL:
    pnpm provider:record --yes --provider <new id> --type <type> --base-url <url> --api-key-env <ENV NAME>
      --model <model> --probe <scenario> [--out <absolute dir>]
      <type> is one of ${KNOWN_CUSTOM_PROVIDER_TYPES.join(', ')}. The id names a runtime provider registered with
      that type and base URL, so the recording runs through the same registry path as a configured custom provider.
      The key is read from the one named environment variable and from nowhere else. --type needs --base-url and
      --api-key-env; --base-url and --api-key-env are only accepted with --type. The id must not be a built-in
      provider (openai, openrouter, codex, grok).

  Deterministic self-validation (no credentials):
    pnpm provider:record --from-fake <protocol> <scenario> [--provider <id>] [--model <model>] [--out <absolute dir>]
      protocols: chat-completions, responses, anthropic, google

  Raw recordings are written outside the repository (default ~/.term2/provider-recordings, or $TERM2_RECORDING_DIR).
  Run \`pnpm provider:fixture:prepare <file>\` before committing anything derived from one.`;
if (has('--help') || has('-h')) {
  console.log(usage);
  process.exit(0);
}

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
  const typed = typedRecordingFromArgs(providerArg!);
  if (!typed) {
    const credentialNames = credentialNamesFor(providerArg!);
    if (!credentialNames.some((name) => process.env[name]))
      fail(`Missing credentials for ${providerArg} (${credentialNames.join(' or ')}).`);
  }
  await runLiveRecording(providerArg!, modelArg!, probe!, outArg, typed);
  process.exit(0);
}

// --from-fake drives the deterministic fake scenario only. The --probe flag is
// for live tool-call probes; accepting it here would stamp a label on frames
// that never came from the probe.
if (probe) fail('--probe drives the live tool-call probe only; --from-fake records the deterministic fake scenario.');
if (typeArg !== undefined || baseUrlArg !== undefined || apiKeyEnvArg !== undefined)
  fail('--type, --base-url and --api-key-env apply to live recording only; --from-fake uses the fake provider.');
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
type TypedRecording = { type: KnownCustomProviderType; baseUrl: string; apiKey: string };

/**
 * `--type` records a custom provider type against a caller-chosen base URL. The key comes from the one
 * environment variable named by `--api-key-env`; nothing else in the environment is consulted.
 * Returns undefined when none of the three flags is present (the original provider-id behaviour).
 */
function typedRecordingFromArgs(providerId: string): TypedRecording | undefined {
  const flags = ['--type', '--base-url', '--api-key-env'].filter((name) => has(name));
  if (!flags.length) return undefined;
  for (const name of flags) {
    const value = get(name);
    if (!value || value.startsWith('--')) fail(`${name} needs a value.\n${usage}`);
  }
  if (!typeArg) fail(`${flags.join(' and ')} only apply together with --type.\n${usage}`);
  if (!(KNOWN_CUSTOM_PROVIDER_TYPES as readonly string[]).includes(typeArg!))
    fail(`--type must be one of ${KNOWN_CUSTOM_PROVIDER_TYPES.join(', ')} (got '${typeArg}').`);
  if (!baseUrlArg || !apiKeyEnvArg)
    fail(`--type requires both --base-url and --api-key-env; a typed recording never falls back to other credentials.`);
  try {
    const url = new URL(baseUrlArg!);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    fail(`--base-url must be an http(s) URL (got '${baseUrlArg}').`);
  }
  const apiKey = process.env[apiKeyEnvArg!];
  if (!apiKey)
    fail(
      `Missing credentials for ${providerId}: environment variable ${apiKeyEnvArg} (from --api-key-env) is not set.`,
    );
  return { type: typeArg as KnownCustomProviderType, baseUrl: baseUrlArg!, apiKey: apiKey! };
}

async function runLiveRecording(
  providerId: string,
  modelId: string,
  probeId: string,
  out: string | undefined,
  typed?: TypedRecording,
): Promise<void> {
  if (process.env.TERM2_RECORDING_TRANSPORT === 'websocket')
    fail('WebSocket live recording requires the ResponsesWS adapter; use HTTP recording for this pilot.');
  const { getProbeScenario } = await import('./provider-black-box/probe-scenarios.js');
  const { getProvider, upsertProvider } = await import('../src/model/providers/registry.js');
  await import('../src/model/providers/index.js');
  const scenarioDefinition = getProbeScenario(probeId);
  const nativeFetch = globalThis.fetch;
  const recorder = createFixtureRecorder({
    provider: providerId,
    wireFamily: wireFamilyFor(providerId, modelId, typed?.type),
    transport: 'http-sse',
    capture: {
      sdkPackage: sdkPackageFor(providerId, modelId, typed?.type),
      apiSdkVersion: installedVersion(sdkPackageFor(providerId, modelId, typed?.type)),
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
    // Every key a provider's createStreamedModel path reads. Keep this in step with the providers: the
    // stub throws on a key it does not list (see below), so a rename fails the recording instead of
    // handing the provider `undefined`.
    const settingsValues: Record<string, unknown> = {
      [SETTING_KEYS.AGENT_MODEL_SELECTION]: { provider: providerId, model: modelId },
      [SETTING_KEYS.AGENT_RETRY_ATTEMPTS]: 0,
      [SETTING_KEYS.AGENT_TRANSPORT]: 'http',
      // The built-in OpenAI and OpenRouter providers read their keys from settings (falling back to the
      // environment themselves). A typed recording uses its own runtime provider and its one key, so
      // no built-in credential is supplied to it.
      [SETTING_KEYS.AGENT_OPENAI_API_KEY]: typed ? undefined : process.env.OPENAI_API_KEY,
      [SETTING_KEYS.AGENT_OPENROUTER_API_KEY]: typed ? undefined : process.env.OPENROUTER_API_KEY,
      [SETTING_KEYS.AGENT_OPENROUTER_BASE_URL]: typed ? undefined : process.env.OPENROUTER_BASE_URL,
    };
    // Read by the OpenRouter provider only to override its defaults; absent means "use the default".
    const optionalSettingKeys = new Set<string>([
      SETTING_KEYS.AGENT_OPENROUTER_REFERRER,
      SETTING_KEYS.AGENT_OPENROUTER_TITLE,
    ]);
    const runtimeConfig = runtimeProviderConfig(providerId, typed);
    if (typed && getProvider(providerId))
      fail(`--provider '${providerId}' is already a registered provider; choose a new id for a --type recording.`);
    if (!getProvider(providerId) && runtimeConfig) {
      const { createOpenAICompatibleProviderDefinition } = await import(
        '../src/model/providers/openai-compatible.provider.js'
      );
      upsertProvider(createOpenAICompatibleProviderDefinition(runtimeConfig));
    }
    const settings = {
      get: (key: string) => {
        if (Object.hasOwn(settingsValues, key)) return settingsValues[key];
        if (optionalSettingKeys.has(key)) return undefined;
        throw new Error(
          `provider:record settings stub has no value for '${key}'. Add it to settingsValues (or optionalSettingKeys) in scripts/provider-record.ts.`,
        );
      },
      getDynamic: (key: string) => {
        if (key === 'providers') return runtimeConfig ? [runtimeConfig] : undefined;
        throw new Error(
          `provider:record settings stub does not supply dynamic key '${key}'. Add it in scripts/provider-record.ts.`,
        );
      },
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
            providerId === 'openai' && !typed
              ? scenarioDefinition.toolResult
              : JSON.stringify(scenarioDefinition.toolResult),
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

/**
 * The wire family a recording is classified under; `provider:fixture:prepare` files fixtures by it and
 * the replay tests select on it. For a typed recording it follows the adapter the registry builds for
 * the type, not the provider id: `openai` (a custom provider of that type) is served by the Chat
 * Completions adapter, unlike the built-in `openai` provider, which speaks Responses.
 */
function wireFamilyFor(providerId: string, modelId: string, type?: KnownCustomProviderType): string {
  if (type) {
    if (type === 'anthropic') return 'anthropic';
    if (type === 'google') return 'google';
    if (type === 'opencode') return opencodeWireFamily(modelId);
    return 'openai-chat';
  }
  if (providerId === 'openai') return 'openai-responses';
  if (providerId === 'openrouter') return 'openai-chat';
  if (providerId === 'anthropic') return 'anthropic';
  if (providerId === 'google' || providerId === 'gemini') return 'google';
  if (providerId === 'opencode') return opencodeWireFamily(modelId);
  return providerId;
}

function sdkPackageFor(id: string, modelId?: string, type?: KnownCustomProviderType): string {
  const family = wireFamilyFor(id, modelId ?? '', type);
  if (family === 'anthropic') return '@ai-sdk/anthropic';
  if (family === 'google') return '@ai-sdk/google';
  return 'openai';
}

function opencodeWireFamily(modelId: string): string {
  const transport = selectOpencodeModelTransport(modelId);
  return transport === 'anthropic-messages'
    ? 'anthropic'
    : transport === 'openai-responses'
    ? 'openai-responses'
    : 'openai-chat';
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
function runtimeProviderConfig(
  id: string,
  typed?: TypedRecording,
):
  | {
      name: string;
      label: string;
      type: KnownCustomProviderType;
      baseUrl: string;
      apiKey: string | undefined;
    }
  | undefined {
  if (typed) return { name: id, label: id, type: typed.type, baseUrl: typed.baseUrl, apiKey: typed.apiKey };
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
