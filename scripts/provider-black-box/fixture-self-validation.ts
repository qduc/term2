import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { startFakeProviderHttpServer, type FakeProviderProtocol, type FakeProviderScenario } from './fake-provider-http-server.js';
import { fixtureRequest } from './provider-wire-fixtures.js';
import { createFixtureRecorder, createRecordingMiddleware } from './fixture-recorder.js';
import { sanitizeFixtureEnvelope } from './fixture-sanitizer.js';
import { validateFixtureEnvelope } from './fixture-envelope.js';

/**
 * Offline self-validation oracle (plan D4): record the deterministic fake
 * scenario through the recorder middleware, sanitize, then replay the resulting
 * envelope through the fake server and assert the recorded request replays to
 * identity. Runs with zero credentials and no network, so CI can invoke it via
 * `provider:record --from-fake <protocol> <scenario>`.
 *
 * The written envelope carries honest capture metadata (`fixture-fake-provider`
 * @1.0.0, probe id `fake:<protocol>:<scenario>`) so the drift test does not
 * bind it to a real SDK version.
 */
export async function recordAndSelfValidate(options: {
  provider: string;
  model: string;
  protocol: FakeProviderProtocol;
  scenario: FakeProviderScenario;
  file: string;
}): Promise<string> {
  const server = await startFakeProviderHttpServer({ protocol: options.protocol, scenario: options.scenario });
  const recorder = createFixtureRecorder({
    provider: options.provider,
    wireFamily: options.protocol === 'chat-completions' ? 'openai-chat' : options.protocol,
    transport: 'http-sse',
    capture: {
      sdkPackage: 'fixture-fake-provider',
      apiSdkVersion: '1.0.0',
      model: options.model,
      modelFamily: 'fixture',
      capturedAt: new Date().toISOString(),
      recorderVersion: '1',
      probeScenario: `fake:${options.protocol}:${options.scenario}`,
    },
  });
  try {
    const fetchWithCapture = createRecordingMiddleware({ recorder })(
      {
        url: `${server.baseUrl}/v1/chat/completions`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: options.model, ...fixtureRequest, stream: true }),
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
      if (!requestFrame || requestFrame.kind !== 'http-request')
        throw new Error('Recorded probe did not contain an HTTP request');
      await fetch(`${replay.baseUrl}${requestFrame.urlPath}`, {
        method: requestFrame.method,
        headers: requestFrame.headers,
        body: JSON.stringify(requestFrame.body),
      });
      replay.assertReplayValid();
    } finally {
      await replay.close();
    }
    await mkdir(dirname(options.file), { recursive: true });
    await writeFile(options.file, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
    return options.file;
  } finally {
    await server.close();
  }
}
