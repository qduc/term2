import { createPublicKey, createSign, createVerify, randomUUID, type KeyObject } from 'node:crypto';
import {
  ASSERTION_PURPOSES,
  isAssertionPurpose,
  type AssertionPurpose,
  type GatewayAssertionClaims,
} from './contracts.js';
import type { ReplayLedger } from './replay-ledger.js';

const MAX_ASSERTION_LIFETIME_SECONDS = 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 5;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type AssertionKey = string | Buffer | KeyObject;

export class GatewayAssertionError extends Error {
  readonly code:
    | 'malformed'
    | 'invalid_signature'
    | 'unknown_key'
    | 'invalid_claims'
    | 'expired'
    | 'not_yet_valid'
    | 'replay'
    | 'wrong_purpose';

  constructor(code: GatewayAssertionError['code']) {
    super('gateway assertion rejected');
    this.name = 'GatewayAssertionError';
    this.code = code;
  }
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value: string): unknown => JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;

export type CreateAssertionOptions = {
  privateKey: AssertionKey;
  kid: string;
  issuer: string;
  audience: string;
  subject: string;
  purpose: AssertionPurpose;
  workspaceId?: string;
  sessionId?: string;
  nowSeconds?: number;
  lifetimeSeconds?: number;
  jti?: string;
};

export function createGatewayAssertion(options: CreateAssertionOptions): string {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const lifetime = options.lifetimeSeconds ?? MAX_ASSERTION_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_ASSERTION_LIFETIME_SECONDS) {
    throw new Error('assertion lifetime must be between 1 and 60 seconds');
  }
  if (!options.subject || !options.issuer || !options.audience || !options.kid)
    throw new Error('assertion identity is required');
  const header = { alg: 'RS256', typ: 'JWT', kid: options.kid };
  const claims: GatewayAssertionClaims = {
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    purpose: options.purpose,
    iat: now,
    nbf: now - DEFAULT_CLOCK_SKEW_SECONDS,
    exp: now + lifetime,
    jti: options.jti ?? randomUUID(),
    ver: 1,
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  };
  const input = `${encode(header)}.${encode(claims)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(options.privateKey).toString('base64url')}`;
}

export type AssertionVerifierOptions = {
  issuer: string;
  audience: string;
  publicKeys: ReadonlyMap<string, AssertionKey> | Record<string, AssertionKey>;
  allowEmptyKeys?: boolean;
  replayLedger: ReplayLedger;
  clock?: () => number;
  clockSkewSeconds?: number;
};

/** Verifies and consumes one internal BFF assertion. Failures reveal no detail to callers. */
export class AssertionVerifier {
  readonly #issuer: string;
  readonly #audience: string;
  readonly #keys: Map<string, KeyObject>;
  readonly #ledger: ReplayLedger;
  readonly #clock: () => number;
  readonly #clockSkew: number;

  constructor(options: AssertionVerifierOptions) {
    if (
      !options.issuer ||
      !options.audience ||
      (options.publicKeys instanceof Map && options.publicKeys.size === 0 && !options.allowEmptyKeys)
    ) {
      throw new Error('gateway assertion configuration is incomplete');
    }
    const entries =
      options.publicKeys instanceof Map ? [...options.publicKeys.entries()] : Object.entries(options.publicKeys);
    if (entries.length === 0 && !options.allowEmptyKeys)
      throw new Error('gateway assertion configuration is incomplete');
    this.#keys = new Map(entries.map(([kid, key]) => [kid, createPublicKey(key)]));
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#ledger = options.replayLedger;
    this.#clock = options.clock ?? (() => Date.now() / 1000);
    this.#clockSkew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (!Number.isFinite(this.#clockSkew) || this.#clockSkew < 0 || this.#clockSkew > 30)
      throw new Error('invalid gateway clock skew');
  }

  /** Adds a persisted paired public key without changing assertion semantics. */
  addTrustedKey(kid: string, publicKey: AssertionKey): void {
    if (!kid || this.#keys.has(kid)) throw new Error('trusted assertion key is invalid');
    this.#keys.set(kid, createPublicKey(publicKey));
  }

  verify(token: string, expectedPurpose?: AssertionPurpose): GatewayAssertionClaims {
    let header: Record<string, unknown>;
    let claims: unknown;
    let input: string;
    let signature: Buffer;
    try {
      const pieces = token.split('.');
      if (pieces.length !== 3 || pieces.some((piece) => !piece || !BASE64URL.test(piece))) throw new Error();
      input = `${pieces[0]}.${pieces[1]}`;
      header = decode(pieces[0]) as Record<string, unknown>;
      claims = decode(pieces[1]);
      signature = Buffer.from(pieces[2], 'base64url');
    } catch {
      throw new GatewayAssertionError('malformed');
    }
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string') {
      throw new GatewayAssertionError('malformed');
    }
    const key = this.#keys.get(header.kid);
    if (!key) throw new GatewayAssertionError('unknown_key');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(input);
    verifier.end();
    if (!verifier.verify(key, signature)) throw new GatewayAssertionError('invalid_signature');
    if (!isClaims(claims)) throw new GatewayAssertionError('invalid_claims');
    const now = this.#clock();
    if (claims.iss !== this.#issuer || claims.aud !== this.#audience || claims.ver !== 1) {
      throw new GatewayAssertionError('invalid_claims');
    }
    if (expectedPurpose !== undefined && claims.purpose !== expectedPurpose)
      throw new GatewayAssertionError('wrong_purpose');
    if (claims.nbf > now + this.#clockSkew) throw new GatewayAssertionError('not_yet_valid');
    if (claims.exp <= now - this.#clockSkew) throw new GatewayAssertionError('expired');
    if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_ASSERTION_LIFETIME_SECONDS) {
      throw new GatewayAssertionError('invalid_claims');
    }
    if (!this.#ledger.record({ ...claims, sessionId: claims.sessionId }, Math.floor(now))) {
      throw new GatewayAssertionError('replay');
    }
    return claims;
  }
}

function isClaims(value: unknown): value is GatewayAssertionClaims {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.iss !== 'string' ||
    typeof candidate.aud !== 'string' ||
    typeof candidate.sub !== 'string' ||
    candidate.sub.length === 0 ||
    !isAssertionPurpose(candidate.purpose) ||
    !Number.isInteger(candidate.iat) ||
    !Number.isInteger(candidate.nbf) ||
    !Number.isInteger(candidate.exp) ||
    typeof candidate.jti !== 'string' ||
    candidate.jti.length === 0 ||
    candidate.ver !== 1 ||
    (candidate.workspaceId !== undefined && typeof candidate.workspaceId !== 'string') ||
    (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string')
  )
    return false;
  if (
    candidate.purpose === 'workspace_list' ||
    candidate.purpose === 'workspace_candidate_validate' ||
    candidate.purpose === 'workspace_candidate_browse' ||
    candidate.purpose === 'workspace_candidate_select' ||
    candidate.purpose === 'settings_read' ||
    candidate.purpose === 'settings_write' ||
    candidate.purpose === 'credential_write' ||
    candidate.purpose === 'credential_delete' ||
    candidate.purpose === 'oauth_login' ||
    candidate.purpose === 'oauth_select' ||
    candidate.purpose === 'oauth_delete' ||
    candidate.purpose === 'session_list' ||
    candidate.purpose === 'model_list'
  ) {
    return candidate.workspaceId === undefined && candidate.sessionId === undefined;
  }
  if (candidate.purpose === 'session_create')
    return typeof candidate.workspaceId === 'string' && candidate.sessionId === undefined;
  if (candidate.purpose === 'session_update') {
    return (
      candidate.workspaceId === undefined &&
      (candidate.sessionId === undefined || typeof candidate.sessionId === 'string')
    );
  }
  return (
    (candidate.workspaceId === undefined || typeof candidate.workspaceId === 'string') &&
    typeof candidate.sessionId === 'string'
  );
}

export const assertionPurposes = [...ASSERTION_PURPOSES];
