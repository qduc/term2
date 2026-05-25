import { randomBytes } from 'node:crypto';
import type { ILoggingService } from '../services/service-interfaces.js';
import { injectHeaders } from './fetch/logging-middleware.js';

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const OPENCODE_HOST_FRAGMENT = 'opencode.ai';

export type OpencodeProviderIdentity = {
  type?: string;
  name?: string;
  baseUrl?: string;
};

export function isOpencodeProvider(identity: OpencodeProviderIdentity): boolean {
  return (
    identity.type === 'opencode' ||
    identity.name === 'opencode' ||
    (typeof identity.baseUrl === 'string' && identity.baseUrl.toLowerCase().includes(OPENCODE_HOST_FRAGMENT))
  );
}

/**
 * Generates a session ID in the format `ses_<12_hex_timestamp><14_base62_random>`.
 * Total length: 30 characters.
 */
export function generateOpencodeSessionId(): string {
  const timestamp = Date.now().toString(16).padStart(12, '0').slice(0, 12);
  const bytes = randomBytes(11);
  let value = 0n;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8n) + BigInt(bytes[i]);
  }
  let random = '';
  for (let i = 0; i < 14; i++) {
    random += BASE62_ALPHABET[Number(value % 62n)];
    value /= 62n;
  }
  return `ses_${timestamp}${random}`;
}

export function resolveOpencodeSessionId(
  loggingService?: ILoggingService,
  fallbackSessionId?: string,
): string | undefined {
  return fallbackSessionId || loggingService?.getTrafficContext?.()?.sessionId;
}

export function withOpencodeSessionHeader(init: RequestInit, sessionId: string): RequestInit {
  return {
    ...init,
    headers: injectHeaders(init.headers, {
      'x-opencode-session': sessionId,
    }),
  };
}

export function resolveOpencodeRuntimeConfig(
  baseUrl?: string,
  apiKey?: string,
): {
  baseUrl: string;
  apiKey: string | undefined;
} {
  return {
    baseUrl: baseUrl ?? 'https://opencode.ai/v1',
    apiKey: apiKey ?? process.env.OPENCODE_API_KEY,
  };
}
