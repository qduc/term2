import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Env-driven gateway client configuration for the thin server.
 *
 * Socket mode (default): TERM2_GATEWAY_SOCKET_PATH — the gateway's Unix socket,
 * the only transport this client is meant to use in the composable topology
 * (the gateway never binds the network; see
 * docs/plans/web-client-composable-redesign.md "Deployment topology").
 * Network TLS mode exists for parity with the reference client but is unused.
 */

function resolvePrivateKeyPath() {
  if (process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH) {
    return process.env.TERM2_GATEWAY_BFF_PRIVATE_KEY_PATH;
  }
  // Generate once and persist so the paired key survives restarts.
  const dir = path.join(process.cwd(), '.data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gateway-client-key.pem');
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
  }
  return file;
}

export const LOCAL_OWNER_USER_ID = process.env.TERM2_LOCAL_OWNER_USER_ID || 'local-owner';

let cached = null;

export function getGatewayConfig() {
  if (cached) return cached;
  const port = process.env.TERM2_GATEWAY_PORT ? Number.parseInt(process.env.TERM2_GATEWAY_PORT, 10) : undefined;
  cached = {
    enabled: true,
    sshEnabled: false,
    allowUnsandboxed: false,
    autoApprove: false,
    socketPath: process.env.TERM2_GATEWAY_SOCKET_PATH,
    gatewayPort: Number.isInteger(port) && port > 0 ? port : undefined,
    gatewayHost: process.env.TERM2_GATEWAY_HOST,
    tlsCertPath: process.env.TERM2_GATEWAY_TLS_CERT,
    tlsKeyPath: process.env.TERM2_GATEWAY_TLS_KEY,
    tlsCaPath: process.env.TERM2_GATEWAY_TLS_CA,
    issuer: process.env.TERM2_GATEWAY_ISSUER || 'term2-web-client',
    audience: process.env.TERM2_GATEWAY_AUDIENCE || 'term2-gateway',
    keyId: process.env.TERM2_GATEWAY_KEY_ID || 'term2-web-client',
    assertionTtlSec: 30,
    clockSkewSec: 5,
    pairingEnabled: process.env.TERM2_GATEWAY_PAIRING_ENABLED === 'true',
    pairingOtp: process.env.TERM2_GATEWAY_PAIRING_OTP,
    privateKeyPath: resolvePrivateKeyPath(),
    requestTimeoutMs: 15000,
    streamTimeoutMs: 600000,
    maxResponseBytes: 32 * 1024 * 1024,
  };
  return cached;
}
