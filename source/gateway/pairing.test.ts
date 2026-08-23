import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssertionVerifier, createGatewayAssertion, GatewayAssertionError } from './assertion.js';
import { GatewayPairing, PairingError } from './pairing.js';
import { MemoryReplayLedger } from './replay-ledger.js';
import { TrustedClientsError, TrustedClientsStore } from './trusted-clients.js';

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-pairing-'));
  roots.push(root);
  return root;
};
const keyPair = () => generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = (keys: ReturnType<typeof keyPair>) =>
  keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = (keys: ReturnType<typeof keyPair>) =>
  keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('TrustedClientsStore and GatewayPairing', () => {
  it('generates a six-digit OTP, persists only the public key, and is single-use', async () => {
    const root = makeRoot();
    const filePath = path.join(root, 'trusted-clients.json');
    const store = new TrustedClientsStore(filePath);
    const printed: string[] = [];
    const pairing = new GatewayPairing({ enabled: true, trustStore: store, printOtp: (otp) => printed.push(otp) });
    const keys = keyPair();
    expect(printed[0]).toMatch(/^\d{6}$/);
    const result = await pairing.register(publicPem(keys), printed[0]);
    expect(result).toMatchObject({ paired: true, kid: result.fingerprint });
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({
      version: 1,
      clients: {
        [result.kid]: expect.objectContaining({
          publicKeyPem: expect.stringContaining('PUBLIC KEY'),
          fingerprint: result.fingerprint,
        }),
      },
    });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(filePath, 'utf8')).not.toContain('PRIVATE KEY');
    await expect(pairing.register(publicPem(keyPair()), printed[0])).rejects.toThrowError(
      new PairingError('pairing_not_allowed'),
    );
    expect(store.size).toBe(1);
  });

  it('expires the OTP and regenerates after three failed attempts', async () => {
    const root = makeRoot();
    let now = 100;
    const printed: string[] = [];
    const pairing = new GatewayPairing({
      enabled: true,
      trustStore: new TrustedClientsStore(path.join(root, 'trusted.json')),
      otpTtlMs: 10,
      maxAttempts: 3,
      now: () => now,
      printOtp: (otp) => printed.push(otp),
    });
    const keys = keyPair();
    await expect(pairing.register(publicPem(keys), '000000')).rejects.toThrowError(new PairingError('pairing_invalid'));
    await expect(pairing.register(publicPem(keys), '000000')).rejects.toThrowError(new PairingError('pairing_invalid'));
    await expect(pairing.register(publicPem(keys), '000000')).rejects.toThrowError(new PairingError('pairing_invalid'));
    expect(printed).toHaveLength(2);
    await expect(pairing.register(publicPem(keys), printed[0])).rejects.toThrowError(
      new PairingError('pairing_invalid'),
    );
    now += 11;
    await expect(pairing.register(publicPem(keys), printed[1])).rejects.toThrowError(
      new PairingError('pairing_required'),
    );
  });

  it('rejects malformed/private/non-RSA keys without persisting them', async () => {
    const root = makeRoot();
    const printed: string[] = [];
    const store = new TrustedClientsStore(path.join(root, 'trusted.json'));
    const pairing = new GatewayPairing({ enabled: true, trustStore: store, printOtp: (otp) => printed.push(otp) });
    const keys = keyPair();
    await expect(pairing.register(privatePem(keys), printed[0])).rejects.toThrowError(
      new PairingError('pairing_invalid'),
    );
    expect(store.size).toBe(0);
    await expect(pairing.register('not-a-key', printed[0])).rejects.toThrowError(new PairingError('pairing_invalid'));
    expect(store.size).toBe(0);
  });

  it('loads paired keys into assertion verification while preserving purpose checks', async () => {
    const root = makeRoot();
    const store = new TrustedClientsStore(path.join(root, 'trusted.json'));
    const printed: string[] = [];
    const pairing = new GatewayPairing({ enabled: true, trustStore: store, printOtp: (otp) => printed.push(otp) });
    const keys = keyPair();
    const paired = await pairing.register(publicPem(keys), printed[0]);
    const configured = keyPair();
    const verifier = new AssertionVerifier({
      issuer: 'bff',
      audience: 'gateway',
      publicKeys: { configured: publicPem(configured) },
      replayLedger: new MemoryReplayLedger(),
    });
    verifier.addTrustedKey(paired.kid, store.entries()[0].publicKeyPem);
    const token = createGatewayAssertion({
      privateKey: keys.privateKey,
      kid: paired.kid,
      issuer: 'bff',
      audience: 'gateway',
      subject: 'client-a',
      purpose: 'session_list',
    });
    expect(verifier.verify(token, 'session_list').sub).toBe('client-a');
    const unpaired = keyPair();
    const unpairedToken = createGatewayAssertion({
      privateKey: unpaired.privateKey,
      kid: 'unpaired',
      issuer: 'bff',
      audience: 'gateway',
      subject: 'client-b',
      purpose: 'session_list',
    });
    expect(() => verifier.verify(unpairedToken, 'session_list')).toThrowError(new GatewayAssertionError('unknown_key'));
  });

  it('fails closed on a corrupt trust file', () => {
    const root = makeRoot();
    const filePath = path.join(root, 'trusted.json');
    writeFileSync(filePath, '{not-json');
    expect(() => new TrustedClientsStore(filePath)).toThrowError(new TrustedClientsError());
  });
});
