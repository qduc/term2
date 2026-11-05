/** Isolated assertion/pairing composition. All file paths must belong to the new direct server,
 * never the old gateway's trust/replay stores. Caller owns the supplied assertion replay ledger.
 */
import { AssertionVerifier, type AssertionVerifierOptions } from './server-assertion.js';
import { GatewayPairing, PairingError } from './server-pairing.js';
import { TrustedClientsStore } from './server-trusted-clients.js';
import { isPairingRegisterBody } from './server-validation.js';
import { publicError } from './server-errors.js';
import type { GatewayAssertionClaims, ServerResult } from './server-contracts.js';

export { AssertionVerifier, createGatewayAssertion, GatewayAssertionError } from './server-assertion.js';
export { SqliteReplayLedger, MemoryReplayLedger } from './server-replay-ledger.js';
export type { ReplayLedger } from './server-replay-ledger.js';
export { TrustedClientsStore } from './server-trusted-clients.js';
export { GatewayPairing, PairingError } from './server-pairing.js';
export type ServerAuthentication = {
  verify(token: string): GatewayAssertionClaims;
  register?(body: unknown): Promise<ServerResult>;
};
export type ServerAuthenticationOptions = AssertionVerifierOptions & {
  pairing?: {
    enabled: boolean;
    trustFilePath: string;
    otpTtlMs?: number;
    maxAttempts?: number;
    printOtp?: (otp: string) => void;
  };
};
/** Uses the gateway RS256/issuer/audience/purpose/60-second/replay contract and first-key OTP flow. */
export function createServerAuthentication(options: ServerAuthenticationOptions): ServerAuthentication {
  const pairingOptions = options.pairing;
  const store = pairingOptions?.enabled ? new TrustedClientsStore(pairingOptions.trustFilePath) : undefined;
  const keys = new Map(options.publicKeys instanceof Map ? options.publicKeys : Object.entries(options.publicKeys));
  for (const key of store?.entries() ?? []) keys.set(key.kid, key.publicKeyPem);
  const verifier = new AssertionVerifier({ ...options, publicKeys: keys, allowEmptyKeys: store !== undefined });
  if (!store || !pairingOptions) return { verify: (token) => verifier.verify(token) };
  const pairing = new GatewayPairing({ ...pairingOptions, trustStore: store });
  return {
    verify: (token) => verifier.verify(token),
    async register(body) {
      if (!isPairingRegisterBody(body)) return publicError(401, 'pairing_invalid', 'pairing request is invalid');
      try {
        const result = await pairing.register(body.publicKeyPem, body.otp);
        const key = store.entries().find((entry) => entry.kid === result.kid);
        if (!key) return publicError(503, 'pairing_unavailable', 'pairing is unavailable', true);
        verifier.addTrustedKey(key.kid, key.publicKeyPem);
        return { status: 200, body: result };
      } catch (error) {
        if (!(error instanceof PairingError)) throw error;
        if (error.code === 'pairing_unavailable') return publicError(503, error.code, 'pairing is unavailable', true);
        return publicError(
          401,
          error.code === 'pairing_invalid' ? 'pairing_invalid' : 'pairing_required',
          'pairing rejected',
        );
      }
    },
  };
}
