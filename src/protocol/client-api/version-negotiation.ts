/**
 * Whole-spec semantic version (<major>.<minor>) and capability negotiation for the Client API.
 * Self-contained (zero Term2-internal imports) for graduation into @qduc/agent-wire (Decision D006).
 */

export const CLIENT_API_VERSION = '1.0' as const;
export const CLIENT_API_MIN_SUPPORTED_VERSION = '1.0' as const;

export type ParsedProtocolVersion = {
  readonly major: number;
  readonly minor: number;
  readonly raw: string;
};

const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseProtocolVersion(value: string): ParsedProtocolVersion | null {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null;
  return { major, minor, raw: value };
}

function compareVersions(a: ParsedProtocolVersion, b: ParsedProtocolVersion): number {
  return a.major !== b.major ? a.major - b.major : a.minor - b.minor;
}

/**
 * Negotiate the highest mutually supported version in [max(cMin, hMin), min(cMax, hMax)]
 * under the linear-release invariant (client-api.md §3.1).
 */
export function negotiateProtocolVersion(
  clientMinRaw: string,
  clientMaxRaw: string,
  hostMinRaw: string = CLIENT_API_MIN_SUPPORTED_VERSION,
  hostMaxRaw: string = CLIENT_API_VERSION,
): { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string } {
  const cMin = parseProtocolVersion(clientMinRaw);
  const cMax = parseProtocolVersion(clientMaxRaw);
  const hMin = parseProtocolVersion(hostMinRaw);
  const hMax = parseProtocolVersion(hostMaxRaw);
  if (!cMin || !cMax || !hMin || !hMax) {
    return { ok: false, reason: 'Invalid protocol version syntax; expected <major>.<minor>.' };
  }
  if (compareVersions(cMin, cMax) > 0 || compareVersions(hMin, hMax) > 0) {
    return { ok: false, reason: 'Minimum supported protocol version exceeds maximum version.' };
  }
  const low = compareVersions(cMin, hMin) >= 0 ? cMin : hMin;
  const high = compareVersions(cMax, hMax) <= 0 ? cMax : hMax;
  if (compareVersions(low, high) > 0) {
    return {
      ok: false,
      reason: `No compatible protocol version between client (${cMin.raw}..${cMax.raw}) and host (${hMin.raw}..${hMax.raw}).`,
    };
  }
  return { ok: true, version: high.raw };
}

/**
 * Negotiate a single HTTP `x-term2-client-api-version` header value `M.m` by treating it as
 * the client range `[M.0, M.m]` (same major, backward-compatible minor downgrade; transport-http-sse.md §2).
 */
export function negotiateSingleProtocolVersion(
  headerVersion: string,
  hostMinRaw: string = CLIENT_API_MIN_SUPPORTED_VERSION,
  hostMaxRaw: string = CLIENT_API_VERSION,
): { readonly ok: true; readonly version: string } | { readonly ok: false; readonly reason: string } {
  const parsed = parseProtocolVersion(headerVersion);
  if (!parsed) {
    return { ok: false, reason: 'Invalid protocol version syntax; expected <major>.<minor>.' };
  }
  return negotiateProtocolVersion(`${parsed.major}.0`, parsed.raw, hostMinRaw, hostMaxRaw);
}

/**
 * Negotiate active capabilities: intersection(clientRequested, hostSupported),
 * or all hostSupported when clientRequested is omitted (client-api.md §3.2).
 */
export function negotiateCapabilities(hostSupported: readonly string[], clientRequested?: readonly string[]): string[] {
  if (!clientRequested) return [...hostSupported];
  const supported = new Set(hostSupported);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cap of clientRequested) {
    if (supported.has(cap) && !seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}
