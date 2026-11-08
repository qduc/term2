import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDirectServerHost, createServerAuthentication } from '../../../src/host/server.js';
import { MemoryReplayLedger } from '../../../src/host/server-replay-ledger.js';
import type { DirectHost } from '../../../src/host/in-process-direct-types.js';

it('pairs simultaneous first-page requests across BFF clients and still refuses an untrusted key', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bff-pairing-'));
  const socketPath = path.join(directory, 'gateway.sock');
  const trustFilePath = path.join(directory, 'trusted.json');
  const ledger = new MemoryReplayLedger();
  let otp: string | undefined;
  let registrations = 0;
  const authentication = createServerAuthentication({
    issuer: 'test-bff',
    audience: 'test-gateway',
    publicKeys: {},
    replayLedger: ledger,
    pairing: {
      enabled: true,
      trustFilePath,
      printOtp: (value) => {
        otp = value;
      },
    },
  });
  const transport = createDirectServerHost(
    {
      host: {} as DirectHost,
      workspaces: {
        list: () => [],
        resolveGrant: () => {
          throw new Error('not used');
        },
      },
    },
    {
      transport: { socketPath },
      authentication: {
        ...authentication,
        register: async (body) => {
          registrations++;
          return authentication.register!(body);
        },
      },
    },
  );
  const previous = process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
  process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH = path.join(directory, 'unused-singleton.pem');
  try {
    await transport.start();
    expect(otp).toMatch(/^\d{6}$/);
    const { Term2GatewayClient } = await import(
      new URL('../../../web-client/lib/server/term2-gateway-client.js', import.meta.url).href
    );
    const key = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const config = {
      enabled: true,
      socketPath,
      privateKeyPath: 'fixture.pem',
      keyId: 'fixture',
      issuer: 'test-bff',
      audience: 'test-gateway',
      assertionTtlSec: 30,
      clockSkewSec: 5,
      pairingEnabled: true,
      pairingOtp: otp,
      requestTimeoutMs: 2000,
      maxResponseBytes: 4096,
    };
    const clients = [0, 1].map(() => new Term2GatewayClient({ gatewayConfig: config, readFile: () => key.privateKey }));
    const request = {
      userId: 'owner',
      purpose: 'workspace_list',
      method: 'GET',
      rpcPath: '/private/agent/v1/workspaces',
    };
    const replies = await Promise.all(clients.flatMap((client) => [0, 1, 2].map(() => client.request(request))));
    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(registrations).toBeLessThanOrEqual(2);
    const trust = JSON.parse(await readFile(trustFilePath, 'utf8'));
    expect(Object.keys(trust.clients)).toHaveLength(1);
    const outsider = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const untrusted = new Term2GatewayClient({
      gatewayConfig: { ...config, pairingEnabled: false, keyId: Object.keys(trust.clients)[0] },
      readFile: () => outsider.privateKey,
    });
    await expect(untrusted.request(request)).rejects.toMatchObject({ statusCode: 401, code: 'pairing_required' });
    expect(registrations).toBeLessThanOrEqual(2);
  } finally {
    if (previous === undefined) delete process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
    else process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH = previous;
    await transport.stop();
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
