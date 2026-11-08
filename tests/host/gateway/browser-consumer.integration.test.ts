import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Next's bundler-resolution modules have their own typecheck. Load them at the
// runtime boundary so the root NodeNext project does not recompile that tree.
const browserModule = (name: string) =>
  import(new URL(`../../../web-client/lib/term2/${name}.ts`, import.meta.url).href);
const { consumeSseResponse } = await browserModule('sse');
const { applyTerm2Event, emptyTerm2SessionView } = await browserModule('event-adapter');
const { parseSessionHydration, viewFromHydration } = await browserModule('hydration');

// A real HTTP boundary exercises browser API response validation and SSE decoding.
// The upstream is a controlled public-wire fixture, not native-runtime acceptance.
let baseUrl: string;
let hydrationResponse: unknown;
const server = http.createServer((request, response) => {
  request.resume();
  if (request.url === '/hydration') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(hydrationResponse));
  } else if (request.url?.includes('/interactions/')) {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ sessionId: 'session-1', turnId: 'turn-1', interactionId: 'turn-1:approval:1', accepted: true }),
    );
  } else if (request.url?.endsWith('/abort')) {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        sessionId: 'session-1',
        turnId: 'turn-1',
        accepted: false,
        alreadySettled: true,
        abortStatus: 'terminal_accepted',
      }),
    );
  } else {
    response.setHeader('content-type', 'text/event-stream');
    response.setHeader('x-term2-event-format', 'agent-wire-v2');
    const frame = (seq: number) =>
      `event: accepted\nid: ${seq}\ndata: ${JSON.stringify({
        schemaVersion: 2,
        kind: 'accepted',
        sessionId: 'session-1',
        seq,
        occurredAt: '2026-11-07T00:00:00.000Z',
        changes: [],
      })}`;
    response.write(`${frame(3)}\n\n${frame(3)}\n\n`);
    response.write(
      `event: live\ndata: ${JSON.stringify({
        schemaVersion: 2,
        kind: 'live',
        sessionId: 'session-1',
        changes: [{ type: 'reasoning_delta', payload: { turnId: 'turn-1', delta: 'live' } }],
      })}\n\n`,
    );
    // The JSON is complete, but the SSE dispatch boundary is missing at EOF.
    response.end(frame(9));
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('browser consumer over HTTP', () => {
  it('preserves native command/replay status codes through the BFF while redacting upstream diagnostics', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bff-errors-'));
    const socketPath = path.join(directory, 'gateway.sock');
    const privateKeyPath = path.join(directory, 'bff.pem');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
    let status = 409;
    let code = 'command_ineligible';
    const upstream = http.createServer((request, response) => {
      request.resume();
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code,
            message: 'private upstream diagnostic',
            retryable: false,
            details: { secret: 'private upstream diagnostic' },
          },
        }),
      );
    });
    const previous = process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
    process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH = privateKeyPath;
    try {
      await new Promise<void>((resolve) => upstream.listen(socketPath, resolve));
      const { Term2GatewayClient } = await import(
        new URL('../../../web-client/lib/server/term2-gateway-client.js', import.meta.url).href
      );
      const client = new Term2GatewayClient({
        gatewayConfig: {
          enabled: true,
          socketPath,
          privateKeyPath,
          keyId: 'fixture',
          issuer: 'fixture-bff',
          audience: 'fixture-gateway',
          assertionTtlSec: 30,
          clockSkewSec: 5,
          requestTimeoutMs: 2000,
          maxResponseBytes: 4096,
        },
      });
      for (const [nativeCode, nativeStatus] of [
        ['command_ineligible', 409],
        ['command_stale', 409],
        ['command_cancelled', 409],
        ['command_outcome_unobserved', 409],
        ['command_failed', 503],
        ['command_unavailable', 503],
        ['replay_unavailable', 503],
        ['too_late', 409],
      ] as const) {
        code = nativeCode;
        status = nativeStatus;
        await expect(
          client.request({
            userId: 'owner',
            purpose: 'model_list',
            method: 'GET',
            rpcPath: '/private/agent/v1/models',
          }),
        ).rejects.toMatchObject({
          code,
          statusCode: status,
          retryable: false,
          details: undefined,
          message: expect.not.stringContaining('private upstream diagnostic'),
        });
      }
    } finally {
      if (previous === undefined) delete process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
      else process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH = previous;
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts native colon-delimited approval/rejection receipts and settled abort provenance', async () => {
    const previous = process.env.NEXT_PUBLIC_API_BASE;
    process.env.NEXT_PUBLIC_API_BASE = baseUrl;
    try {
      const { term2Client } = await import(new URL('../../../web-client/lib/api/term2.ts', import.meta.url).href);
      for (const answer of ['approve', 'reject']) {
        const result = await term2Client.resolveInteraction('session-1', 'turn-1:approval:1', { revision: 1, answer });
        expect(result).toMatchObject({ accepted: true, interactionId: 'turn-1:approval:1' });
      }
      expect(await term2Client.abort('session-1', 'turn-1')).toEqual({
        sessionId: 'session-1',
        turnId: 'turn-1',
        accepted: false,
        alreadySettled: true,
        abortStatus: 'terminal_accepted',
      });
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_API_BASE;
      else process.env.NEXT_PUBLIC_API_BASE = previous;
    }
  });

  it('checkpoints complete sparse batches once and never dispatches an EOF-truncated batch', async () => {
    let view = emptyTerm2SessionView('session-1');
    const delivered: number[] = [];
    await consumeSseResponse(await fetch(`${baseUrl}/events`), {
      expectedSessionId: 'session-1',
      onFrame(frame: { kind: string; seq: number }) {
        if (frame.kind === 'accepted') delivered.push(frame.seq);
        view = applyTerm2Event(view, frame);
      },
    });
    expect(delivered).toEqual([3, 3]);
    expect(view.lastAppliedSequence).toBe(3);
    expect(view.turns).toEqual([]); // Live evidence is separate from accepted history.
    expect(view.liveChanges).toHaveLength(1);
  });

  it('hydrates a result-only timeline slot without fabricating a named tool or turn', async () => {
    const snapshot = {
      protocolVersion: 1,
      sessionId: 'session-1',
      backingSessionId: 'session-1',
      seq: 5,
      status: 'idle',
      activeTurnId: null,
      messages: [],
      tools: [],
      unmatchedToolResults: [{ executionId: 'result-only', output: 'retained output', isError: false }],
      timeline: [{ kind: 'tool', id: 'result-only' }],
      queue: [],
      tasks: [],
      notices: [],
      pendingInteractions: [],
      admissions: [],
      model: { provider: 'fixture', model: 'fixture-model' },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      configuration: { model: { provider: 'fixture', model: 'fixture-model' } },
      retryEligibility: { turn: false, tool: false },
      queueState: 'idle',
      cost: null,
      goal: null,
      verification: null,
      lastError: null,
      terminal: null,
      reasoning: '',
    };
    // Round-trip the same public snapshot through an HTTP response before parsing.
    hydrationResponse = {
      schemaVersion: 2,
      kind: 'snapshot',
      sessionId: 'session-1',
      seq: 5,
      earliestReplayableSequence: 1,
      interaction: null,
      snapshot,
    };
    const wire = await fetch(`${baseUrl}/hydration`);
    const view = viewFromHydration(parseSessionHydration(await wire.json(), 'session-1'));
    expect(view.lastAppliedSequence).toBe(5);
    expect(view.turns).toEqual([]);
    expect(view.hydration?.snapshot.unmatchedToolResults).toEqual(snapshot.unmatchedToolResults);
  });
});
