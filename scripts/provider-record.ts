#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  recordAndSelfValidate,
  recordAndSelfValidateWebSocket,
  webSocketSelfValidationScenarios,
  type WebSocketSelfValidationScenario,
} from './provider-black-box/fixture-self-validation.js';
import { createFixtureRecorder, createRecordingMiddleware } from './provider-black-box/fixture-recorder.js';
import { probeRunOptionsFor, runToolContinuationProbe } from './provider-black-box/probe-runner.js';
import { RecordingLeakError, addLiteral, redactLiterals } from './provider-black-box/recording-secret-scan.js';
import type { ScrubReport } from './provider-black-box/wire-identity-scrubber.js';
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
const transportArg = get('--transport');

const usage = `Usage:
  Live recording (spends credits; never part of PR tests):
    pnpm provider:record --yes --provider <id> --model <model> --probe <scenario> [--transport http|websocket]
      [--out <absolute dir>]
      <id> is one of openai, openrouter, anthropic, google|gemini, opencode, codex; credentials come from that
      provider's usual environment variables (OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY,
      GEMINI_API_KEY, ...). Base URL overrides: OPENROUTER_BASE_URL (openrouter), OPENAI_BASE_URL (openai),
      ANTHROPIC_BASE_URL (anthropic), OPENCODE_BASE_URL (opencode), CODEX_BASE_URL (codex).
      --transport defaults to websocket for codex and http otherwise; websocket is accepted for codex and openai.

  Live recording of Codex with your ChatGPT login (two model requests on one WebSocket):
    pnpm provider:record --yes --provider codex --model <model> --probe tool-continuation-v2 --out <absolute dir>
      The login is read the way term2 reads it: term2's codex-auth.json (\`term2 --codex-login\`), else the Codex
      CLI's ~/.codex/auth.json. Tokens are never printed. Codex and OpenAI-over-WebSocket recordings are
      scrubbed as they are captured (account, session, installation and turn ids, headers outside an
      allow-list, rate-limit and plan details), sanitized, and secret-scanned after writing; on a match the
      files are deleted and the command exits 3. Writes <provider>-<transport>-<probe>.json and a
      .redactions.json beside it.

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
      protocols: chat-completions, responses, anthropic, google, websocket
      websocket scenarios: ${webSocketSelfValidationScenarios.join(', ')} (records the WebSocket capture
      adapter from the fake WebSocket server, scans for planted secrets, and replays it)

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
  const transport = liveTransport(providerArg!, typed);
  if (!typed && providerArg !== 'codex') {
    const credentialNames = credentialNamesFor(providerArg!);
    if (!credentialNames.some((name) => process.env[name]))
      fail(`Missing credentials for ${providerArg} (${credentialNames.join(' or ')}).`);
  }
  await runLiveRecording(providerArg!, modelArg!, probe!, outArg, transport, typed);
  process.exit(0);
}

// --from-fake drives the deterministic fake scenario only. The --probe flag is
// for live tool-call probes; accepting it here would stamp a label on frames
// that never came from the probe.
if (probe) fail('--probe drives the live tool-call probe only; --from-fake records the deterministic fake scenario.');
if (typeArg !== undefined || baseUrlArg !== undefined || apiKeyEnvArg !== undefined)
  fail('--type, --base-url and --api-key-env apply to live recording only; --from-fake uses the fake provider.');
if (transportArg !== undefined) fail('--transport applies to live recording only; use --from-fake websocket.');
const protocolArg = args[args.indexOf('--from-fake') + 1];
const scenarioArg = args[args.indexOf('--from-fake') + 2] ?? 'success';
if (protocolArg === 'websocket') {
  if (!(webSocketSelfValidationScenarios as readonly string[]).includes(scenarioArg))
    fail(`Unknown websocket scenario '${scenarioArg}'. Available: ${webSocketSelfValidationScenarios.join(', ')}`);
  const provider = providerArg ?? 'fixture';
  try {
    const file = await recordAndSelfValidateWebSocket({
      provider,
      model: modelArg ?? 'fixture-model',
      scenario: scenarioArg as WebSocketSelfValidationScenario,
      file: recordingPath(outArg, provider, 'websocket', scenarioArg).file,
    });
    console.log(file);
  } catch (error) {
    if (error instanceof RecordingLeakError) {
      console.error(`provider:record: ${error.message}`);
      process.exit(3);
    }
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(0);
}
if (!(fakeProtocols as readonly string[]).includes(protocolArg ?? ''))
  fail(`Usage: --from-fake <protocol> <scenario>; protocols: ${[...fakeProtocols, 'websocket'].join(', ')}`);
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

type LiveTransport = 'http' | 'websocket';

function liveTransport(providerId: string, typed?: TypedRecording): LiveTransport {
  const value = transportArg ?? (providerId === 'codex' ? 'websocket' : 'http');
  if (value !== 'http' && value !== 'websocket') fail(`--transport must be http or websocket (got '${value}').`);
  if (value === 'websocket' && (typed || (providerId !== 'codex' && providerId !== 'openai')))
    fail('--transport websocket records the built-in codex and openai providers only.');
  return value as LiveTransport;
}

/**
 * Codex (either transport) and OpenAI over WebSocket are recorded with an account's own credentials and
 * through the identity scrubber; their output is sanitized and secret-scanned before it is kept. The other
 * HTTP recordings keep their original behaviour: a raw recording that `provider:fixture:prepare` sanitizes.
 */
function isCredentialedRecording(providerId: string, transport: LiveTransport): boolean {
  return providerId === 'codex' || transport === 'websocket';
}

async function runLiveRecording(
  providerId: string,
  modelId: string,
  probeId: string,
  out: string | undefined,
  transport: LiveTransport,
  typed?: TypedRecording,
): Promise<void> {
  const { getProbeScenario } = await import('./provider-black-box/probe-scenarios.js');
  const { getProvider, upsertProvider } = await import('../src/model/providers/registry.js');
  const credentialed = await import('./provider-black-box/credentialed-recording.js');
  await import('../src/model/providers/index.js');
  const scenarioDefinition = getProbeScenario(probeId);
  const scrubbed = isCredentialedRecording(providerId, transport);
  const literals = providerId === 'codex' ? codexLoginLiterals(credentialed) : [];
  if (scrubbed) {
    addLiteral(literals, 'OPENAI_API_KEY', providerId === 'openai' ? process.env.OPENAI_API_KEY : undefined);
    for (const literal of credentialed.codexSecretLiterals()) addLiteral(literals, literal.label, literal.value);
  }
  const capturedAt = new Date().toISOString();
  const sdkPackage = sdkPackageFor(providerId, modelId, typed?.type);
  const recorder = createFixtureRecorder({
    provider: providerId,
    wireFamily: providerId === 'codex' ? 'codex-responses' : wireFamilyFor(providerId, modelId, typed?.type),
    transport: transport === 'websocket' ? 'websocket' : 'http-sse',
    capture: {
      sdkPackage,
      apiSdkVersion: installedVersion(sdkPackage),
      model: modelId,
      modelFamily: providerId,
      capturedAt,
      recorderVersion: scrubbed ? '2' : '1',
      probeScenario: probeId,
    },
  });
  const captureReport: ScrubReport = [];
  const nativeFetch = globalThis.fetch;
  let webSocketCapture: import('./provider-black-box/websocket-capture.js').WebSocketCapture | undefined;
  let fallback: ReturnType<typeof credentialed.observeResponsesHttpFallback> | undefined;
  if (transport === 'websocket') {
    const { ResponsesWS } = await import('openai/resources/responses/ws');
    const { installResponsesWebSocketCapture } = await import('./provider-black-box/websocket-capture.js');
    webSocketCapture = installResponsesWebSocketCapture(ResponsesWS);
    fallback = credentialed.observeResponsesHttpFallback();
  } else {
    const codexBase = providerId === 'codex' ? codexBaseUrl() : undefined;
    const captureFetch = createRecordingMiddleware({
      recorder,
      ...(scrubbed ? { identityScrub: captureReport } : {}),
      // Codex's token refresh goes through the same global fetch; only the Responses traffic is recorded.
      ...(codexBase ? { shouldRecord: (url: URL) => url.href.startsWith(codexBase) } : {}),
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      captureFetch({ url: input, init }, (ctx) => nativeFetch(ctx.url, ctx.init))) as typeof fetch;
  }
  let model: any;
  try {
    // Every key a provider's createStreamedModel path reads. Keep this in step with the providers: the
    // stub throws on a key it does not list (see below), so a rename fails the recording instead of
    // handing the provider `undefined`.
    const settingsValues: Record<string, unknown> = {
      [SETTING_KEYS.AGENT_MODEL_SELECTION]: { provider: providerId, model: modelId },
      [SETTING_KEYS.AGENT_RETRY_ATTEMPTS]: 0,
      [SETTING_KEYS.AGENT_TRANSPORT]: transport,
      // The built-in OpenAI and OpenRouter providers read their keys from settings (falling back to the
      // environment themselves). A typed recording uses its own runtime provider and its one key, so
      // no built-in credential is supplied to it.
      [SETTING_KEYS.AGENT_OPENAI_API_KEY]: typed ? undefined : process.env.OPENAI_API_KEY,
      [SETTING_KEYS.AGENT_OPENROUTER_API_KEY]: typed ? undefined : process.env.OPENROUTER_API_KEY,
      [SETTING_KEYS.AGENT_OPENROUTER_BASE_URL]: typed ? undefined : process.env.OPENROUTER_BASE_URL,
    };
    // Read only to override a provider default; absent means "use the default" (OpenRouter's referrer and
    // title, Codex's WebSocket receive timeouts).
    const optionalSettingKeys = new Set<string>([
      SETTING_KEYS.AGENT_OPENROUTER_REFERRER,
      SETTING_KEYS.AGENT_OPENROUTER_TITLE,
      'agent.codex.websocketFirstFrameTimeoutMs',
      'agent.codex.websocketInterFrameTimeoutMs',
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
    model = await provider.createStreamedModel(modelId, {
      settingsService: settings,
      loggingService,
      // The CLI runs every turn inside a session; Codex keys its response chaining (previous_response_id on
      // the retained socket) and its session headers to it. HTTP recordings of other providers keep none.
      ...(scrubbed ? { sessionContextService: credentialed.recordingSessionContext(capturedAt) as any } : {}),
    });
    await runToolContinuationProbe(
      model,
      scenarioDefinition,
      probeRunOptionsFor(providerId, provider.defaultModelSettings?.().include as string[] | undefined, !!typed),
    );
    if (webSocketCapture) {
      await model.close?.();
      await webSocketCapture.settle();
      webSocketCapture.assertCaptured();
      if (fallback!.count() > 0)
        throw new Error(
          `The model fell back from WebSocket to HTTP (${fallback!.count()} HTTP Responses request(s)); this is not a WebSocket recording. Nothing was written.`,
        );
      webSocketCapture.recordInto(recorder);
      captureReport.push(...webSocketCapture.report);
    }
    const envelope = await recorder.flush();
    const destination = recordingPath(out, providerId, scrubbed ? transport : providerId, probeId);
    await mkdir(destination.dir, { recursive: true });
    if (!scrubbed) {
      await writeFile(destination.file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      console.log(destination.file);
      return;
    }
    // Tokens may have been refreshed during the run; scan for the new ones too.
    if (providerId === 'codex')
      for (const literal of credentialed.codexSecretLiterals()) addLiteral(literals, literal.label, literal.value);
    const written = await credentialed.writeCredentialedRecording({
      envelope,
      file: destination.file,
      captureReport,
      literals,
    });
    console.log(written.file);
    console.log(written.reportFile);
  } catch (error) {
    if (error instanceof RecordingLeakError) {
      console.error(`provider:record: ${error.message}`);
      process.exit(3);
    }
    const message = error instanceof Error ? error.message : String(error);
    fail(scrubbed ? redactLiterals(message, literals) : message);
  } finally {
    globalThis.fetch = nativeFetch;
    fallback?.restore();
    webSocketCapture?.uninstall();
  }
}

function codexBaseUrl(): string {
  return (process.env.CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
}

function codexLoginLiterals(credentialed: typeof import('./provider-black-box/credentialed-recording.js')) {
  const login = credentialed.findCodexLogin();
  if (!login)
    fail(`No Codex login found. Looked for ${credentialed.codexLoginLocations()}. Run \`term2 --codex-login\` first.`);
  console.error(`provider:record: using the Codex login from ${login!.sources[0]}`);
  return [...login!.literals];
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
