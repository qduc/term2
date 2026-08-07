import { randomBytes } from 'node:crypto';
import type { ISessionContextService, SessionTrafficContext } from '../services/service-interfaces.js';
import { injectHeaders } from './fetch/logging-middleware.js';
import { isOpencodeProvider, type OpencodeProviderIdentity } from './opencode.provider.js';

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Generates a session ID in the format `ses_<12_hex_timestamp><14_base62_random>`.
 * Total length: 30 characters.
 */
export function generateOpencodeSessionId(effectiveSessionId?: string): string {
  if (effectiveSessionId) {
    const hexPool = '0123456789abcdef';
    let seed = 0;
    for (let i = 0; i < effectiveSessionId.length; i++) {
      seed = (seed * 31 + effectiveSessionId.charCodeAt(i)) | 0;
    }
    let state = Math.abs(seed);
    const nextRand = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    let result = '';
    for (let i = 0; i < 12; i++) {
      result += hexPool[nextRand() % 16];
    }
    for (let i = 0; i < 14; i++) {
      result += BASE62_ALPHABET[nextRand() % 62];
    }
    return `ses_${result}`;
  }

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

/**
 * Requests made on behalf of a nested run — a subagent, or the shell
 * auto-approval evaluator — must not land in the parent conversation's OpenCode
 * session, because the server keys state off `x-opencode-session`. Such a run
 * is identified by its own `providerHistoryKey`, or by the `evaluator` marker.
 *
 * Returns the key to derive a session ID from, or `undefined` when the context
 * is the conversation itself.
 */
function nestedScopeKey(context: SessionTrafficContext | null | undefined): string | undefined {
  if (!context) return undefined;
  if (context.providerHistoryKey) return context.providerHistoryKey;
  if (context.evaluator) return `${context.sessionId}:evaluator`;
  return undefined;
}

export function resolveOpencodeSessionId(options: {
  sessionContextService?: ISessionContextService;
  fallbackSessionId?: string;
  fallbackSessionIdOverride?: string;
}): string | undefined {
  const context = options.sessionContextService?.getContext();

  // Checked ahead of the override: the override is conversation-scoped by
  // construction, so honouring it here would put nested runs back in the
  // parent's session.
  const nestedKey = nestedScopeKey(context);
  if (nestedKey) {
    return generateOpencodeSessionId(nestedKey);
  }

  if (options.fallbackSessionIdOverride) {
    return options.fallbackSessionIdOverride;
  }

  if (context?.sessionId) {
    return generateOpencodeSessionId(context.sessionId);
  }

  return options.fallbackSessionId;
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
    sessionContextService?: ISessionContextService;
    fallbackSessionIdOverride?: string;
  },
): OpencodeSessionInjector | null {
  if (!isOpencodeProvider(identity)) return null;

  const fallbackSessionId = generateOpencodeSessionId();

  return (init: RequestInit) => {
    const sessionId = resolveOpencodeSessionId({
      sessionContextService: options?.sessionContextService,
      fallbackSessionId,
      fallbackSessionIdOverride: options?.fallbackSessionIdOverride,
    });
    if (!sessionId) return null;
    return withOpencodeSessionHeader(init, sessionId);
  };
}
