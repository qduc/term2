import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  startFakeProviderHttpServer,
  type FakeProviderProtocol,
  type FakeProviderScenario,
} from './fake-provider-http-server.js';
import { fixtureRequest } from './provider-wire-fixtures.js';
import { createFixtureRecorder, createRecordingMiddleware } from './fixture-recorder.js';
import { sanitizeFixtureEnvelope } from './fixture-sanitizer.js';
import { validateFixtureEnvelope } from './fixture-envelope.js';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { startFakeProviderWebSocketServer } from './fake-provider-websocket-server.js';
import { installResponsesWebSocketCapture } from './websocket-capture.js';
import { addLiteral, writeScannedRecording, type SensitiveLiteral } from './recording-secret-scan.js';

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

export const webSocketSelfValidationScenarios = ['success', 'native-error', 'incomplete', 'abnormal-close'] as const;
export type WebSocketSelfValidationScenario = (typeof webSocketSelfValidationScenarios)[number];

/**
 * Values planted in the self-validation's handshake and request so the scrubber, the sanitizer and the
 * secret scan are exercised on every run: each must be gone from the written envelope, and the replay must
 * still match the client that sends them again. None is a real credential.
 */
export const plantedWebSocketSecrets = {
  apiKey: 'sk-fixture-planted-0123456789abcdef',
  accountId: 'fixture-account-5a4b3c2d1e',
  installationId: 'fixture-installation-0f9e8d7c6b',
  sessionId: 'fixture-session-a1b2c3d4e5',
  promptCacheKey: 'fixture-cache-key-9z8y7x6w',
} as const;

/**
 * WebSocket self-validation (plan D4 for adapter 2): drive the OpenAI SDK's `ResponsesWS` (the capture seam
 * Codex and OpenAI WebSocket share) against the deterministic fake WebSocket server with planted
 * credentials and identity fields, capture it through `installResponsesWebSocketCapture`, sanitize, write
 * through the secret scan, then replay the written envelope through a fresh fake server with the same
 * client and require the replay to validate (outbound sequence, handshake path and headers). Runs with no
 * credentials and no network beyond loopback.
 */
export async function recordAndSelfValidateWebSocket(options: {
  provider: string;
  model: string;
  scenario: WebSocketSelfValidationScenario;
  file: string;
}): Promise<string> {
  const message = {
    type: 'response.create',
    model: options.model,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixture prompt' }] }],
    prompt_cache_key: plantedWebSocketSecrets.promptCacheKey,
    client_metadata: {
      'x-codex-installation-id': plantedWebSocketSecrets.installationId,
      session_id: plantedWebSocketSecrets.sessionId,
    },
  };
  const server = await startFakeProviderWebSocketServer({
    scenario: options.scenario,
    expectedOutbound: [message],
    provider: options.provider,
    model: options.model,
  });
  const capture = installResponsesWebSocketCapture(ResponsesWS);
  let envelope;
  try {
    await driveResponsesWebSocket(server.url, message);
    await capture.settle();
    capture.assertCaptured();
    server.assertValid();
    const recorder = createFixtureRecorder({
      provider: options.provider,
      wireFamily: 'openai-responses',
      transport: 'websocket',
      capture: {
        sdkPackage: 'fixture-fake-provider',
        apiSdkVersion: '1.0.0',
        model: options.model,
        modelFamily: 'fixture',
        capturedAt: new Date().toISOString(),
        recorderVersion: '2',
        probeScenario: `fake:websocket:${options.scenario}`,
      },
    });
    capture.recordInto(recorder);
    envelope = sanitizeFixtureEnvelope(await recorder.flush()).envelope;
    validateFixtureEnvelope(envelope);
  } finally {
    capture.uninstall();
    await server.close();
  }
  const replay = await startFakeProviderWebSocketServer({ fixture: envelope });
  try {
    await driveResponsesWebSocket(replay.url, message);
    replay.assertValid();
  } finally {
    await replay.close();
  }
  const literals: SensitiveLiteral[] = [];
  for (const [label, value] of Object.entries(plantedWebSocketSecrets)) addLiteral(literals, `planted ${label}`, value);
  await mkdir(dirname(options.file), { recursive: true });
  await writeScannedRecording(options.file, `${JSON.stringify(envelope, null, 2)}\n`, literals);
  return options.file;
}

/** One `response.create` over `ResponsesWS`, with the planted key and account header; resolves on close. */
async function driveResponsesWebSocket(url: string, message: Record<string, unknown>): Promise<void> {
  const client = new OpenAI({ apiKey: plantedWebSocketSecrets.apiKey, baseURL: url.replace(/^ws:/, 'http:') });
  const socket = new ResponsesWS(client, {
    headers: {
      'chatgpt-account-id': plantedWebSocketSecrets.accountId,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
      originator: 'fixture-self-validation',
    },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket self-validation timed out')), 10_000);
    socket.on('error', () => {
      /* the abnormal-close scenario ends in a socket error; the close below settles it */
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.send(message as any);
  });
}
