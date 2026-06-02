import { randomBytes } from 'node:crypto';
import type { ILoggingService } from '../services/service-interfaces.js';
import { injectHeaders } from './fetch/logging-middleware.js';
import { isOpencodeProvider, type OpencodeProviderIdentity } from './opencode.provider.js';

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

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

export type OpencodeSessionInjector = (init: RequestInit) => RequestInit | null;

export function createOpencodeSessionInjector(
  identity: OpencodeProviderIdentity,
  options?: {
    loggingService?: ILoggingService;
    fallbackSessionIdOverride?: string;
  },
): OpencodeSessionInjector | null {
  if (!isOpencodeProvider(identity)) return null;

  const fallbackSessionId = options?.fallbackSessionIdOverride ?? generateOpencodeSessionId();

  return (init: RequestInit) => {
    const sessionId = resolveOpencodeSessionId(options?.loggingService, fallbackSessionId);
    if (!sessionId) return null;
    return withOpencodeSessionHeader(init, sessionId);
  };
}
