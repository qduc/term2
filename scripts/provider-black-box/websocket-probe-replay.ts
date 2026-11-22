import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProvider } from '../../src/model/providers/registry.js';
import '../../src/model/providers/index.js';
import { recordingSessionContext } from './credentialed-recording.js';
import type { FixtureEnvelopeV1, WsMessageFrame, WsOpenFrame } from './fixture-envelope.js';
import {
  startFakeProviderWebSocketServer,
  type FakeProviderWebSocketServer,
} from './fake-provider-websocket-server.js';
import { probeRunOptionsFor, runToolContinuationProbe, type ProbeRunResult } from './probe-runner.js';
import { getProbeScenario } from './probe-scenarios.js';

/**
 * Replays a WebSocket probe recording made by `provider:record --transport websocket` (Codex or OpenAI)
 * through the registry model, the same probe (`runToolContinuationProbe` with `probeRunOptionsFor`) and
 * the same session context, against `fake-provider-websocket-server.ts` serving the recording. The server
 * checks every outbound message and the handshake (path, header names, kept header values); scrubbed
 * values match whatever the replaying client sends.
 *
 * The environment the recording needs is rebuilt in a temporary directory: the base URL points at the
 * fake server under the recorded path, and for Codex a fake login (a JWT that never expires, plus the
 * `account_id` and Codex CLI `installation_id` when the recording shows the client sent them).
 *
 * It sets `CODEX_BASE_URL`/`OPENAI_BASE_URL`, `CODEX_HOME` and `TERM2_CONFIG_DIR` on `process.env` for the
 * duration of the call and restores them after, so callers must not run two replays concurrently in one
 * process.
 */
export async function replayWebSocketProbeRecording(
  fixture: FixtureEnvelopeV1,
): Promise<ProbeRunResult & { server: FakeProviderWebSocketServer }> {
  if (fixture.transport !== 'websocket') throw new Error('replayWebSocketProbeRecording needs a websocket recording');
  const providerId = fixture.provider;
  if (providerId !== 'codex' && providerId !== 'openai')
    throw new Error(`No WebSocket replay wiring for provider '${providerId}'`);
  const frames = fixture.turns.flatMap((turn) => turn.frames);
  const handshake = frames.find((frame): frame is WsOpenFrame => frame.kind === 'ws-open');
  const sends = frames.filter(
    (frame): frame is WsMessageFrame => frame.kind === 'ws-message' && frame.direction === 'send',
  );
  const basePath = (handshake?.urlPath.split('?')[0] ?? '/responses').replace(/\/responses$/, '');
  const server = await startFakeProviderWebSocketServer({ fixture });
  const root = await mkdtemp(join(tmpdir(), 'ws-probe-replay-'));
  const env = {
    CODEX_BASE_URL: undefined as string | undefined,
    OPENAI_BASE_URL: undefined as string | undefined,
    CODEX_HOME: join(root, 'codex'),
    CHATGPT_LOCAL_HOME: undefined as string | undefined,
    TERM2_CONFIG_DIR: join(root, 'config'),
  };
  const baseUrl = `${server.url.replace(/^ws:/, 'http:')}${basePath}`;
  if (providerId === 'codex') env.CODEX_BASE_URL = baseUrl;
  else env.OPENAI_BASE_URL = baseUrl;
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  let model: any;
  try {
    if (providerId === 'codex') {
      await mkdir(env.CODEX_HOME, { recursive: true });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const sentAccount = handshake?.headers['chatgpt-account-id'] !== undefined;
      await writeFile(
        join(env.CODEX_HOME, 'auth.json'),
        JSON.stringify({
          tokens: {
            access_token: `${encode({ alg: 'none' })}.${encode({ exp: 4_102_444_800 })}.replay`,
            ...(sentAccount ? { account_id: 'replay-account' } : {}),
          },
        }),
      );
      if (sends.some((frame) => (frame.data as { client_metadata?: unknown })?.client_metadata !== undefined))
        await writeFile(join(env.CODEX_HOME, 'installation_id'), 'replay-installation');
    }
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const provider = getProvider(providerId);
    if (!provider?.createStreamedModel) throw new Error(`Provider '${providerId}' is not registered`);
    const values: Record<string, unknown> = {
      'agent.modelSelection': { provider: providerId, model: fixture.capture.model },
      'agent.retryAttempts': 0,
      'agent.transport': 'websocket',
      'agent.openai.apiKey': providerId === 'openai' ? 'replay-key' : undefined,
    };
    model = await provider.createStreamedModel(fixture.capture.model, {
      settingsService: { get: (key: string) => values[key], getDynamic: () => undefined } as any,
      loggingService: { info() {}, warn() {}, error() {}, debug() {}, security() {} } as any,
      sessionContextService: recordingSessionContext(fixture.capture.capturedAt) as any,
    });
    const result = await runToolContinuationProbe(
      model,
      getProbeScenario(fixture.capture.probeScenario),
      probeRunOptionsFor(providerId, provider.defaultModelSettings?.().include as string[] | undefined),
    );
    await model.close?.();
    server.assertValid();
    return { ...result, server };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}
